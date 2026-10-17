// Opening and joining rooms, and the room endpoints behind RoomAuth (T09).
// createRoom and joinRoom join the lobby group in routes/lobby.ts. The game
// itself is refereed by the room's Durable Object (room/referee.ts).
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi, RoomSession } from '../contract/api';
import { type ApiError, apiError } from '../contract/errors';
import {
  NAME_PATTERN,
  RESERVED_NAMES,
  SETTINGS_DEFAULTS,
} from '../contract/schemas';
import type { RoomApi } from '../room/referee';
import { signRoomToken } from '../token/token';
import { type Bindings, WorkerEnv } from './env';

const ROOM_ID = /^r_[a-z0-9]{10}$/;
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

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

// `test` settings only count where ALLOW_TEST_ROOMS=true (casino-api 測試房).
const allowTestRooms = (env: Bindings) =>
  (env as Bindings & { ALLOW_TEST_ROOMS?: string }).ALLOW_TEST_ROOMS === 'true';

const nameError = (name: string, retry: string) => {
  if (!NAME_PATTERN.test(name)) {
    return apiError(
      'name_invalid',
      `The name ${JSON.stringify(name)} is not allowed: use 1-32 characters, only letters, digits, - and _; pick a different name`,
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

const roomStub = (env: Bindings, roomId: string) =>
  ROOM_ID.test(roomId)
    ? Effect.succeed(stubOf(env, roomId))
    : Effect.fail(
        apiError(
          'room_not_found',
          `There is no room ${JSON.stringify(roomId)}: room ids look like r_ followed by 10 lowercase letters or digits`,
          'Check the room_id, or open a room with POST /v1/rooms',
        ),
      );

type Outcome<T, C extends ApiError['code']> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError<C> };

// Calls the room's DO; a DO that can't be reached is a retryable 503.
const reachRoom = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: () =>
      apiError(
        'unavailable',
        'The room could not be reached',
        'Resend the same request in a few seconds',
      ),
  });

// The same, failing with the room's own error.
const callRoom = <T, C extends ApiError['code']>(
  call: () => Promise<Outcome<T, C>>,
) =>
  reachRoom(call).pipe(
    Effect.flatMap(outcome =>
      outcome.ok ? Effect.succeed(outcome.value) : Effect.fail(outcome.error),
    ),
  );

const sign = (
  env: Bindings,
  claims: { room_id: string; seat: 0 | 1; name: string },
) => Effect.promise(() => signRoomToken(claims, env.TOKEN_SECRET, Date.now()));

export const createRoom = HttpApiBuilder.handler(
  CasinoApi,
  'lobby',
  'createRoom',
  ({ payload }) =>
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      const badName = nameError(payload.name, 'POST /v1/rooms');
      if (badName) return yield* Effect.fail(badName);
      if (payload.opponent === 'bot') {
        return yield* Effect.fail(
          apiError(
            'invalid_request',
            'Playing against the house bot is not available yet',
            'Leave out "opponent" and give room_id and invite_code to another player',
          ),
        );
      }
      const settings = { ...SETTINGS_DEFAULTS, ...payload.settings };
      const seed =
        allowTestRooms(env) && payload.test?.seed !== undefined
          ? payload.test.seed
          : randomSeed();
      // A clash of 36^10 room ids is not expected; retrying is cheap anyway.
      for (let attempt = 0; ; attempt++) {
        const room_id = `r_${randomString(ROOM_ID_CHARS, 10)}`;
        const invite_code = randomString(INVITE_CHARS, 6);
        const created = yield* reachRoom(() =>
          stubOf(env, room_id).create({
            room_id,
            invite_code,
            name: payload.name,
            settings,
            seed,
          }),
        );
        if (!created.ok && attempt < 2) continue;
        if (!created.ok) return yield* Effect.fail(created.error);
        const token = yield* sign(env, {
          room_id,
          seat: 0,
          name: payload.name,
        });
        return {
          room_id,
          invite_code,
          seat: 0 as const,
          token,
          hint: `Give room_id and invite_code to your opponent, then call GET /v1/rooms/${room_id}/wait`,
        };
      }
    }),
);

export const joinRoom = HttpApiBuilder.handler(
  CasinoApi,
  'lobby',
  'joinRoom',
  ({ params, payload }) =>
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      const stub = yield* roomStub(env, params.room_id);
      const badName = nameError(
        payload.name,
        `POST /v1/rooms/${params.room_id}/join`,
      );
      if (badName) return yield* Effect.fail(badName);
      const { seat } = yield* callRoom(() =>
        stub.join({ name: payload.name, invite_code: payload.invite_code }),
      );
      const token = yield* sign(env, {
        room_id: params.room_id,
        seat,
        name: payload.name,
      });
      return {
        room_id: params.room_id,
        seat,
        token,
        hint: `Joined. Call GET /v1/rooms/${params.room_id}/wait for your first turn`,
      };
    }),
);

const status = (roomId: string, wait: boolean) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* RoomSession;
    const stub = yield* roomStub(env, roomId);
    return yield* callRoom(() => stub.status(session.seat, { wait }));
  });

export const RoomHandlers = HttpApiBuilder.group(CasinoApi, 'room', handlers =>
  handlers.handleAll({
    wait: ({ params }) => status(params.room_id, true),
    state: ({ params }) => status(params.room_id, false),
    act: () => notImplemented('POST /v1/rooms/{room_id}/actions'),
    leave: () => notImplemented('POST /v1/rooms/{room_id}/leave'),
  }),
);

// Stub until the ticket above fills it in.
const notImplemented = (endpoint: string) =>
  Effect.fail(
    apiError(
      'internal',
      `${endpoint} is not implemented yet on this server`,
      'This endpoint is not available yet. Read GET /skill.md for what works now',
    ),
  );
