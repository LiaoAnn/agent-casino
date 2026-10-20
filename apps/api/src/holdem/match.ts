import type { Card } from './cards';
import {
  type Action,
  applyTableAction,
  blindsAt,
  type LegalAction,
  type Street,
  startTable,
  type TableHandRecord,
  type TableLastHand,
  type TableState,
  tableLegalActions,
} from './table';

// The heads-up API the Room DO still uses, over the table engine in
// `table.ts`. Its output is exactly what it was before the table engine
// (`heads-up-golden.test.ts`). T38 moves the Room DO to `table.ts` and
// deletes this adapter.

export type { Action, LegalAction, Street };
export { blindsAt };

export type Seat = 0 | 1;

export interface MatchConfig {
  seed: string;
  startingStack: number;
  /** Blinds double after every this many hands (holdem-rules 賽制). */
  blindEvery: number;
  /** The safety cap: after this hand the bigger stack wins. */
  maxHands: number;
}

export interface HistoryEvent {
  seat: Seat;
  street: Street;
  type: 'post_blind' | 'fold' | 'check' | 'call' | 'raise';
  /** post_blind: chips posted; call: chips added; raise: street total. */
  amount?: number;
  timeout?: true;
}

/** The `last_hand` response shape (casino-api A15). */
export interface LastHand {
  hand_number: number;
  /** [small, big] as scheduled; a short stack posts less. */
  blinds: [number, number];
  /** `null` is a split pot. */
  winner_seat: Seat | null;
  /** Chips won: everything put in, minus any uncalled bet returned. */
  pot: number;
  ended_by: 'fold' | 'showdown';
  /** The board cards revealed when the hand ended. */
  board: Card[];
  /** Only at showdown. */
  hole_cards: [[Card, Card], [Card, Card]] | null;
  /** After the pot was paid. */
  stacks: [number, number];
}

/** One finished hand as the match record stores it (casino-api A15). */
export interface HandRecord extends LastHand {
  button_seat: Seat;
  events: HistoryEvent[];
}

/** Plain JSON data: store it as is, or rebuild it from the seed and actions. */
export interface MatchState {
  config: MatchConfig;
  handNumber: number;
  /** Posts the small blind and acts first preflop. */
  button: Seat;
  street: Street;
  holeCards: [[Card, Card], [Card, Card]];
  /** Revealed so far. */
  board: Card[];
  /** Chips behind, not counting chips already put in this hand. */
  stacks: [number, number];
  /** Put in on the current street. */
  bets: [number, number];
  /** Put in this hand so far, including `bets`. */
  contributed: [number, number];
  /** `null` only when the match is over. */
  toAct: Seat | null;
  over: boolean;
  /** This hand only, starting with the two blinds. */
  history: HistoryEvent[];
  lastHand: LastHand | null;
  /** Who has acted on this street (blinds don't count). */
  acted: [boolean, boolean];
  /** Size of the last full raise on this street; the big blind when none. */
  minRaise: number;
}

export type ApplyResult =
  | { ok: true; state: MatchState; finishedHands: HandRecord[] }
  | {
      ok: false;
      code: 'not_your_turn' | 'match_over' | 'invalid_action';
      message: string;
    };

export const otherSeat = (seat: Seat): Seat => (seat === 0 ? 1 : 0);

/** Deals hand 1 and posts its blinds. Throws RangeError on a bad config. */
export function startMatch(config: MatchConfig): MatchState {
  return toMatch(startTable({ ...config, players: 2 }));
}

/** What the seat to act may do, in the order fold, check or call, raise. */
export function legalActions(state: MatchState): LegalAction[] {
  return tableLegalActions(toTable(state));
}

/**
 * Applies one action and returns a new state; the input is never changed.
 * A finished hand is paid out and the next one dealt in the same call, and
 * hands nobody can act in are run out, so `finishedHands` may hold several.
 */
export function applyAction(
  state: MatchState,
  seat: Seat,
  action: Action,
  options: { timeout?: boolean } = {},
): ApplyResult {
  const result = applyTableAction(toTable(state), seat, action, options);
  if (!result.ok) return result;
  return {
    ok: true,
    state: toMatch(result.state),
    finishedHands: result.finishedHands.map(toHandRecord),
  };
}

const pair = <T>([a, b]: T[]): [T, T] => [a, b];

function toMatch(table: TableState): MatchState {
  const { players: _players, ...config } = table.config;
  return {
    config,
    handNumber: table.handNumber,
    button: table.button as Seat,
    street: table.street,
    holeCards: pair(table.holeCards as [Card, Card][]),
    board: table.board,
    stacks: pair(table.stacks),
    bets: pair(table.bets),
    contributed: pair(table.contributed),
    toAct: table.toAct as Seat | null,
    over: table.over,
    history: table.history as HistoryEvent[],
    lastHand: table.lastHand && toLastHand(table.lastHand),
    acted: pair(table.acted),
    minRaise: table.minRaise,
  };
}

/**
 * Heads-up nobody is folded in a live state (a fold ends the hand), every
 * hand has one pot, and the adapter never asks the table who placed where.
 */
function toTable(match: MatchState): TableState {
  const last = match.lastHand;
  return {
    ...match,
    config: { ...match.config, players: 2 },
    lastHand: last && {
      ...last,
      pots: [
        {
          amount: last.pot,
          winners: last.winner_seat === null ? [0, 1] : [last.winner_seat],
        },
      ],
    },
    folded: [false, false],
    places: [null, null],
    taken: [0, 0],
  };
}

const toLastHand = (hand: TableLastHand): LastHand => ({
  hand_number: hand.hand_number,
  blinds: hand.blinds,
  winner_seat: hand.winner_seat as Seat | null,
  pot: hand.pot,
  ended_by: hand.ended_by,
  board: hand.board,
  hole_cards: hand.hole_cards && pair(hand.hole_cards as [Card, Card][]),
  stacks: pair(hand.stacks),
});

const toHandRecord = (hand: TableHandRecord): HandRecord => ({
  ...toLastHand(hand),
  button_seat: hand.button_seat as Seat,
  events: hand.events as HistoryEvent[],
});
