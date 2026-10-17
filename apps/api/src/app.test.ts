// T17: the Worker answers every CasinoApi endpoint through `handle()`.
// Handlers are still stubs, so a request that gets past routing, decoding and
// auth answers 500 `internal` "not implemented". Everything else must answer
// with the contract's error body (casino-api skill: 錯誤格式, A4).
// The room handlers are real (T09): the fake Room namespace never has a room,
// so a request that reaches one answers 404 `room_not_found`.
import { HttpApi } from 'effect/http-api';
import { describe, expect, it } from 'vitest';
import { handle } from './app';
import { AdminAuth, CasinoApi, RoomAuth } from './contract/api';
import { ERROR_STATUS, type ErrorCode } from './contract/errors';
import { RoomReferee, type RoomStorage } from './room/referee';
import type { Bindings } from './routes/env';
import { signRoomToken, TOKEN_TTL_SECONDS } from './token/token';

const BASE = 'http://api.test';
const TOKEN_SECRET = 'test-token-secret';
const ADMIN_KEY = 'test-admin-key';
const ROOM = 'r_abcde12345';
const OTHER_ROOM = 'r_zzzzz99999';

// Empty storage: every room was never created.
const emptyStorage: RoomStorage = {
  get: async () => undefined,
  put: async () => {},
};

const FAKE_ROOM = {
  idFromName: (name: string) => name,
  get: () => new RoomReferee(emptyStorage, { waitMs: 50 }),
};

const makeEnv = (overrides: Partial<Record<string, string>> = {}): Bindings =>
  ({
    TOKEN_SECRET,
    ADMIN_KEY,
    DB: {},
    ROOM: FAKE_ROOM,
    MATCHMAKER: {},
    ...overrides,
  }) as unknown as Bindings;

const ENV = makeEnv();

const roomToken = (
  options: { room?: string; secret?: string; nowMs?: number } = {},
): Promise<string> =>
  signRoomToken(
    { room_id: options.room ?? ROOM, seat: 0, name: 'alice' },
    options.secret ?? TOKEN_SECRET,
    options.nowMs ?? Date.now(),
  );

interface Call {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
  authorization?: string;
}

const call = (c: Call, env: Bindings = ENV): Promise<Response> => {
  const headers = new Headers();
  let body: string | undefined;
  if (c.rawBody !== undefined) {
    body = c.rawBody;
    headers.set('content-type', c.contentType ?? 'application/json');
  } else if (c.body !== undefined) {
    body = JSON.stringify(c.body);
    headers.set('content-type', c.contentType ?? 'application/json');
  }
  if (c.authorization !== undefined) {
    headers.set('authorization', c.authorization);
  }
  return handle(
    new Request(`${BASE}${c.path}`, { method: c.method, headers, body }),
    env,
  );
};

interface ErrorBody {
  status: 'error';
  code: string;
  message: string;
  hint: string;
  retryable: boolean;
}

// Asserts the response is the contract's error body and returns it.
const readError = async (response: Response): Promise<ErrorBody> => {
  expect(response.headers.get('content-type') ?? '').toContain(
    'application/json',
  );
  const body = (await response.json()) as ErrorBody;
  expect(body).toMatchObject({
    status: 'error',
    code: expect.any(String),
    message: expect.any(String),
    hint: expect.any(String),
    retryable: expect.any(Boolean),
  });
  expect(body.message.length).toBeGreaterThan(0);
  expect(body.hint.length).toBeGreaterThan(0);
  return body;
};

const expectError = async (
  response: Response,
  code: ErrorCode,
  status: number = ERROR_STATUS[code],
): Promise<ErrorBody> => {
  const body = await readError(response);
  expect({ status: response.status, code: body.code }).toEqual({
    status,
    code,
  });
  return body;
};

const expectStub = async (response: Response): Promise<void> => {
  const body = await expectError(response, 'internal', 500);
  expect(body.retryable).toBe(false);
  expect(body.message.toLowerCase()).toContain('not implemented');
};

// Must be stopped before the handler: not 2xx, an auth or internal error,
// and never the stub's answer.
const expectBlocked = async (response: Response): Promise<void> => {
  expect([401, 500]).toContain(response.status);
  const body = await readError(response);
  expect(['invalid_token', 'internal']).toContain(body.code);
  expect(body.message.toLowerCase()).not.toContain('not implemented');
};

const admin = (key: string = ADMIN_KEY) => `Bearer ${key}`;

describe('GET /health', () => {
  it('answers 200 { ok: true }', async () => {
    const response = await call({ method: 'GET', path: '/health' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe('every CasinoApi endpoint is wired to a stub', () => {
  type Endpoint = {
    name: string;
    // The contract's route template, e.g. 'POST /v1/rooms/:room_id/join'.
    route: string;
    auth: 'none' | 'room' | 'admin';
  } & Omit<Call, 'authorization'>;

  const ENDPOINTS: Endpoint[] = [
    {
      name: 'skill.skill',
      route: 'GET /skill.md',
      auth: 'none',
      method: 'GET',
      path: '/skill.md',
    },
    {
      name: 'lobby.queue',
      route: 'POST /v1/queue',
      auth: 'none',
      method: 'POST',
      path: '/v1/queue',
      body: { game: 'holdem', name: 'alice' },
    },
    {
      name: 'lobby.createRoom',
      route: 'POST /v1/rooms',
      auth: 'none',
      method: 'POST',
      path: '/v1/rooms',
      body: { game: 'holdem', name: 'alice' },
    },
    {
      name: 'lobby.joinRoom',
      route: 'POST /v1/rooms/:room_id/join',
      auth: 'none',
      method: 'POST',
      path: `/v1/rooms/${ROOM}/join`,
      body: { name: 'bob', invite_code: 'ABC234' },
    },
    {
      name: 'room.wait',
      route: 'GET /v1/rooms/:room_id/wait',
      auth: 'room',
      method: 'GET',
      path: `/v1/rooms/${ROOM}/wait`,
    },
    {
      name: 'room.state',
      route: 'GET /v1/rooms/:room_id/state',
      auth: 'room',
      method: 'GET',
      path: `/v1/rooms/${ROOM}/state`,
    },
    {
      name: 'room.act',
      route: 'POST /v1/rooms/:room_id/actions',
      auth: 'room',
      method: 'POST',
      path: `/v1/rooms/${ROOM}/actions`,
      body: { turn_id: 't_1', type: 'check' },
    },
    {
      name: 'room.leave',
      route: 'POST /v1/rooms/:room_id/leave',
      auth: 'room',
      method: 'POST',
      path: `/v1/rooms/${ROOM}/leave`,
    },
    {
      name: 'read.leaderboard',
      route: 'GET /v1/leaderboard',
      auth: 'none',
      method: 'GET',
      path: '/v1/leaderboard',
    },
    {
      name: 'read.matches',
      route: 'GET /v1/matches',
      auth: 'none',
      method: 'GET',
      path: '/v1/matches',
    },
    {
      name: 'read.match',
      route: 'GET /v1/matches/:match_id',
      auth: 'none',
      method: 'GET',
      path: `/v1/matches/${ROOM}`,
    },
    {
      name: 'admin.abortRoom',
      route: 'POST /v1/admin/rooms/:room_id/abort',
      auth: 'admin',
      method: 'POST',
      path: `/v1/admin/rooms/${ROOM}/abort`,
    },
    {
      name: 'admin.banName',
      route: 'POST /v1/admin/names/:name/ban',
      auth: 'admin',
      method: 'POST',
      path: '/v1/admin/names/alice/ban',
    },
  ];

  it('covers exactly the endpoints of CasinoApi, with their auth', () => {
    const contract: string[] = [];
    HttpApi.reflect(CasinoApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint, middleware }) => {
        const keys: ReadonlySet<unknown> = middleware;
        const auth = keys.has(RoomAuth)
          ? 'room'
          : keys.has(AdminAuth)
            ? 'admin'
            : 'none';
        contract.push(`${endpoint.method} ${endpoint.path} ${auth}`);
      },
    });
    const table = ENDPOINTS.map(e => `${e.route} ${e.auth}`);
    expect(contract).toHaveLength(13);
    expect([...table].sort()).toEqual([...contract].sort());
  });

  it.each(ENDPOINTS)('$name: path matches its route template', e => {
    const [method, template = ''] = e.route.split(' ');
    const pattern = new RegExp(`^${template.replace(/:[a-z_]+/g, '[^/]+')}$`);
    expect(e.method).toBe(method);
    expect(e.path).toMatch(pattern);
  });

  // Real handlers now; routes/room.test.ts covers them (T09).
  const IMPLEMENTED = new Set([
    'lobby.createRoom',
    'lobby.joinRoom',
    'room.wait',
    'room.state',
    'room.act',
    'room.leave',
  ]);

  it.each(ENDPOINTS.filter(e => !IMPLEMENTED.has(e.name)))(
    '$name ($method $path) answers 500 internal "not implemented"',
    async ({ name: _name, route: _route, auth, ...request }) => {
      const authorization =
        auth === 'room'
          ? `Bearer ${await roomToken()}`
          : auth === 'admin'
            ? admin()
            : undefined;
      await expectStub(await call({ ...request, authorization }));
    },
  );
});

describe('bad request input answers 400 invalid_request', () => {
  const queue = (overrides: Partial<Call>) =>
    call({ method: 'POST', path: '/v1/queue', ...overrides });

  it('malformed JSON body', async () => {
    const body = await expectError(
      await queue({ rawBody: '{bad' }),
      'invalid_request',
    );
    expect(body.retryable).toBe(false);
  });

  it('valid JSON missing a required field (name)', async () => {
    const body = await expectError(
      await queue({ body: { game: 'holdem' } }),
      'invalid_request',
    );
    expect(body.retryable).toBe(false);
  });

  it('a field of the wrong type, naming the field in message', async () => {
    const body = await expectError(
      await queue({ body: { game: 'holdem', name: 5 } }),
      'invalid_request',
    );
    expect(body.retryable).toBe(false);
    expect(body.message).toContain('name');
  });

  it('a JSON body sent as form data (curl -d) tells to set Content-Type', async () => {
    const body = await expectError(
      await queue({
        rawBody: JSON.stringify({ game: 'holdem', name: 'alice' }),
        contentType: 'application/x-www-form-urlencoded',
      }),
      'invalid_request',
    );
    expect(body.retryable).toBe(false);
    expect(body.hint.toLowerCase()).toContain('content-type: application/json');
  });

  it('a room endpoint with a valid token but malformed JSON', async () => {
    const body = await expectError(
      await call({
        method: 'POST',
        path: `/v1/rooms/${ROOM}/actions`,
        rawBody: '{bad',
        authorization: `Bearer ${await roomToken()}`,
      }),
      'invalid_request',
    );
    expect(body.retryable).toBe(false);
  });
});

describe('unknown path or method answers 404 pointing to /skill.md', () => {
  it.each([
    { method: 'GET', path: '/nope' },
    { method: 'GET', path: '/v1/queue' },
    { method: 'POST', path: '/health' },
  ] as const)('$method $path', async request => {
    const body = await expectError(await call(request), 'invalid_request', 404);
    expect(body.hint).toContain('/skill.md');
  });
});

describe('RoomAuth answers 401 invalid_token', () => {
  const ROOM_ENDPOINTS: Call[] = [
    { method: 'GET', path: `/v1/rooms/${ROOM}/wait` },
    { method: 'GET', path: `/v1/rooms/${ROOM}/state` },
    {
      method: 'POST',
      path: `/v1/rooms/${ROOM}/actions`,
      body: { turn_id: 't_1', type: 'check' },
    },
    { method: 'POST', path: `/v1/rooms/${ROOM}/leave` },
  ];

  // `reason`: what the message must say (token/token.ts tokenRejectionError).
  const ROOM_BAD_AUTH: {
    case: string;
    authorization: () => Promise<string | undefined>;
    reason?: string;
  }[] = [
    { case: 'no Authorization header', authorization: async () => undefined },
    {
      case: 'a token signed with another secret',
      authorization: async () =>
        `Bearer ${await roomToken({ secret: 'some-other-secret' })}`,
    },
    {
      case: 'an expired token',
      authorization: async () =>
        `Bearer ${await roomToken({
          nowMs: Date.now() - (TOKEN_TTL_SECONDS + 60) * 1000,
        })}`,
      reason: 'expired',
    },
    {
      case: 'a token of another room',
      authorization: async () =>
        `Bearer ${await roomToken({ room: OTHER_ROOM })}`,
      reason: 'different room',
    },
    {
      case: 'a garbage token',
      authorization: async () => 'Bearer not-a-token',
    },
    {
      case: 'the admin key as a room token',
      authorization: async () => admin(),
    },
  ];

  const cases = ROOM_ENDPOINTS.flatMap(endpoint =>
    ROOM_BAD_AUTH.map(bad => ({
      ...bad,
      endpoint,
      label: `${endpoint.method} ${endpoint.path}`,
    })),
  );

  it.each(cases)(
    '$label with $case',
    async ({ endpoint, authorization, reason }) => {
      const body = await expectError(
        await call({ ...endpoint, authorization: await authorization() }),
        'invalid_token',
      );
      expect(body.retryable).toBe(false);
      if (reason !== undefined) {
        expect(body.message.toLowerCase()).toContain(reason);
      }
    },
  );

  it('checks the token before the body (no token + malformed JSON)', async () => {
    const body = await expectError(
      await call({
        method: 'POST',
        path: `/v1/rooms/${ROOM}/actions`,
        rawBody: '{bad',
      }),
      'invalid_token',
    );
    expect(body.retryable).toBe(false);
  });
});

describe('AdminAuth answers 401 invalid_token', () => {
  const ADMIN_ENDPOINTS: Call[] = [
    { method: 'POST', path: `/v1/admin/rooms/${ROOM}/abort` },
    { method: 'POST', path: '/v1/admin/names/alice/ban' },
  ];

  const BAD_AUTH: {
    case: string;
    authorization: () => Promise<string | undefined>;
  }[] = [
    { case: 'no Authorization header', authorization: async () => undefined },
    { case: 'a wrong key', authorization: async () => admin('wrong-key') },
    {
      case: 'a valid room token',
      authorization: async () => `Bearer ${await roomToken()}`,
    },
    {
      case: 'the key in different case',
      authorization: async () => admin(ADMIN_KEY.toUpperCase()),
    },
    {
      case: 'the key with an extra character',
      authorization: async () => admin(`${ADMIN_KEY}x`),
    },
  ];

  const cases = ADMIN_ENDPOINTS.flatMap(endpoint =>
    BAD_AUTH.map(bad => ({
      ...bad,
      endpoint,
      label: `${endpoint.method} ${endpoint.path}`,
    })),
  );

  it.each(cases)('$label with $case', async ({ endpoint, authorization }) => {
    const body = await expectError(
      await call({ ...endpoint, authorization: await authorization() }),
      'invalid_token',
    );
    expect(body.retryable).toBe(false);
  });

  it.each(ADMIN_ENDPOINTS)(
    '$method $path with the right key reaches the handler',
    async endpoint => {
      await expectStub(await call({ ...endpoint, authorization: admin() }));
    },
  );
});

describe('secrets come only from env', () => {
  const ABORT: Call = {
    method: 'POST',
    path: `/v1/admin/rooms/${ROOM}/abort`,
  };

  it('an empty ADMIN_KEY never lets an empty bearer in', async () => {
    const env = makeEnv({ ADMIN_KEY: '' });
    await expectBlocked(
      await call({ ...ABORT, authorization: 'Bearer ' }, env),
    );
  });

  it('an empty ADMIN_KEY never lets a request without a header in', async () => {
    const env = makeEnv({ ADMIN_KEY: '' });
    await expectBlocked(await call(ABORT, env));
  });

  it('an empty TOKEN_SECRET never accepts a room token', async () => {
    const env = makeEnv({ TOKEN_SECRET: '' });
    const token = await roomToken({ secret: 'x' });
    await expectBlocked(
      await call(
        {
          method: 'GET',
          path: `/v1/rooms/${ROOM}/state`,
          authorization: `Bearer ${token}`,
        },
        env,
      ),
    );
  });

  it('two envs with different ADMIN_KEYs work independently', async () => {
    const envA = makeEnv({ ADMIN_KEY: 'key-a' });
    const envB = makeEnv({ ADMIN_KEY: 'key-b' });
    await expectStub(
      await call({ ...ABORT, authorization: admin('key-a') }, envA),
    );
    await expectError(
      await call({ ...ABORT, authorization: admin('key-a') }, envB),
      'invalid_token',
    );
    await expectStub(
      await call({ ...ABORT, authorization: admin('key-b') }, envB),
    );
    await expectError(
      await call({ ...ABORT, authorization: admin('key-b') }, envA),
      'invalid_token',
    );
  });

  it('two envs with different TOKEN_SECRETs work independently', async () => {
    const envA = makeEnv({ TOKEN_SECRET: 'secret-a' });
    const envB = makeEnv({ TOKEN_SECRET: 'secret-b' });
    const state = (token: string): Call => ({
      method: 'GET',
      path: `/v1/rooms/${ROOM}/state`,
      authorization: `Bearer ${token}`,
    });
    const tokenA = await roomToken({ secret: 'secret-a' });
    // Past auth, the fake env has no room: the handler answers room_not_found.
    await expectError(await call(state(tokenA), envA), 'room_not_found');
    await expectError(await call(state(tokenA), envB), 'invalid_token');
  });
});
