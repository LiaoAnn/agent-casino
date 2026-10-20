import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { Leaderboard, MatchDetail, MatchList } from '../contract/schemas';
import { dealTable } from '../holdem/shuffle';
import type { TableHandRecord } from '../holdem/table';
import type { Bindings } from '../routes/env';
import { type MatchRecordInput, recordMatch } from './records';
import { startTestD1, type TestD1 } from './test-d1';

let store: TestD1;
beforeAll(async () => {
  store = await startTestD1();
}, 30_000);
beforeEach(async () => {
  await store.reset();
});
afterAll(async () => {
  await store?.dispose();
});

let counter = 0;
function input(overrides: Partial<MatchRecordInput> = {}): MatchRecordInput {
  return {
    match_id: `r_${String(++counter).padStart(10, '0')}`,
    players: ['Alice', 'Bob', 'Carol'],
    settings: {
      starting_stack: 200,
      blind_every: 5,
      max_hands: 3,
      turn_seconds: 30,
    },
    seed: 'ab'.repeat(32),
    result: 'seat0_win',
    places: [1, 2, 3],
    ended_at: '2026-10-20T00:00:00.000Z',
    final_stacks: [300, 200, 100],
    hands: [],
    ...overrides,
  };
}

// Independent pairwise oracle: every comparison uses the pre-match ratings.
function elo(ratings: number[], places: number[]): number[] {
  return ratings.map(
    (rating, i) =>
      rating +
      ratings.reduce((delta, other, j) => {
        if (i === j) return delta;
        const score =
          places[i] === places[j] ? 0.5 : places[i] < places[j] ? 1 : 0;
        return (
          delta +
          (32 / (ratings.length - 1)) *
            (score - 1 / (1 + 10 ** ((other - rating) / 400)))
        );
      }, 0),
  );
}

async function json(path: string): Promise<unknown> {
  const response = await handle(new Request(`http://api.test${path}`), {
    DB: store.d1,
  } as unknown as Bindings);
  expect(response.status).toBe(200);
  return response.json();
}
const detail = async (id: string) =>
  Schema.decodeUnknownSync(MatchDetail)(await json(`/v1/matches/${id}`));
const board = async () =>
  Schema.decodeUnknownSync(Leaderboard)(await json('/v1/leaderboard'));
const list = async (query = '') =>
  Schema.decodeUnknownSync(MatchList)(await json(`/v1/matches${query}`));

async function rawRatings() {
  return (
    await store.d1
      .prepare(
        'SELECT name, rating, games, wins, losses, draws, display_name FROM ratings ORDER BY name_key',
      )
      .all<{
        name: string;
        rating: number;
        games: number;
        wins: number;
        losses: number;
        draws: number;
        display_name: string | null;
      }>()
  ).results;
}

describe('T40 N-seat rating persistence', () => {
  it.each([
    { places: [1, 2, 3], result: 'seat0_win' },
    { places: [6, 4, 3, 5, 2, 1], result: 'seat5_win' },
    { places: [1, 2, 2, 4], result: 'seat0_win' },
    { places: [1, 1, 1], result: 'draw' },
    { places: [1, 1, 3, 4], result: 'draw' },
  ] as const)(
    'rates $places and counts championships only for sole first place',
    async scenario => {
      const places = [...scenario.places];
      const players = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'].slice(
        0,
        places.length,
      );
      const match = input({
        players,
        places,
        result: scenario.result,
        final_stacks: places.map(place => 700 - place * 100),
      });
      const expected = elo(
        players.map(() => 1500),
        places,
      );
      const recorded = await recordMatch(store.db, match);
      expect(recorded).toEqual({
        rated: true,
        ratings: players.map((name, i) => ({
          name,
          rating: Math.round(expected[i]),
          change: Math.round(expected[i]) - 1500,
        })),
      });
      const stored = await detail(match.match_id);
      expect(stored.rating_changes).toEqual(
        players.map((name, i) => ({
          name,
          before: 1500,
          after: Math.round(expected[i]),
        })),
      );
      expect(stored.players).toEqual(players);
      expect(stored.places).toEqual(places);
      const firstCount = places.filter(p => p === 1).length;
      const entries = (await board()).entries;
      expect(entries).toHaveLength(players.length);
      for (const [i, name] of players.entries()) {
        const wins = places[i] === 1 && firstCount === 1 ? 1 : 0;
        const draws = places[i] === 1 && firstCount > 1 ? 1 : 0;
        expect(entries.find(entry => entry.name === name)).toMatchObject({
          name,
          display_name: name,
          rating: Math.round(expected[i]),
          games: 1,
          wins,
          championships: wins,
          draws,
          losses: places[i] === 1 ? 0 : 1,
        });
      }
      for (const [i, row] of (await rawRatings()).entries()) {
        expect(row.rating).toBeCloseTo(expected[i], 12);
      }
    },
  );

  it('uses unrounded prior ratings, keeps identity spelling and returns the original result on retries', async () => {
    const first = input({ display_names: ['愛一', '包一', '卡一'] });
    await recordMatch(store.db, first);
    const before = elo([1500, 1500, 1500], [1, 2, 3]);
    const second = input({
      players: ['ALICE', 'bob', 'Carol'],
      display_names: ['愛二', '包二', '卡二'],
      places: [3, 1, 2],
      result: 'seat1_win',
    });
    const after = elo(before, [3, 1, 2]);
    const answer = await recordMatch(store.db, second);
    expect(answer.ratings).toEqual(
      first.players.map((name, i) => ({
        name,
        rating: Math.round(after[i]),
        change: Math.round(after[i]) - Math.round(before[i]),
      })),
    );
    expect((await detail(second.match_id)).rating_changes).toEqual(
      first.players.map((name, i) => ({
        name,
        before: Math.round(before[i]),
        after: Math.round(after[i]),
      })),
    );
    expect((await detail(second.match_id)).players).toEqual(second.players);
    const snapshot = await rawRatings();
    const saved = await detail(first.match_id);
    expect(await recordMatch(store.db, first)).toEqual({
      rated: true,
      ratings: first.players.map((name, i) => ({
        name,
        rating: Math.round(before[i]),
        change: Math.round(before[i]) - 1500,
      })),
    });
    expect(await recordMatch(store.db, second)).toEqual(answer);
    expect(await rawRatings()).toEqual(snapshot);
    expect(await detail(first.match_id)).toEqual(saved);
    expect((await list()).matches).toHaveLength(2);
    expect(
      snapshot.map(row => [
        row.games,
        row.wins,
        row.losses,
        row.draws,
        row.display_name,
      ]),
    ).toEqual([
      [2, 1, 1, 0, '愛二'],
      [2, 1, 1, 0, '包二'],
      [2, 0, 2, 0, '卡二'],
    ]);
    snapshot.forEach((row, i) => {
      expect(row.rating).toBeCloseTo(after[i], 12);
    });
  });

  it.each(['bots', 'void', 'cancelled'] as const)(
    'does not rate %s but refreshes existing display names',
    async kind => {
      await recordMatch(store.db, input());
      const before = await rawRatings();
      const match =
        kind === 'bots'
          ? input({
              players: ['ALICE', 'house-bot', 'house-bot', 'NewName'],
              display_names: ['新愛', 'House Bot', 'House Bot', '新手'],
              places: [1, 2, 3, 4],
              final_stacks: [400, 200, 100, 0],
            })
          : input({
              players: ['ALICE', 'Bob', 'NewName'],
              display_names: ['新愛', '新包', '新手'],
              result: kind,
              places: null,
            });
      const result = await recordMatch(store.db, match);
      expect(result).toEqual({ rated: false, ratings: null });
      const after = await rawRatings();
      expect(after).toEqual(
        before.map(row => ({
          ...row,
          display_name:
            row.name === 'Alice'
              ? '新愛'
              : row.name === 'Bob' && kind !== 'bots'
                ? '新包'
                : row.display_name,
        })),
      );
      const stored = await detail(match.match_id);
      expect(stored).toMatchObject({
        rated: false,
        rating_changes: null,
        players: match.players,
        places: match.places,
      });
      expect(await recordMatch(store.db, match)).toEqual(result);
      expect(await rawRatings()).toEqual(after);
    },
  );
});

describe('T40 rejects invalid records before writing anything', () => {
  const invalid: [string, Partial<MatchRecordInput>][] = [
    ['one seat', { players: ['Alice'], places: [1], final_stacks: [200] }],
    [
      'seven seats',
      {
        players: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        places: [1, 2, 3, 4, 5, 6, 7],
        final_stacks: [7, 6, 5, 4, 3, 2, 1],
      },
    ],
    ['short display names', { display_names: ['A', 'B'] }],
    ['long display names', { display_names: ['A', 'B', 'C', 'D'] }],
    ['short stacks', { final_stacks: [300, 200] }],
    ['long stacks', { final_stacks: [300, 200, 100, 0] }],
    ['short places', { places: [1, 2] }],
    ['long places', { places: [1, 2, 3, 4] }],
    ['missing multiplayer places', { places: undefined }],
    ['duplicate name', { players: ['Alice', 'Alice', 'Carol'] }],
    ['case-insensitive duplicate', { players: ['Alice', 'ALICE', 'Carol'] }],
    ['winner disagrees', { places: [2, 1, 3] }],
    ['sole winner reported as draw', { result: 'draw' }],
    ['shared winner reported as sole winner', { places: [1, 1, 3] }],
    ['null places on a scored match', { places: null }],
    ['places on void', { result: 'void' }],
    ['places on cancelled', { result: 'cancelled' }],
  ];
  it.each(invalid)(
    '%s throws RangeError atomically',
    async (_label, overrides) => {
      const match = input(overrides);
      await expect(recordMatch(store.db, match)).rejects.toBeInstanceOf(
        RangeError,
      );
      for (const table of [
        'matches',
        'match_seats',
        'match_hands',
        'match_events',
        'ratings',
      ]) {
        expect(
          await store.d1.prepare(`SELECT count(*) AS n FROM ${table}`).first(),
        ).toEqual({ n: 0 });
      }
    },
  );
});

describe('T40 two-seat Elo compatibility', () => {
  it('is exactly the K=32 formula with heads-up places', async () => {
    let expected = [1500, 1500];
    for (const [result, places, score] of [
      ['seat0_win', [1, 2], 1],
      ['seat1_win', [2, 1], 0],
      ['draw', [1, 1], 0.5],
    ] as const) {
      const delta =
        32 * (score - 1 / (1 + 10 ** ((expected[1] - expected[0]) / 400)));
      const next = [expected[0] + delta, expected[1] - delta];
      const match = input({
        players: ['Alice', 'Bob'],
        final_stacks: [200, 200],
        result,
        places: [...places],
      });
      const answer = await recordMatch(store.db, match);
      expect((await rawRatings()).map(row => row.rating)).toEqual(next);
      expect(answer.ratings).toEqual(
        match.players.map((name, i) => ({
          name,
          rating: Math.round(next[i]),
          change: Math.round(next[i]) - Math.round(expected[i]),
        })),
      );
      expect((await detail(match.match_id)).places).toEqual(places);
      expected = next;
    }
  });
});

describe('T40 multiplayer read contracts', () => {
  it('preserves side pots, shared winners, seat 5 events and showdown cards, and deals only active seats', async () => {
    const first: TableHandRecord = {
      hand_number: 1,
      button_seat: 5,
      blinds: [1, 2],
      winner_seat: null,
      pot: 900,
      pots: [
        { amount: 600, winners: [0, 5] },
        { amount: 300, winners: [5] },
      ],
      ended_by: 'showdown',
      board: ['As', 'Kd', '7h', '2c', '9s'],
      hole_cards: [['Qs', 'Qh'], null, null, null, null, ['Jd', 'Jc']],
      stacks: [300, 0, 0, 200, 0, 700],
      events: [
        { seat: 5, street: 'preflop', type: 'raise', amount: 200 },
        { seat: 3, street: 'flop', type: 'fold', timeout: true },
        { seat: 4, street: 'turn', type: 'leave', amount: 200 },
      ],
    };
    const second: TableHandRecord = {
      hand_number: 2,
      button_seat: 3,
      blinds: [1, 2],
      winner_seat: 5,
      pot: 3,
      pots: [{ amount: 3, winners: [5] }],
      ended_by: 'fold',
      board: [],
      hole_cards: null,
      stacks: [299, 0, 0, 198, 0, 703],
      events: [
        { seat: 0, street: 'preflop', type: 'fold' },
        { seat: 3, street: 'preflop', type: 'fold' },
      ],
    };
    const match = input({
      players: ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank'],
      display_names: ['愛', '包', '卡', '戴', '艾', '法'],
      result: 'seat5_win',
      places: [2, 4, 4, 3, 4, 1],
      final_stacks: second.stacks,
      hands: [first, second],
      end_reason: 'max_hands',
    });
    await recordMatch(store.db, match);
    const stored = await detail(match.match_id);
    const dealtFirst = dealTable(match.seed, 1, 6).holeCards;
    const dealtSecond = dealTable(match.seed, 2, 3).holeCards;
    expect(stored).toMatchObject({
      players: match.players,
      display_names: match.display_names,
      places: match.places,
      final_stacks: match.final_stacks,
      end_reason: 'max_hands',
    });
    expect(stored.hands).toEqual([
      {
        ...first,
        pots: first.pots.map(pot => ({
          amount: pot.amount,
          winner_seats: pot.winners,
        })),
        hole_cards: first.hole_cards?.map(
          (cards, seat) => cards ?? dealtFirst[seat],
        ),
      },
      {
        ...second,
        pots: [{ amount: 3, winner_seats: [5] }],
        hole_cards: [
          dealtSecond[0],
          null,
          null,
          dealtSecond[1],
          null,
          dealtSecond[2],
        ],
      },
    ]);
    expect((await list()).matches).toEqual([
      {
        match_id: match.match_id,
        players: match.players,
        display_names: match.display_names,
        result: match.result,
        places: match.places,
        ended_at: match.ended_at,
        rated: true,
      },
    ]);
  });

  it('paginates mixed 3- and 6-seat records without losing seat arrays', async () => {
    const matches: MatchRecordInput[] = [];
    for (let i = 0; i < 23; i++) {
      const n = i % 2 ? 6 : 3;
      const match = input({
        players: ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, n),
        places: Array.from({ length: n }, (_, seat) => seat + 1),
        final_stacks: Array.from({ length: n }, (_, seat) => 600 - seat * 100),
        ended_at: new Date(Date.UTC(2026, 9, 20, 0, i)).toISOString(),
      });
      await recordMatch(store.db, match);
      matches.unshift(match);
    }
    const first = await list();
    expect(first.matches).toHaveLength(20);
    expect(first.next).toBe(matches[19].match_id);
    const second = await list(`?before=${first.next}`);
    expect(second.matches).toHaveLength(3);
    expect(second.next).toBeNull();
    expect([...first.matches, ...second.matches]).toEqual(
      matches.map(match => ({
        match_id: match.match_id,
        players: match.players,
        display_names: match.players,
        places: match.places,
        result: match.result,
        rated: true,
        ended_at: match.ended_at,
      })),
    );
  }, 30_000);
});
