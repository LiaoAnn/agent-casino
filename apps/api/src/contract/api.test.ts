import { Effect, Exit, Layer, Redacted, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/http';
import { HttpApi, HttpApiBuilder } from 'effect/http-api';
import { afterAll, describe, expect, it } from 'vitest';
import {
  signRoomToken,
  TOKEN_TTL_SECONDS,
  tokenRejectionError,
  verifyRoomToken,
  verifyWatchToken,
  watchRejectionError,
} from '../token/token';
import {
  AdminAuth,
  CasinoApi,
  RoomAuth,
  RoomSession,
  WatchAuth,
  WatchSession,
} from './api';
import { apiError, ERROR_CODES, ERROR_STATUS, type ErrorCode } from './errors';

const SECRET = 'test-secret-not-real';
const ADMIN_KEY = 'admin-key-not-real';
const ROOM = 'r_abcde12345';
const OTHER_ROOM = 'r_zzzzz99999';
const BASE = 'http://api.test';

const decodes = (schema: Schema.Top, value: unknown): boolean =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(value),
  );

const errorBody = (code: ErrorCode) => ({
  status: 'error',
  code,
  message: 'Something went wrong; do this instead',
  hint: 'Try again later',
  retryable: false,
});

// --- the endpoint table from the casino-api skill --------------------------

const COMMON: ErrorCode[] = ['unavailable', 'internal'];
const NAME_CODES: ErrorCode[] = [
  'invalid_request',
  'name_invalid',
  'name_banned',
];

const EXPECTED: Record<
  string,
  {
    route: string;
    auth: 'none' | 'room' | 'watch' | 'admin';
    codes: ErrorCode[];
  }
> = {
  'skill.skill': { route: 'GET /skill.md', auth: 'none', codes: [] },
  'skill.casinoSh': { route: 'GET /casino.sh', auth: 'none', codes: [] },
  'lobby.queue': {
    route: 'POST /v1/queue',
    auth: 'none',
    codes: [...NAME_CODES, 'name_in_use'],
  },
  'lobby.createRoom': {
    route: 'POST /v1/rooms',
    auth: 'none',
    codes: NAME_CODES,
  },
  'lobby.joinRoom': {
    route: 'POST /v1/rooms/:room_id/join',
    auth: 'none',
    codes: [
      ...NAME_CODES,
      'room_not_found',
      'wrong_invite_code',
      'room_full',
      'match_over',
    ],
  },
  'room.wait': {
    route: 'GET /v1/rooms/:room_id/wait',
    auth: 'room',
    codes: ['invalid_token', 'room_not_found'],
  },
  'room.state': {
    route: 'GET /v1/rooms/:room_id/state',
    auth: 'room',
    codes: ['invalid_token', 'room_not_found'],
  },
  'room.act': {
    route: 'POST /v1/rooms/:room_id/actions',
    auth: 'room',
    codes: [
      'invalid_token',
      'invalid_request',
      'room_not_found',
      'not_your_turn',
      'stale_turn',
      'invalid_action',
      'match_over',
    ],
  },
  'room.leave': {
    route: 'POST /v1/rooms/:room_id/leave',
    auth: 'room',
    codes: ['invalid_token', 'room_not_found', 'match_over'],
  },
  // The watch link has its own token (A16): it is guarded by WatchAuth, not RoomAuth.
  'watch.watch': {
    route: 'GET /v1/rooms/:room_id/watch',
    auth: 'watch',
    codes: ['invalid_token', 'room_not_found'],
  },
  'read.leaderboard': {
    route: 'GET /v1/leaderboard',
    auth: 'none',
    codes: [],
  },
  'read.matches': {
    route: 'GET /v1/matches',
    auth: 'none',
    codes: ['invalid_request'],
  },
  'read.match': {
    route: 'GET /v1/matches/:match_id',
    auth: 'none',
    codes: ['room_not_found'],
  },
  'admin.abortRoom': {
    route: 'POST /v1/admin/rooms/:room_id/abort',
    auth: 'admin',
    codes: ['invalid_token', 'room_not_found', 'match_over'],
  },
  'admin.banName': {
    route: 'POST /v1/admin/names/:name/ban',
    auth: 'admin',
    codes: ['invalid_token', 'name_invalid'],
  },
};

type Reflected = {
  route: string;
  auth: 'none' | 'room' | 'watch' | 'admin';
  codes: ErrorCode[];
};

const reflectApi = (): Record<string, Reflected> => {
  const out: Record<string, Reflected> = {};
  HttpApi.reflect(CasinoApi, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint, middleware, errors }) => {
      const keys: ReadonlySet<unknown> = middleware;
      const auth = keys.has(RoomAuth)
        ? 'room'
        : keys.has(WatchAuth)
          ? 'watch'
          : keys.has(AdminAuth)
            ? 'admin'
            : 'none';
      const codes = ERROR_CODES.filter(code =>
        (errors.get(ERROR_STATUS[code]) ?? []).some(schema =>
          decodes(schema, errorBody(code)),
        ),
      );
      out[`${group.identifier}.${endpoint.identifier}`] = {
        route: `${endpoint.method} ${endpoint.path}`,
        auth,
        codes,
      };
    },
  });
  return out;
};

describe('CasinoApi definition', () => {
  const reflected = reflectApi();

  it('defines exactly the endpoints of the skill, with their auth', () => {
    const shape = (r: Record<string, Reflected>) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, `${v.route} ${v.auth}`]),
      );
    expect(shape(reflected)).toEqual(
      shape(EXPECTED as Record<string, Reflected>),
    );
  });

  it.each(Object.entries(EXPECTED))(
    '%s declares exactly its error codes',
    (key, expected) => {
      expect(reflected[key]?.codes.sort()).toEqual(
        [...expected.codes, ...COMMON].sort(),
      );
    },
  );
});

// --- a stub server over real HTTP requests ----------------------------------

const waitingStatus = (hint: string) =>
  ({
    status: 'waiting',
    room_status: 'playing',
    opponent_name: 'bob',
    display_name: 'alice',
    opponent_display_name: 'bob',
    settings: {
      max_hands: 10,
      turn_seconds: 60,
      blind_every: 50,
      starting_stack: 40,
    },
    to_act_seat: 1,
    hand_number: 1,
    view: null,
    hint,
  }) as const;

const staleTurn = apiError(
  'stale_turn',
  'turn_id t_1 is no longer valid; the turn already ended',
  `Do not resubmit. Call GET /v1/rooms/${ROOM}/wait`,
  { state: waitingStatus('Opponent is acting. Call wait again') },
);

const notServed = () => Effect.die('not served in this test');

const RoomAuthTest = Layer.succeed(RoomAuth, {
  bearer: (httpEffect, { credential }) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const result = yield* Effect.promise(() =>
        verifyRoomToken(
          Redacted.value(credential),
          SECRET,
          params.room_id ?? '',
          Date.now(),
        ),
      );
      if (!result.ok)
        return yield* Effect.fail(tokenRejectionError(result.reason));
      return yield* Effect.provideService(
        httpEffect,
        RoomSession,
        result.claims,
      );
    }),
});

const WatchAuthTest = Layer.succeed(WatchAuth, {
  bearer: (httpEffect, { credential }) =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const result = yield* Effect.promise(() =>
        verifyWatchToken(
          Redacted.value(credential),
          SECRET,
          params.room_id ?? '',
        ),
      );
      if (!result.ok)
        return yield* Effect.fail(watchRejectionError(result.reason));
      return yield* Effect.provideService(
        httpEffect,
        WatchSession,
        result.claims,
      );
    }),
});

const AdminAuthTest = Layer.succeed(AdminAuth, {
  bearer: (httpEffect, { credential }) =>
    Redacted.value(credential) === ADMIN_KEY
      ? httpEffect
      : Effect.fail(
          apiError(
            'invalid_token',
            'Missing or wrong admin key',
            'Send Authorization: Bearer <ADMIN_KEY>',
          ),
        ),
});

const SkillHandlers = HttpApiBuilder.group(CasinoApi, 'skill', handlers =>
  handlers.handleAll({
    skill: () => Effect.succeed('# Agent Casino\n'),
    casinoSh: () => Effect.succeed('#!/bin/sh\n'),
  }),
);

const LobbyHandlers = HttpApiBuilder.group(CasinoApi, 'lobby', handlers =>
  handlers.handleAll({
    queue: notServed,
    createRoom: notServed,
    joinRoom: notServed,
  }),
);

const RoomHandlers = HttpApiBuilder.group(CasinoApi, 'room', handlers =>
  handlers.handleAll({
    wait: notServed,
    state: () =>
      Effect.gen(function* () {
        const session = yield* RoomSession;
        return waitingStatus(
          `seat ${session.seat} ${session.name} in ${session.room_id}`,
        );
      }),
    act: () => Effect.fail(staleTurn),
    leave: notServed,
  }),
);

const WatchHandlers = HttpApiBuilder.group(CasinoApi, 'watch', handlers =>
  handlers.handle('watch', notServed),
);

const ReadHandlers = HttpApiBuilder.group(CasinoApi, 'read', handlers =>
  handlers.handleAll({
    leaderboard: () => Effect.succeed({ entries: [] }),
    matches: notServed,
    match: notServed,
  }),
);

const AdminHandlers = HttpApiBuilder.group(CasinoApi, 'admin', handlers =>
  handlers.handleAll({
    abortRoom: ({ params }) =>
      Effect.succeed({ status: 'aborted', room_id: params.room_id } as const),
    banName: notServed,
  }),
);

const { handler, dispose } = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(CasinoApi).pipe(
    Layer.provide([
      SkillHandlers,
      LobbyHandlers,
      RoomHandlers,
      WatchHandlers,
      ReadHandlers,
      AdminHandlers,
    ]),
    Layer.provide([RoomAuthTest, AdminAuthTest, WatchAuthTest]),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
);

afterAll(() => dispose());

const request = (
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
) =>
  handler(
    new Request(`${BASE}${path}`, {
      method,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    }),
  );

const tokenFor = (roomId: string, nowMs = Date.now(), secret = SECRET) =>
  signRoomToken({ room_id: roomId, seat: 0, name: 'alice' }, secret, nowMs);

const expectInvalidToken = async (response: Response) => {
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    status: 'error',
    code: 'invalid_token',
    retryable: false,
    message: expect.any(String),
    hint: expect.any(String),
  });
};

describe('CasinoApi over HTTP (stub handlers)', () => {
  it('serves GET /skill.md as markdown without a token', async () => {
    const response = await request('GET', '/skill.md');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(await response.text()).toBe('# Agent Casino\n');
  });

  it('serves GET /casino.sh as plain text without a token', async () => {
    const response = await request('GET', '/casino.sh');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('#!/bin/sh\n');
  });

  it('serves read endpoints without a token', async () => {
    const response = await request('GET', '/v1/leaderboard');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [] });
  });

  it('lets a valid room token reach the handler with its claims', async () => {
    const response = await request('GET', `/v1/rooms/${ROOM}/state`, {
      token: await tokenFor(ROOM),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      waitingStatus(`seat 0 alice in ${ROOM}`),
    );
  });

  it('rejects a request without a token', async () => {
    await expectInvalidToken(await request('GET', `/v1/rooms/${ROOM}/state`));
  });

  it('rejects a forged token', async () => {
    const token = await tokenFor(ROOM, Date.now(), 'attacker-secret');
    await expectInvalidToken(
      await request('GET', `/v1/rooms/${ROOM}/state`, { token }),
    );
  });

  it('rejects an expired token', async () => {
    const issued = Date.now() - (TOKEN_TTL_SECONDS + 60) * 1000;
    const token = await tokenFor(ROOM, issued);
    await expectInvalidToken(
      await request('GET', `/v1/rooms/${ROOM}/state`, { token }),
    );
  });

  it("rejects another room's token", async () => {
    const token = await tokenFor(OTHER_ROOM);
    await expectInvalidToken(
      await request('GET', `/v1/rooms/${ROOM}/state`, { token }),
    );
  });

  it('turns a handler apiError into its status and exact JSON body', async () => {
    const response = await request('POST', `/v1/rooms/${ROOM}/actions`, {
      token: await tokenFor(ROOM),
      body: { turn_id: 't_1', type: 'check' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(staleTurn);
  });

  it('guards admin endpoints with the admin key', async () => {
    const path = `/v1/admin/rooms/${ROOM}/abort`;
    await expectInvalidToken(await request('POST', path));
    await expectInvalidToken(
      await request('POST', path, { token: await tokenFor(ROOM) }),
    );
    const response = await request('POST', path, { token: ADMIN_KEY });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'aborted', room_id: ROOM });
  });
});
