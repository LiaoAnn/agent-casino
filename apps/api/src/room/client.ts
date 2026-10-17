// How the Worker opens rooms and talks to their DOs: POST /v1/rooms and the
// room endpoints (routes/room.ts), and the queue once it pairs two players
// (T12: openRoom, then joinRoom with the invite code it returns).
import { Effect, Schema } from 'effect';
import { type ApiError, apiError } from '../contract/errors';
import {
  NAME_PATTERN,
  RESERVED_NAMES,
  RoomId,
  SETTINGS_DEFAULTS,
  type Settings,
  type TestSettings,
} from '../contract/schemas';
import type { Bindings } from '../routes/env';
import { signRoomToken } from '../token/token';
import type { RoomApi } from './referee';
import { newSeed } from './seed';

const isRoomId = Schema.is(RoomId);
const ROOM_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
// No 0, O, 1 or I (casino-api A14).
const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Uniform picks: bytes past the last whole multiple of the alphabet are
// thrown away instead of biasing the first characters.
function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) {
        out += alphabet[byte % alphabet.length];
      }
    }
  }
  return out;
}

// `test` settings only count where ALLOW_TEST_ROOMS=true (casino-api 測試房).
const allowTestRooms = (env: Bindings) =>
  (env as Bindings & { ALLOW_TEST_ROOMS?: string }).ALLOW_TEST_ROOMS === 'true';

// `retry` names the request to resend with another name.
export const nameError = (name: string, retry: string) => {
  if (!NAME_PATTERN.test(name)) {
    return apiError(
      'name_invalid',
      'That name is not allowed: use 1-32 characters, only letters, digits, - and _; pick a different name',
      `Pick a valid name and resend ${retry}`,
    );
  }
  if ((RESERVED_NAMES as readonly string[]).includes(name.toLowerCase())) {
    return apiError(
      'name_invalid',
      `The name ${name} is reserved for the house bot; pick a different name`,
      `Pick a different name and resend ${retry}`,
    );
  }
  return undefined;
};

// The DO stub, typed as the referee it forwards to: the RPC types of
// DurableObjectStub would turn the contract's tuples into plain arrays.
const stubOf = (env: Bindings, roomId: string) =>
  env.ROOM.get(env.ROOM.idFromName(roomId)) as unknown as RoomApi;

export const roomStub = (env: Bindings, roomId: string) =>
  isRoomId(roomId)
    ? Effect.succeed(stubOf(env, roomId))
    : Effect.fail(
        apiError(
          'room_not_found',
          'There is no such room: room ids look like r_ followed by 10 lowercase letters or digits',
          'Check the room_id, or open a room with POST /v1/rooms',
        ),
      );

// Cloudflare marks DO errors worth retrying (reset, overloaded) this way.
const isTransient = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { retryable?: unknown }).retryable === true ||
    (error as { overloaded?: unknown }).overloaded === true);

type Outcome<T, C extends ApiError['code']> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError<C> };

// Calls a room's DO and fails with the room's own error. A DO that can't be
// reached right now is a retryable 503; any other error is a bug, which dies
// and answers 500 internal (app.ts).
export const callRoom = <T, C extends ApiError['code']>(
  call: () => Promise<Outcome<T, C>>,
) =>
  Effect.promise(() =>
    call().then(
      outcome => ({ reached: true as const, outcome }),
      (error: unknown) => ({ reached: false as const, error }),
    ),
  ).pipe(
    Effect.flatMap(
      (answer): Effect.Effect<T, ApiError<C> | ApiError<'unavailable'>> => {
        if (answer.reached) {
          const { outcome } = answer;
          return outcome.ok
            ? Effect.succeed(outcome.value)
            : Effect.fail(outcome.error);
        }
        if (!isTransient(answer.error)) return Effect.die(answer.error);
        return Effect.fail(
          apiError(
            'unavailable',
            'The room could not be reached',
            'Resend the same request in a few seconds',
          ),
        );
      },
    ),
  );

const sign = (
  env: Bindings,
  claims: { room_id: string; seat: 0 | 1; name: string },
) => Effect.promise(() => signRoomToken(claims, env.TOKEN_SECRET, Date.now()));

// Opens a room with `name` in seat 0. Check the name with nameError first.
export const openRoom = (
  env: Bindings,
  input: {
    name: string;
    settings?: typeof Settings.Type;
    test?: typeof TestSettings.Type;
  },
) =>
  Effect.gen(function* () {
    const test = allowTestRooms(env) ? (input.test ?? null) : null;
    const room_id = `r_${randomString(ROOM_ID_CHARS, 10)}`;
    const invite_code = randomString(INVITE_CHARS, 6);
    // Fails only if the room id is taken, which 36^10 ids make unlikely
    // enough not to retry.
    yield* callRoom(() =>
      stubOf(env, room_id).create({
        room_id,
        invite_code,
        name: input.name,
        settings: { ...SETTINGS_DEFAULTS, ...input.settings },
        seed: newSeed(test),
        test,
      }),
    );
    const token = yield* sign(env, { room_id, seat: 0, name: input.name });
    return { room_id, invite_code, seat: 0 as const, token };
  });

// Seats `name` in seat 1 of the room. Check the name with nameError first.
export const joinRoom = (
  env: Bindings,
  roomId: string,
  input: { name: string; invite_code: string },
) =>
  Effect.gen(function* () {
    const stub = yield* roomStub(env, roomId);
    const { seat } = yield* callRoom(() => stub.join(input));
    const token = yield* sign(env, { room_id: roomId, seat, name: input.name });
    return { room_id: roomId, seat, token };
  });

// A9: an admin calls the room's match off (void).
export const abortRoom = (env: Bindings, roomId: string) =>
  Effect.gen(function* () {
    const stub = yield* roomStub(env, roomId);
    yield* callRoom(() => stub.abort());
    return { status: 'aborted' as const, room_id: roomId };
  });
