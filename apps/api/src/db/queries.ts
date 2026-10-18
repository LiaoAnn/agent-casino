// What the read endpoints answer (A13, A15), in the contract's shapes.
import { and, asc, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type {
  Leaderboard,
  MatchDetail,
  MatchHand,
  MatchList,
} from '../contract/schemas';
import type { Db } from './client';
import { bans, matchEvents, matches, matchHands, ratings } from './schema';

const LEADERBOARD_SIZE = 100;
const PAGE_SIZE = 20;

export async function getLeaderboard(db: Db): Promise<Leaderboard> {
  const rows = await db
    .select({
      name: ratings.name,
      rating: ratings.rating,
      games: ratings.games,
      wins: ratings.wins,
      losses: ratings.losses,
      draws: ratings.draws,
    })
    .from(ratings)
    .leftJoin(bans, eq(bans.nameKey, ratings.nameKey))
    .where(isNull(bans.nameKey))
    .orderBy(desc(ratings.rating), asc(ratings.nameKey))
    .limit(LEADERBOARD_SIZE);
  return {
    entries: rows.map((row, i) => ({
      ...row,
      rank: i + 1,
      rating: Math.round(row.rating),
    })),
  };
}

/** Newest first, 20 a page. `null` when `before` names no stored match. */
export async function listMatches(
  db: Db,
  before?: string,
): Promise<MatchList | null> {
  let older: ReturnType<typeof or>;
  if (before !== undefined) {
    const cursor = await db
      .select({ endedAt: matches.endedAt })
      .from(matches)
      .where(eq(matches.matchId, before))
      .get();
    if (!cursor) return null;
    older = or(
      lt(matches.endedAt, cursor.endedAt),
      and(eq(matches.endedAt, cursor.endedAt), lt(matches.matchId, before)),
    );
  }
  const rows = await db
    .select({
      match_id: matches.matchId,
      player0: matches.player0,
      player1: matches.player1,
      result: matches.result,
      endedAt: matches.endedAt,
      rated: matches.rated,
    })
    .from(matches)
    .where(older)
    .orderBy(desc(matches.endedAt), desc(matches.matchId))
    .limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  return {
    matches: page.map(({ player0, player1, endedAt, ...row }) => ({
      ...row,
      players: [player0, player1],
      ended_at: endedAt.toISOString(),
    })),
    next: rows.length > PAGE_SIZE ? (page.at(-1)?.match_id ?? null) : null,
  };
}

export async function getMatch(
  db: Db,
  matchId: string,
): Promise<MatchDetail | null> {
  const [match, hands, events] = await db.batch([
    db.select().from(matches).where(eq(matches.matchId, matchId)),
    db
      .select()
      .from(matchHands)
      .where(eq(matchHands.matchId, matchId))
      .orderBy(asc(matchHands.handNumber)),
    db
      .select()
      .from(matchEvents)
      .where(eq(matchEvents.matchId, matchId))
      .orderBy(asc(matchEvents.handNumber), asc(matchEvents.seq)),
  ]);
  const row = match[0];
  if (!row) return null;

  const eventsByHand = new Map<number, MatchHand['events'][number][]>();
  for (const e of events) {
    const list = eventsByHand.get(e.handNumber) ?? [];
    list.push({
      seat: e.seat,
      street: e.street,
      type: e.type,
      ...(e.amount === null ? {} : { amount: e.amount }),
      ...(e.timeout ? { timeout: true as const } : {}),
    });
    eventsByHand.set(e.handNumber, list);
  }
  return {
    match_id: row.matchId,
    players: [row.player0, row.player1],
    settings: row.settings,
    seed: row.seed,
    result: row.result,
    rated: row.rated,
    ended_at: row.endedAt.toISOString(),
    final_stacks: row.finalStacks,
    rating_changes: row.ratingChanges,
    hands: hands.map(hand => ({
      hand_number: hand.handNumber,
      button_seat: hand.buttonSeat,
      board: hand.board,
      // recordMatch stores none for folded hands (A13).
      hole_cards: hand.holeCards,
      events: eventsByHand.get(hand.handNumber) ?? [],
      winner_seat: hand.winnerSeat,
      pot: hand.pot,
      ended_by: hand.endedBy,
      stacks: hand.stacks,
    })),
  };
}
