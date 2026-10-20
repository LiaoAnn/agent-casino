// The multiplayer fields of the contract (casino-api A25) for the heads-up
// rooms of today: two seats at most, no side pots. T38 replaces this with
// the real N-seat table.
import type { SeatInfo } from '../contract/schemas';
import type { SeatResult } from '../db/schema';
import type { MatchState, Seat } from '../holdem/match';

type Places = [number, number] | null;

// Each seat's place, from a seat-angle result; `null` when nobody placed.
export const placesOf = (result: SeatResult): Places =>
  result === 'seat0_win'
    ? [1, 2]
    : result === 'seat1_win'
      ? [2, 1]
      : result === 'draw'
        ? [1, 1]
        : null;

// A heads-up hand has one pot: the winner's, or both seats' when split.
export const headsUpPots = (hand: {
  pot: number;
  winner_seat: Seat | null;
}) => [
  {
    amount: hand.pot,
    winner_seats: (hand.winner_seat === null
      ? [0, 1]
      : [hand.winner_seat]) as Seat[],
  },
];

// The seats taken so far, by seat.
export function headsUpSeats(input: {
  names: readonly [string, string | null];
  display_names: readonly [string, string | null];
  settings: { starting_stack: number };
  match: MatchState | null;
  // Set once the match is over.
  places: Places;
  // The seat that left mid-match.
  left?: Seat;
  // Playing though no match state is at hand, as when opening a bot room:
  // hand 1 has begun, seat 0 (the button) posted 1 and seat 1 posted 2.
  started?: boolean;
}): (typeof SeatInfo.Type)[] {
  const { match, places } = input;
  const seats: (typeof SeatInfo.Type)[] = [];
  for (const seat of [0, 1] as const) {
    const name = input.names[seat];
    if (name === null) continue;
    const blind = !match && input.started ? seat + 1 : 0;
    const stack = match
      ? match.stacks[seat]
      : input.settings.starting_stack - blind;
    seats.push({
      seat,
      name,
      display_name: input.display_names[seat] ?? name,
      stack,
      bet_this_street: match && !places ? match.bets[seat] : blind,
      status: !match
        ? input.started
          ? 'playing'
          : 'waiting'
        : input.left === seat
          ? 'left'
          : places
            ? stack === 0
              ? 'out'
              : 'playing'
            : stack === 0
              ? 'all_in'
              : 'playing',
      place: places?.[seat] ?? null,
    });
  }
  return seats;
}

// The A25 fields of a seat answer (open, join) in a heads-up room.
export const seatAnswerFields = (input: {
  seat: Seat;
  names: readonly [string, string | null];
  display_names: readonly [string, string | null];
  settings: { starting_stack: number };
}) => {
  const started = input.names[1] !== null;
  return {
    visibility: 'private' as const,
    is_host: input.seat === 0,
    seats: headsUpSeats({ ...input, match: null, places: null, started }),
    seats_open: started ? 0 : 1,
  };
};
