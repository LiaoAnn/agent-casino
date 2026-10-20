// Writing a finished match (casino-api skill: 資料與積分, A10).
import { asc, eq, getTableColumns, inArray } from 'drizzle-orm';
import { defaultDisplayName, type MatchDetail } from '../contract/schemas';
import type { TableHandRecord } from '../holdem/table';
import type { Db } from './client';
import { INITIAL_RATING, placesEloUpdate } from './elo';
import {
  matchEvents,
  matches,
  matchHands,
  matchSeats,
  type RoomSettings,
  ratings,
  type SeatResult,
} from './schema';

export interface MatchRecordInput {
  /** = room_id. */
  match_id: string;
  /** By seat (2–6), spelled as typed in this room. */
  players: string[];
  /** What people saw of each seat (A20); the names when left out. */
  display_names?: string[];
  settings: RoomSettings;
  /** Stored as is. */
  seed: string;
  /** From the seats' point of view; must agree with `places`. */
  result: SeatResult;
  /**
   * Each seat's place (1224 ties), `null` for void and cancelled. Heads-up
   * callers may leave it out: it follows from `result`.
   */
  places?: number[] | null;
  /** Absent for callers predating T44; never infer a historical reason. */
  end_reason?: MatchDetail['end_reason'];
  /** ISO-8601 UTC. */
  ended_at: string;
  final_stacks: number[];
  /** The engine's finished hands, in order; heads-up ones may lack `pots`. */
  hands: (Omit<TableHandRecord, 'pots'> & {
    pots?: TableHandRecord['pots'];
  })[];
  /** Each seat's notes (A16); `seq` is the step's position in the hand's events. */
  notes?: { hand_number: number; seq: number; note: string }[];
}

/** The `ratings` field of `match_over` (A15): by seat, null when unrated. */
type MatchRatings = { name: string; rating: number; change: number }[] | null;

export interface RecordedMatch {
  rated: boolean;
  ratings: MatchRatings;
}

const HOUSE_BOT = 'house-bot';
const nameKey = (name: string) => name.toLowerCase();

// D1 binds at most 100 parameters per statement.
const MAX_PARAMS = 100;

function chunks<T>(rows: T[], columnCount: number): T[][] {
  const size = Math.floor(MAX_PARAMS / columnCount);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const renameRated = (db: Db, key: string, displayName: string) =>
  db.update(ratings).set({ displayName }).where(eq(ratings.nameKey, key));

const upsertRating = (db: Db, row: typeof ratings.$inferInsert) => {
  const { nameKey: _key, name: _name, ...counts } = row;
  return db
    .insert(ratings)
    .values(row)
    .onConflictDoUpdate({ target: ratings.nameKey, set: counts });
};

// What a seat-angle result says about first place.
const firstPlaceOf = (result: SeatResult) =>
  result === 'void' || result === 'cancelled'
    ? null
    : result === 'draw'
      ? 'shared'
      : Number(result.slice(4, 5));

// Heads-up callers send only the result (T40 keeps them working).
const headsUpPlaces = (result: SeatResult): number[] | null => {
  const first = firstPlaceOf(result);
  return first === null
    ? null
    : first === 'shared'
      ? [1, 1]
      : first === 0
        ? [1, 2]
        : [2, 1];
};

function checkInput(input: MatchRecordInput): number[] | null {
  const n = input.players.length;
  if (n < 2 || n > 6) throw new RangeError(`${n} seats; a match has 2 to 6`);
  const places =
    input.places === undefined && n === 2
      ? headsUpPlaces(input.result)
      : input.places;
  if (places === undefined) throw new RangeError('places is missing');
  for (const [field, list] of [
    ['display_names', input.display_names],
    ['final_stacks', input.final_stacks],
    ['places', places],
  ] as const) {
    if (list && list.length !== n)
      throw new RangeError(
        `${field} has ${list.length} entries for ${n} seats`,
      );
  }
  const keys = input.players.map(nameKey).filter(key => key !== HOUSE_BOT);
  if (new Set(keys).size !== keys.length)
    throw new RangeError(`A name sits twice: ${input.players.join(', ')}`);
  const first = firstPlaceOf(input.result);
  const firsts = (places ?? []).flatMap((place, seat) =>
    place === 1 ? [seat] : [],
  );
  const agrees =
    first === null
      ? places === null
      : places !== null &&
        (first === 'shared' ? firsts.length > 1 : firsts.join() === `${first}`);
  if (!agrees)
    throw new RangeError(
      `result ${input.result} disagrees with places ${JSON.stringify(places)}`,
    );
  return places;
}

/**
 * Stores a finished match and, when it is rated, every seat's new Elo, in one
 * D1 batch. Reads the ratings first, so call it only from the Matchmaker DO,
 * which runs one at a time (A10). A retry with a stored match_id writes
 * nothing and returns the first answer. Throws RangeError, writing nothing,
 * when the seats don't add up.
 */
export async function recordMatch(
  db: Db,
  input: MatchRecordInput,
): Promise<RecordedMatch> {
  const places = checkInput(input);
  const shown =
    input.display_names ?? input.players.map(name => defaultDisplayName(name));
  const keys = input.players.map(nameKey);
  const endedAt = new Date(input.ended_at);
  if (Number.isNaN(endedAt.getTime())) {
    throw new RangeError(`Bad ended_at ${input.ended_at}`);
  }
  const rated = places !== null && !keys.includes(HOUSE_BOT);

  const [stored, rows] = await db.batch([
    db
      .select({
        rated: matches.rated,
        name: matchSeats.ratingName,
        before: matchSeats.ratingBefore,
        after: matchSeats.ratingAfter,
      })
      .from(matches)
      .innerJoin(matchSeats, eq(matchSeats.matchId, matches.matchId))
      .where(eq(matches.matchId, input.match_id))
      .orderBy(asc(matchSeats.seat)),
    db.select().from(ratings).where(inArray(ratings.nameKey, keys)),
  ]);
  if (stored.length > 0) {
    return {
      rated: stored[0].rated,
      ratings: stored[0].rated
        ? stored.map(seat => ({
            name: seat.name ?? '',
            rating: seat.after ?? 0,
            change: (seat.after ?? 0) - (seat.before ?? 0),
          }))
        : null,
    };
  }

  // An unrated match still renames whoever is on the leaderboard (A20).
  let ratingWrites: (
    | ReturnType<typeof upsertRating>
    | ReturnType<typeof renameRated>
  )[] = keys.map((key, seat) => renameRated(db, key, shown[seat]));
  let changes: { name: string; before: number; after: number }[] | null = null;
  if (rated) {
    const next = keys.map((key, seat) => {
      const row = rows.find(r => r.nameKey === key);
      return {
        nameKey: key,
        // The first spelling seen stays (A14).
        name: row?.name ?? input.players[seat],
        displayName: shown[seat],
        rating: row?.rating ?? INITIAL_RATING,
        games: (row?.games ?? 0) + 1,
        wins: row?.wins ?? 0,
        losses: row?.losses ?? 0,
        draws: row?.draws ?? 0,
      };
    });
    const before = next.map(row => row.rating);
    const after = placesEloUpdate(before, places);
    const shared = places.filter(place => place === 1).length > 1;
    next.forEach((row, seat) => {
      row.rating = after[seat];
      // A seat's result in match_over: alone first, shared first, or not (T40).
      if (places[seat] !== 1) row.losses += 1;
      else if (shared) row.draws += 1;
      else row.wins += 1;
    });
    ratingWrites = next.map(row => upsertRating(db, row));
    changes = next.map((row, seat) => ({
      name: row.name,
      before: Math.round(before[seat]),
      after: Math.round(after[seat]),
    }));
  }

  const seatRows = input.players.map((name, seat) => ({
    matchId: input.match_id,
    seat,
    name,
    displayName: shown[seat],
    finalStack: input.final_stacks[seat],
    place: places?.[seat] ?? null,
    ratingName: changes?.[seat].name ?? null,
    ratingBefore: changes?.[seat].before ?? null,
    ratingAfter: changes?.[seat].after ?? null,
  }));
  const handRows = input.hands.map(hand => ({
    matchId: input.match_id,
    handNumber: hand.hand_number,
    buttonSeat: hand.button_seat,
    board: hand.board,
    // Folded hands never reveal hole cards (A13).
    holeCards: hand.ended_by === 'showdown' ? hand.hole_cards : null,
    winnerSeat: hand.winner_seat,
    pot: hand.pot,
    pots:
      hand.pots?.map(pot => ({
        amount: pot.amount,
        winner_seats: pot.winners,
      })) ?? null,
    endedBy: hand.ended_by,
    stacks: hand.stacks,
  }));
  const notes = new Map(
    (input.notes ?? []).map(n => [`${n.hand_number}:${n.seq}`, n.note]),
  );
  const eventRows = input.hands.flatMap(hand =>
    hand.events.map((event, seq) => ({
      matchId: input.match_id,
      handNumber: hand.hand_number,
      seq,
      seat: event.seat,
      street: event.street,
      type: event.type,
      amount: event.amount ?? null,
      timeout: event.timeout === true,
      note: notes.get(`${hand.hand_number}:${seq}`) ?? null,
    })),
  );

  await db.batch([
    db.insert(matches).values({
      matchId: input.match_id,
      settings: input.settings,
      seed: input.seed,
      result: input.result,
      endReason: input.end_reason ?? null,
      rated,
      endedAt,
    }),
    db.insert(matchSeats).values(seatRows),
    ...chunks(handRows, Object.keys(getTableColumns(matchHands)).length).map(
      rows => db.insert(matchHands).values(rows),
    ),
    ...chunks(eventRows, Object.keys(getTableColumns(matchEvents)).length).map(
      rows => db.insert(matchEvents).values(rows),
    ),
    ...ratingWrites,
  ]);
  return {
    rated,
    ratings:
      changes?.map(c => ({
        name: c.name,
        rating: c.after,
        change: c.after - c.before,
      })) ?? null,
  };
}
