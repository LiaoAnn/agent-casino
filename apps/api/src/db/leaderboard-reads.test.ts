import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from './client';
import { getLeaderboard } from './queries';
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

/** Count real D1 reads, excluding fixture inserts and migrations. */
function measureReads(d1: D1Database) {
  let rowsRead = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const count = <T>(result: D1Result<T>) => {
    expect(Number.isFinite(result.meta.rows_read)).toBe(true);
    rowsRead += result.meta.rows_read;
    return result;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        if (property === 'all' || property === 'run') {
          return async () => count(await target[property]());
        }
        // raw() and first() discard metadata. Execute the same SQL with all()
        // to retain rows_read, then return the requested representation.
        if (property === 'raw') {
          return async (options?: { columnNames?: boolean }) => {
            const result = count(await target.all());
            const rows = result.results.map(row => Object.values(row));
            return options?.columnNames
              ? [Object.keys(result.results[0] ?? {}), ...rows]
              : rows;
          };
        }
        if (property === 'first') {
          return async (column?: string) => {
            const result = count(await target.all());
            const row = result.results[0];
            return row ? (column === undefined ? row : row[column]) : null;
          };
        }
        return Reflect.get(target, property);
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const measured = new Proxy(d1, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => wrap(target.prepare(query));
      }
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(
            statements.map(statement => originals.get(statement) ?? statement),
          );
          return results.map(count);
        };
      }
      // Fail closed if a new query path bypasses this meter.
      throw new Error(`Unmetered D1 operation: ${String(property)}`);
    },
  });
  return { db: openDb(measured), rowsRead: () => rowsRead };
}

// Permute scores so insertion order and name order cannot produce the ranking.
function ratingFixtures() {
  return Array.from({ length: 1_000 }, (_, i) => ({
    nameKey: `player-${String(i).padStart(4, '0')}`,
    name: `Player-${String(i).padStart(4, '0')}`,
    rating: 1_000 + ((i * 37) % 1_000),
    games: 10 + (i % 3),
    wins: 4 + (i % 3),
    losses: 3,
    draws: 3,
  }));
}

type RatingFixture = ReturnType<typeof ratingFixtures>[number];

async function seedRatings(rows: RatingFixture[]) {
  // Stay below D1's bound-parameter limit without depending on bulk SQL.
  const inserts = [];
  for (let start = 0; start < rows.length; start += 10) {
    inserts.push(
      testD1.db.insert(ratings).values(rows.slice(start, start + 10)),
    );
  }
  // One round trip: awaiting each insert took about 3 s, and a test timed
  // out mid-seed kept inserting into the next test's table.
  const [first, ...rest] = inserts;
  if (first === undefined) throw new Error('No ratings to seed');
  await testD1.db.batch([first, ...rest]);
}

function expectedEntries(rows: RatingFixture[], banned = new Set<string>()) {
  return rows
    .filter(row => !banned.has(row.nameKey))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 100)
    .map(({ nameKey: _nameKey, ...row }, index) => ({
      rank: index + 1,
      ...row,
    }));
}

// Seeding 1,000 rows takes about a second; a busy machine can triple that.
describe('getLeaderboard D1 rows read', { timeout: 15_000 }, () => {
  it('reads at most 150 rows for the top 100 of 1,000 ratings', async () => {
    const rows = ratingFixtures();
    await seedRatings(rows);
    const measured = measureReads(testD1.d1);

    const result = await getLeaderboard(measured.db);

    expect(result.entries).toHaveLength(100);
    expect(result.entries).toEqual(expectedEntries(rows));
    expect(measured.rowsRead()).toBeGreaterThan(0);
    expect(measured.rowsRead()).toBeLessThanOrEqual(150);
  });

  it('fills 100 eligible places while bounding reads for banned leaders', async () => {
    const rows = ratingFixtures();
    await seedRatings(rows);
    const leaders = [...rows].sort((a, b) => b.rating - a.rating);
    const banned = new Set(leaders.slice(0, 7).map(leader => leader.nameKey));
    await testD1.db
      .insert(bans)
      .values([...banned].map(nameKey => ({ nameKey })));
    const measured = measureReads(testD1.d1);

    const result = await getLeaderboard(measured.db);

    expect(result.entries).toHaveLength(100);
    expect(result.entries).toEqual(expectedEntries(rows, banned));
    expect(measured.rowsRead()).toBeGreaterThan(0);
    expect(measured.rowsRead()).toBeLessThanOrEqual(150 + banned.size * 2);
  });
});
