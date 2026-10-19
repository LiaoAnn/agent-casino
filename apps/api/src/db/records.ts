// Writing a finished match (casino-api skill: 資料與積分, A10).
import { eq, getTableColumns, inArray } from 'drizzle-orm';
import { defaultDisplayName, type MatchDetail } from '../contract/schemas';
import type { HandRecord } from '../holdem/match';
import type { Db } from './client';
import { eloUpdate, INITIAL_RATING } from './elo';
import {
  matchEvents,
  matches,
  matchHands,
  type RatingChanges,
  type RoomSettings,
  ratings,
  type SeatResult,
} from './schema';

export interface MatchRecordInput {
  /** = room_id. */
  match_id: string;
  /** Seat 0, seat 1, spelled as typed in this room. */
  players: [string, string];
  /** What people saw of seat 0 and seat 1 (A20); the names when left out. */
  display_names?: [string, string];
  settings: RoomSettings;
  /** Stored as is. */
  seed: string;
  /** From the seats' point of view. */
  result: SeatResult;
  /** Absent for callers predating T44; never infer a historical reason. */
  end_reason?: MatchDetail['end_reason'];
  /** ISO-8601 UTC. */
  ended_at: string;
  final_stacks: [number, number];
  /** The engine's finished hands, in order. */
  hands: HandRecord[];
  /** Each seat's notes (A16); `seq` is the step's position in the hand's events. */
  notes?: { hand_number: number; seq: number; note: string }[];
}

/** The `ratings` field of `match_over` (A15). */
type MatchRatings =
  | [
      { name: string; rating: number; change: number },
      { name: string; rating: number; change: number },
    ]
  | null;

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

const toMatchRatings = (changes: RatingChanges | null): MatchRatings =>
  changes === null
    ? null
    : [
        {
          name: changes[0].name,
          rating: changes[0].after,
          change: changes[0].after - changes[0].before,
        },
        {
          name: changes[1].name,
          rating: changes[1].after,
          change: changes[1].after - changes[1].before,
        },
      ];

const renameRated = (db: Db, key: string, displayName: string) =>
  db.update(ratings).set({ displayName }).where(eq(ratings.nameKey, key));

const upsertRating = (db: Db, row: typeof ratings.$inferInsert) => {
  const { nameKey: _key, name: _name, ...counts } = row;
  return db
    .insert(ratings)
    .values(row)
    .onConflictDoUpdate({ target: ratings.nameKey, set: counts });
};

/**
 * Stores a finished match and, when it is rated, both players' new Elo, in
 * one D1 batch. Reads the ratings first, so call it only from the Matchmaker
 * DO, which runs one at a time (A10). A retry with a stored match_id writes
 * nothing and returns the first answer.
 */
export async function recordMatch(
  db: Db,
  input: MatchRecordInput,
): Promise<RecordedMatch> {
  const shown = input.display_names ?? [
    defaultDisplayName(input.players[0]),
    defaultDisplayName(input.players[1]),
  ];
  const keys = [nameKey(input.players[0]), nameKey(input.players[1])] as const;
  if (keys[0] === keys[1]) {
    throw new RangeError(`Both seats are ${input.players[0]}`);
  }
  const endedAt = new Date(input.ended_at);
  if (Number.isNaN(endedAt.getTime())) {
    throw new RangeError(`Bad ended_at ${input.ended_at}`);
  }
  const score =
    input.result === 'seat0_win'
      ? 1
      : input.result === 'seat1_win'
        ? 0
        : input.result === 'draw'
          ? 0.5
          : null;
  const rated = score !== null && !keys.includes(HOUSE_BOT);

  const [[stored], rows] = await db.batch([
    db
      .select({ rated: matches.rated, ratingChanges: matches.ratingChanges })
      .from(matches)
      .where(eq(matches.matchId, input.match_id)),
    db
      .select()
      .from(ratings)
      .where(inArray(ratings.nameKey, [...keys])),
  ]);
  if (stored) {
    return {
      rated: stored.rated,
      ratings: toMatchRatings(stored.ratingChanges),
    };
  }

  let ratingChanges: RatingChanges | null = null;
  // An unrated match still renames whoever is on the leaderboard (A20).
  let ratingWrites: (
    | ReturnType<typeof upsertRating>
    | ReturnType<typeof renameRated>
  )[] = keys.map((key, n) => renameRated(db, key, shown[n as 0 | 1]));
  if (rated) {
    const seat = (n: 0 | 1) => {
      const row = rows.find(r => r.nameKey === keys[n]);
      return {
        nameKey: keys[n],
        // The first spelling seen stays (A14).
        name: row?.name ?? input.players[n],
        displayName: shown[n],
        rating: row?.rating ?? INITIAL_RATING,
        games: (row?.games ?? 0) + 1,
        wins: row?.wins ?? 0,
        losses: row?.losses ?? 0,
        draws: row?.draws ?? 0,
      };
    };
    const next = [seat(0), seat(1)] as const;
    const before = [next[0].rating, next[1].rating] as const;
    [next[0].rating, next[1].rating] = eloUpdate(before[0], before[1], score);
    const tally = (row: (typeof next)[0], seatScore: number) => {
      if (seatScore === 1) row.wins += 1;
      else if (seatScore === 0) row.losses += 1;
      else row.draws += 1;
    };
    tally(next[0], score);
    tally(next[1], 1 - score);
    ratingWrites = next.map(row => upsertRating(db, row));
    const change = (n: 0 | 1) => ({
      name: next[n].name,
      before: Math.round(before[n]),
      after: Math.round(next[n].rating),
    });
    ratingChanges = [change(0), change(1)];
  }

  const handRows = input.hands.map(hand => ({
    matchId: input.match_id,
    handNumber: hand.hand_number,
    buttonSeat: hand.button_seat,
    board: hand.board,
    // Folded hands never reveal hole cards (A13).
    holeCards: hand.ended_by === 'showdown' ? hand.hole_cards : null,
    winnerSeat: hand.winner_seat,
    pot: hand.pot,
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
      player0: input.players[0],
      player1: input.players[1],
      display0: shown[0],
      display1: shown[1],
      settings: input.settings,
      seed: input.seed,
      result: input.result,
      endReason: input.end_reason ?? null,
      rated,
      finalStacks: input.final_stacks,
      ratingChanges,
      endedAt,
    }),
    ...chunks(handRows, Object.keys(getTableColumns(matchHands)).length).map(
      rows => db.insert(matchHands).values(rows),
    ),
    ...chunks(eventRows, Object.keys(getTableColumns(matchEvents)).length).map(
      rows => db.insert(matchEvents).values(rows),
    ),
    ...ratingWrites,
  ]);
  return { rated, ratings: toMatchRatings(ratingChanges) };
}
