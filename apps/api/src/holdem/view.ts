import type { Card } from './cards';
import {
  blindsAt,
  type HistoryEvent,
  type LastHand,
  type MatchState,
  otherSeat,
  type Seat,
  type Street,
} from './match';

/** The `view` response object (casino-api A6). Never holds the opponent's cards. */
interface View {
  /** This hand's [small, big]. */
  blinds: [number, number];
  /** The first hand of the next blind level; `null` when there is none. */
  next_blinds_at_hand: number | null;
  street: Street;
  my_seat: Seat;
  button_seat: Seat;
  my_cards: [Card, Card];
  board: Card[];
  /** Everything put in this hand so far, including this street's bets. */
  pot: number;
  my_stack: number;
  opponent_stack: number;
  my_bet_this_street: number;
  opponent_bet_this_street: number;
  /** This hand only. */
  history: HistoryEvent[];
}

export interface SeatView {
  hand_number: number;
  to_act_seat: Seat | null;
  view: View;
  last_hand: LastHand | null;
}

/** The match as `seat` may see it; shares nothing mutable with `state`. */
export function viewFor(state: MatchState, seat: Seat): SeatView {
  const opponent = otherSeat(seat);
  const { blindEvery, maxHands } = state.config;
  const nextLevel =
    (Math.floor((state.handNumber - 1) / blindEvery) + 1) * blindEvery + 1;
  return structuredClone({
    hand_number: state.handNumber,
    to_act_seat: state.toAct,
    view: {
      blinds: blindsAt(state.handNumber, blindEvery),
      next_blinds_at_hand:
        state.over || nextLevel > maxHands ? null : nextLevel,
      street: state.street,
      my_seat: seat,
      button_seat: state.button,
      my_cards: state.holeCards[seat],
      board: state.board,
      pot: state.contributed[0] + state.contributed[1],
      my_stack: state.stacks[seat],
      opponent_stack: state.stacks[opponent],
      my_bet_this_street: state.bets[seat],
      opponent_bet_this_street: state.bets[opponent],
      history: state.history,
    },
    last_hand: state.lastHand,
  });
}
