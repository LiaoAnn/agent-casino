// What the read endpoints answer (A13, A15), in the contract's shapes.
import { and, asc, desc, eq, isNull, lt, or } from 'drizzle-orm';
import {
  defaultDisplayName,
  type Leaderboard,
  type MatchDetail,
  type MatchHand,
  type MatchList,
} from '../contract/schemas';
import { blindsAt } from '../holdem/match';
import { dealHand } from '../holdem/shuffle';
import type { Db } from './client';
import {
  bans,
  type LegacySettings,
  matchEvents,
  matches,
  matchHands,
  type RoomSettings,
  ratings,
} from './schema';

const LEADERBOARD_SIZE = 100;
const PAGE_SIZE = 20;

export async function getLeaderboard(db: Db): Promise<Leaderboard> {
  const rows = await db
    .select({
      name: ratings.name,
      displayName: ratings.displayName,
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
    entries: rows.map(({ displayName, ...row }, i) => ({
      ...row,
      // Null until the name plays a match after T35 (A20).
      display_name: displayName ?? row.name,
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
      display0: matches.display0,
      display1: matches.display1,
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
    matches: page.map(
      ({ player0, player1, display0, display1, endedAt, ...rest }) => ({
        ...rest,
        players: [player0, player1],
        display_names: displayNames({ player0, player1, display0, display1 }),
        ended_at: endedAt.toISOString(),
      }),
    ),
    next: rows.length > PAGE_SIZE ? (page.at(-1)?.match_id ?? null) : null,
  };
}

// A20: a match from before T35 stored no display names.
const displayNames = (row: {
  player0: string;
  player1: string;
  display0: string | null;
  display1: string | null;
}): [string, string] => [
  row.display0 ?? defaultDisplayName(row.player0),
  row.display1 ?? defaultDisplayName(row.player1),
];

// A19: a match from before T34 had a fixed number of hands and blinds 1/2,
// which `blind_every: null` stands for.
const matchSettings = (
  stored: RoomSettings | LegacySettings,
): MatchDetail['settings'] =>
  'hands' in stored
    ? {
        starting_stack: stored.starting_stack,
        blind_every: null,
        max_hands: stored.hands,
        turn_seconds: stored.turn_seconds,
      }
    : stored;

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
  const settings = matchSettings(row.settings);
  return {
    match_id: row.matchId,
    players: [row.player0, row.player1],
    display_names: displayNames(row),
    settings,
    seed: row.seed,
    result: row.result,
    rated: row.rated,
    ended_at: row.endedAt.toISOString(),
    final_stacks: row.finalStacks,
    rating_changes: row.ratingChanges,
    hands: hands.map(hand => ({
      hand_number: hand.handNumber,
      blinds:
        settings.blind_every === null
          ? [1, 2]
          : blindsAt(hand.handNumber, settings.blind_every),
      button_seat: hand.buttonSeat,
      board: hand.board,
      // recordMatch stores none for folded hands; the public seed deals them
      // again (A13).
      hole_cards:
        hand.holeCards ?? dealHand(row.seed, hand.handNumber).holeCards,
      events: eventsByHand.get(hand.handNumber) ?? [],
      winner_seat: hand.winnerSeat,
      pot: hand.pot,
      ended_by: hand.endedBy,
      stacks: hand.stacks,
    })),
  };
}
