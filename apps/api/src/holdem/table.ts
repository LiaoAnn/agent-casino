import type { Card } from './cards';
import { compareHands, evaluateHand, type HandValue } from './hand';
import { dealTable } from './shuffle';

// The 2–6 seat engine (holdem-rules, T36). Heads-up is the 2-seat table;
// `heads-up-golden.test.ts` locks it to the engine before this one.

/** 0..players−1, in joining order; seats are always contiguous. */
export type TableSeat = number;
export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export interface TableConfig {
  seed: string;
  /** 2–6 players, all seated from hand 1. */
  players: number;
  startingStack: number;
  /** Blinds double after every this many hands (holdem-rules 賽制). */
  blindEvery: number;
  /** The safety cap: after this hand places go by stacks. */
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

export interface TableEvent {
  seat: TableSeat;
  street: Street;
  type: 'post_blind' | 'fold' | 'check' | 'call' | 'raise' | 'leave';
  /** post_blind: chips posted; call: chips added; raise: street total; leave: chips taken. */
  amount?: number;
  timeout?: true;
}

interface Pot {
  amount: number;
  /** Seats paid from this pot, ascending. */
  winners: TableSeat[];
}

export interface TableLastHand {
  hand_number: number;
  /** [small, big] as scheduled; a short stack posts less. */
  blinds: [number, number];
  /** The seat that won every pot alone; `null` otherwise. */
  winner_seat: TableSeat | null;
  /** Chips won in all pots: everything put in, minus any uncalled bet returned. */
  pot: number;
  /** Main pot first, then side pots. */
  pots: Pot[];
  ended_by: 'fold' | 'showdown';
  board: Card[];
  /** Only at showdown: cards of seats that had not folded, else `null`. */
  hole_cards: ([Card, Card] | null)[] | null;
  /** After the pots were paid (a seat that left shows 0). */
  stacks: number[];
}

export interface TableHandRecord extends TableLastHand {
  button_seat: TableSeat;
  events: TableEvent[];
}

/** Plain JSON data, one entry per seat in every array. */
export interface TableState {
  config: TableConfig;
  handNumber: number;
  button: TableSeat;
  street: Street;
  /** `null` for seats not dealt in this hand (out of the match). */
  holeCards: ([Card, Card] | null)[];
  board: Card[];
  /** Chips behind, not counting chips already put in this hand. */
  stacks: number[];
  /** Put in on the current street. */
  bets: number[];
  /** Put in this hand so far, including `bets`. */
  contributed: number[];
  /** `null` only when the match is over. */
  toAct: TableSeat | null;
  over: boolean;
  /** This hand only, starting with the two blinds. */
  history: TableEvent[];
  lastHand: TableLastHand | null;
  /** Who has acted on this street (blinds don't count). */
  acted: boolean[];
  /** Size of the last full raise on this street; the big blind when none. */
  minRaise: number;
  /** Folded (or left) in this hand. */
  folded: boolean[];
  /** Finishing place (1 is first); `null` while still at the table. */
  places: (number | null)[];
  /** Chips each seat took off the table when it left. */
  taken: number[];
}

type Rejection = {
  ok: false;
  code: 'not_your_turn' | 'match_over' | 'invalid_action';
  message: string;
};

export type TableApplyResult =
  | { ok: true; state: TableState; finishedHands: TableHandRecord[] }
  | Rejection;

export type TableReplayResult =
  | { ok: true; state: TableState; hands: TableHandRecord[] }
  | (Rejection & {
      /** Position in `events` of the first event the engine rejected. */
      index: number;
    });

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];
/** Board cards showing on each street. */
const BOARD_SIZE: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

/** [small, big] for hand `handNumber` (from 1): 1/2, doubling every `blindEvery` hands. */
export function blindsAt(
  handNumber: number,
  blindEvery: number,
): [number, number] {
  const small = 2 ** Math.floor((handNumber - 1) / blindEvery);
  return [small, 2 * small];
}

/**
 * The `blind_every` a room uses when none is given, by player count
 * (holdem-rules 人數 → blind_every 預設; `blind-every.test.ts` simulates it).
 */
export const DEFAULT_BLIND_EVERY: Readonly<Record<number, number>> = {
  2: 5,
  3: 5,
  4: 4,
  5: 3,
  6: 3,
};

const bigBlind = (state: TableState) =>
  blindsAt(state.handNumber, state.config.blindEvery)[1];

function checkRange(name: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be an integer from ${min} to ${max}: ${value}`,
    );
  }
}

const seats = (state: TableState) => state.stacks.map((_, seat) => seat);
const seated = (state: TableState, seat: TableSeat) =>
  state.places[seat] === null;
/** Still holding cards in this hand. */
const live = (state: TableState, seat: TableSeat) =>
  seated(state, seat) && !state.folded[seat];

/** The first seat after `from`, going up and round, that passes `test`. */
function nextSeat(
  state: TableState,
  from: TableSeat,
  test: (seat: TableSeat) => boolean,
): TableSeat {
  const n = state.stacks.length;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (test(seat)) return seat;
  }
  return from;
}

/** [small blind, big blind]: heads-up the button posts the small blind. */
function blindSeats(state: TableState): [TableSeat, TableSeat] {
  const inHand = (seat: TableSeat) => seated(state, seat);
  const small =
    seats(state).filter(inHand).length === 2
      ? state.button
      : nextSeat(state, state.button, inHand);
  return [small, nextSeat(state, small, inHand)];
}

/** Heads-up the button acts first preflop; otherwise the seat after the big blind. */
function firstPreflop(state: TableState): TableSeat {
  const [small, big] = blindSeats(state);
  return small === state.button
    ? state.button
    : nextSeat(state, big, seat => seated(state, seat));
}

/** Deals hand 1 and posts its blinds. Throws RangeError on a bad config. */
export function startTable(config: TableConfig): TableState {
  // dealTable checks the seed.
  const { players, startingStack, blindEvery, maxHands } = config;
  checkRange('players', players, 2, 6);
  checkRange('startingStack', startingStack, 10, 2000);
  checkRange('blindEvery', blindEvery, 1, 50);
  checkRange('maxHands', maxHands, 1, 100);
  const state = dealNextHand(
    { ...config },
    1,
    {
      stacks: Array(players).fill(startingStack),
      places: Array(players).fill(null),
      taken: Array(players).fill(0),
    },
    null,
    null,
  );
  proceed(state, firstPreflop(state), []);
  return state;
}

/** Another seat still holding cards and chips. */
const othersWithChips = (state: TableState, seat: TableSeat) =>
  seats(state).some(
    other => other !== seat && live(state, other) && state.stacks[other] > 0,
  );

/** What the seat to act may do, in the order fold, check or call, raise. */
export function tableLegalActions(state: TableState): LegalAction[] {
  if (state.toAct === null) return [];
  const seat = state.toAct;
  const stack = state.stacks[seat];
  const highest = Math.max(...state.bets);
  const toCall = highest - state.bets[seat];
  const actions: LegalAction[] = [{ type: 'fold' }];
  actions.push(
    toCall === 0
      ? { type: 'check' }
      : { type: 'call', amount: Math.min(toCall, stack) },
  );
  // A short all-in doesn't reopen the raise for a seat that has acted, but
  // short all-ins adding up to a full raise do (holdem-rules 加注權).
  const reopened = !state.acted[seat] || toCall >= state.minRaise;
  if (stack > toCall && othersWithChips(state, seat) && reopened) {
    const allIn = state.bets[seat] + stack;
    const fullRaise = highest + state.minRaise;
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
export function applyTableAction(
  state: TableState,
  seat: TableSeat,
  action: Action,
  options: { timeout?: boolean } = {},
): TableApplyResult {
  if (state.over) return matchOver();
  if (seat !== state.toAct) {
    return {
      ok: false,
      code: 'not_your_turn',
      message: `It is seat ${state.toAct}'s turn, not seat ${seat}'s; wait for your turn`,
    };
  }
  const legal = matchLegal(action, tableLegalActions(state));
  if (typeof legal === 'string') {
    return { ok: false, code: 'invalid_action', message: legal };
  }

  const next = structuredClone(state);
  const finishedHands: TableHandRecord[] = [];
  const event: TableEvent = { seat, street: next.street, type: action.type };
  next.acted[seat] = true;

  if (action.type === 'fold') {
    record(next, event, options);
    next.folded[seat] = true;
    afterFold(next, seat, finishedHands);
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
  proceed(
    next,
    nextSeat(next, seat, () => true),
    finishedHands,
  );
  return { ok: true, state: next, finishedHands };
}

/**
 * `seat` leaves now, in turn or not: it folds if still in the hand, its
 * chips in the pot stay there, the rest leave with it, and it takes the
 * last place among the seats still at the table.
 */
export function leaveTable(
  state: TableState,
  seat: TableSeat,
): TableApplyResult {
  if (state.over) return matchOver();
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.stacks.length) {
    return {
      ok: false,
      code: 'invalid_action',
      message: `There is no seat ${seat} at this table`,
    };
  }
  if (!seated(state, seat)) {
    return {
      ok: false,
      code: 'invalid_action',
      message: `Seat ${seat} is already out of the match`,
    };
  }
  const next = structuredClone(state);
  const finishedHands: TableHandRecord[] = [];
  const amount = next.stacks[seat];
  next.places[seat] = seats(next).filter(other => seated(next, other)).length;
  next.taken[seat] += amount;
  next.stacks[seat] = 0;
  next.folded[seat] = true;
  next.history.push({ seat, street: next.street, type: 'leave', amount });
  afterFold(next, seat, finishedHands);
  return { ok: true, state: next, finishedHands };
}

/** Rebuilds a table from its config and every event so far, blinds skipped. */
export function replayTable(
  config: TableConfig,
  events: TableEvent[],
): TableReplayResult {
  let state = startTable(config);
  const hands: TableHandRecord[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type === 'post_blind') continue;
    const result =
      event.type === 'leave'
        ? leaveTable(state, event.seat)
        : applyTableAction(
            state,
            event.seat,
            event.type === 'raise'
              ? { type: 'raise', amount: event.amount ?? Number.NaN }
              : { type: event.type },
            { timeout: event.timeout },
          );
    if (!result.ok) return { ...result, index };
    state = result.state;
    hands.push(...result.finishedHands);
  }
  return { ok: true, state, hands };
}

const matchOver = (): Rejection => ({
  ok: false,
  code: 'match_over',
  message: 'The match is over; no more actions are accepted',
});

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
  state: TableState,
  event: TableEvent,
  options: { timeout?: boolean },
): void {
  if (options.timeout) event.timeout = true;
  state.history.push(event);
}

function put(state: TableState, seat: TableSeat, chips: number): void {
  state.stacks[seat] -= chips;
  state.bets[seat] += chips;
  state.contributed[seat] += chips;
}

/** After `seat` folded or left: the last seat holding cards wins, or play goes on. */
function afterFold(
  state: TableState,
  seat: TableSeat,
  finishedHands: TableHandRecord[],
): void {
  const holding = seats(state).filter(other => live(state, other));
  if (holding.length === 1) {
    endHand(state, 'fold', finishedHands);
    if (!state.over) proceed(state, firstPreflop(state), finishedHands);
    return;
  }
  // Out of turn, the seat to act keeps the turn if it still has to act.
  const from =
    state.toAct === seat
      ? nextSeat(state, seat, () => true)
      : (state.toAct ?? seat);
  proceed(state, from, finishedHands);
}

function needsAction(state: TableState, seat: TableSeat): boolean {
  if (!live(state, seat) || state.stacks[seat] === 0) return false;
  if (state.bets[seat] < Math.max(...state.bets)) return true;
  return !state.acted[seat] && othersWithChips(state, seat);
}

/**
 * Hands the turn to whoever must act, from `first` going round. When
 * nobody must, closes the street: deals the next one, or runs the board out
 * and shows down, then keeps going with the next hand.
 */
function proceed(
  state: TableState,
  first: TableSeat,
  finishedHands: TableHandRecord[],
): void {
  const n = state.stacks.length;
  let preferred = first;
  for (;;) {
    for (let i = 0; i < n; i++) {
      const seat = (preferred + i) % n;
      if (needsAction(state, seat)) {
        state.toAct = seat;
        return;
      }
    }
    const withChips = seats(state).filter(
      seat => live(state, seat) && state.stacks[seat] > 0,
    );
    const deal = dealOf(state);
    if (withChips.length <= 1 || state.street === 'river') {
      state.street = 'river';
      state.board = deal.board;
      endHand(state, 'showdown', finishedHands);
      if (state.over) return;
      preferred = firstPreflop(state);
    } else {
      state.street = STREETS[STREETS.indexOf(state.street) + 1];
      state.board = deal.board.slice(0, BOARD_SIZE[state.street]);
      state.bets = state.bets.map(() => 0);
      state.acted = state.acted.map(() => false);
      state.minRaise = bigBlind(state);
      preferred = nextSeat(state, state.button, () => true);
    }
  }
}

const dealOf = (state: TableState) =>
  dealTable(
    state.config.seed,
    state.handNumber,
    state.holeCards.filter(cards => cards !== null).length,
  );

/** Gives back the part of the biggest bet nobody matched, unless its owner folded. */
function returnUncalled(state: TableState): void {
  const top = Math.max(...state.contributed);
  const owners = seats(state).filter(seat => state.contributed[seat] === top);
  if (owners.length !== 1 || !live(state, owners[0])) return;
  const [seat] = owners;
  const second = Math.max(
    ...state.contributed.filter((_, other) => other !== seat),
  );
  const excess = top - second;
  state.bets[seat] -= excess;
  state.contributed[seat] -= excess;
  state.stacks[seat] += excess;
}

/**
 * Main pot, then side pots: one layer per amount a live seat put in.
 * Chips a folded seat put in above every live seat go to the last pot.
 */
function buildPots(
  state: TableState,
): { amount: number; eligible: number[] }[] {
  const holding = seats(state).filter(seat => live(state, seat));
  const levels = [
    ...new Set(holding.map(seat => state.contributed[seat])),
  ].sort((a, b) => a - b);
  const layer = (low: number, high: number) =>
    state.contributed.reduce(
      (sum, chips) => sum + Math.min(chips, high) - Math.min(chips, low),
      0,
    );
  const pots = levels.map((level, i) => ({
    amount: layer(levels[i - 1] ?? 0, level),
    eligible: holding.filter(seat => state.contributed[seat] >= level),
  }));
  pots[pots.length - 1].amount += layer(levels[levels.length - 1], Infinity);
  return pots.filter(pot => pot.amount > 0);
}

/** Splits `amount` among `winners`; the odd chips go to the first winner left of the button. */
function pay(state: TableState, amount: number, winners: TableSeat[]): void {
  const share = Math.floor(amount / winners.length);
  for (const seat of winners) state.stacks[seat] += share;
  const first = nextSeat(state, state.button, seat => winners.includes(seat));
  state.stacks[first] += amount - share * winners.length;
}

/**
 * Pays every pot, records the hand, places the seats that busted, then
 * either ends the match (keeping the final hand on show) or deals the next.
 */
function endHand(
  state: TableState,
  endedBy: 'fold' | 'showdown',
  finishedHands: TableHandRecord[],
): void {
  returnUncalled(state);
  const handStart = seats(state).map(
    seat => state.stacks[seat] + state.contributed[seat],
  );
  const values = new Map<TableSeat, HandValue>();
  if (endedBy === 'showdown') {
    for (const seat of seats(state)) {
      const cards = state.holeCards[seat];
      if (cards && live(state, seat)) {
        values.set(seat, evaluateHand([...cards, ...state.board]));
      }
    }
  }
  const pots: Pot[] = buildPots(state).map(({ amount, eligible }) => {
    let winners = eligible;
    if (endedBy === 'showdown') {
      const value = (seat: TableSeat) => values.get(seat) as HandValue;
      const best = eligible.reduce((a, b) =>
        compareHands(value(b), value(a)) > 0 ? b : a,
      );
      winners = eligible.filter(
        seat => compareHands(value(seat), value(best)) === 0,
      );
    }
    pay(state, amount, winners);
    return { amount, winners };
  });
  const everyWinner = new Set(pots.flatMap(pot => pot.winners));
  const lastHand: TableLastHand = {
    hand_number: state.handNumber,
    blinds: blindsAt(state.handNumber, state.config.blindEvery),
    winner_seat: everyWinner.size === 1 ? [...everyWinner][0] : null,
    pot: pots.reduce((sum, pot) => sum + pot.amount, 0),
    pots,
    ended_by: endedBy,
    board: [...state.board],
    hole_cards:
      endedBy === 'showdown'
        ? state.holeCards.map((cards, seat) =>
            cards && live(state, seat) ? [...cards] : null,
          )
        : null,
    stacks: [...state.stacks],
  };
  finishedHands.push({
    ...structuredClone(lastHand),
    button_seat: state.button,
    events: structuredClone(state.history),
  });

  // Busted together: more chips at the start of the hand places higher.
  const staying = seats(state).filter(
    seat => seated(state, seat) && state.stacks[seat] > 0,
  );
  const busted = seats(state).filter(
    seat => seated(state, seat) && state.stacks[seat] === 0,
  );
  for (const seat of busted) {
    state.places[seat] =
      staying.length +
      1 +
      busted.filter(other => handStart[other] > handStart[seat]).length;
  }
  if (staying.length <= 1 || state.handNumber >= state.config.maxHands) {
    for (const seat of staying) {
      state.places[seat] =
        1 +
        staying.filter(other => state.stacks[other] > state.stacks[seat])
          .length;
    }
    Object.assign(state, {
      bets: state.bets.map(() => 0),
      contributed: state.contributed.map(() => 0),
      toAct: null,
      over: true,
      lastHand,
    });
    return;
  }
  Object.assign(
    state,
    dealNextHand(
      state.config,
      state.handNumber + 1,
      state,
      lastHand,
      state.button,
    ),
  );
}

/**
 * A new hand with its blinds posted; short stacks post what they have.
 * The button moves to the next seat still at the table.
 */
function dealNextHand(
  config: TableConfig,
  handNumber: number,
  { stacks, places, taken }: Pick<TableState, 'stacks' | 'places' | 'taken'>,
  lastHand: TableLastHand | null,
  previousButton: TableSeat | null,
): TableState {
  const [small, big] = blindsAt(handNumber, config.blindEvery);
  const n = stacks.length;
  const state: TableState = {
    config,
    handNumber,
    button: 0,
    street: 'preflop',
    holeCards: Array(n).fill(null),
    board: [],
    stacks: [...stacks],
    bets: Array(n).fill(0),
    contributed: Array(n).fill(0),
    toAct: null,
    over: false,
    history: [],
    lastHand,
    acted: Array(n).fill(false),
    minRaise: big,
    folded: Array(n).fill(false),
    places: [...places],
    taken: [...taken],
  };
  const dealtIn = seats(state).filter(seat => seated(state, seat));
  if (previousButton !== null) {
    state.button = nextSeat(state, previousButton, seat => seated(state, seat));
  }
  const deal = dealTable(config.seed, handNumber, dealtIn.length);
  dealtIn.forEach((seat, k) => {
    state.holeCards[seat] = deal.holeCards[k];
  });
  for (const [seat, blind] of blindSeats(state).map(
    (seat, i) => [seat, i === 0 ? small : big] as const,
  )) {
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
