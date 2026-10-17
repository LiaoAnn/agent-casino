import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { Effect } from 'effect';
import { type ApiError, apiError } from '../contract/errors';
import * as schema from './schema';

export type Db = DrizzleD1Database<typeof schema>;

export const openDb = (d1: D1Database): Db => drizzle(d1, { schema });

/**
 * Runs queries for a handler: a D1 failure is logged and answers 503
 * `unavailable`, which the agent may retry.
 */
export const withDb = <A>(
  d1: D1Database,
  run: (db: Db) => Promise<A>,
): Effect.Effect<A, ApiError<'unavailable'>> =>
  Effect.tryPromise({ try: () => run(openDb(d1)), catch: cause => cause }).pipe(
    Effect.tapError(cause => Effect.logError('D1 query failed', cause)),
    Effect.mapError(() =>
      apiError(
        'unavailable',
        'The database did not answer',
        'Retry the same request in a few seconds',
      ),
    ),
  );
