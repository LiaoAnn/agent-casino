// What the owner's watch link shows of one seat (casino-api A16): built from
// what the room keeps, and also by contract/fake.ts for the web's fake data.
// While the match is played it holds nothing the seat couldn't get from its
// own `state` at the same time, except the seat's notes.
import type { WatchResponse } from '../contract/schemas';
import type { SeatResult } from '../db/schema';
import type {
  HandRecord,
  HistoryEvent,
  MatchState,
  Seat,
} from '../holdem/match';
import { otherSeat } from '../holdem/match';
import { dealHand } from '../holdem/shuffle';
import { viewFor } from '../holdem/view';
import { headsUpPots, headsUpSeats, placesOf } from './heads-up';

// The seat's notes of one hand, by the step's position in the hand's events.
export type HandNotes = Record<number, string>;

export interface WatchInput {
  room_id: string;
  seat: Seat;
  names: [string, string | null];
  // What people see of each seat (A20).
  display_names: [string, string | null];
  settings: WatchResponse['settings'];
  seed: string;
  // `null` until the opponent joins.
  match: MatchState | null;
  // The hands played to the end, in order.
  hands: HandRecord[];
  // The watched seat's notes, by hand number.
  notes: Record<number, HandNotes>;
  // Epoch ms; only while it is the watched seat's turn.
  deadline: number | null;
  ended: {
    result: SeatResult;
    final_stacks: [number, number];
    ratings: Extract<WatchResponse, { match_id: string }>['ratings'];
  } | null;
}

const withNotes = (events: HistoryEvent[], notes: HandNotes = {}) =>
  events.map((event, seq) => {
    const note = notes[seq];
    return note === undefined ? event : { ...event, note };
  });

export function watchView(input: WatchInput): WatchResponse {
  const { match, seat, ended, notes } = input;
  const seen = match ? viewFor(match, seat) : null;
  const opponent = otherSeat(seat);
  const hands = input.hands.map(hand => {
    const dealt = dealHand(input.seed, hand.hand_number).holeCards;
    // The seat always saw its own cards; the opponent's only at showdown
    // until the match is over and the seed is public (A13).
    const hole_cards: [(typeof dealt)[0] | null, (typeof dealt)[1] | null] = [
      dealt[0],
      dealt[1],
    ];
    if (!ended && hand.ended_by !== 'showdown') hole_cards[opponent] = null;
    return {
      hand_number: hand.hand_number,
      blinds: hand.blinds,
      button_seat: hand.button_seat,
      board: hand.board,
      hole_cards,
      events: withNotes(hand.events, notes[hand.hand_number]),
      winner_seat: hand.winner_seat,
      pot: hand.pot,
      pots: headsUpPots(hand),
      ended_by: hand.ended_by,
      stacks: hand.stacks,
    };
  });
  const seated = (input.names[1] === null ? [0] : [0, 1]) as Seat[];
  const common = {
    room_id: input.room_id,
    seat,
    players: seated.map(s => input.names[s] ?? ''),
    display_names: seated.map(s => input.display_names[s] ?? ''),
    settings: input.settings,
    visibility: 'private' as const,
    seats: headsUpSeats({
      names: input.names,
      display_names: input.display_names,
      settings: input.settings,
      match,
      places: ended && placesOf(ended.result),
    }),
    seats_open: match ? 0 : 2 - seated.length,
    hand_number: seen?.hand_number ?? null,
    view: seen && {
      ...seen.view,
      pots: [seen.view.pot],
      // A match that is over never raises the blinds again (A19).
      ...(ended && { next_blinds_at_hand: null }),
      history: withNotes(seen.view.history, notes[seen.hand_number]),
    },
    hands,
  };
  if (ended) {
    return {
      ...common,
      room_status: ended.result === 'void' ? 'void' : 'finished',
      to_act_seat: null,
      deadline: null,
      match_id: input.room_id,
      result: ended.result,
      places: placesOf(ended.result),
      final_stacks: ended.final_stacks,
      ratings: ended.ratings,
    };
  }
  return {
    ...common,
    room_status: match ? 'playing' : 'waiting',
    to_act_seat: seen?.to_act_seat ?? null,
    deadline:
      input.deadline !== null && seen?.to_act_seat === seat
        ? new Date(input.deadline).toISOString()
        : null,
  };
}
