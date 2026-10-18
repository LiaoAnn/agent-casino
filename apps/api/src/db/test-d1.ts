// A real local D1 (wrangler's miniflare, in memory) for tests, built from the
// migration chain. One per test file: it takes about two seconds to start.
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/d1/migrator';
import { getPlatformProxy } from 'wrangler';
import { type Db, openDb } from './client';
import { bans, matchEvents, matches, matchHands, ratings } from './schema';

export interface TestD1 {
  d1: D1Database;
  db: Db;
  /** Empties every table. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export async function startTestD1(): Promise<TestD1> {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: fileURLToPath(
      new URL('../../wrangler.jsonc', import.meta.url).href,
    ),
    persist: false,
  });
  const d1 = proxy.env.DB;
  const db = openDb(d1);
  await migrate(db, {
    migrationsFolder: fileURLToPath(
      new URL('./migrations', import.meta.url).href,
    ),
  });
  return {
    d1,
    db,
    reset: async () => {
      await db.batch([
        db.delete(matchEvents),
        db.delete(matchHands),
        db.delete(matches),
        db.delete(ratings),
        db.delete(bans),
      ]);
    },
    dispose: () => proxy.dispose(),
  };
}
