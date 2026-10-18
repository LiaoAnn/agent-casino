import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomAction } from '../holdem/bot';
import {
  applyAction,
  type HandRecord,
  type HistoryEvent,
  legalActions,
  type MatchState,
  startMatch,
} from '../holdem/match';
import { mulberry32 } from '../holdem/shuffle';
import { getMatch } from './queries';
import { type MatchRecordInput, recordMatch } from './records';
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
  const events: HistoryEvent[] = [
    { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
    { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
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
    settings: { hands: 3, turn_seconds: 30, starting_stack: 200 },
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
  let state: MatchState = startMatch({ seed, hands, startingStack: 200 });
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
    seed: String(seed),
    settings: { hands, turn_seconds: 30, starting_stack: 200 },
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
  it('preserves every hand and event of a 200-hand match after a retry', async () => {
    const hands = Array.from({ length: 200 }, (_, i) => {
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
      seed: '42',
      settings: { hands: 200, turn_seconds: 30, starting_stack: 200 },
      hands,
    });
    const expected = hands.map(h => ({
      ...h,
      hole_cards: h.ended_by === 'fold' ? null : h.hole_cards,
    }));

    const result = await recordMatch(testD1.db, match);
    const stored = await getMatch(testD1.db, match.match_id);
    expect(stored?.hands).toStrictEqual(expected);

    expect(await recordMatch(testD1.db, match)).toEqual(result);
    const retried = await getMatch(testD1.db, match.match_id);
    expect(retried?.hands).toStrictEqual(expected);
    expect(retried).toStrictEqual(stored);
  }, 30_000);

  it('stores 200 hands with 8 events each', async () => {
    const hands = Array.from({ length: 200 }, (_, i) => hand(i + 1, 8));
    const match = input({
      settings: { hands: 200, turn_seconds: 30, starting_stack: 200 },
      hands,
    });
    const result = await recordMatch(testD1.db, match);
    expect(result.ratings).toEqual([
      { name: 'Alice', rating: 1516, change: 16 },
      { name: 'Bob', rating: 1484, change: -16 },
    ]);
    expect(await recordMatch(testD1.db, match)).toEqual(result);
  }, 30_000);

  it('stores a 200-hand match played by the engine', async () => {
    const match = playedHands(11, 200);
    const result = await recordMatch(testD1.db, match);
    expect(result.rated).toBe(true);
  }, 30_000);
});
