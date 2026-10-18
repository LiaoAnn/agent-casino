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
import {
  QueueResponse,
  RoomStatus,
  SETTINGS_DEFAULTS,
} from '../contract/schemas';
import { banName } from '../db/bans';
import { startTestD1, type TestD1 } from '../db/test-d1';
import {
  type MatchQueue,
  matchQueueIn,
  type QueueInput,
} from '../matchmaker/pairing';
import { RoomReferee, type RoomStorage } from '../room/referee';
import { verifyRoomToken, verifyWatchToken } from '../token/token';
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

  async setAlarm(_scheduledTime: number): Promise<void> {}

  async deleteAlarm(): Promise<void> {}
}

const makeEnv = (
  allowTestRooms?: string,
  defaults: { DEFAULT_SETTINGS_JSON?: string; DEFAULT_TEST_JSON?: string } = {},
) => {
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
    ...defaults,
    TOKEN_SECRET,
    WEB_URL: 'https://web.test',
    ADMIN_KEY: 'queue-test-admin-key',
    DB: testD1.d1,
    ROOM,
    MATCHMAKER: {},
    ...(allowTestRooms === undefined
      ? {}
      : { ALLOW_TEST_ROOMS: allowTestRooms }),
  } as unknown as Bindings;
  const queues = new Map<string, MatchQueue>();
  const queueCall = vi.fn((id: string, input: QueueInput) => {
    let queue = queues.get(id);
    if (queue === undefined) {
      queue = matchQueueIn(env, { waitMs: WAIT_MS });
      queues.set(id, queue);
    }
    return queue.queue(input);
  });
  Object.assign(env, {
    MATCHMAKER: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        queue: (input: QueueInput) => queueCall(id, input),
      }),
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
) =>
  post(env, {
    game: 'holdem',
    name,
    queue_key: `queue-key-${name.toLowerCase().padEnd(16, '_')}`,
    ...options,
  });
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

  it('removes a retained waiter banned before pairing and pairs the remaining callers', async () => {
    const { env } = makeEnv();
    expect((await decodeQueue(await queue(env, 'Alice'))).status).toBe(
      'waiting',
    );
    await banName(testD1.db, 'Alice');
    expect((await decodeQueue(await queue(env, 'Bob'))).status).toBe('waiting');
    await expectError(await queue(env, 'ALICE'), 'name_banned');
    const carol = await decodeQueue(await queue(env, 'Carol'));
    const bob = await decodeQueue(await queue(env, 'Bob'));
    expect(carol.status).toBe('matched');
    expect(bob.status).toBe('matched');
    if (carol.status !== 'matched' || bob.status !== 'matched')
      throw new Error('Expected Bob and Carol to match');
    expect(carol.room_id).toBe(bob.room_id);
    expect([bob.seat, carol.seat]).toEqual([0, 1]);
  });

  it.each([3, 10])(
    'compares effective environment settings with requested hands=%s',
    async hands => {
      const { env } = makeEnv(undefined, {
        DEFAULT_SETTINGS_JSON: '{"hands":3}',
      });
      const responses = await Promise.all([
        queue(env, 'Alice'),
        queue(env, 'Bob', { settings: { hands } }),
      ]);
      const [alice, bob] = await Promise.all(responses.map(decodeQueue));
      if (hands === 3) {
        expect(alice.status).toBe('matched');
        expect(bob.status).toBe('matched');
        if (alice.status !== 'matched' || bob.status !== 'matched')
          throw new Error('Expected matching environment defaults');
        expect(alice.room_id).toBe(bob.room_id);
      } else {
        expect([alice.status, bob.status]).toEqual(['waiting', 'waiting']);
      }
    },
  );

  it('pairs omitted test options with the same environment seed', async () => {
    const seed = '00'.repeat(32);
    const { env } = makeEnv('true', {
      DEFAULT_TEST_JSON: JSON.stringify({ seed }),
    });
    const responses = await Promise.all([
      queue(env, 'Alice'),
      queue(env, 'Bob', { test: { seed } }),
    ]);
    const [alice, bob] = await Promise.all(responses.map(decodeQueue));
    expect(alice.status).toBe('matched');
    expect(bob.status).toBe('matched');
    if (alice.status !== 'matched' || bob.status !== 'matched')
      throw new Error('Expected matching environment test defaults');
    expect(alice.room_id).toBe(bob.room_id);
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
    await expectError(
      await post(env, { name: 'Alice', queue_key: 'alice-queue-key-1' }),
      'invalid_request',
    );
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
      for (const [, input] of queueCall.mock.calls)
        expect(input.test).toBeUndefined();
    },
  );

  it('passes test options through when ALLOW_TEST_ROOMS is true', async () => {
    const { env, queueCall } = makeEnv('true');
    const test = { seed: '00'.repeat(32), chaos: { extra_waiting: 1 } };
    await pair(env, { test });
    expect(queueCall).toHaveBeenCalledTimes(2);
    for (const [, input] of queueCall.mock.calls)
      expect(input.test).toEqual(test);
  });
});

describe('POST /v1/queue: opponent, settings and watch link (A16)', () => {
  const tokenOf = (watchUrl: string) => {
    const token = new URL(watchUrl).searchParams.get('token');
    if (token === null) throw new Error('no token in watch_url');
    return token;
  };

  it('matched carries opponent_name, settings and watch_url for each player', async () => {
    const { env } = makeEnv();
    const [alice, bob] = await pair(env);
    for (const [name, player, opponent] of [
      ['AlIce', alice, 'bOB'],
      ['bOB', bob, 'AlIce'],
    ] as const) {
      expect(player.opponent_name).toBe(opponent);
      expect(player.settings).toEqual(SETTINGS_DEFAULTS);
      expect(
        player.watch_url.startsWith(
          `https://web.test/watch/${player.room_id}?token=`,
        ),
      ).toBe(true);
      expect(
        await verifyWatchToken(
          tokenOf(player.watch_url),
          TOKEN_SECRET,
          player.room_id,
        ),
      ).toEqual({
        ok: true,
        claims: { room_id: player.room_id, seat: player.seat, name },
      });
    }
    expect(alice.watch_url).not.toBe(bob.watch_url);
  });

  it('matched shows the settings the two players asked for', async () => {
    const { env } = makeEnv();
    const settings = { hands: 3, turn_seconds: 10, starting_stack: 100 };
    const players = await pair(env, { settings });
    for (const player of players) expect(player.settings).toEqual(settings);
  });

  it('wait and state of the room name the opponent and the same settings', async () => {
    const { env } = makeEnv();
    const settings = { hands: 3, turn_seconds: 10, starting_stack: 100 };
    const players = await pair(env, { settings });
    for (const player of players) {
      for (const path of ['wait', 'state']) {
        const response = await get(
          env,
          `/v1/rooms/${player.room_id}/${path}`,
          player.token,
        );
        const status = Schema.decodeUnknownSync(RoomStatus)(
          await response.json(),
        );
        expect(status.opponent_name).toBe(player.opponent_name);
        expect(status.settings).toEqual(settings);
      }
    }
  });

  it('calling again after being matched answers the same matched, watch_url included', async () => {
    const { env } = makeEnv();
    const players = await pair(env);
    for (const [index, name] of ['AlIce', 'bOB'].entries()) {
      const again = await decodeQueue(await queue(env, name));
      expect(again).toEqual(players[index]);
      expect(players[index]?.watch_url).toEqual(expect.any(String));
      expect(again.status === 'matched' && again.watch_url).toBe(
        players[index]?.watch_url,
      );
    }
  });

  it('the waiter who is paired later gets the same watch_url on every call', async () => {
    const { env } = makeEnv();
    expect((await decodeQueue(await queue(env, 'Alice'))).status).toBe(
      'waiting',
    );
    const bob = await decodeQueue(await queue(env, 'Bob'));
    const first = await decodeQueue(await queue(env, 'Alice'));
    const second = await decodeQueue(await queue(env, 'Alice'));
    expect(bob.status).toBe('matched');
    expect(first.status).toBe('matched');
    expect(second).toEqual(first);
    if (first.status !== 'matched' || bob.status !== 'matched')
      throw new Error('Expected a pair');
    expect(first.opponent_name).toBe('Bob');
    expect(bob.opponent_name).toBe('Alice');
    expect(first.watch_url).not.toBe(bob.watch_url);
  });
});

describe('POST /v1/queue queue_key (A17)', () => {
  const ALICE_KEY = 'alice-private-key-1';
  const OTHER_KEY = 'other-private-key-2';

  const conflictBody = async (response: Response) => {
    expect(response.status).toBe(409);
    const body = (await response.json()) as ApiError;
    expect(body).toMatchObject({
      status: 'error',
      code: 'name_in_use',
      retryable: false,
      message: expect.any(String),
      hint: expect.any(String),
    });
    for (const field of ['room_id', 'token', 'watch_url', 'seat', 'queue_key'])
      expect(body).not.toHaveProperty(field);
    const text = JSON.stringify(body);
    expect(text).not.toContain(ALICE_KEY);
    expect(text).not.toContain(OTHER_KEY);
    expect(body.hint).toMatch(/name/i);
    expect(body.hint).toContain('queue_key');
  };

  it('rejects a missing key with instructions for generating one', async () => {
    const { env, queueCall } = makeEnv();
    const response = await post(env, { game: 'holdem', name: 'Alice' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiError;
    expect(body).toMatchObject({
      status: 'error',
      code: 'invalid_request',
      retryable: false,
    });
    expect(`${body.message} ${body.hint}`).toContain('openssl rand -hex 16');
    expect(queueCall).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'a'.repeat(15),
    'a'.repeat(65),
    'invalid key here!',
    `${'a'.repeat(16)}.`,
    `${'a'.repeat(16)}中`,
    `${'a'.repeat(16)}\n`,
  ])('rejects invalid queue_key %j before Matchmaker', async queue_key => {
    const { env, queueCall } = makeEnv();
    const response = await queue(env, 'Alice', { queue_key });
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiError;
    expect(body).toMatchObject({
      status: 'error',
      code: 'invalid_request',
      retryable: false,
    });
    expect(body.hint).toContain('openssl rand -hex 16');
    if (queue_key.length > 0)
      expect(JSON.stringify(body)).not.toContain(queue_key);
    expect(queueCall).not.toHaveBeenCalled();
  });

  it.each(['A'.repeat(16), 'z'.repeat(64), 'Az09_-'.repeat(3)])(
    'accepts boundary queue_key %s without echoing it',
    async queue_key => {
      const { env, queueCall } = makeEnv();
      const response = await queue(env, 'Alice', { queue_key });
      expect(response.status).toBe(200);
      const body = (await response.json()) as typeof QueueResponse.Type;
      expect(body.status).toBe('waiting');
      expect(JSON.stringify(body)).not.toContain(queue_key);
      expect(body).not.toHaveProperty('queue_key');
      expect(queueCall.mock.calls[0]?.[1]).toMatchObject({
        name: 'Alice',
        queue_key,
      });
    },
  );

  it('rejects another key while waiting, preserves settings and lets the owner retrieve matched', async () => {
    const { env } = makeEnv();
    const settings = { hands: 3, turn_seconds: 10, starting_stack: 100 };
    expect(
      (
        await decodeQueue(
          await queue(env, 'Alice', { queue_key: ALICE_KEY, settings }),
        )
      ).status,
    ).toBe('waiting');
    const conflict = await queue(env, 'ALICE', {
      queue_key: OTHER_KEY,
      settings: { hands: 10 },
    });
    const bob = await decodeQueue(await queue(env, 'Bob', { settings }));
    const alice = await decodeQueue(
      await queue(env, 'Alice', { queue_key: ALICE_KEY }),
    );
    await conflictBody(conflict);
    expect(alice.status).toBe('matched');
    expect(bob.status).toBe('matched');
    if (alice.status !== 'matched' || bob.status !== 'matched')
      throw new Error('Expected a match');
    expect(alice.room_id).toBe(bob.room_id);
    expect(alice.settings).toEqual(settings);
    expect(alice.seat).toBe(0);
    expect(JSON.stringify(alice)).not.toContain(ALICE_KEY);
    expect(
      await decodeQueue(await queue(env, 'alice', { queue_key: ALICE_KEY })),
    ).toEqual(alice);
  });

  it('denies the matched seat and watch link to another key but replays them for the owner', async () => {
    const { env } = makeEnv();
    const [alice] = await pair(env);
    const conflict = await queue(env, 'ALICE', { queue_key: OTHER_KEY });
    const again = await decodeQueue(await queue(env, 'alice'));
    await conflictBody(conflict);
    expect(again).toEqual(alice);
    if (again.status !== 'matched') throw new Error('Expected a match');
    expect(again.watch_url).toBe(alice.watch_url);
    expect(JSON.stringify(again)).not.toContain('queue-key-alice');
    expect(again).not.toHaveProperty('queue_key');
  });
});
