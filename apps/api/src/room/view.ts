// What one seat sees of the table (casino-api A6, A15, A25), from the N-seat
// engine in holdem/table.ts.
import type { RoomStatus, SeatInfo } from '../contract/schemas';
import type { Card } from '../holdem/cards';
import { blindsAt, type TableLastHand, type TableState } from '../holdem/table';

type View = NonNullable<RoomStatus['view']>;
type Seat = View['my_seat'];
type SeatInfoBody = typeof SeatInfo.Type;

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
export const asSeat = (seat: number) => seat as Seat;

// Main pot first: a new pot starts above each all-in of a seat still in the
// hand; everything else is in the top pot (A25).
function livePots(table: TableState): number[] {
  const allIns = [
    ...new Set(
      table.contributed.filter(
        (put, seat) =>
          put > 0 &&
          table.stacks[seat] === 0 &&
          !table.folded[seat] &&
          table.places[seat] === null,
      ),
    ),
  ].sort((a, b) => a - b);
  const pots: number[] = [];
  let floor = 0;
  for (const level of allIns) {
    pots.push(
      sum(
        table.contributed.map(put => Math.max(0, Math.min(put, level) - floor)),
      ),
    );
    floor = level;
  }
  const top = sum(table.contributed) - sum(pots);
  return top > 0 || pots.length === 0 ? [...pots, top] : pots;
}

// `seat`'s view of the hand, or `null` when it holds no cards (out, left).
export function seatView(table: TableState, seat: number): View | null {
  const cards = table.holeCards[seat];
  if (!cards) return null;
  const { blindEvery, maxHands } = table.config;
  const nextLevel =
    (Math.floor((table.handNumber - 1) / blindEvery) + 1) * blindEvery + 1;
  const headsUp = table.stacks.length === 2;
  const opponent = 1 - seat;
  return structuredClone({
    blinds: blindsAt(table.handNumber, blindEvery),
    next_blinds_at_hand: table.over || nextLevel > maxHands ? null : nextLevel,
    street: table.street,
    my_seat: asSeat(seat),
    button_seat: asSeat(table.button),
    my_cards: [cards[0], cards[1]] as [Card, Card],
    board: table.board,
    pot: sum(table.contributed),
    pots: livePots(table),
    my_stack: table.stacks[seat],
    opponent_stack: headsUp ? table.stacks[opponent] : null,
    my_bet_this_street: table.bets[seat],
    opponent_bet_this_street: headsUp ? table.bets[opponent] : null,
    history: table.history as View['history'],
  });
}

// A finished hand's pots as answers name them (A25: winners → winner_seats).
export const potsOut = (hand: TableLastHand) =>
  hand.pots.map(({ amount, winners }) => ({
    amount,
    winner_seats: winners.map(asSeat),
  }));

// A finished hand as last_hand shows it; `before` is each seat's chips when
// it began (A15 stack_changes).
export const lastHandOut = (hand: TableLastHand, before: number[]) => ({
  hand_number: hand.hand_number,
  blinds: hand.blinds,
  winner_seat: hand.winner_seat === null ? null : asSeat(hand.winner_seat),
  pot: hand.pot,
  pots: potsOut(hand),
  ended_by: hand.ended_by,
  board: [...hand.board],
  hole_cards: hand.hole_cards?.map(c => c && [c[0], c[1]]) ?? null,
  stacks: [...hand.stacks],
  stack_changes: hand.stacks.map((stack, seat) => stack - (before[seat] ?? 0)),
});

// The seats dealt in hand `n`: those with chips when it began (holdem-rules
// 種子與洗牌). `before` is each seat's chips after hand n − 1.
export const dealtIn = (before: number[]) =>
  before.flatMap((stack, seat) => (stack > 0 ? [seat] : []));

// Each seat as seats[] shows it (A25). `ended`: the match is over, with
// each seat's place (`null` for void and cancelled); `left`: by seat, who
// left mid-match.
export function seatInfos(input: {
  names: string[];
  display_names: string[];
  starting_stack: number;
  table: TableState | null;
  ended: { places: number[] | null } | null;
  left: boolean[];
}): SeatInfoBody[] {
  const { table, ended } = input;
  return input.names.map((name, seat) => {
    const base = {
      seat: asSeat(seat),
      name,
      display_name: input.display_names[seat] ?? name,
    };
    if (!table) {
      return {
        ...base,
        stack: input.starting_stack,
        bet_this_street: 0,
        status: 'waiting' as const,
        place: null,
      };
    }
    const stack = table.stacks[seat];
    const place = ended?.places ? ended.places[seat] : table.places[seat];
    const status: SeatInfoBody['status'] = input.left[seat]
      ? 'left'
      : place !== null
        ? ended && stack > 0
          ? 'playing'
          : 'out'
        : table.folded[seat]
          ? 'folded'
          : stack === 0
            ? 'all_in'
            : 'playing';
    return {
      ...base,
      stack,
      bet_this_street: ended?.places ? 0 : table.bets[seat],
      status,
      place,
    };
  });
}
