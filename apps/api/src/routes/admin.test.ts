// T07: POST /v1/admin/names/{name}/ban (casino-api skill: 資料與積分, A13).
import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import {
  BanResponse,
  Leaderboard,
  MatchDetail,
  MatchList,
} from '../contract/schemas';
import { type MatchRecordInput, recordMatch } from '../db/records';
import { startTestD1, type TestD1 } from '../db/test-d1';
import type { Bindings } from './env';

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

const ADMIN_KEY = 'test-admin-key';

const makeEnv = (db: unknown): Bindings =>
  ({
    TOKEN_SECRET: 'test-token-secret',
    WEB_URL: 'https://web.test',
    ADMIN_KEY,
    DB: db,
    ROOM: {},
    MATCHMAKER: {},
  }) as unknown as Bindings;

const ban = (
  name: string,
  options: { key?: string | null; env?: Bindings } = {},
) => {
  const headers = new Headers();
  const key = options.key === undefined ? ADMIN_KEY : options.key;
  if (key !== null) headers.set('authorization', `Bearer ${key}`);
  return handle(
    new Request(`http://api.test/v1/admin/names/${name}/ban`, {
      method: 'POST',
      headers,
    }),
    options.env ?? makeEnv(testD1.d1),
  );
};

const banned = async (name: string) => {
  const response = await ban(name);
  expect(response.status).toBe(200);
  return Schema.decodeUnknownSync(BanResponse)(await response.json());
};

const getJson = async (path: string): Promise<unknown> => {
  const response = await handle(
    new Request(`http://api.test${path}`),
    makeEnv(testD1.d1),
  );
  expect(response.status).toBe(200);
  return response.json();
};

const leaderboard = async () =>
  Schema.decodeUnknownSync(Leaderboard)(await getJson('/v1/leaderboard'))
    .entries;

const expectError = async (
  response: Response,
  status: number,
  code: string,
) => {
  const body = (await response.json()) as Record<string, unknown>;
  expect({ status: response.status, code: body.code }).toEqual({
    status,
    code,
  });
  expect(body).toMatchObject({
    status: 'error',
    message: expect.any(String),
    hint: expect.any(String),
    retryable: expect.any(Boolean),
  });
  return body;
};

let matchCounter = 0;

const record = async (
  overrides: Partial<MatchRecordInput> = {},
): Promise<MatchRecordInput> => {
  const match: MatchRecordInput = {
    match_id: `r_${String(++matchCounter).padStart(10, '0')}`,
    players: ['Alice', 'Bob'],
    settings: {
      max_hands: 1,
      turn_seconds: 30,
      blind_every: 50,
      starting_stack: 200,
    },
    seed: '2a'.repeat(32),
    result: 'seat0_win',
    ended_at: '2026-10-18T10:00:00.000Z',
    final_stacks: [210, 190],
    hands: [
      {
        hand_number: 1,
        button_seat: 0,
        blinds: [1, 2],
        winner_seat: 0,
        pot: 20,
        ended_by: 'showdown',
        board: ['As', 'Kd', '7h', '2c', '9s'],
        hole_cards: [
          ['Qs', 'Qh'],
          ['Jd', 'Jc'],
        ],
        stacks: [210, 190],
        events: [
          { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
          { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
        ],
      },
    ],
    ...overrides,
  };
  await recordMatch(testD1.db, match);
  return match;
};

describe('POST /v1/admin/names/{name}/ban', () => {
  it('answers 200 banned with the name as given', async () => {
    expect(await banned('AlIce_9-x')).toEqual({
      status: 'banned',
      name: 'AlIce_9-x',
    });
  });

  it('banning twice answers 200 again', async () => {
    expect(await banned('alice')).toEqual({ status: 'banned', name: 'alice' });
    expect(await banned('alice')).toEqual({ status: 'banned', name: 'alice' });
    expect(await banned('ALICE')).toEqual({ status: 'banned', name: 'ALICE' });
  });

  it('a name that never played can be banned', async () => {
    await record();
    const before = await leaderboard();
    expect(await banned('nobody')).toEqual({
      status: 'banned',
      name: 'nobody',
    });
    expect(await leaderboard()).toEqual(before);
  });

  it.each(['a'.repeat(33), 'bad%20name', 'a.b', '%C3%A4lice', 'al%2Bice'])(
    '%s answers 400 name_invalid',
    async name => {
      const body = await expectError(await ban(name), 400, 'name_invalid');
      expect(body.retryable).toBe(false);
    },
  );

  it('a 32-character name is valid', async () => {
    const name = 'a'.repeat(32);
    expect(await banned(name)).toEqual({ status: 'banned', name });
  });

  it('a wrong key answers 401 invalid_token and bans nothing', async () => {
    await record();
    await expectError(
      await ban('Alice', { key: 'wrong-key' }),
      401,
      'invalid_token',
    );
    await expectError(await ban('Alice', { key: null }), 401, 'invalid_token');
    expect((await leaderboard()).map(e => e.name)).toEqual(['Alice', 'Bob']);
  });

  it('a D1 network error answers 503 unavailable', async () => {
    const reject = async () => {
      throw new Error('D1_ERROR: Network connection lost');
    };
    const statement = {
      bind: () => statement,
      all: reject,
      raw: reject,
      run: reject,
      first: reject,
    };
    const db = { prepare: () => statement, batch: reject };
    const body = await expectError(
      await ban('alice', { env: makeEnv(db) }),
      503,
      'unavailable',
    );
    expect(body.retryable).toBe(true);
  });

  it('a broken D1 answers 503 unavailable', async () => {
    const body = await expectError(
      await ban('alice', { env: makeEnv({}) }),
      503,
      'unavailable',
    );
    expect(body.retryable).toBe(true);
  });
});

describe('after a ban', () => {
  const seed = async () => {
    // Alice 2-0, Bob 1-1, Carol 0-1, Dave 0-1.
    const first = await record({ players: ['Alice', 'Bob'] });
    const second = await record({
      players: ['Bob', 'Carol'],
      ended_at: '2026-10-18T10:05:00.000Z',
    });
    const third = await record({
      players: ['Alice', 'Dave'],
      ended_at: '2026-10-18T10:10:00.000Z',
    });
    return [first, second, third];
  };

  it.each(['Bob', 'bob', 'BOB'])(
    'banning %s hides Bob from the leaderboard, ranks stay contiguous',
    async name => {
      await seed();
      const before = await leaderboard();
      expect(before.map(e => e.name)).toContain('Bob');
      await banned(name);
      const after = await leaderboard();
      const expected = before
        .filter(e => e.name !== 'Bob')
        .map((e, i) => ({ ...e, rank: i + 1 }));
      expect(after).toEqual(expected);
      expect(after.map(e => e.rank)).toEqual([1, 2, 3]);
    },
  );

  it('banning the top player moves everyone up', async () => {
    await seed();
    const before = await leaderboard();
    expect(before[0]?.name).toBe('Alice');
    await banned('aLiCe');
    expect(await leaderboard()).toEqual(
      before.slice(1).map((e, i) => ({ ...e, rank: i + 1 })),
    );
  });

  it('the banned name’s matches still appear in the list and detail', async () => {
    const matches = await seed();
    const listBefore = Schema.decodeUnknownSync(MatchList)(
      await getJson('/v1/matches'),
    );
    const details = await Promise.all(
      matches.map(async m =>
        Schema.decodeUnknownSync(MatchDetail)(
          await getJson(`/v1/matches/${m.match_id}`),
        ),
      ),
    );
    await banned('bob');
    expect(
      Schema.decodeUnknownSync(MatchList)(await getJson('/v1/matches')),
    ).toEqual(listBefore);
    expect(listBefore.matches).toHaveLength(3);
    for (const [i, m] of matches.entries()) {
      expect(
        Schema.decodeUnknownSync(MatchDetail)(
          await getJson(`/v1/matches/${m.match_id}`),
        ),
      ).toEqual(details[i]);
    }
  });

  it('a later rated match of a banned name stays hidden', async () => {
    await seed();
    await banned('Bob');
    await record({
      players: ['bob', 'Erin'],
      ended_at: '2026-10-18T11:00:00.000Z',
    });
    const names = (await leaderboard()).map(e => e.name);
    expect(names).toContain('Erin');
    expect(names).not.toContain('Bob');
    expect(names.map(n => n.toLowerCase())).not.toContain('bob');
  });
});
