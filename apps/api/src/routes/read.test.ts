// T07: the read endpoints answer from D1 (casino-api skill: 資料與積分, A13).
import { createHash } from 'node:crypto';
import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { Leaderboard, MatchDetail, MatchList } from '../contract/schemas';
import { type MatchRecordInput, recordMatch } from '../db/records';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { randomAction } from '../holdem/bot';
import {
  applyAction,
  type HandRecord,
  legalActions,
  type MatchState,
  startMatch,
} from '../holdem/match';
import { dealHand, mulberry32 } from '../holdem/shuffle';
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

const makeEnv = (db: unknown): Bindings =>
  ({
    TOKEN_SECRET: 'test-token-secret',
    ADMIN_KEY: 'test-admin-key',
    DB: db,
    ROOM: {},
    MATCHMAKER: {},
  }) as unknown as Bindings;

const get = (path: string, env: Bindings = makeEnv(testD1.d1)) =>
  handle(new Request(`http://api.test${path}`), env);

const getJson = async (path: string): Promise<unknown> => {
  const response = await get(path);
  expect(response.status).toBe(200);
  return response.json();
};

const leaderboard = async () =>
  Schema.decodeUnknownSync(Leaderboard)(await getJson('/v1/leaderboard'));

const matchList = async (query = '') =>
  Schema.decodeUnknownSync(MatchList)(await getJson(`/v1/matches${query}`));

const matchDetail = async (id: string) =>
  Schema.decodeUnknownSync(MatchDetail)(await getJson(`/v1/matches/${id}`));

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

/** Independent of elo.ts: the casino-api formula, K = 32. */
function elo(a: number, b: number, scoreA: number): [number, number] {
  const delta = 32 * (scoreA - 1 / (1 + 10 ** ((b - a) / 400)));
  return [a + delta, b - delta];
}

let matchCounter = 0;
const nextMatchId = () => `r_${String(++matchCounter).padStart(10, '0')}`;

function hand(
  handNumber: number,
  overrides: Partial<HandRecord> = {},
): HandRecord {
  return {
    hand_number: handNumber,
    button_seat: handNumber % 2 === 1 ? 0 : 1,
    blinds: [1, 2],
    winner_seat: 0,
    pot: 8,
    ended_by: 'showdown',
    board: ['As', 'Kd', '7h', '2c', '9s'],
    hole_cards: [
      ['Qs', 'Qh'],
      ['Jd', 'Jc'],
    ],
    stacks: [204, 196],
    events: [
      { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
      { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
      { seat: 0, street: 'preflop', type: 'raise', amount: 4 },
      { seat: 1, street: 'preflop', type: 'call', amount: 2 },
      { seat: 1, street: 'flop', type: 'check' },
      { seat: 0, street: 'flop', type: 'check', timeout: true },
    ],
    ...overrides,
  };
}

/** A fixed 64-hex match seed derived from a label. */
const hexSeed = (label: string) =>
  createHash('sha256').update(label).digest('hex');

const RECORDED_SEED = hexSeed('recorded');

function input(overrides: Partial<MatchRecordInput> = {}): MatchRecordInput {
  return {
    match_id: nextMatchId(),
    players: ['Alice', 'Bob'],
    settings: {
      max_hands: 2,
      turn_seconds: 30,
      blind_every: 50,
      starting_stack: 200,
    },
    seed: RECORDED_SEED,
    result: 'seat0_win',
    ended_at: '2026-10-18T10:00:00.000Z',
    final_stacks: [300, 100],
    hands: [hand(1), hand(2)],
    ...overrides,
  };
}

const record = async (overrides: Partial<MatchRecordInput> = {}) => {
  const match = input(overrides);
  await recordMatch(testD1.db, match);
  return match;
};

/** A whole match played by the engine with random legal actions. */
function playedMatch(seed: number, hands: number): MatchRecordInput {
  const random = mulberry32(seed + 1);
  const hexed = hexSeed(`played-${seed}`);
  let state: MatchState = startMatch({
    seed: hexed,
    maxHands: hands,
    blindEvery: 50,
    startingStack: 200,
  });
  const finished: HandRecord[] = [];
  while (!state.over) {
    const seat = state.toAct;
    if (seat === null) throw new Error('nobody to act');
    const result = applyAction(
      state,
      seat,
      randomAction(legalActions(state), random),
    );
    if (!result.ok) throw new Error(result.message);
    finished.push(...result.finishedHands);
    state = result.state;
  }
  const [s0, s1] = state.stacks;
  return input({
    seed: hexed,
    settings: {
      max_hands: hands,
      turn_seconds: 30,
      blind_every: 50,
      starting_stack: 200,
    },
    result: s0 > s1 ? 'seat0_win' : s1 > s0 ? 'seat1_win' : 'draw',
    final_stacks: [s0, s1],
    hands: finished,
  });
}

const minutes = (n: number) =>
  new Date(Date.UTC(2026, 9, 18, 10, n)).toISOString();

describe('GET /v1/leaderboard', () => {
  it('is empty before any rated match', async () => {
    expect(await leaderboard()).toEqual({ entries: [] });
  });

  it('lists both players of a rated match with their counts', async () => {
    await record();
    expect((await leaderboard()).entries).toEqual([
      {
        rank: 1,
        name: 'Alice',
        rating: 1516,
        games: 1,
        wins: 1,
        losses: 0,
        draws: 0,
      },
      {
        rank: 2,
        name: 'Bob',
        rating: 1484,
        games: 1,
        wins: 0,
        losses: 1,
        draws: 0,
      },
    ]);
  });

  it('counts draws', async () => {
    await record({ result: 'draw', final_stacks: [200, 200] });
    const entries = (await leaderboard()).entries;
    expect(entries.map(e => [e.name, e.rating, e.games, e.draws])).toEqual([
      ['Alice', 1500, 1, 1],
      ['Bob', 1500, 1, 1],
    ]);
  });

  it('breaks rating ties by lowercase name', async () => {
    await record({
      players: ['Bob', 'alice'],
      result: 'draw',
      final_stacks: [200, 200],
    });
    await record({
      players: ['Carol', 'dave'],
      result: 'draw',
      final_stacks: [200, 200],
    });
    const entries = (await leaderboard()).entries;
    expect(entries.map(e => [e.rank, e.name])).toEqual([
      [1, 'alice'],
      [2, 'Bob'],
      [3, 'Carol'],
      [4, 'dave'],
    ]);
  });

  it('rounds ratings to integers and sorts by rating', async () => {
    await record({ players: ['Alice', 'Bob'] });
    await record({ players: ['Alice', 'Carol'] });
    const [alice, carol] = elo(1516, 1500, 1);
    const entries = (await leaderboard()).entries;
    expect(entries.map(e => [e.rank, e.name, e.rating, e.games])).toEqual([
      [1, 'Alice', Math.round(alice), 2],
      [2, 'Carol', Math.round(carol), 1],
      [3, 'Bob', 1484, 1],
    ]);
  });

  it('shows the first spelling of a name', async () => {
    await record({ players: ['Alice', 'Bob'] });
    await record({ players: ['ALICE', 'bob'] });
    const entries = (await leaderboard()).entries;
    expect(entries.map(e => [e.name, e.games])).toEqual([
      ['Alice', 2],
      ['Bob', 2],
    ]);
  });

  it('leaves out house-bot and players of unrated matches only', async () => {
    await record({ players: ['Alice', 'house-bot'] });
    await record({ players: ['house-bot', 'Bob'], result: 'seat1_win' });
    await record({ players: ['Carol', 'Dave'], result: 'void' });
    await record({ players: ['Erin', 'Frank'], result: 'cancelled' });
    expect(await leaderboard()).toEqual({ entries: [] });
  });

  it('lists at most 100 entries, ranked 1 to 100', async () => {
    for (let i = 0; i < 51; i++) {
      const n = String(i).padStart(2, '0');
      await record({ players: [`w${n}`, `l${n}`], hands: [hand(1)] });
    }
    const entries = (await leaderboard()).entries;
    expect(entries).toHaveLength(100);
    expect(entries.map(e => e.rank)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    const names = (prefix: string, count: number) =>
      Array.from(
        { length: count },
        (_, i) => `${prefix}${String(i).padStart(2, '0')}`,
      );
    expect(entries.map(e => e.name)).toEqual([
      ...names('w', 51),
      ...names('l', 49),
    ]);
  }, 30_000);
});

describe('GET /v1/matches', () => {
  it('is empty before any match', async () => {
    expect(await matchList()).toEqual({ matches: [], next: null });
  });

  it('lists every recorded match, rated or not', async () => {
    const rated = await record({ ended_at: minutes(5) });
    const bot = await record({
      players: ['carol', 'house-bot'],
      ended_at: minutes(4),
    });
    const voided = await record({ result: 'void', ended_at: minutes(3) });
    const cancelled = await record({
      players: ['ALICE', 'dave'],
      result: 'cancelled',
      ended_at: minutes(2),
      hands: [],
    });
    expect(await matchList()).toEqual({
      matches: [
        {
          match_id: rated.match_id,
          players: ['Alice', 'Bob'],
          result: 'seat0_win',
          ended_at: minutes(5),
          rated: true,
        },
        {
          match_id: bot.match_id,
          players: ['carol', 'house-bot'],
          result: 'seat0_win',
          ended_at: minutes(4),
          rated: false,
        },
        {
          match_id: voided.match_id,
          players: ['Alice', 'Bob'],
          result: 'void',
          ended_at: minutes(3),
          rated: false,
        },
        {
          match_id: cancelled.match_id,
          players: ['ALICE', 'dave'],
          result: 'cancelled',
          ended_at: minutes(2),
          rated: false,
        },
      ],
      next: null,
    });
  });

  it('shows players as typed in each match', async () => {
    await record({ players: ['Alice', 'Bob'], ended_at: minutes(1) });
    await record({ players: ['bob', 'ALICE'], ended_at: minutes(2) });
    const { matches } = await matchList();
    expect(matches.map(m => m.players)).toEqual([
      ['bob', 'ALICE'],
      ['Alice', 'Bob'],
    ]);
  });

  it('orders newest first, ties by match_id descending', async () => {
    const a = await record({ ended_at: minutes(1) });
    const b = await record({ ended_at: minutes(3) });
    const c = await record({ ended_at: minutes(1) });
    const d = await record({ ended_at: minutes(2) });
    const { matches } = await matchList();
    expect(matches.map(m => m.match_id)).toEqual([
      b.match_id,
      d.match_id,
      c.match_id,
      a.match_id,
    ]);
  });

  describe('pages of 20', () => {
    const seed = async (count: number) => {
      const recorded: MatchRecordInput[] = [];
      for (let i = 0; i < count; i++) {
        recorded.push(
          await record({ ended_at: minutes((i * 7) % 11), hands: [hand(1)] }),
        );
      }
      return recorded
        .sort(
          (x, y) =>
            y.ended_at.localeCompare(x.ended_at) ||
            y.match_id.localeCompare(x.match_id),
        )
        .map(m => m.match_id);
    };

    it('following next visits every match once, in order', async () => {
      const expected = await seed(45);
      const pages: MatchList[] = [];
      let query = '';
      for (;;) {
        const page = await matchList(query);
        pages.push(page);
        if (page.next === null) break;
        expect(pages.length).toBeLessThan(10);
        query = `?before=${page.next}`;
      }
      expect(pages.map(p => p.matches.length)).toEqual([20, 20, 5]);
      expect(pages.map(p => p.next)).toEqual([
        expected[19],
        expected[39],
        null,
      ]);
      expect(pages.flatMap(p => p.matches.map(m => m.match_id))).toEqual(
        expected,
      );
    }, 30_000);

    it('next is null when exactly 20 matches exist', async () => {
      const expected = await seed(20);
      const page = await matchList();
      expect(page.matches.map(m => m.match_id)).toEqual(expected);
      expect(page.next).toBeNull();
    }, 30_000);

    it('next is set when 21 matches exist', async () => {
      const expected = await seed(21);
      const first = await matchList();
      expect(first.next).toBe(expected[19]);
      const second = await matchList(`?before=${first.next}`);
      expect(second).toEqual({
        matches: [expect.objectContaining({ match_id: expected[20] })],
        next: null,
      });
    }, 30_000);

    it('before lists the matches strictly after that one', async () => {
      const expected = await seed(30);
      const page = await matchList(`?before=${expected[4]}`);
      expect(page.matches.map(m => m.match_id)).toEqual(expected.slice(5, 25));
      expect(page.next).toBe(expected[24]);
    }, 30_000);

    it('before the oldest match is an empty last page', async () => {
      const expected = await seed(3);
      expect(await matchList(`?before=${expected[2]}`)).toEqual({
        matches: [],
        next: null,
      });
    });
  });

  it.each(['abc', 'r_ABCDE12345', 'r_abc', 'r_abcde123456', ''])(
    'before=%j (malformed) answers 400 invalid_request',
    async before => {
      await record();
      const body = await expectError(
        await get(`/v1/matches?before=${encodeURIComponent(before)}`),
        400,
        'invalid_request',
      );
      expect(body.retryable).toBe(false);
    },
  );

  it('before naming no recorded match answers 400 invalid_request', async () => {
    await record();
    await expectError(
      await get('/v1/matches?before=r_zzzzzzzzzz'),
      400,
      'invalid_request',
    );
  });
});

describe('GET /v1/matches/{match_id}', () => {
  it('returns the whole record of a rated match', async () => {
    const match = await record({
      players: ['Alice', 'bob'],
      settings: {
        max_hands: 2,
        turn_seconds: 45,
        blind_every: 50,
        starting_stack: 200,
      },
      ended_at: '2026-10-18T10:31:07.250Z',
    });
    expect(await matchDetail(match.match_id)).toStrictEqual({
      match_id: match.match_id,
      players: ['Alice', 'bob'],
      settings: {
        max_hands: 2,
        turn_seconds: 45,
        blind_every: 50,
        starting_stack: 200,
      },
      seed: RECORDED_SEED,
      result: 'seat0_win',
      rated: true,
      ended_at: '2026-10-18T10:31:07.250Z',
      final_stacks: [300, 100],
      rating_changes: [
        { name: 'Alice', before: 1500, after: 1516 },
        { name: 'bob', before: 1500, after: 1484 },
      ],
      hands: [hand(1), hand(2)],
    });
  });

  it('keeps events in order, amount and timeout only where set', async () => {
    const match = await record({ hands: [hand(1)] });
    const [first] = (await matchDetail(match.match_id)).hands;
    expect(first?.events).toStrictEqual([
      { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
      { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
      { seat: 0, street: 'preflop', type: 'raise', amount: 4 },
      { seat: 1, street: 'preflop', type: 'call', amount: 2 },
      { seat: 1, street: 'flop', type: 'check' },
      { seat: 0, street: 'flop', type: 'check', timeout: true },
    ]);
  });

  it('reconstructs folded hole cards from the seed and preserves stored showdown cards', async () => {
    const folded = hand(2, {
      ended_by: 'fold',
      board: [],
      blinds: [1, 2],
      winner_seat: 1,
      pot: 2,
      stacks: [199, 201],
      events: [
        { seat: 1, street: 'preflop', type: 'post_blind', amount: 1 },
        { seat: 0, street: 'preflop', type: 'post_blind', amount: 2 },
        { seat: 1, street: 'preflop', type: 'fold', timeout: true },
      ],
    });
    const match = await record({ hands: [hand(1), folded, hand(3)] });
    const { hands } = await matchDetail(match.match_id);
    expect(hands.map(h => [h.hand_number, h.ended_by, h.hole_cards])).toEqual([
      [1, 'showdown', hand(1).hole_cards],
      [2, 'fold', dealHand(match.seed, 2).holeCards],
      [3, 'showdown', hand(3).hole_cards],
    ]);
    expect(hands[1]).toStrictEqual({
      ...folded,
      hole_cards: dealHand(match.seed, 2).holeCards,
    });
  });

  it('returns the hands of a match played by the engine', async () => {
    const match = playedMatch(11, 30);
    await recordMatch(testD1.db, match);
    const detail = await matchDetail(match.match_id);
    expect(detail.seed).toBe(match.seed);
    const expected = (
      JSON.parse(JSON.stringify(match.hands)) as HandRecord[]
    ).map(h => ({
      ...h,
      hole_cards: dealHand(match.seed, h.hand_number).holeCards,
    }));
    expect(match.hands.some(h => h.ended_by === 'fold')).toBe(true);
    expect(match.hands.some(h => h.ended_by === 'showdown')).toBe(true);
    expect(detail.hands).toStrictEqual(expected);
  });

  it('rating_changes are integers carried over from earlier matches', async () => {
    await record({ players: ['Alice', 'Bob'] });
    const second = await record({
      players: ['carol', 'ALICE'],
      result: 'seat1_win',
    });
    const [carol, alice] = elo(1500, 1516, 0);
    const detail = await matchDetail(second.match_id);
    expect(detail.players).toEqual(['carol', 'ALICE']);
    expect(detail.rating_changes).toEqual([
      { name: 'carol', before: 1500, after: Math.round(carol) },
      { name: 'Alice', before: 1516, after: Math.round(alice) },
    ]);
  });

  it.each([
    ['a house-bot match', { players: ['Alice', 'house-bot'] }],
    ['a void match', { result: 'void' }],
    ['a cancelled match', { result: 'cancelled', hands: [] }],
  ] as const)('%s is unrated with null rating_changes', async (_label, o) => {
    const match = await record(o as Partial<MatchRecordInput>);
    const detail = await matchDetail(match.match_id);
    expect(detail.rated).toBe(false);
    expect(detail.rating_changes).toBeNull();
    expect(detail.result).toBe(match.result);
    expect(detail.hands).toHaveLength(match.hands.length);
  });

  it.each(['r_zzzzzzzzzz', 'nope', 'r_ABCDE12345'])(
    '%s answers 404 room_not_found',
    async id => {
      await record();
      await expectError(await get(`/v1/matches/${id}`), 404, 'room_not_found');
    },
  );
});

describe('a broken D1 answers 503 unavailable', () => {
  it.each([
    '/v1/leaderboard',
    '/v1/matches',
    '/v1/matches?before=r_0000000001',
    '/v1/matches/r_0000000001',
  ])('GET %s', async path => {
    const body = await expectError(
      await get(path, makeEnv({})),
      503,
      'unavailable',
    );
    expect(body.retryable).toBe(true);
  });
});

describe('a D1 network error answers 503 unavailable', () => {
  it.each([
    '/v1/leaderboard',
    '/v1/matches',
    '/v1/matches?before=r_0000000001',
    '/v1/matches/r_0000000001',
  ])('GET %s', async path => {
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
      await get(path, makeEnv(db)),
      503,
      'unavailable',
    );
    expect(body.retryable).toBe(true);
  });
});

describe('T34 freezeout match records', () => {
  it('returns blinds for every new hand from its hand number and blind interval', async () => {
    const match = await record({
      settings: {
        starting_stack: 200,
        blind_every: 2,
        max_hands: 4,
        turn_seconds: 30,
      },
      hands: [
        hand(1),
        hand(2),
        hand(3, { blinds: [2, 4] }),
        hand(4, { blinds: [2, 4] }),
      ],
    });
    const detail = await matchDetail(match.match_id);
    expect(detail.settings).toEqual(match.settings);
    expect(detail.hands.map(h => h.blinds)).toEqual([
      [1, 2],
      [1, 2],
      [2, 4],
      [2, 4],
    ]);
  });

  it('decodes an old D1 record with hands settings as fixed 1/2 blinds', async () => {
    // Persist the same tables/hand rows as production, then replace the match
    // row directly through D1 so the writer cannot normalize the old JSON.
    const match = await record();
    const stored = await testD1.d1
      .prepare('SELECT * FROM matches')
      .first<Record<string, unknown>>();
    if (stored === null) throw new Error('Expected a stored match row');
    const legacy = {
      ...stored,
      settings: JSON.stringify({
        hands: 2,
        turn_seconds: 30,
        starting_stack: 200,
      }),
    };
    const columns = Object.keys(legacy);
    await testD1.d1
      .prepare(
        `INSERT OR REPLACE INTO matches (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .bind(...columns.map(c => legacy[c as keyof typeof legacy]))
      .run();
    const response = await get(`/v1/matches/${match.match_id}`);
    expect(response.status).toBe(200);
    const raw = await response.json();
    const detail = Schema.decodeUnknownSync(MatchDetail)(raw);
    expect(detail.settings).toEqual({
      starting_stack: 200,
      blind_every: null,
      max_hands: 2,
      turn_seconds: 30,
    });
    expect(detail.hands).toHaveLength(2);
    for (const hand of detail.hands) expect(hand.blinds).toEqual([1, 2]);
  });
});
