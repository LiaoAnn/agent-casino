import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Schema } from 'effect';
import { expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { handle } from '../app';
import { Leaderboard, MatchDetail, MatchList } from '../contract/schemas';
import { dealTable } from '../holdem/shuffle';
import type { Bindings } from '../routes/env';

it('T40 migration 0005 preserves every old result, seat, rating, hand and event through the read APIs', async () => {
  const migrations = readMigrationFiles({
    migrationsFolder: fileURLToPath(
      new URL('./migrations', import.meta.url).href,
    ),
  });
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(
      new URL('../../wrangler.jsonc', import.meta.url).href,
    ),
    persist: false,
  });
  try {
    const d1 = proxy.env.DB;
    for (const migration of migrations.slice(0, 5)) {
      for (const statement of migration.sql) await d1.prepare(statement).run();
    }
    const seed = 'ab'.repeat(32);
    const settings = {
      starting_stack: 200,
      blind_every: 5,
      max_hands: 2,
      turn_seconds: 30,
    };
    interface Scenario {
      result: MatchDetail['result'];
      places: MatchDetail['places'];
      stacks: number[];
      before: number[] | null;
      after: number[] | null;
      end: MatchDetail['end_reason'];
      players?: string[];
      displays?: (string | null)[];
    }
    // Seat ratings differ on purpose, so a seat-1 read of `$[0]` cannot pass.
    const scenarios: Scenario[] = [
      {
        result: 'seat0_win',
        places: [1, 2],
        stacks: [400, 0],
        before: [1500, 1480],
        after: [1516, 1464],
        end: 'bust',
      },
      {
        result: 'seat1_win',
        places: [2, 1],
        stacks: [0, 400],
        before: [1490, 1510],
        after: [1473, 1527],
        end: 'leave',
      },
      {
        result: 'draw',
        places: [1, 1],
        stacks: [200, 200],
        before: [1520, 1470],
        after: [1518, 1472],
        end: 'max_hands',
      },
      {
        result: 'void',
        places: null,
        stacks: [200, 200],
        before: null,
        after: null,
        end: null,
      },
      {
        result: 'cancelled',
        places: null,
        stacks: [200, 200],
        before: null,
        after: null,
        end: 'cancelled',
      },
      // Decided but never rated (a house-bot game): places still come from result.
      {
        result: 'seat1_win',
        places: [2, 1],
        stacks: [0, 400],
        before: null,
        after: null,
        end: 'bust',
        players: ['AlIce', 'house-bot'],
        // Stored names, so the test does not pin an unspecified NULL fallback for house-bot.
        displays: ['小愛', 'House Bot'],
      },
    ];
    const expected: MatchDetail[] = [];
    for (const [index, scenario] of scenarios.entries()) {
      const id = `r_${String(index + 1).padStart(10, '0')}`;
      const endedAt = new Date(Date.UTC(2026, 9, 18, 10, index)).toISOString();
      const players = scenario.players ?? ['AlIce', 'bOB'];
      const displays =
        scenario.displays ??
        (index % 2 === 0 ? [null, null] : ['小愛', '小包']);
      // Rating spelling deliberately differs from the match spelling.
      const changes =
        scenario.after?.map((after, seat) => ({
          name: seat === 0 ? 'Alice' : 'Bob',
          before: scenario.before?.[seat] ?? 0,
          after,
        })) ?? null;
      await d1
        .prepare(
          'INSERT INTO matches (match_id, player0, player1, display0, display1, settings, seed, result, rated, final_stacks, rating_changes, ended_at, end_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          players[0],
          players[1],
          displays[0],
          displays[1],
          JSON.stringify(settings),
          seed,
          scenario.result,
          scenario.after === null ? 0 : 1,
          JSON.stringify(scenario.stacks),
          changes === null ? null : JSON.stringify(changes),
          Date.parse(endedAt),
          scenario.end,
        )
        .run();
      const hands: MatchDetail['hands'][number][] = [];
      if (scenario.result !== 'cancelled') {
        for (const handNumber of [1, 2]) {
          const showdown = handNumber === 1;
          const winner = showdown ? null : 1;
          const cards = [
            ['Qs', 'Qh'],
            ['Jd', 'Jc'],
          ] as const;
          const board = showdown
            ? (['As', 'Kd', '7h', '2c', '9s'] as const)
            : [];
          const events = showdown
            ? ([
                { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
                { seat: 1, street: 'flop', type: 'check' },
              ] as const)
            : ([
                { seat: 1, street: 'preflop', type: 'post_blind', amount: 1 },
                { seat: 0, street: 'preflop', type: 'fold', timeout: true },
              ] as const);
          await d1
            .prepare(
              'INSERT INTO match_hands (match_id, hand_number, button_seat, board, hole_cards, winner_seat, pot, ended_by, stacks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              id,
              handNumber,
              handNumber - 1,
              JSON.stringify(board),
              showdown ? JSON.stringify(cards) : null,
              winner,
              4,
              showdown ? 'showdown' : 'fold',
              '[200,200]',
            )
            .run();
          for (const [seq, event] of events.entries()) {
            await d1
              .prepare(
                'INSERT INTO match_events (match_id, hand_number, seq, seat, street, type, amount, timeout, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              )
              .bind(
                id,
                handNumber,
                seq,
                event.seat,
                event.street,
                event.type,
                'amount' in event ? event.amount : null,
                'timeout' in event ? 1 : 0,
                seq === 1 ? 'old private note' : null,
              )
              .run();
          }
          hands.push({
            hand_number: handNumber,
            button_seat: handNumber === 1 ? 0 : 1,
            board,
            hole_cards: showdown
              ? cards
              : dealTable(seed, handNumber, 2).holeCards,
            winner_seat: winner,
            pot: 4,
            pots: [
              { amount: 4, winner_seats: winner === null ? [0, 1] : [winner] },
            ],
            ended_by: showdown ? 'showdown' : 'fold',
            stacks: [200, 200],
            blinds: [1, 2],
            events,
          });
        }
      }
      // Written as the public N-seat shape; never use the new reader on 0004.
      expected.push({
        match_id: id,
        players,
        display_names: displays.map(
          (display, seat) => display ?? players[seat],
        ),
        settings,
        seed,
        result: scenario.result,
        places: scenario.places,
        final_stacks: scenario.stacks,
        rating_changes: changes,
        end_reason: scenario.end,
        rated: scenario.after !== null,
        ended_at: endedAt,
        hands,
      });
    }
    await d1
      .prepare(
        'INSERT INTO ratings (name_key, name, rating, games, wins, losses, draws, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('alice', 'Alice', 1600.25, 10, 5, 3, 2, null)
      .run();
    await d1
      .prepare(
        'INSERT INTO ratings (name_key, name, rating, games, wins, losses, draws, display_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind('bob', 'Bob', 1399.75, 10, 3, 5, 2, '小包最新')
      .run();
    const oldRatings = (
      await d1.prepare('SELECT * FROM ratings ORDER BY name_key').all()
    ).results;

    const addition = migrations[5];
    expect(addition, 'the generated 0005 migration must exist').toBeDefined();
    if (!addition) throw new Error('Missing migration 0005');
    for (const statement of addition.sql) await d1.prepare(statement).run();

    expect(
      (await d1.prepare('SELECT * FROM ratings ORDER BY name_key').all())
        .results,
    ).toEqual(oldRatings);
    expect(
      await d1.prepare('SELECT count(*) AS n FROM match_seats').first(),
    ).toEqual({ n: 12 });
    const columns = (
      await d1.prepare('PRAGMA table_info(matches)').all<{ name: string }>()
    ).results.map(column => column.name);
    for (const removed of [
      'player0',
      'player1',
      'display0',
      'display1',
      'final_stacks',
      'rating_changes',
    ])
      expect(columns).not.toContain(removed);
    const potsColumn = (
      await d1
        .prepare('PRAGMA table_info(match_hands)')
        .all<{ name: string; notnull: number }>()
    ).results.find(column => column.name === 'pots');
    expect(potsColumn).toMatchObject({ name: 'pots', notnull: 0 });
    expect(
      (
        await d1
          .prepare('SELECT note FROM match_events WHERE note IS NOT NULL')
          .all()
      ).results,
    ).toEqual(Array.from({ length: 10 }, () => ({ note: 'old private note' })));
    const get = async (path: string) => {
      const response = await handle(new Request(`http://api.test${path}`), {
        DB: d1,
      } as unknown as Bindings);
      expect(response.status).toBe(200);
      return response.json();
    };
    for (const match of expected) {
      const raw = await get(`/v1/matches/${match.match_id}`);
      expect(Schema.decodeUnknownSync(MatchDetail)(raw)).toStrictEqual(match);
      expect(raw).toStrictEqual(match);
    }
    const matches = await get('/v1/matches');
    const expectedList = {
      matches: [...expected]
        .reverse()
        .map(
          ({
            match_id,
            players,
            display_names,
            places,
            result,
            ended_at,
            rated,
          }) => ({
            match_id,
            players,
            display_names,
            places,
            result,
            ended_at,
            rated,
          }),
        ),
      next: null,
    };
    expect(Schema.decodeUnknownSync(MatchList)(matches)).toStrictEqual(
      expectedList,
    );
    expect(matches).toStrictEqual(expectedList);
    const leaderboard = await get('/v1/leaderboard');
    const expectedBoard = {
      entries: [
        {
          rank: 1,
          name: 'Alice',
          display_name: 'Alice',
          rating: 1600,
          games: 10,
          wins: 5,
          losses: 3,
          draws: 2,
          championships: 5,
        },
        {
          rank: 2,
          name: 'Bob',
          display_name: '小包最新',
          rating: 1400,
          games: 10,
          wins: 3,
          losses: 5,
          draws: 2,
          championships: 3,
        },
      ],
    };
    expect(Schema.decodeUnknownSync(Leaderboard)(leaderboard)).toStrictEqual(
      expectedBoard,
    );
    expect(leaderboard).toStrictEqual(expectedBoard);
  } finally {
    await proxy.dispose();
  }
}, 30_000);
