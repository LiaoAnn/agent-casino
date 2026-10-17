// Banned names (A9): no new queue, room or join; hidden from the leaderboard;
// past records stay.
import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { bans } from './schema';

/** Idempotent; the first spelling banned is kept. */
export async function banName(db: Db, name: string): Promise<void> {
  await db
    .insert(bans)
    .values({ nameKey: name.toLowerCase(), name })
    .onConflictDoNothing();
}

/** Case-insensitive. */
export async function isBanned(db: Db, name: string): Promise<boolean> {
  const row = await db
    .select({ nameKey: bans.nameKey })
    .from(bans)
    .where(eq(bans.nameKey, name.toLowerCase()))
    .get();
  return row !== undefined;
}
