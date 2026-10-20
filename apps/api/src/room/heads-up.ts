// Heads-up helpers that contract/fake.ts and db/ still use. The Room DO is
// N-seat since T38; T38 or T40, whichever merges last, deletes this file.
import type { SeatResult } from '../db/schema';
import type { Seat } from '../holdem/match';

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
