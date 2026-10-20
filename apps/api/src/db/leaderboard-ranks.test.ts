import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import type { Leaderboard } from '../contract/schemas';
import type { Bindings } from '../routes/env';
import { bans, ratings } from './schema';
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

describe('GET /v1/leaderboard competition ranks (T44)', () => {
  it('ties 1600.1 and 1600.4 by their public rounded rating and skips to rank 3', async () => {
    await testD1.db.insert(ratings).values(
      [
        { name: 'Alice', rating: 1600.1 },
        { name: 'Bob', rating: 1600.4 },
        { name: 'Carol', rating: 1599.4 },
      ].map(player => ({
        ...player,
        nameKey: player.name.toLowerCase(),
        games: 1,
        wins: 0,
        losses: 0,
        draws: 1,
      })),
    );
    const response = await handle(
      new Request('http://api.test/v1/leaderboard'),
      { DB: testD1.d1 } as unknown as Bindings,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Leaderboard;
    expect(body.entries).toHaveLength(3);
    expect(body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Alice', rating: 1600, rank: 1 }),
        expect.objectContaining({ name: 'Bob', rating: 1600, rank: 1 }),
        expect.objectContaining({ name: 'Carol', rating: 1599, rank: 3 }),
      ]),
    );
    expect(body.entries.map((entry: { rank: number }) => entry.rank)).toEqual([
      1, 1, 3,
    ]);
  });

  it.each([false, true])(
    'shares ranks for equal stored Elo and skips tied positions (banned players: %s)',
    async includeBanned => {
      // Insert out of rating order; names and records do not break Elo ties.
      const players = [
        { name: 'Carol', rating: 1500, wins: 3 },
        { name: 'Bob', rating: 1600, wins: 6 },
        { name: 'Eve', rating: 1400, wins: 2 },
        { name: 'Alice', rating: 1600, wins: 7 },
        { name: 'Dave', rating: 1500, wins: 4 },
      ];
      const fixtures = players.map(player => ({
        ...player,
        nameKey: player.name.toLowerCase(),
        games: 10,
        losses: 10 - player.wins,
        draws: 0,
      }));
      await testD1.db.insert(ratings).values(fixtures);
      if (includeBanned) {
        await testD1.db.insert(ratings).values([
          {
            nameKey: 'banned-leader',
            name: 'Banned-Leader',
            rating: 1700,
            games: 10,
            wins: 8,
            losses: 2,
            draws: 0,
          },
          {
            nameKey: 'banned-tie',
            name: 'Banned-Tie',
            rating: 1600,
            games: 10,
            wins: 5,
            losses: 5,
            draws: 0,
          },
        ]);
        await testD1.db
          .insert(bans)
          .values([{ nameKey: 'banned-leader' }, { nameKey: 'banned-tie' }]);
      }

      const env = {
        DB: testD1.d1,
        ROOM: {},
        MATCHMAKER: {},
      } as unknown as Bindings;
      const response = await handle(
        new Request('http://api.test/v1/leaderboard'),
        env,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as Leaderboard;
      const expectedRanks: Record<string, number> = {
        Alice: 1,
        Bob: 1,
        Carol: 3,
        Dave: 3,
        Eve: 5,
      };
      expect(body).toEqual({
        entries: expect.arrayContaining(
          fixtures.map(({ nameKey: _nameKey, ...player }) => ({
            ...player,
            championships: player.wins,
            display_name: player.name,
            rank: expectedRanks[player.name],
          })),
        ),
      });
      expect(body.entries).toHaveLength(5);
      expect(body.entries.map((entry: { rank: number }) => entry.rank)).toEqual(
        [1, 1, 3, 3, 5],
      );
    },
  );
});
