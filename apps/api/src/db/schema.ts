// D1 tables (casino-api skill: 資料與積分). Change this file, then run
// `pnpm db:generate` to write the migration; edit a generated migration only
// to add a data backfill the generator can't express (0005).
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { MATCH_END_REASONS } from '../contract/schemas';
import type { Card } from '../holdem/cards';

// The seat in first place alone; `draw` when first place is shared.
export const SEAT_RESULTS = [
  'seat0_win',
  'seat1_win',
  'seat2_win',
  'seat3_win',
  'seat4_win',
  'seat5_win',
  'draw',
  'void',
  'cancelled',
] as const;
export type SeatResult = (typeof SEAT_RESULTS)[number];

export interface RoomSettings {
  starting_stack: number;
  blind_every: number;
  max_hands: number;
  turn_seconds: number;
}

/** What rows written before T34 hold: a fixed number of hands, blinds 1/2. */
export interface LegacySettings {
  hands: number;
  turn_seconds: number;
  starting_stack: number;
}

/** One pot of a hand as the match record shows it (A25). */
export interface StoredPot {
  amount: number;
  /** Ascending. */
  winner_seats: number[];
}

// Only finished matches are written, so `result` is also the room's status:
// void and cancelled are the two that end without a winner.
export const matches = sqliteTable(
  'matches',
  {
    // match_id = room_id (A14).
    matchId: text('match_id').primaryKey(),
    settings: text('settings', { mode: 'json' })
      .$type<RoomSettings | LegacySettings>()
      .notNull(),
    // Opaque: a 64-hex-character secret once T20 lands (holdem-rules 種子與洗牌).
    seed: text('seed').notNull(),
    result: text('result', { enum: SEAT_RESULTS }).notNull(),
    endReason: text('end_reason', { enum: MATCH_END_REASONS }),
    rated: integer('rated', { mode: 'boolean' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }).notNull(),
  },
  t => [index('matches_ended_at_idx').on(t.endedAt, t.matchId)],
);

// One row per seat of a finished match (T40); migration 0005 moved the two
// seats of every earlier match here.
export const matchSeats = sqliteTable(
  'match_seats',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.matchId),
    seat: integer('seat').notNull(),
    // Spelled as the player typed it in this room.
    name: text('name').notNull(),
    // What the seat was shown as (A20); null in rows from before T35, which
    // show the name instead.
    displayName: text('display_name'),
    finalStack: integer('final_stack').notNull(),
    // null when the match is void or cancelled.
    place: integer('place'),
    // Whole-number Elo around a rated match (A15), under the leaderboard's
    // spelling of the name; null when unrated.
    ratingName: text('rating_name'),
    ratingBefore: integer('rating_before'),
    ratingAfter: integer('rating_after'),
  },
  t => [primaryKey({ columns: [t.matchId, t.seat] })],
);

// One row per finished hand: what the match record shows besides the events.
export const matchHands = sqliteTable(
  'match_hands',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.matchId),
    handNumber: integer('hand_number').notNull(),
    buttonSeat: integer('button_seat').notNull(),
    board: text('board', { mode: 'json' }).$type<Card[]>().notNull(),
    // Only for hands that went to showdown, by seat; a seat that folded or
    // was out is null. Folded hands store none.
    holeCards: text('hole_cards', { mode: 'json' }).$type<
      ([Card, Card] | null)[]
    >(),
    // The seat that won every pot alone; null otherwise.
    winnerSeat: integer('winner_seat'),
    pot: integer('pot').notNull(),
    // null in rows from before T40: one pot, to winner_seat or split.
    pots: text('pots', { mode: 'json' }).$type<StoredPot[]>(),
    endedBy: text('ended_by', { enum: ['fold', 'showdown'] }).notNull(),
    stacks: text('stacks', { mode: 'json' }).$type<number[]>().notNull(),
  },
  t => [primaryKey({ columns: [t.matchId, t.handNumber] })],
);

// Every step of every hand, blinds included, in order: with the seed this
// replays the match (AGENTS.md rule 6).
export const matchEvents = sqliteTable(
  'match_events',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.matchId),
    handNumber: integer('hand_number').notNull(),
    // Position within the hand, from 0.
    seq: integer('seq').notNull(),
    seat: integer('seat').notNull(),
    street: text('street', {
      enum: ['preflop', 'flop', 'turn', 'river'],
    }).notNull(),
    type: text('type', {
      enum: ['post_blind', 'fold', 'check', 'call', 'raise', 'leave'],
    }).notNull(),
    amount: integer('amount'),
    timeout: integer('timeout', { mode: 'boolean' }).notNull(),
    // What the seat wrote with this step (A16). Only its own watch link shows
    // it; never /v1/matches.
    note: text('note'),
  },
  t => [primaryKey({ columns: [t.matchId, t.handNumber, t.seq] })],
);

// Keyed by the lowercased name; `name` keeps the first spelling seen (A14).
export const ratings = sqliteTable(
  'ratings',
  {
    nameKey: text('name_key').primaryKey(),
    name: text('name').notNull(),
    // The display name of the name's latest match (A20); null until a match
    // after T35, which shows the name instead.
    displayName: text('display_name'),
    // Unrounded; responses round it (A15).
    rating: real('rating').notNull(),
    games: integer('games').notNull(),
    wins: integer('wins').notNull(),
    losses: integer('losses').notNull(),
    draws: integer('draws').notNull(),
  },
  // In the leaderboard's order, so it reads its 100 rows instead of every
  // name (D1 bills the rows a query scans; T22).
  t => [index('ratings_rank_idx').on(sql`${t.rating} desc`, t.nameKey)],
);

// Lowercased names.
export const bans = sqliteTable('bans', {
  nameKey: text('name_key').primaryKey(),
});
