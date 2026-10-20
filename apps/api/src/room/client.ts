// How the Worker opens rooms and talks to their DOs: POST /v1/rooms and the
// room endpoints (routes/room.ts), and the lobby when it seats someone
// (matchmaker/lobby.ts).
import { Effect, Schema } from 'effect';
import { type ApiError, apiError } from '../contract/errors';
import {
  NAME_PATTERN,
  normalizeDisplayName,
  RESERVED_NAMES,
  RoomId,
  SETTINGS_DEFAULTS,
  Settings,
  TestSettings,
} from '../contract/schemas';
import type { Bindings } from '../routes/env';
import { signRoomToken, signWatchToken } from '../token/token';
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

// Plain vars of this deployment that routes/env.ts doesn't type.
type RoomVars = {
  // Where the web runs; watch links point there (A16).
  WEB_URL?: string;
  ALLOW_TEST_ROOMS?: string;
  DEFAULT_SETTINGS_JSON?: string;
  DEFAULT_TEST_JSON?: string;
};
const vars = (env: Bindings) => env as Bindings & RoomVars;

// `test` settings only count where ALLOW_TEST_ROOMS=true (casino-api 測試房);
// anywhere else is production.
const allowTestRooms = (env: Bindings) => vars(env).ALLOW_TEST_ROOMS === 'true';

// A11: a deployment's defaults for every room, as JSON. A bad value throws,
// so every POST /v1/rooms answers 500 until it is fixed.
const fromJson =
  <T>(decode: (input: unknown) => T, name: string) =>
  (json: string | undefined): T | undefined => {
    if (json === undefined) return undefined;
    try {
      return decode(JSON.parse(json));
    } catch (error) {
      throw new Error(`${name} is not valid: ${String(error)}`);
    }
  };
const defaultSettings = fromJson(
  Schema.decodeUnknownSync(Settings),
  'DEFAULT_SETTINGS_JSON',
);
const defaultTest = fromJson(
  Schema.decodeUnknownSync(TestSettings),
  'DEFAULT_TEST_JSON',
);

// Built-in defaults < DEFAULT_SETTINGS_JSON < the request, key by key; the
// test settings likewise, but production never reads DEFAULT_TEST_JSON.
const roomDefaults = (
  env: Bindings,
  input: { settings?: typeof Settings.Type; test?: typeof TestSettings.Type },
) => {
  const { DEFAULT_SETTINGS_JSON, DEFAULT_TEST_JSON } = vars(env);
  const settings = {
    ...SETTINGS_DEFAULTS,
    ...defaultSettings(DEFAULT_SETTINGS_JSON),
    ...input.settings,
  };
  if (!allowTestRooms(env)) return { settings, test: null };
  const defaults = defaultTest(DEFAULT_TEST_JSON);
  const test = defaults || input.test ? { ...defaults, ...input.test } : null;
  return { settings, test };
};

// A20: the display name to store, `name` when none was given. Requests are
// checked by the contract, so a given one is valid.
export const displayNameOf = (input: {
  name: string;
  display_name?: string;
}) =>
  input.display_name === undefined
    ? input.name
    : (normalizeDisplayName(input.display_name) ?? input.name);

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

// The seat's room token and its owner's watch link (A16). The watch token
// has no exp, so the same seat always gets the same link.
const sign = (
  env: Bindings,
  claims: { room_id: string; seat: number; name: string },
) =>
  Effect.gen(function* () {
    const { WEB_URL } = vars(env);
    if (!WEB_URL) return yield* Effect.die(new Error('WEB_URL is not set'));
    const [token, watchToken] = yield* Effect.promise(() =>
      Promise.all([
        signRoomToken(claims, env.TOKEN_SECRET, Date.now()),
        signWatchToken(claims, env.TOKEN_SECRET),
      ]),
    );
    const watch_url = `${WEB_URL}/watch/${claims.room_id}?token=${watchToken}`;
    return { token, watch_url };
  });

// A19: a multiplayer room with no blind_every given, by the request or the
// deployment's defaults, sets it by player count when it starts.
const blindEveryGiven = (
  env: Bindings,
  input: { settings?: typeof Settings.Type },
) =>
  input.settings?.blind_every !== undefined ||
  defaultSettings(vars(env).DEFAULT_SETTINGS_JSON)?.blind_every !== undefined;

// What a room opened with `input` is played with: a multiplayer room with
// no blind_every given sets it when it starts (A19).
const openedWith = (
  env: Bindings,
  input: {
    visibility?: 'public' | 'private';
    settings?: typeof Settings.Type;
    test?: typeof TestSettings.Type;
    opponent?: 'bot';
  },
) => {
  const defaults = roomDefaults(env, input);
  const multiplayer = input.visibility !== undefined && !input.opponent;
  return multiplayer && !blindEveryGiven(env, input)
    ? { ...defaults, settings: { ...defaults.settings, blind_every: null } }
    : defaults;
};

// The settings and test settings of a public room opened with the
// deployment's defaults: the only rooms auto-seating fills (A2).
export const publicDefaults = (env: Bindings) =>
  openedWith(env, { visibility: 'public' });

// Opens a room with `name` in seat 0, the host. Check the name with
// nameError first. Without `visibility` it is a heads-up room that starts
// when the second player sits (房間狀態).
export const openRoom = (
  env: Bindings,
  input: {
    name: string;
    // Normalized (A20); `name` when left out.
    display_name?: string;
    visibility?: 'public' | 'private';
    settings?: typeof Settings.Type;
    test?: typeof TestSettings.Type;
    opponent?: 'bot';
  },
) =>
  Effect.gen(function* () {
    const { settings, test } = yield* Effect.sync(() => openedWith(env, input));
    const visibility = input.visibility ?? null;
    const room_id = `r_${randomString(ROOM_ID_CHARS, 10)}`;
    const invite_code = randomString(INVITE_CHARS, 6);
    // Signed first: the room keeps the watch link for the first turn (T46).
    const signed = yield* sign(env, { room_id, seat: 0, name: input.name });
    // Fails only if the room id is taken, which 36^10 ids make unlikely
    // enough not to retry.
    const room = yield* callRoom(() =>
      stubOf(env, room_id).create({
        room_id,
        invite_code,
        name: input.name,
        display_name: input.display_name,
        visibility,
        settings,
        seed: newSeed(test),
        test,
        ...(input.opponent && { opponent: input.opponent }),
        watch_url: signed.watch_url,
      }),
    );
    return { ...room, ...signed };
  });

// Seats `name` in the next seat of the room. Check the name with nameError
// first. The seat is known once the room has seated it, so its watch link
// is signed then and handed back to the room (T46).
export const joinRoom = (
  env: Bindings,
  roomId: string,
  input: { name: string; display_name?: string; invite_code?: string | null },
) =>
  Effect.gen(function* () {
    const stub = yield* roomStub(env, roomId);
    const { invite_code, ...player } = input;
    const room = yield* callRoom(() =>
      stub.join({ ...player, ...(invite_code && { invite_code }) }),
    );
    const signed = yield* sign(env, {
      room_id: roomId,
      seat: room.seat,
      name: input.name,
    });
    yield* callRoom(() => stub.setWatchUrl(input.name, signed.watch_url));
    return { ...room, ...signed };
  });

// A9: an admin calls the room's match off (void).
export const abortRoom = (env: Bindings, roomId: string) =>
  Effect.gen(function* () {
    const stub = yield* roomStub(env, roomId);
    yield* callRoom(() => stub.abort());
    return { status: 'aborted' as const, room_id: roomId };
  });
