import type { Card } from './cards';
import { compareHands, evaluateHand } from './hand';
import {
  type HandRecord,
  type HistoryEvent,
  legalActions,
  type MatchConfig,
  type MatchState,
  otherSeat,
  type Seat,
  type Street,
} from './match';
import { type Deal, dealHand, isSeed } from './shuffle';

// Restated here, not imported, so a wrong table in the engine can't hide.
const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river'];
const BOARD_SIZE: Record<Street, number> = {
  preflop: 0,
  flop: 3,
  turn: 4,
  river: 5,
};

/** Rule violations in `state`, as English sentences; [] when none. */
export function checkState(state: MatchState): string[] {
  const { config } = state;
  const errors: string[] = [];
  const chips = [...state.stacks, ...state.contributed];
  if (sum(chips) !== 2 * config.startingStack) {
    errors.push(
      `Chips add up to ${sum(chips)}, not ${2 * config.startingStack}`,
    );
  }
  if (![...chips, ...state.bets].every(isChipCount)) {
    errors.push('Stacks, bets and contributions must be whole numbers ≥ 0');
  }
  for (const seat of [0, 1] as const) {
    if (state.bets[seat] > state.contributed[seat]) {
      errors.push(`Seat ${seat} bet more this street than this hand`);
    }
  }
  errors.push(...checkConfig(config));
  errors.push(...checkHandNumber(state.handNumber, state.button, config));
  errors.push(...checkOrder(state.history, state.button));

  if (state.over !== (state.toAct === null)) {
    errors.push(`over is ${state.over} but toAct is ${state.toAct}`);
  }
  if (state.over) {
    if (sum(state.bets) !== 0 || sum(state.contributed) !== 0) {
      errors.push('Bets and contributions must be 0 once the match is over');
    }
    if (state.lastHand === null) {
      errors.push('A finished match must keep its last hand');
    }
    const busted = state.stacks[0] === 0 || state.stacks[1] === 0;
    if (!busted && state.handNumber !== config.hands) {
      errors.push(
        `Match ended after hand ${state.handNumber} of ${config.hands} with both players still holding chips`,
      );
    }
    return errors;
  }
  if (state.toAct === null) return errors;

  errors.push(...checkLegal(state, state.toAct));
  const expected = nextToAct(state.history, state.button, state.street);
  if (expected !== state.toAct) {
    errors.push(`Seat ${state.toAct} is to act but seat ${expected} is next`);
  }
  if (state.board.length !== BOARD_SIZE[state.street]) {
    errors.push(
      `${state.street} shows ${state.board.length} board cards, not ${BOARD_SIZE[state.street]}`,
    );
  }
  const deal = dealOf(config, state.handNumber);
  if (deal) {
    if (!sameCards(state.holeCards, deal.holeCards)) {
      errors.push("Hole cards aren't the ones the seed deals");
    }
    if (!sameCards(state.board, deal.board.slice(0, state.board.length))) {
      errors.push("Board isn't the one the seed deals");
    }
  }
  return errors;
}

/** Rule violations in one finished hand record of a match with `config`. */
export function checkHand(hand: HandRecord, config: MatchConfig): string[] {
  const errors: string[] = [];
  if (
    sum(hand.stacks) !== 2 * config.startingStack ||
    !hand.stacks.every(isChipCount)
  ) {
    errors.push(
      `Stacks ${hand.stacks.join(', ')} don't add up to ${2 * config.startingStack}`,
    );
  }
  const expectedPot = potOf(hand.events);
  if (hand.pot !== expectedPot || hand.pot <= 0) {
    errors.push(`Pot is ${hand.pot}, but the events put in ${expectedPot}`);
  }
  errors.push(...checkConfig(config));
  errors.push(...checkHandNumber(hand.hand_number, hand.button_seat, config));
  errors.push(...checkOrder(hand.events, hand.button_seat));

  const last = hand.events.at(-1);
  if (hand.ended_by === 'fold') {
    if (last?.type !== 'fold') {
      errors.push('Hand ended by a fold but the last event is no fold');
    } else if (hand.winner_seat !== otherSeat(last.seat)) {
      errors.push(`Seat ${last.seat} folded but the winner isn't the other`);
    }
    if (hand.hole_cards !== null) {
      errors.push('Hole cards are shown after a fold');
    }
  } else {
    if (hand.events.some(event => event.type === 'fold')) {
      errors.push('Hand went to showdown after a fold');
    }
    if (hand.hole_cards === null) {
      errors.push('Hole cards are missing at showdown');
    }
    if (hand.board.length !== 5) {
      errors.push(`Showdown with ${hand.board.length} board cards`);
    }
  }

  const deal = dealOf(config, hand.hand_number);
  if (!deal) return errors;
  const dealtBoard = sameCards(
    hand.board,
    deal.board.slice(0, hand.board.length),
  );
  if (!dealtBoard) errors.push("Board isn't the one the seed deals");
  if (hand.hole_cards && !sameCards(hand.hole_cards, deal.holeCards)) {
    errors.push("Hole cards aren't the ones the seed deals");
  } else if (hand.hole_cards && dealtBoard && hand.board.length === 5) {
    const [a, b] = hand.hole_cards.map(cards =>
      evaluateHand([...cards, ...hand.board]),
    );
    const order = compareHands(a, b);
    const winner = order === 0 ? null : order > 0 ? 0 : 1;
    if (hand.winner_seat !== winner) {
      errors.push(`Showdown winner is ${winner}, not ${hand.winner_seat}`);
    }
  }
  return errors;
}

/** What the seat to act is offered: fold, then check or call, then raise. */
function checkLegal(state: MatchState, seat: Seat): string[] {
  const errors: string[] = [];
  const legal = legalActions(state);
  const stack = state.stacks[seat];
  const highest = Math.max(...state.bets);
  const toCall = highest - state.bets[seat];
  if (stack <= 0) errors.push(`Seat ${seat} is to act with no chips`);
  if (legal.length === 0) return [...errors, 'No legal actions on a turn'];
  if (legal[0].type !== 'fold') errors.push('fold must come first');
  const second = legal[1];
  if (toCall === 0 ? second?.type !== 'check' : second?.type !== 'call') {
    errors.push(`With ${toCall} to call, check or call is missing`);
  } else if (
    second.type === 'call' &&
    (second.amount !== Math.min(toCall, stack) || second.amount <= 0)
  ) {
    errors.push(`call adds ${second.amount}, not ${Math.min(toCall, stack)}`);
  }
  const raise = legal[2];
  if (raise?.type === 'raise') {
    if (raise.max !== state.bets[seat] + stack) {
      errors.push(`raise max ${raise.max} isn't all-in`);
    }
    if (raise.min > raise.max || raise.min <= highest) {
      errors.push(`raise min ${raise.min} is out of range`);
    }
  }
  if (legal.length > (raise?.type === 'raise' ? 3 : 2)) {
    errors.push('Unexpected extra legal actions');
  }
  return errors;
}

function checkConfig({ seed }: MatchConfig): string[] {
  return isSeed(seed)
    ? []
    : [`Seed must be 64 lowercase hex characters: ${seed}`];
}

/**
 * The chips both seats put in according to `events`, less the part of the
 * bigger last-street bet nobody matched (it goes back to its owner).
 */
function potOf(events: HistoryEvent[]): number {
  let total = 0;
  let bets = [0, 0];
  let street: Street = 'preflop';
  for (const event of events) {
    if (event.street !== street) {
      total += bets[0] + bets[1];
      bets = [0, 0];
      street = event.street;
    }
    const amount = event.amount ?? 0;
    if (event.type === 'raise') bets[event.seat] = amount;
    else if (event.type !== 'fold' && event.type !== 'check') {
      bets[event.seat] += amount;
    }
  }
  return total + 2 * Math.min(bets[0], bets[1]);
}

function checkHandNumber(
  handNumber: number,
  button: Seat,
  config: MatchConfig,
): string[] {
  const errors: string[] = [];
  if (
    !Number.isInteger(handNumber) ||
    handNumber < 1 ||
    handNumber > config.hands
  ) {
    errors.push(`Hand ${handNumber} is outside 1 to ${config.hands}`);
  }
  if (button !== (handNumber % 2 === 1 ? 0 : 1)) {
    errors.push(`Seat ${button} has the button in hand ${handNumber}`);
  }
  return errors;
}

/**
 * Nobody acts out of turn: two blinds (button first), streets in order,
 * seats taking turns, the button first preflop and the other seat after.
 */
function checkOrder(events: HistoryEvent[], button: Seat): string[] {
  const errors: string[] = [];
  const [small, big] = events;
  if (
    small?.type !== 'post_blind' ||
    small.seat !== button ||
    big?.type !== 'post_blind' ||
    big.seat !== otherSeat(button)
  ) {
    errors.push('History must start with the two blinds, button first');
  }
  let previous: HistoryEvent | undefined;
  for (const event of events.slice(2)) {
    if (event.type === 'post_blind') {
      errors.push('A blind was posted after the hand started');
      continue;
    }
    const street = STREETS.indexOf(event.street);
    const newStreet =
      previous === undefined || STREETS.indexOf(previous.street) < street;
    if (previous && STREETS.indexOf(previous.street) > street) {
      errors.push(`${event.street} action came after ${previous.street}`);
    } else if (newStreet && event.seat !== firstToAct(event.street, button)) {
      errors.push(`Seat ${event.seat} acted first on the ${event.street}`);
    } else if (!newStreet && event.seat === previous?.seat) {
      errors.push(`Seat ${event.seat} acted twice in a row`);
    }
    previous = event;
  }
  return errors;
}

/** Whose turn the history says it is on `street`. */
function nextToAct(
  history: HistoryEvent[],
  button: Seat,
  street: Street,
): Seat {
  const last = history.at(-1);
  if (last && last.type !== 'post_blind' && last.street === street) {
    return otherSeat(last.seat);
  }
  return firstToAct(street, button);
}

const firstToAct = (street: Street, button: Seat): Seat =>
  street === 'preflop' ? button : otherSeat(button);

function dealOf(config: MatchConfig, handNumber: number): Deal | null {
  try {
    return dealHand(config.seed, handNumber);
  } catch {
    return null;
  }
}

const sameCards = (a: Card[] | Card[][], b: Card[] | Card[][]) =>
  JSON.stringify(a) === JSON.stringify(b);

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

const isChipCount = (value: number) => Number.isInteger(value) && value >= 0;
