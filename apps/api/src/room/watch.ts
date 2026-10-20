// What the owner's watch link shows of one seat (casino-api A16): built from
// what the room keeps, and also by contract/fake.ts for the web's fake data.
// While the match is played it holds nothing the seat couldn't get from its
// own `state` at the same time, except the seat's notes.
import type { WatchResponse } from '../contract/schemas';
import type { Card } from '../holdem/cards';
import { dealTable } from '../holdem/shuffle';
import type { TableEvent, TableHandRecord, TableState } from '../holdem/table';
import { asSeat, dealtIn, potsOut, seatInfos, seatView } from './view';

// The seat's notes of one hand, by the step's position in the hand's events.
export type HandNotes = Record<number, string>;

type SeatResult = Extract<WatchResponse, { match_id: string }>['result'];

export interface WatchInput {
  room_id: string;
  seat: number;
  // By seat, everyone seated so far.
  names: string[];
  // What people see of each seat (A20).
  display_names: string[];
  settings: WatchResponse['settings'];
  visibility: WatchResponse['visibility'];
  // By seat: who left mid-match.
  left: boolean[];
  seats_open: number;
  seed: string;
  // `null` until the table starts.
  table: TableState | null;
  // The hands played to the end, in order.
  hands: TableHandRecord[];
  // The watched seat's notes, by hand number.
  notes: Record<number, HandNotes>;
  // Epoch ms; only while it is the watched seat's turn.
  deadline: number | null;
  ended: {
    result: SeatResult;
    places: number[] | null;
    final_stacks: number[];
    ratings: Extract<WatchResponse, { match_id: string }>['ratings'];
  } | null;
}

const withNotes = (events: TableEvent[], notes: HandNotes = {}) =>
  events.map((event, seq) => {
    const note = notes[seq];
    const out = { ...event, seat: asSeat(event.seat) };
    return note === undefined ? out : { ...out, note };
  });

export function watchView(input: WatchInput): WatchResponse {
  const { table, seat, ended, notes } = input;
  const seen = table && seatView(table, seat);
  let before: number[] = input.names.map(() => input.settings.starting_stack);
  const hands = input.hands.map(hand => {
    // Hand n is dealt to the seats with chips when it began (holdem-rules
    // 種子與洗牌), so its cards come from the seed as the record shows.
    const dealt = dealtIn(before);
    const { holeCards } = dealTable(input.seed, hand.hand_number, dealt.length);
    before = hand.stacks;
    // The seat always saw its own cards; the others' only at showdown
    // until the match is over and the seed is public (A13).
    const hole_cards = input.names.map((_, s) => {
      const k = dealt.indexOf(s);
      const cards =
        k < 0 ? null : ([holeCards[k][0], holeCards[k][1]] as [Card, Card]);
      if (ended || s === seat) return cards;
      return hand.hole_cards?.[s] ? cards : null;
    });
    return {
      hand_number: hand.hand_number,
      blinds: hand.blinds,
      button_seat: asSeat(hand.button_seat),
      board: hand.board,
      hole_cards,
      events: withNotes(hand.events, notes[hand.hand_number]),
      winner_seat: hand.winner_seat === null ? null : asSeat(hand.winner_seat),
      pot: hand.pot,
      pots: potsOut(hand),
      ended_by: hand.ended_by,
      stacks: hand.stacks,
    };
  });
  const common = {
    room_id: input.room_id,
    seat: asSeat(seat),
    players: input.names,
    display_names: input.display_names,
    settings: input.settings,
    visibility: input.visibility,
    seats: seatInfos({
      names: input.names,
      display_names: input.display_names,
      starting_stack: input.settings.starting_stack,
      table,
      ended,
      left: input.left,
    }),
    seats_open: input.seats_open,
    hand_number: table?.handNumber ?? null,
    view: seen && {
      ...seen,
      // A match that is over never raises the blinds again (A19).
      ...(ended && { next_blinds_at_hand: null }),
      history: withNotes(table.history, notes[table.handNumber]),
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
      places: ended.places,
      final_stacks: ended.final_stacks,
      ratings: ended.ratings,
    } as WatchResponse;
  }
  const toAct = table?.toAct ?? null;
  return {
    ...common,
    room_status: table ? 'playing' : 'waiting',
    to_act_seat: toAct === null ? null : asSeat(toAct),
    deadline:
      input.deadline !== null && toAct === seat
        ? new Date(input.deadline).toISOString()
        : null,
  } as WatchResponse;
}
