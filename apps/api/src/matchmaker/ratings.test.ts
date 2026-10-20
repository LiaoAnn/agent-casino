import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eloUpdate, INITIAL_RATING } from '../db/elo';
import type { MatchRecordInput, RecordedMatch } from '../db/records';
import { ratings } from '../db/schema';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { RatingWriter } from './ratings';

let testD1: TestD1;
let writer: RatingWriter;

beforeAll(async () => {
  testD1 = await startTestD1();
}, 30_000);

beforeEach(async () => {
  await testD1.reset();
  writer = new RatingWriter(testD1.db);
});

afterAll(async () => {
  await testD1?.dispose();
});

function input(
  id: number,
  opponent: string,
  score: 0 | 0.5 | 1 = 1,
): MatchRecordInput {
  const stacks: [number, number] =
    score === 1 ? [300, 100] : score === 0 ? [100, 300] : [200, 200];
  return {
    match_id: `r_${String(id).padStart(10, '0')}`,
    players: ['alice', opponent],
    settings: {
      max_hands: 1,
      turn_seconds: 30,
      blind_every: 50,
      starting_stack: 200,
    },
    seed: '2a'.repeat(32),
    result: score === 1 ? 'seat0_win' : score === 0 ? 'seat1_win' : 'draw',
    places: score === 1 ? [1, 2] : score === 0 ? [2, 1] : [1, 1],
    ended_at: '2026-10-18T10:00:00.000Z',
    final_stacks: stacks,
    hands: [
      {
        hand_number: 1,
        button_seat: 0,
        blinds: [1, 2],
        winner_seat: score === 1 ? 0 : score === 0 ? 1 : null,
        pot: 200,
        pots: [
          {
            amount: 200,
            winners: score === 1 ? [0] : score === 0 ? [1] : [0, 1],
          },
        ],
        ended_by: 'showdown',
        board: ['As', 'Kd', '7h', '2c', '9s'],
        hole_cards: [
          ['Qs', 'Qh'],
          ['Qd', 'Qc'],
        ],
        stacks,
        events: [
          { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
          { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
        ],
      },
    ],
  };
}

function expectedResult(
  opponent: string,
  before: number,
  after: [number, number],
): RecordedMatch {
  return {
    rated: true,
    ratings: [
      {
        name: 'alice',
        rating: Math.round(after[0]),
        change: Math.round(after[0]) - Math.round(before),
      },
      {
        name: opponent,
        rating: Math.round(after[1]),
        change: Math.round(after[1]) - INITIAL_RATING,
      },
    ],
  };
}

async function aliceRating() {
  return testD1.db
    .select()
    .from(ratings)
    .where(eq(ratings.nameKey, 'alice'))
    .get();
}

describe('RatingWriter', () => {
  it('records simultaneous matches in call order without losing shared-player updates', async () => {
    const first = eloUpdate(INITIAL_RATING, INITIAL_RATING, 1);
    const second = eloUpdate(first[0], INITIAL_RATING, 0);

    const results = await Promise.all([
      writer.record(input(1, 'bob')),
      writer.record(input(2, 'carol', 0)),
    ]);

    const alice = await aliceRating();
    expect(alice).toMatchObject({ games: 2, wins: 1, losses: 1, draws: 0 });
    expect(alice?.rating).toBeCloseTo(second[0], 10);
    expect(results).toEqual([
      expectedResult('bob', INITIAL_RATING, first),
      expectedResult('carol', first[0], second),
    ]);
  });

  it('counts every match in a simultaneous five-match queue', async () => {
    const scores = [1, 0, 0.5, 1, 0] as const;
    let alice = INITIAL_RATING;
    const expected = scores.map((score, index) => {
      const after = eloUpdate(alice, INITIAL_RATING, score);
      const result = expectedResult(`opponent${index}`, alice, after);
      alice = after[0];
      return result;
    });

    const results = await Promise.all(
      scores.map((score, index) =>
        writer.record(input(index + 1, `opponent${index}`, score)),
      ),
    );

    const stored = await aliceRating();
    expect(stored).toMatchObject({ games: 5, wins: 2, losses: 2, draws: 1 });
    expect(stored?.rating).toBeCloseTo(alice, 10);
    expect(results).toEqual(expected);
  });

  it('rejects a failed call while allowing the next queued call to complete', async () => {
    const invalid = { ...input(1, 'bob'), ended_at: 'not-a-date' };
    const results = await Promise.allSettled([
      writer.record(invalid),
      writer.record(input(2, 'carol')),
    ]);

    expect(results[0]?.status).toBe('rejected');
    expect(results[1]).toEqual({
      status: 'fulfilled',
      value: expectedResult(
        'carol',
        INITIAL_RATING,
        eloUpdate(INITIAL_RATING, INITIAL_RATING, 1),
      ),
    });
    expect(await aliceRating()).toMatchObject({
      games: 1,
      wins: 1,
      losses: 0,
      draws: 0,
      rating: 1516,
    });
  });

  it('returns the first result on a sequential retry even after another match', async () => {
    const match = input(1, 'bob');
    const first = await writer.record(match);
    await writer.record(input(2, 'carol', 0));
    const beforeRetry = await testD1.db.select().from(ratings);

    expect(await writer.record(match)).toEqual(first);
    expect(await testD1.db.select().from(ratings)).toEqual(beforeRetry);
    expect(await aliceRating()).toMatchObject({
      games: 2,
      wins: 1,
      losses: 1,
      draws: 0,
    });
  });
});
