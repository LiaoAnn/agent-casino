// What the read endpoints answer (A13, A15), in the contract's shapes.
import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import {
  defaultDisplayName,
  type Leaderboard,
  type MatchDetail,
  type MatchHand,
  type MatchList,
} from '../contract/schemas';
import { dealTable } from '../holdem/shuffle';
import { blindsAt } from '../holdem/table';
import type { Db } from './client';
import {
  bans,
  type LegacySettings,
  matchEvents,
  matches,
  matchHands,
  matchSeats,
  type RoomSettings,
  ratings,
} from './schema';

// D1 stores seats as plain integers; recordMatch takes at most 6 seats.
const asSeat = (seat: number) => seat as MatchHand['button_seat'];

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
  let rank = 1;
  return {
    entries: rows.map(({ displayName, ...row }, i) => {
      if (
        Math.round(rows[i - 1]?.rating ?? Number.NaN) !== Math.round(row.rating)
      )
        rank = i + 1;
      return {
        ...row,
        // Null until the name plays a match after T35 (A20).
        display_name: displayName ?? row.name,
        rank,
        rating: Math.round(row.rating),
        // A win is first place alone, heads-up or not (T40).
        championships: row.wins,
      };
    }),
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
      result: matches.result,
      endedAt: matches.endedAt,
      rated: matches.rated,
    })
    .from(matches)
    .where(older)
    .orderBy(desc(matches.endedAt), desc(matches.matchId))
    .limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  const seats =
    page.length === 0
      ? []
      : await db
          .select()
          .from(matchSeats)
          .where(
            inArray(
              matchSeats.matchId,
              page.map(row => row.match_id),
            ),
          )
          .orderBy(asc(matchSeats.seat));
  return {
    matches: page.map(({ endedAt, ...rest }) => {
      const own = seats.filter(seat => seat.matchId === rest.match_id);
      return {
        ...rest,
        ...seatFields(own),
        ended_at: endedAt.toISOString(),
      };
    }),
    next: rows.length > PAGE_SIZE ? (page.at(-1)?.match_id ?? null) : null,
  };
}

// The by-seat fields of a match from its match_seats rows, in seat order.
const seatFields = (seats: (typeof matchSeats.$inferSelect)[]) => ({
  players: seats.map(seat => seat.name),
  // A20: a match from before T35 stored no display names.
  display_names: seats.map(
    seat => seat.displayName ?? defaultDisplayName(seat.name),
  ),
  // Void and cancelled matches place nobody.
  places: seats.every(seat => seat.place !== null)
    ? seats.map(seat => seat.place as number)
    : null,
});

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
  const [match, seats, hands, events] = await db.batch([
    db.select().from(matches).where(eq(matches.matchId, matchId)),
    db
      .select()
      .from(matchSeats)
      .where(eq(matchSeats.matchId, matchId))
      .orderBy(asc(matchSeats.seat)),
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
      seat: asSeat(e.seat),
      street: e.street,
      type: e.type,
      ...(e.amount === null ? {} : { amount: e.amount }),
      ...(e.timeout ? { timeout: true as const } : {}),
    });
    eventsByHand.set(e.handNumber, list);
  }
  const settings = matchSettings(row.settings);
  // Seats with chips when each hand began: all of them for hand 1.
  let inPlay = seats.map(() => true);
  return {
    match_id: row.matchId,
    ...seatFields(seats),
    settings,
    seed: row.seed,
    result: row.result,
    end_reason: row.endReason,
    rated: row.rated,
    ended_at: row.endedAt.toISOString(),
    final_stacks: seats.map(seat => seat.finalStack),
    rating_changes: row.rated
      ? seats.map(seat => ({
          name: seat.ratingName ?? seat.name,
          before: seat.ratingBefore ?? 0,
          after: seat.ratingAfter ?? 0,
        }))
      : null,
    hands: hands.map(hand => {
      const holeCards = dealtHoleCards(row.seed, hand, inPlay);
      inPlay = hand.stacks.map(stack => stack > 0);
      return {
        hand_number: hand.handNumber,
        blinds:
          settings.blind_every === null
            ? [1, 2]
            : blindsAt(hand.handNumber, settings.blind_every),
        button_seat: asSeat(hand.buttonSeat),
        board: hand.board,
        hole_cards: holeCards,
        events: eventsByHand.get(hand.handNumber) ?? [],
        winner_seat: hand.winnerSeat === null ? null : asSeat(hand.winnerSeat),
        pot: hand.pot,
        // A hand from before T40 had one pot: the winner's, or split.
        pots: (
          hand.pots ?? [
            {
              amount: hand.pot,
              winner_seats:
                hand.winnerSeat === null ? [0, 1] : [hand.winnerSeat],
            },
          ]
        ).map(pot => ({ ...pot, winner_seats: pot.winner_seats.map(asSeat) })),
        ended_by: hand.endedBy,
        stacks: hand.stacks,
      };
    }),
  };
}

// Every seat dealt in, by seat (A13): the cards shown at showdown, else the
// public seed deals them again; `null` for a seat already out.
function dealtHoleCards(
  seed: string,
  hand: typeof matchHands.$inferSelect,
  inPlay: boolean[],
) {
  const dealt = inPlay.flatMap((playing, seat) => (playing ? [seat] : []));
  const deal = dealTable(seed, hand.handNumber, dealt.length).holeCards;
  return inPlay.map((_, seat) => {
    const k = dealt.indexOf(seat);
    return hand.holeCards?.[seat] ?? (k === -1 ? null : deal[k]);
  });
}
