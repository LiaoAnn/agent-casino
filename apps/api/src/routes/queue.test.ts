import { Schema } from 'effect';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { handle } from '../app';
import {
  type ApiError,
  ERROR_STATUS,
  type ErrorCode,
} from '../contract/errors';
import { QueueResponse, RoomStatus } from '../contract/schemas';
import { banName } from '../db/bans';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { MatchQueue, openMatchIn } from '../matchmaker/pairing';
import { RoomReferee, type RoomStorage } from '../room/referee';
import { verifyRoomToken } from '../token/token';
import type { Bindings } from './env';

const BASE = 'http://api.test';
const TOKEN_SECRET = 'queue-test-token-secret';
const WAIT_MS = 100;
let testD1: TestD1;

beforeAll(async () => {
  testD1 = await startTestD1();
}, 30_000);
beforeEach(async () => {
  await testD1.reset();
});
afterAll(async () => {
  await testD1?.dispose();
});

class MemoryStorage implements RoomStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

const makeEnv = (allowTestRooms?: string) => {
  const referees = new Map<string, RoomReferee>();
  const ROOM = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let referee = referees.get(id);
      if (referee === undefined) {
        referee = new RoomReferee(new MemoryStorage(), { waitMs: WAIT_MS });
        referees.set(id, referee);
      }
      return referee;
    },
  };
  const env = {
    TOKEN_SECRET,
    ADMIN_KEY: 'queue-test-admin-key',
    DB: testD1.d1,
    ROOM,
    MATCHMAKER: {},
    ...(allowTestRooms === undefined
      ? {}
      : { ALLOW_TEST_ROOMS: allowTestRooms }),
  } as unknown as Bindings;
  const queue = new MatchQueue(openMatchIn(env), { waitMs: WAIT_MS });
  const queueCall = vi.fn(queue.queue.bind(queue));
  Object.assign(env, {
    MATCHMAKER: {
      idFromName: (name: string) => name,
      get: () => ({ queue: queueCall }),
    },
  });
  return { env, queueCall };
};

const post = (env: Bindings, body: unknown) =>
  handle(
    new Request(`${BASE}/v1/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
const queue = (
  env: Bindings,
  name: string,
  options: Record<string, unknown> = {},
) => post(env, { game: 'holdem', name, ...options });
const get = (env: Bindings, path: string, token: string) =>
  handle(
    new Request(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );

const decodeQueue = async (response: Response) => {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  return Schema.decodeUnknownSync(QueueResponse)(await response.json());
};
const expectError = async (response: Response, code: ErrorCode) => {
  expect(response.status).toBe(ERROR_STATUS[code]);
  expect(response.headers.get('content-type')).toContain('application/json');
  const body = (await response.json()) as ApiError;
  expect(body).toMatchObject({
    status: 'error',
    code,
    message: expect.any(String),
    hint: expect.any(String),
    retryable: false,
  });
  expect(body.message.length).toBeGreaterThan(0);
  expect(body.hint.length).toBeGreaterThan(0);
};

const pair = async (env: Bindings, options: Record<string, unknown> = {}) => {
  const responses = await Promise.all([
    queue(env, 'AlIce', options),
    queue(env, 'bOB', options),
  ]);
  const [alice, bob] = await Promise.all(responses.map(decodeQueue));
  expect(alice?.status).toBe('matched');
  expect(bob?.status).toBe('matched');
  if (alice?.status !== 'matched' || bob?.status !== 'matched')
    throw new Error('Expected a matched pair');
  expect(alice.room_id).toBe(bob.room_id);
  expect(alice.room_id).toMatch(/^r_[a-z0-9]{10}$/);
  expect([alice.seat, bob.seat].sort()).toEqual([0, 1]);
  expect(alice.token).not.toBe(bob.token);
  for (const player of [alice, bob]) {
    expect(player.hint).toBe(
      `Matched. Next, call GET /v1/rooms/${player.room_id}/wait`,
    );
  }
  return [alice, bob] as const;
};

describe('POST /v1/queue (S1)', () => {
  it('pairs two HTTP callers with usable room tokens and wait access', async () => {
    const { env } = makeEnv();
    const players = await pair(env);
    for (const [index, player] of players.entries()) {
      const verified = await verifyRoomToken(
        player.token,
        TOKEN_SECRET,
        player.room_id,
        Date.now(),
      );
      expect(verified.ok).toBe(true);
      if (verified.ok)
        expect(verified.claims).toMatchObject({
          room_id: player.room_id,
          seat: player.seat,
          name: index === 0 ? 'AlIce' : 'bOB',
        });
    }
    const waits = await Promise.all(
      players.map(player =>
        get(env, `/v1/rooms/${player.room_id}/wait`, player.token),
      ),
    );
    for (const response of waits) {
      expect(response.status).toBe(200);
      const status = Schema.decodeUnknownSync(RoomStatus)(
        await response.json(),
      );
      expect(status.room_status).toBe('playing');
      expect(status.view).not.toBeNull();
    }
  });

  it('returns waiting with the exact hint for one caller', async () => {
    const { env } = makeEnv();
    expect(await decodeQueue(await queue(env, 'Alice'))).toEqual({
      status: 'waiting',
      hint: 'No opponent yet. Call POST /v1/queue again',
    });
  });

  it.each(['Alice', 'alice', 'ALICE'])(
    'rejects banned %s before passing it to Matchmaker',
    async name => {
      await banName(testD1.db, 'Alice');
      const { env, queueCall } = makeEnv();
      await expectError(await queue(env, name), 'name_banned');
      expect(queueCall).not.toHaveBeenCalled();
    },
  );

  it.each([
    'house-bot',
    'HOUSE-BOT',
    '',
    'a'.repeat(33),
    'bad name',
    'a.b',
    '玩家',
    'alice!',
  ])('rejects invalid or reserved name %j', async name => {
    const { env, queueCall } = makeEnv();
    await expectError(await queue(env, name), 'name_invalid');
    expect(queueCall).not.toHaveBeenCalled();
  });

  it.each(['A', 'a'.repeat(32), 'Valid_09-name'])(
    'accepts valid boundary name %s',
    async name => {
      const { env } = makeEnv();
      expect((await decodeQueue(await queue(env, name))).status).toBe(
        'waiting',
      );
    },
  );

  it('rejects malformed JSON', async () => {
    const { env, queueCall } = makeEnv();
    const response = await handle(
      new Request(`${BASE}/v1/queue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
      env,
    );
    await expectError(response, 'invalid_request');
    expect(queueCall).not.toHaveBeenCalled();
  });

  it('rejects a request missing game', async () => {
    const { env, queueCall } = makeEnv();
    await expectError(await post(env, { name: 'Alice' }), 'invalid_request');
    expect(queueCall).not.toHaveBeenCalled();
  });

  it('does not pair different settings', async () => {
    const { env } = makeEnv();
    const responses = await Promise.all([
      queue(env, 'Alice', { settings: { starting_stack: 100 } }),
      queue(env, 'Bob', { settings: { starting_stack: 200 } }),
    ]);
    for (const response of responses)
      expect((await decodeQueue(response)).status).toBe('waiting');
  });

  it('opens a room using the matching requested settings', async () => {
    const { env } = makeEnv();
    const settings = { hands: 3, turn_seconds: 10, starting_stack: 100 };
    const players = await pair(env, { settings });
    for (const player of players) {
      const response = await get(
        env,
        `/v1/rooms/${player.room_id}/state`,
        player.token,
      );
      expect(response.status).toBe(200);
      const status = Schema.decodeUnknownSync(RoomStatus)(
        await response.json(),
      );
      expect(status.view).not.toBeNull();
      if (status.view !== null) {
        expect(status.view.my_stack + status.view.my_bet_this_street).toBe(
          settings.starting_stack,
        );
        expect(
          status.view.opponent_stack + status.view.opponent_bet_this_street,
        ).toBe(settings.starting_stack);
      }
    }
  });

  it.each([undefined, 'false', 'TRUE'])(
    'strips test options unless ALLOW_TEST_ROOMS is exactly true (%s)',
    async allow => {
      const { env, queueCall } = makeEnv(allow);
      const responses = await Promise.all([
        queue(env, 'Alice', { test: { seed: '00'.repeat(32) } }),
        queue(env, 'Bob', { test: { seed: '01'.repeat(32) } }),
      ]);
      for (const response of responses)
        expect((await decodeQueue(response)).status).toBe('matched');
      expect(queueCall).toHaveBeenCalledTimes(2);
      for (const [input] of queueCall.mock.calls)
        expect(input.test).toBeUndefined();
    },
  );

  it('passes test options through when ALLOW_TEST_ROOMS is true', async () => {
    const { env, queueCall } = makeEnv('true');
    const test = { seed: '00'.repeat(32), chaos: { extra_waiting: 1 } };
    await pair(env, { test });
    expect(queueCall).toHaveBeenCalledTimes(2);
    for (const [input] of queueCall.mock.calls)
      expect(input.test).toEqual(test);
  });
});
