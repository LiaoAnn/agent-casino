import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { handle } from '../app';
import { randomAction } from '../holdem/bot';
import {
  applyAction,
  type HandRecord,
  type HistoryEvent,
  legalActions,
  type MatchState,
  startMatch,
} from '../holdem/match';
import { dealHand, mulberry32 } from '../holdem/shuffle';
import type { Bindings } from '../routes/env';
import { openDb } from './client';
import { getMatch } from './queries';
import { type MatchRecordInput, recordMatch } from './records';
import { matchEvents } from './schema';
import { startTestD1, type TestD1 } from './test-d1';

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

/** Independent of elo.ts: the casino-api formula, K = 32. */
function elo(a: number, b: number, scoreA: number): [number, number] {
  const delta = 32 * (scoreA - 1 / (1 + 10 ** ((b - a) / 400)));
  return [a + delta, b - delta];
}

let matchCounter = 0;
const nextMatchId = () => `r_${String(++matchCounter).padStart(10, '0')}`;

function hand(handNumber: number, eventCount = 8): HandRecord {
  const small = 2 ** Math.floor((handNumber - 1) / 50);
  const events: HistoryEvent[] = [
    { seat: 0, street: 'preflop', type: 'post_blind', amount: small },
    { seat: 1, street: 'preflop', type: 'post_blind', amount: small * 2 },
  ];
  while (events.length < eventCount) {
    events.push({
      seat: events.length % 2 === 0 ? 0 : 1,
      street: 'flop',
      type: 'check',
    });
  }
  return {
    hand_number: handNumber,
    button_seat: handNumber % 2 === 1 ? 0 : 1,
    blinds: [small, small * 2],
    winner_seat: null,
    pot: 4,
    ended_by: 'showdown',
    board: ['As', 'Kd', '7h', '2c', '9s'],
    hole_cards: [
      ['Qs', 'Qh'],
      ['Qd', 'Qc'],
    ],
    stacks: [200, 200],
    events,
  };
}

function input(overrides: Partial<MatchRecordInput> = {}): MatchRecordInput {
  return {
    match_id: nextMatchId(),
    players: ['Alice', 'Bob'],
    settings: {
      max_hands: 3,
      turn_seconds: 30,
      blind_every: 50,
      starting_stack: 200,
    },
    seed: '9f3c2a7e5b1d4f60c8a2e7b3d9f1c5a04e6b8d2f7a3c9e1b5d0f4a8c2e6b7d39',
    result: 'seat0_win',
    ended_at: '2026-10-18T10:00:00.000Z',
    final_stacks: [300, 100],
    hands: [hand(1), hand(2), hand(3)],
    ...overrides,
  };
}

/** A whole match played by the engine with random legal actions. */
function playedHands(seed: number, hands: number): MatchRecordInput {
  const random = mulberry32(seed + 1);
  const hexed = createHash('sha256').update(`played-${seed}`).digest('hex');
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

describe('recordMatch: first rated match', () => {
  it('starts both new names at 1500 and gives the winner +16', async () => {
    const result = await recordMatch(testD1.db, input());
    expect(result).toEqual({
      rated: true,
      ratings: [
        { name: 'Alice', rating: 1516, change: 16 },
        { name: 'Bob', rating: 1484, change: -16 },
      ],
    });
  });

  it('rates seat1_win from the seat perspective', async () => {
    const result = await recordMatch(
      testD1.db,
      input({ result: 'seat1_win', final_stacks: [100, 300] }),
    );
    expect(result).toEqual({
      rated: true,
      ratings: [
        { name: 'Alice', rating: 1484, change: -16 },
        { name: 'Bob', rating: 1516, change: 16 },
      ],
    });
  });

  it('leaves equal ratings unchanged on a draw', async () => {
    const result = await recordMatch(
      testD1.db,
      input({ result: 'draw', final_stacks: [200, 200] }),
    );
    expect(result).toEqual({
      rated: true,
      ratings: [
        { name: 'Alice', rating: 1500, change: 0 },
        { name: 'Bob', rating: 1500, change: 0 },
      ],
    });
  });

  it('records a match played by the engine', async () => {
    const match = playedHands(7, 20);
    const result = await recordMatch(testD1.db, match);
    expect(result.rated).toBe(true);
    expect(result.ratings?.map(r => r.name)).toEqual(['Alice', 'Bob']);
  });
});

describe('recordMatch: ratings carry over', () => {
  it('uses the previous ratings in the next match', async () => {
    await recordMatch(testD1.db, input());
    const [a, b] = elo(1516, 1484, 1);
    const result = await recordMatch(testD1.db, input());
    expect(result).toEqual({
      rated: true,
      ratings: [
        { name: 'Alice', rating: Math.round(a), change: Math.round(a) - 1516 },
        { name: 'Bob', rating: Math.round(b), change: Math.round(b) - 1484 },
      ],
    });
    expect(result.ratings).toEqual([
      { name: 'Alice', rating: 1531, change: 15 },
      { name: 'Bob', rating: 1469, change: -15 },
    ]);
  });

  it('moves unequal ratings toward each other on a draw', async () => {
    await recordMatch(testD1.db, input());
    const result = await recordMatch(
      testD1.db,
      input({ result: 'draw', final_stacks: [200, 200] }),
    );
    expect(result.ratings).toEqual([
      { name: 'Alice', rating: 1515, change: -1 },
      { name: 'Bob', rating: 1485, change: 1 },
    ]);
  });

  it('carries over across seats', async () => {
    await recordMatch(testD1.db, input());
    const [b, a] = elo(1484, 1516, 1);
    const result = await recordMatch(
      testD1.db,
      input({ players: ['Bob', 'Alice'], final_stacks: [300, 100] }),
    );
    expect(result.ratings).toEqual([
      { name: 'Bob', rating: Math.round(b), change: Math.round(b) - 1484 },
      { name: 'Alice', rating: Math.round(a), change: Math.round(a) - 1516 },
    ]);
  });

  it('keys names case-insensitively and keeps the first spelling', async () => {
    await recordMatch(testD1.db, input());
    const [a, c] = elo(1516, 1500, 1);
    const result = await recordMatch(
      testD1.db,
      input({ players: ['ALICE', 'Carol'] }),
    );
    expect(result).toEqual({
      rated: true,
      ratings: [
        { name: 'Alice', rating: Math.round(a), change: Math.round(a) - 1516 },
        { name: 'Carol', rating: Math.round(c), change: Math.round(c) - 1500 },
      ],
    });
  });

  it('carries a new player’s first spelling into later matches', async () => {
    await recordMatch(testD1.db, input({ players: ['Alice', 'bOb'] }));
    const result = await recordMatch(
      testD1.db,
      input({ players: ['alice', 'BOB'] }),
    );
    expect(result.ratings?.map(r => r.name)).toEqual(['Alice', 'bOb']);
    expect(result.ratings?.map(r => r.change)).toEqual([15, -15]);
  });
});

describe('recordMatch: unrated matches', () => {
  const unrated: [string, Partial<MatchRecordInput>][] = [
    ['house-bot in seat 1', { players: ['Alice', 'house-bot'] }],
    ['house-bot in seat 0', { players: ['house-bot', 'Bob'] }],
    ['house-bot in another case', { players: ['Alice', 'House-Bot'] }],
    ['a void match', { result: 'void', final_stacks: [200, 200] }],
    ['a cancelled match', { result: 'cancelled', final_stacks: [200, 200] }],
  ];

  for (const [label, overrides] of unrated) {
    it(`does not rate ${label}`, async () => {
      expect(await recordMatch(testD1.db, input(overrides))).toEqual({
        rated: false,
        ratings: null,
      });
      const next = await recordMatch(testD1.db, input());
      expect(next.ratings).toEqual([
        { name: 'Alice', rating: 1516, change: 16 },
        { name: 'Bob', rating: 1484, change: -16 },
      ]);
    });
  }

  it('does not change an existing rating', async () => {
    await recordMatch(testD1.db, input());
    expect(
      await recordMatch(
        testD1.db,
        input({ players: ['house-bot', 'Alice'], result: 'seat0_win' }),
      ),
    ).toEqual({ rated: false, ratings: null });
    expect(
      await recordMatch(
        testD1.db,
        input({ result: 'void', final_stacks: [200, 200] }),
      ),
    ).toEqual({ rated: false, ratings: null });
    const result = await recordMatch(testD1.db, input());
    expect(result.ratings).toEqual([
      { name: 'Alice', rating: 1531, change: 15 },
      { name: 'Bob', rating: 1469, change: -15 },
    ]);
  });
});

describe('recordMatch: retries', () => {
  it('returns the first result and counts a retried match once', async () => {
    const match = input();
    const first = await recordMatch(testD1.db, match);
    const retry = await recordMatch(testD1.db, match);
    expect(retry).toEqual(first);
    expect(retry.ratings).toEqual([
      { name: 'Alice', rating: 1516, change: 16 },
      { name: 'Bob', rating: 1484, change: -16 },
    ]);
    const next = await recordMatch(testD1.db, input());
    expect(next.ratings).toEqual([
      { name: 'Alice', rating: 1531, change: 15 },
      { name: 'Bob', rating: 1469, change: -15 },
    ]);
  });

  it('returns the first result when retried after later matches', async () => {
    const match = input();
    const first = await recordMatch(testD1.db, match);
    await recordMatch(testD1.db, input());
    expect(await recordMatch(testD1.db, match)).toEqual(first);
    const next = await recordMatch(
      testD1.db,
      input({ result: 'draw', final_stacks: [200, 200] }),
    );
    const [a, b] = elo(1531, 1469, 0.5);
    expect(next.ratings).toEqual([
      { name: 'Alice', rating: Math.round(a), change: Math.round(a) - 1531 },
      { name: 'Bob', rating: Math.round(b), change: Math.round(b) - 1469 },
    ]);
  });

  it('retries an unrated match without rating it', async () => {
    const match = input({ result: 'void', final_stacks: [200, 200] });
    await recordMatch(testD1.db, match);
    expect(await recordMatch(testD1.db, match)).toEqual({
      rated: false,
      ratings: null,
    });
  });
});

describe('recordMatch: long matches', () => {
  it('preserves every hand and event of a 100-hand match after a retry', async () => {
    const hands = Array.from({ length: 100 }, (_, i) => {
      const current = hand(i + 1, 8 + (i % 5));
      current.events[2] = {
        seat: i % 2 === 0 ? 0 : 1,
        street: 'preflop',
        type: 'raise',
        amount: 4 + i,
        timeout: true,
      };
      if (i % 3 === 0) {
        current.ended_by = 'fold';
        current.winner_seat = 1;
        current.events.push({ seat: 0, street: 'flop', type: 'fold' });
      }
      return current;
    });
    const match = input({
      seed: '2a'.repeat(32),
      settings: {
        max_hands: 100,
        turn_seconds: 30,
        blind_every: 50,
        starting_stack: 200,
      },
      hands,
    });
    const expected = hands.map(h => ({
      ...h,
      pots: [
        {
          amount: h.pot,
          winner_seats: h.winner_seat === null ? [0, 1] : [h.winner_seat],
        },
      ],
      hole_cards:
        h.ended_by === 'fold'
          ? dealHand(match.seed, h.hand_number).holeCards
          : h.hole_cards,
    }));

    const result = await recordMatch(testD1.db, match);
    const stored = await getMatch(testD1.db, match.match_id);
    expect(stored?.hands).toStrictEqual(expected);

    expect(await recordMatch(testD1.db, match)).toEqual(result);
    const retried = await getMatch(testD1.db, match.match_id);
    expect(retried?.hands).toStrictEqual(expected);
    expect(retried).toStrictEqual(stored);
  }, 30_000);

  it('stores 100 hands with 8 events each', async () => {
    const hands = Array.from({ length: 100 }, (_, i) => hand(i + 1, 8));
    const match = input({
      settings: {
        max_hands: 100,
        turn_seconds: 30,
        blind_every: 50,
        starting_stack: 200,
      },
      hands,
    });
    const result = await recordMatch(testD1.db, match);
    expect(result.ratings).toEqual([
      { name: 'Alice', rating: 1516, change: 16 },
      { name: 'Bob', rating: 1484, change: -16 },
    ]);
    expect(await recordMatch(testD1.db, match)).toEqual(result);
  }, 30_000);

  it('stores a 100-hand match played by the engine', async () => {
    const match = playedHands(11, 100);
    const result = await recordMatch(testD1.db, match);
    expect(result.rated).toBe(true);
    const detail = await getMatch(testD1.db, match.match_id);
    expect(detail).not.toBeNull();
    expect(match.hands.some(h => h.ended_by === 'fold')).toBe(true);
    expect(match.hands.some(h => h.ended_by === 'showdown')).toBe(true);
    expect(detail?.hands).toStrictEqual(
      (JSON.parse(JSON.stringify(match.hands)) as HandRecord[]).map(hand => ({
        ...hand,
        pots: [
          {
            amount: hand.pot,
            winner_seats:
              hand.winner_seat === null ? [0, 1] : [hand.winner_seat],
          },
        ],
        hole_cards: dealHand(match.seed, hand.hand_number).holeCards,
      })),
    );
  }, 30_000);
});

describe('recordMatch: agent notes (A16)', () => {
  const NOTES = [
    { hand_number: 1, seq: 2, note: 'first note' },
    { hand_number: 1, seq: 3, note: 'second note' },
    { hand_number: 3, seq: 7, note: 'last step of the match' },
  ];

  const eventRows = async (matchId: string) =>
    testD1.db
      .select()
      .from(matchEvents)
      .where(eq(matchEvents.matchId, matchId));

  it('stores each note on the match_events row of its hand and seq, and no other row has one', async () => {
    const match = input({ notes: NOTES });
    await recordMatch(testD1.db, match);
    const rows = await eventRows(match.match_id);
    expect(rows).toHaveLength(24);
    expect(
      rows
        .filter(row => row.note !== null)
        .map(row => ({
          hand_number: row.handNumber,
          seq: row.seq,
          note: row.note,
        }))
        .sort((a, b) => a.hand_number - b.hand_number || a.seq - b.seq),
    ).toEqual(NOTES);
    // The note sits with the step it explains.
    const second = rows.find(row => row.handNumber === 1 && row.seq === 3);
    expect(second).toMatchObject({ seat: 1, type: 'check' });
  });

  it('stores null notes when the match has none, or an empty list', async () => {
    const plain = input();
    const empty = input({ notes: [] });
    await recordMatch(testD1.db, plain);
    await recordMatch(testD1.db, empty);
    for (const match of [plain, empty]) {
      const rows = await eventRows(match.match_id);
      expect(rows).toHaveLength(24);
      expect(rows.every(row => row.note === null)).toBe(true);
    }
  });

  it('keeps a long note and non-ASCII text unchanged', async () => {
    const note = `${'牌桌上的想法 '.repeat(70)}end`.slice(0, 500);
    const match = input({ notes: [{ hand_number: 2, seq: 4, note }] });
    await recordMatch(testD1.db, match);
    const row = (await eventRows(match.match_id)).find(
      entry => entry.handNumber === 2 && entry.seq === 4,
    );
    expect(row?.note).toBe(note);
  });

  it('getMatch gives the same record with or without notes: no note anywhere', async () => {
    const withNotes = input({ notes: NOTES });
    const without = input({ match_id: nextMatchId() });
    await recordMatch(testD1.db, withNotes);
    await recordMatch(testD1.db, without);
    const stored = await getMatch(testD1.db, withNotes.match_id);
    const plain = await getMatch(testD1.db, without.match_id);
    expect(stored).not.toBeNull();
    expect(stored?.hands).toStrictEqual(plain?.hands);
    const text = JSON.stringify(stored);
    for (const entry of NOTES) expect(text).not.toContain(entry.note);
    for (const hand of stored?.hands ?? []) {
      for (const event of hand.events) expect(event).not.toHaveProperty('note');
    }
  });

  it('a retried recordMatch keeps the notes once', async () => {
    const match = input({ notes: NOTES });
    const first = await recordMatch(testD1.db, match);
    expect(await recordMatch(testD1.db, match)).toEqual(first);
    const rows = await eventRows(match.match_id);
    expect(rows).toHaveLength(24);
    expect(rows.filter(row => row.note !== null)).toHaveLength(NOTES.length);
  });
});

describe('T35 display name storage', () => {
  it('writes per-seat names and updates the latest display name without replacing the identity spelling', async () => {
    const first = input({
      players: ['Alice', 'Bob'],
      display_names: ['小愛 A', '小包 A'],
    });
    await recordMatch(testD1.db, first);
    expect(
      await testD1.d1
        .prepare('SELECT display0, display1 FROM matches WHERE match_id = ?')
        .bind(first.match_id)
        .first(),
    ).toEqual({ display0: '小愛 A', display1: '小包 A' });
    const second = input({
      players: ['ALICE', 'bOB'],
      display_names: ['小愛 B 🃏', '小包 B 🎲'],
      ended_at: '2026-10-18T11:00:00.000Z',
    });
    await recordMatch(testD1.db, second);
    expect(
      await testD1.d1
        .prepare('SELECT display0, display1 FROM matches WHERE match_id = ?')
        .bind(first.match_id)
        .first(),
    ).toEqual({ display0: '小愛 A', display1: '小包 A' });
    expect(
      await testD1.d1
        .prepare('SELECT display0, display1 FROM matches WHERE match_id = ?')
        .bind(second.match_id)
        .first(),
    ).toEqual({ display0: '小愛 B 🃏', display1: '小包 B 🎲' });
    const rows = await testD1.d1
      .prepare(
        'SELECT name, display_name, games FROM ratings ORDER BY name_key',
      )
      .all();
    expect(rows.results).toEqual([
      { name: 'Alice', display_name: '小愛 B 🃏', games: 2 },
      { name: 'Bob', display_name: '小包 B 🎲', games: 2 },
    ]);
  });
});

describe('T44 persisted match end reasons', () => {
  it('migration 0004 keeps a pre-existing busted match null without backfilling a guessed reason', async () => {
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(
        new URL('./migrations', import.meta.url).href,
      ),
    });
    const addition = migrations[4];
    expect(addition, 'the generated 0004 migration must exist').toBeDefined();
    if (addition === undefined) throw new Error('Missing migration 0004');

    // Obtain an old-format row through the existing recorder API, then put it
    // in a separate database migrated only through 0003 before applying 0004.
    const match = input({ hands: [], final_stacks: [400, 0] });
    await recordMatch(testD1.db, match);
    const source = await testD1.d1
      .prepare('SELECT * FROM matches WHERE match_id = ?')
      .bind(match.match_id)
      .first();
    if (source === null) throw new Error('Missing fixture row');
    const columns = Object.keys(source).filter(key => key !== 'end_reason');
    const proxy = await getPlatformProxy<{ DB: D1Database }>({
      configPath: fileURLToPath(
        new URL('../../wrangler.jsonc', import.meta.url).href,
      ),
      persist: false,
    });
    try {
      const d1 = proxy.env.DB;
      for (const migration of migrations.slice(0, 4)) {
        for (const statement of migration.sql)
          await d1.prepare(statement).run();
      }
      await d1
        .prepare(
          `INSERT INTO matches (${columns.map(key => `"${key}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        )
        .bind(...columns.map(key => source[key]))
        .run();
      for (const statement of addition.sql) await d1.prepare(statement).run();
      expect(
        await d1
          .prepare('SELECT end_reason FROM matches WHERE match_id = ?')
          .bind(match.match_id)
          .first(),
      ).toEqual({ end_reason: null });
      expect(await getMatch(openDb(d1), match.match_id)).toHaveProperty(
        'end_reason',
        null,
      );
      const response = await handle(
        new Request(`http://api.test/v1/matches/${match.match_id}`),
        { DB: d1 } as unknown as Bindings,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toHaveProperty('end_reason', null);
    } finally {
      await proxy.dispose();
    }
  }, 30_000);

  const detailResponse = async (matchId: string) => {
    const response = await handle(
      new Request(`http://api.test/v1/matches/${matchId}`),
      { DB: testD1.d1 } as unknown as Bindings,
    );
    expect(response.status).toBe(200);
    return response.json();
  };

  it.each([
    { end_reason: 'bust', result: 'seat0_win', final_stacks: [400, 0] },
    { end_reason: 'max_hands', result: 'draw', final_stacks: [200, 200] },
    { end_reason: 'leave', result: 'seat1_win', final_stacks: [300, 100] },
    { end_reason: 'void', result: 'void', final_stacks: [200, 200] },
    { end_reason: 'cancelled', result: 'cancelled', final_stacks: [200, 200] },
  ] as const)(
    'stores and publishes $end_reason without guessing from the result or stacks',
    async scenario => {
      const match = input({
        ...scenario,
        final_stacks: [...scenario.final_stacks],
        hands: scenario.end_reason === 'cancelled' ? [] : [hand(1)],
      });
      await recordMatch(testD1.db, match);
      expect(
        await testD1.d1
          .prepare('SELECT end_reason FROM matches WHERE match_id = ?')
          .bind(match.match_id)
          .first(),
      ).toEqual({ end_reason: scenario.end_reason });
      expect(await getMatch(testD1.db, match.match_id)).toHaveProperty(
        'end_reason',
        scenario.end_reason,
      );
      expect(await detailResponse(match.match_id)).toHaveProperty(
        'end_reason',
        scenario.end_reason,
      );
      await recordMatch(testD1.db, match);
      expect(await detailResponse(match.match_id)).toHaveProperty(
        'end_reason',
        scenario.end_reason,
      );
    },
  );

  it.each([
    { result: 'seat0_win', final_stacks: [400, 0] },
    { result: 'draw', final_stacks: [200, 200] },
    { result: 'void', final_stacks: [200, 200] },
  ] as const)(
    'keeps an old caller without end_reason compatible and returns null for $result',
    async scenario => {
      const match = input({
        ...scenario,
        final_stacks: [...scenario.final_stacks],
      });
      await recordMatch(testD1.db, match);
      expect(
        await testD1.d1
          .prepare('SELECT end_reason FROM matches WHERE match_id = ?')
          .bind(match.match_id)
          .first(),
      ).toEqual({ end_reason: null });
      expect(await getMatch(testD1.db, match.match_id)).toHaveProperty(
        'end_reason',
        null,
      );
      expect(await detailResponse(match.match_id)).toHaveProperty(
        'end_reason',
        null,
      );
    },
  );
});
