// D1 tables (casino-api skill: 資料與積分). Change this file, then run
// `pnpm db:generate` to write the migration; never edit migrations by hand.
import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type { Card } from '../holdem/cards';

export const SEAT_RESULTS = [
  'seat0_win',
  'seat1_win',
  'draw',
  'void',
  'cancelled',
] as const;
export type SeatResult = (typeof SEAT_RESULTS)[number];

export interface RoomSettings {
  hands: number;
  turn_seconds: number;
  starting_stack: number;
}

/** Whole-number ratings, as the match record shows them (A15). */
export type RatingChanges = [
  { name: string; before: number; after: number },
  { name: string; before: number; after: number },
];

// Only finished matches are written, so `result` is also the room's status:
// void and cancelled are the two that end without a winner.
export const matches = sqliteTable(
  'matches',
  {
    // match_id = room_id (A14).
    matchId: text('match_id').primaryKey(),
    // Spelled as the players typed them in this room.
    player0: text('player0').notNull(),
    player1: text('player1').notNull(),
    settings: text('settings', { mode: 'json' })
      .$type<RoomSettings>()
      .notNull(),
    // Opaque: a 64-hex-character secret once T20 lands (holdem-rules 種子與洗牌).
    seed: text('seed').notNull(),
    result: text('result', { enum: SEAT_RESULTS }).notNull(),
    rated: integer('rated', { mode: 'boolean' }).notNull(),
    finalStacks: text('final_stacks', { mode: 'json' })
      .$type<[number, number]>()
      .notNull(),
    ratingChanges: text('rating_changes', {
      mode: 'json',
    }).$type<RatingChanges>(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }).notNull(),
  },
  t => [index('matches_ended_at_idx').on(t.endedAt, t.matchId)],
);

// One row per finished hand: what the match record shows besides the events.
export const matchHands = sqliteTable(
  'match_hands',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.matchId),
    handNumber: integer('hand_number').notNull(),
    buttonSeat: integer('button_seat').$type<0 | 1>().notNull(),
    board: text('board', { mode: 'json' }).$type<Card[]>().notNull(),
    // Only for hands that went to showdown; folded hands never store them.
    holeCards: text('hole_cards', { mode: 'json' }).$type<
      [[Card, Card], [Card, Card]]
    >(),
    // null is a split pot.
    winnerSeat: integer('winner_seat').$type<0 | 1>(),
    pot: integer('pot').notNull(),
    endedBy: text('ended_by', { enum: ['fold', 'showdown'] }).notNull(),
    stacks: text('stacks', { mode: 'json' })
      .$type<[number, number]>()
      .notNull(),
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
    seat: integer('seat').$type<0 | 1>().notNull(),
    street: text('street', {
      enum: ['preflop', 'flop', 'turn', 'river'],
    }).notNull(),
    type: text('type', {
      enum: ['post_blind', 'fold', 'check', 'call', 'raise'],
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
