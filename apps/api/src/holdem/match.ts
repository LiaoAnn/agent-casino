import type { Card } from './cards';
import { compareHands, evaluateHand } from './hand';
import { dealHand } from './shuffle';

export type Seat = 0 | 1;
export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export interface MatchConfig {
  seed: string;
  startingStack: number;
  /** Blinds double after every this many hands (holdem-rules 賽制). */
  blindEvery: number;
  /** The safety cap: after this hand the bigger stack wins. */
  maxHands: number;
}

export type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  /** `amount` is the street total to raise to, not the extra chips. */
  | { type: 'raise'; amount: number };

export type LegalAction =
  | { type: 'fold' }
  | { type: 'check' }
  /** `amount` is the chips to add (all-in when the stack is short). */
  | { type: 'call'; amount: number }
  /** Street totals; `max` is all-in. */
  | { type: 'raise'; min: number; max: number };

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

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];
/** Board cards showing on each street. */
const BOARD_SIZE: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

export const otherSeat = (seat: Seat): Seat => (seat === 0 ? 1 : 0);

/** [small, big] for hand `handNumber` (from 1): 1/2, doubling every `blindEvery` hands. */
export function blindsAt(
  handNumber: number,
  blindEvery: number,
): [number, number] {
  const small = 2 ** Math.floor((handNumber - 1) / blindEvery);
  return [small, 2 * small];
}

const bigBlind = (state: MatchState) =>
  blindsAt(state.handNumber, state.config.blindEvery)[1];

function checkRange(name: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be an integer from ${min} to ${max}: ${value}`,
    );
  }
}

/** Deals hand 1 and posts its blinds. Throws RangeError on a bad config. */
export function startMatch(config: MatchConfig): MatchState {
  // dealHand checks the seed.
  const { startingStack, blindEvery, maxHands } = config;
  checkRange('startingStack', startingStack, 10, 2000);
  checkRange('blindEvery', blindEvery, 1, 50);
  checkRange('maxHands', maxHands, 1, 200);
  const state = dealNextHand(
    { ...config },
    1,
    [startingStack, startingStack],
    null,
  );
  proceed(state, state.button, []);
  return state;
}

/** What the seat to act may do, in the order fold, check or call, raise. */
export function legalActions(state: MatchState): LegalAction[] {
  if (state.toAct === null) return [];
  const seat = state.toAct;
  const stack = state.stacks[seat];
  const toCall = Math.max(...state.bets) - state.bets[seat];
  const actions: LegalAction[] = [{ type: 'fold' }];
  actions.push(
    toCall === 0
      ? { type: 'check' }
      : { type: 'call', amount: Math.min(toCall, stack) },
  );
  // Heads-up, a short all-in can only come from a player who is then all-in,
  // so "the opponent has chips" also covers "a short all-in doesn't reopen".
  if (stack > toCall && state.stacks[otherSeat(seat)] > 0) {
    const allIn = state.bets[seat] + stack;
    const fullRaise = Math.max(...state.bets) + state.minRaise;
    actions.push({
      type: 'raise',
      min: Math.min(fullRaise, allIn),
      max: allIn,
    });
  }
  return actions;
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
  if (state.over) {
    return {
      ok: false,
      code: 'match_over',
      message: 'The match is over; no more actions are accepted',
    };
  }
  if (seat !== state.toAct) {
    return {
      ok: false,
      code: 'not_your_turn',
      message: `It is seat ${state.toAct}'s turn, not seat ${seat}'s; wait for your turn`,
    };
  }
  const legal = matchLegal(action, legalActions(state));
  if (typeof legal === 'string') {
    return { ok: false, code: 'invalid_action', message: legal };
  }

  const next = structuredClone(state);
  const finishedHands: HandRecord[] = [];
  const event: HistoryEvent = { seat, street: next.street, type: action.type };
  next.acted[seat] = true;

  if (action.type === 'fold') {
    record(next, event, options);
    endHand(next, otherSeat(seat), 'fold', finishedHands);
    if (!next.over) proceed(next, next.button, finishedHands);
    return { ok: true, state: next, finishedHands };
  }
  if (legal.type === 'call') {
    event.amount = legal.amount;
    put(next, seat, legal.amount);
  }
  if (action.type === 'raise') {
    const raiseSize = action.amount - Math.max(...next.bets);
    if (raiseSize >= next.minRaise) next.minRaise = raiseSize;
    event.amount = action.amount;
    put(next, seat, action.amount - next.bets[seat]);
  }
  record(next, event, options);
  proceed(next, otherSeat(seat), finishedHands);
  return { ok: true, state: next, finishedHands };
}

/** The legal action `action` picks, or an English "how to fix it" message. */
function matchLegal(
  action: Action,
  legal: LegalAction[],
): LegalAction | string {
  const offered = legal.find(legal => legal.type === action.type);
  const choices = legal
    .map(legal =>
      legal.type === 'call'
        ? `call (adds ${legal.amount})`
        : legal.type === 'raise'
          ? `raise (amount ${legal.min} to ${legal.max})`
          : legal.type,
    )
    .join(', ');
  if (!offered) {
    return `${String(action.type)} is not allowed now; pick one of: ${choices}`;
  }
  if (offered.type === 'raise' && action.type === 'raise') {
    const { amount } = action;
    if (
      !Number.isInteger(amount) ||
      amount < offered.min ||
      amount > offered.max
    ) {
      const sent = amount === undefined ? 'no amount' : String(amount);
      return `Raise amount is the street total to raise to and must be a whole number from ${offered.min} to ${offered.max}; you sent ${sent}`;
    }
  }
  return offered;
}

function record(
  state: MatchState,
  event: HistoryEvent,
  options: { timeout?: boolean },
): void {
  if (options.timeout) event.timeout = true;
  state.history.push(event);
}

function put(state: MatchState, seat: Seat, chips: number): void {
  state.stacks[seat] -= chips;
  state.bets[seat] += chips;
  state.contributed[seat] += chips;
}

function needsAction(state: MatchState, seat: Seat): boolean {
  if (state.stacks[seat] === 0) return false;
  if (state.bets[seat] < Math.max(...state.bets)) return true;
  return !state.acted[seat] && state.stacks[otherSeat(seat)] > 0;
}

/**
 * Hands the turn to whoever must act, `first` before the other seat. When
 * nobody must, closes the street: deals the next one, or runs the board out
 * and shows down, then keeps going with the next hand.
 */
function proceed(
  state: MatchState,
  first: Seat,
  finishedHands: HandRecord[],
): void {
  let preferred = first;
  for (;;) {
    for (const seat of [preferred, otherSeat(preferred)]) {
      if (needsAction(state, seat)) {
        state.toAct = seat;
        return;
      }
    }
    const allIn = state.stacks[0] === 0 || state.stacks[1] === 0;
    if (allIn || state.street === 'river') {
      state.street = 'river';
      state.board = dealHand(state.config.seed, state.handNumber).board;
      endHand(state, showdownWinner(state), 'showdown', finishedHands);
      if (state.over) return;
      preferred = state.button;
    } else {
      state.street = STREETS[STREETS.indexOf(state.street) + 1];
      state.board = dealHand(state.config.seed, state.handNumber).board.slice(
        0,
        BOARD_SIZE[state.street],
      );
      state.bets = [0, 0];
      state.acted = [false, false];
      state.minRaise = bigBlind(state);
      preferred = otherSeat(state.button);
    }
  }
}

/** Gives back the part of the bigger street bet that wasn't matched. */
function returnUncalled(state: MatchState): void {
  const [a, b] = state.bets;
  if (a === b) return;
  const seat: Seat = a > b ? 0 : 1;
  const excess = Math.abs(a - b);
  state.bets[seat] -= excess;
  state.contributed[seat] -= excess;
  state.stacks[seat] += excess;
}

function showdownWinner(state: MatchState): Seat | null {
  const [a, b] = state.holeCards.map(cards =>
    evaluateHand([...cards, ...state.board]),
  );
  const order = compareHands(a, b);
  return order === 0 ? null : order > 0 ? 0 : 1;
}

/**
 * Pays the pot, records the hand, then either ends the match (keeping the
 * final hand on show) or deals the next hand.
 */
function endHand(
  state: MatchState,
  winner: Seat | null,
  endedBy: 'fold' | 'showdown',
  finishedHands: HandRecord[],
): void {
  returnUncalled(state);
  const pot = state.contributed[0] + state.contributed[1];
  if (winner === null) {
    const half = Math.floor(pot / 2);
    const nonButton = otherSeat(state.button);
    state.stacks[state.button] += half;
    state.stacks[nonButton] += pot - half;
  } else {
    state.stacks[winner] += pot;
  }
  const lastHand: LastHand = {
    hand_number: state.handNumber,
    blinds: blindsAt(state.handNumber, state.config.blindEvery),
    winner_seat: winner,
    pot,
    ended_by: endedBy,
    board: [...state.board],
    hole_cards:
      endedBy === 'showdown'
        ? [[...state.holeCards[0]], [...state.holeCards[1]]]
        : null,
    stacks: [...state.stacks],
  };
  finishedHands.push({
    ...structuredClone(lastHand),
    button_seat: state.button,
    events: structuredClone(state.history),
  });

  const over =
    state.handNumber >= state.config.maxHands ||
    state.stacks[0] === 0 ||
    state.stacks[1] === 0;
  if (over) {
    Object.assign(state, {
      bets: [0, 0],
      contributed: [0, 0],
      toAct: null,
      over: true,
      lastHand,
    });
    return;
  }
  Object.assign(
    state,
    dealNextHand(state.config, state.handNumber + 1, state.stacks, lastHand),
  );
}

/** A new hand with its blinds posted; short stacks post what they have. */
function dealNextHand(
  config: MatchConfig,
  handNumber: number,
  stacks: [number, number],
  lastHand: LastHand | null,
): MatchState {
  const button: Seat = handNumber % 2 === 1 ? 0 : 1;
  const [small, big] = blindsAt(handNumber, config.blindEvery);
  const state: MatchState = {
    config,
    handNumber,
    button,
    street: 'preflop',
    holeCards: dealHand(config.seed, handNumber).holeCards,
    board: [],
    stacks: [...stacks],
    bets: [0, 0],
    contributed: [0, 0],
    toAct: null,
    over: false,
    history: [],
    lastHand,
    acted: [false, false],
    minRaise: big,
  };
  for (const [seat, blind] of [
    [button, small],
    [otherSeat(button), big],
  ] as const) {
    const posted = Math.min(blind, state.stacks[seat]);
    put(state, seat, posted);
    state.history.push({
      seat,
      street: 'preflop',
      type: 'post_blind',
      amount: posted,
    });
  }
  return state;
}
