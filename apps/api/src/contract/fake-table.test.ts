import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { dealTable } from '../holdem/shuffle';
import { replayTable, type TableEvent } from '../holdem/table';
import { makeFakeData } from './fake';
import {
  Lobby,
  MatchDetail,
  MatchSummary,
  RoomStatus,
  WatchResponse,
} from './schemas';

// The requested public fixture interface, independent of the generator.
interface TableFixture {
  lobby: Lobby;
  room: Record<'waiting' | 'playing' | 'out' | 'finished', RoomStatus>;
  watch: Record<'waiting' | 'playing' | 'finished', WatchResponse>;
  record: MatchDetail;
  summary: MatchSummary;
}

function required<T>(value: T | null | undefined): T {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
  if (value === null || value === undefined) throw new Error('Missing fixture');
  return value;
}

function tableOf(data: ReturnType<typeof makeFakeData>): TableFixture {
  // Keep the RED executable before the new property is implemented.
  const table: unknown = Reflect.get(data, 'table');
  expect(table, 'makeFakeData().table must exist').toBeDefined();
  return required(table) as TableFixture;
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const taken = (events: readonly TableEvent[]) =>
  sum(events.filter(e => e.type === 'leave').map(e => required(e.amount)));
const eventsOf = (record: MatchDetail) => record.hands.flatMap(h => h.events);
function replay(record: MatchDetail, events = eventsOf(record)) {
  const result = replayTable(
    {
      seed: record.seed,
      players: 6,
      startingStack: record.settings.starting_stack,
      blindEvery: required(record.settings.blind_every),
      maxHands: record.settings.max_hands,
    },
    events,
  );
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(`Event ${result.index}: ${result.message}`);
  return result;
}

describe('T37 engine-backed six-seat public table fake data (A13/A15/A16/A25)', () => {
  const data = makeFakeData();
  const table = () => tableOf(data);

  it('decodes every lobby, room, watch, record and summary without dropping fields', () => {
    const t = table();
    const decode = (schema: Schema.Top, value: unknown) =>
      Schema.decodeUnknownSync(schema as unknown as Schema.Codec<unknown>)(
        value,
      );
    expect(decode(Lobby, t.lobby)).toEqual(t.lobby);
    for (const room of Object.values(t.room))
      expect(decode(RoomStatus, room)).toEqual(room);
    for (const watch of Object.values(t.watch))
      expect(decode(WatchResponse, watch)).toEqual(watch);
    expect(decode(MatchDetail, t.record)).toEqual(t.record);
    expect(decode(MatchSummary, t.summary)).toEqual(t.summary);
  });

  it('offers three occupied seats before start, with deferred blinds', () => {
    const { room, watch, record } = table();
    expect(room.waiting).toMatchObject({
      status: 'waiting',
      room_status: 'waiting',
      visibility: 'public',
      is_host: true,
      view: null,
      seats_open: 3,
      hand_number: null,
      to_act_seat: null,
      settings: { blind_every: null },
    });
    expect(room.waiting.seats).toHaveLength(3);
    for (const seat of room.waiting.seats)
      expect(seat).toMatchObject({
        status: 'waiting',
        place: null,
        stack: record.settings.starting_stack,
        bet_this_street: 0,
      });
    expect(watch.waiting).toMatchObject({
      room_status: 'waiting',
      seat: 0,
      view: null,
      seats_open: 3,
      hands: [],
      settings: { blind_every: null },
      seats: room.waiting.seats,
    });
    expect(watch.waiting.players).toEqual(room.waiting.seats.map(s => s.name));
    expect(watch.waiting.display_names).toEqual(
      room.waiting.seats.map(s => s.display_name),
    );
  });

  it('shows the host acting after an elimination and the first eliminated seat waiting for final ratings', () => {
    const { room, record } = table();
    expect(room.playing).toMatchObject({
      status: 'your_turn',
      room_status: 'playing',
      is_host: true,
      to_act_seat: 0,
      view: { my_seat: 0 },
    });
    const eliminated = room.playing.seats.filter(
      s => s.status === 'out' || s.status === 'left',
    );
    expect(eliminated.length).toBeGreaterThan(0);
    for (const seat of eliminated) {
      expect(seat.place).toBeGreaterThan(1);
      expect(seat.place).toBe(required(record.places)[seat.seat]);
    }
    expect(room.out).toMatchObject({
      status: 'match_over',
      room_status: 'playing',
      result: 'loss',
      ratings: null,
      match_id: record.match_id,
    });
    if (room.out.status !== 'match_over')
      throw new Error('Expected match_over');
    expect(room.out.watch_url).toContain(`/watch/${record.match_id}?token=`);
    // Replay until the first place is assigned, including leaves between turns.
    const events = eventsOf(record);
    let firstSeats: number[] = [];
    for (let i = 1; i <= events.length; i++) {
      const state = replay(record, events.slice(0, i)).state;
      firstSeats = state.places.flatMap((place, seat) =>
        place === null ? [] : [seat],
      );
      if (firstSeats.length > 0) break;
    }
    expect(firstSeats.length).toBeGreaterThan(0);
    // Simultaneous busts have no specified ordering between the seats.
    const caller = room.out.view?.my_seat;
    const candidates = caller === undefined ? firstSeats : [caller];
    if (caller !== undefined) expect(firstSeats).toContain(caller);
    expect(candidates.map(seat => required(record.places)[seat])).toContain(
      room.out.place,
    );
  });

  it('replays every event to the recorded winners, main/side pots, stacks and final result', () => {
    const { record } = table();
    expect(record.players).toHaveLength(6);
    expect(record.hands.length).toBeGreaterThan(0);
    const result = replay(record);
    expect(
      result.hands.map(hand => ({
        hand_number: hand.hand_number,
        winner_seat: hand.winner_seat,
        ended_by: hand.ended_by,
        pot: hand.pot,
        stacks: hand.stacks,
        pots: hand.pots.map(({ amount, winners }) => ({
          amount,
          winner_seats: winners,
        })),
      })),
    ).toEqual(
      record.hands.map(hand => ({
        hand_number: hand.hand_number,
        winner_seat: hand.winner_seat,
        ended_by: hand.ended_by,
        pot: hand.pot,
        stacks: hand.stacks,
        pots: hand.pots,
      })),
    );
    expect(result.state.over).toBe(true);
    expect(record.final_stacks).toEqual(result.state.stacks);
    expect(record.places).toEqual(result.state.places);
    const winners = required(record.places).flatMap((place, seat) =>
      place === 1 ? [seat] : [],
    );
    expect(winners).toHaveLength(1);
    expect(record.result).toBe(`seat${winners[0]}_win`);
    expect(record.hands.some(h => h.pots.length >= 2)).toBe(true);
    const leaves = eventsOf(record).filter(e => e.type === 'leave');
    expect(leaves.length).toBeGreaterThan(0);
    for (const leave of leaves)
      expect(table().watch.finished.seats[leave.seat]?.status).toBe('left');
  });

  it('assigns places independently using simultaneous-bust starting stacks and 1224 ties', () => {
    const { record } = table();
    const active = new Set([0, 1, 2, 3, 4, 5]);
    const places: (number | null)[] = Array(6).fill(null);
    let before = Array<number>(6).fill(record.settings.starting_stack);
    for (const hand of record.hands) {
      for (const event of hand.events.filter(e => e.type === 'leave')) {
        places[event.seat] = active.size;
        active.delete(event.seat);
      }
      const busted = [...active].filter(seat => hand.stacks[seat] === 0);
      for (const seat of busted)
        places[seat] =
          active.size -
          busted.length +
          1 +
          busted.filter(other => before[other] > before[seat]).length;
      for (const seat of busted) active.delete(seat);
      before = [...hand.stacks];
    }
    for (const seat of active)
      places[seat] =
        1 + [...active].filter(other => before[other] > before[seat]).length;
    expect(record.places).toEqual(places);
  });

  it('keeps playing room and watch at the same engine state and conserves all chips including leaves', () => {
    const { room, watch, record } = table();
    expect(watch.playing).toMatchObject({
      seat: 0,
      room_status: 'playing',
      seats: room.playing.seats,
      hand_number: room.playing.hand_number,
      to_act_seat: room.playing.to_act_seat,
      settings: room.playing.settings,
    });
    const view = required(room.playing.view);
    expect(watch.playing.view).toMatchObject(view);
    const events = [
      ...record.hands
        .filter(h => h.hand_number < required(room.playing.hand_number))
        .flatMap(h => h.events),
      ...view.history,
    ];
    const state = replay(record, events).state;
    expect(state.over).toBe(false);
    expect(state.toAct).toBe(0);
    expect(state.stacks).toEqual(room.playing.seats.map(s => s.stack));
    expect(state.bets).toEqual(room.playing.seats.map(s => s.bet_this_street));
    expect(state.places).toEqual(room.playing.seats.map(s => s.place));
    expect(view.pot).toBe(sum(state.contributed));
    expect(view.my_cards).toEqual(state.holeCards[0]);
    expect(view.board).toEqual(state.board);
    const total = 6 * record.settings.starting_stack;
    expect(
      sum(room.playing.seats.map(s => s.stack)) + view.pot + taken(events),
    ).toBe(total);
    let removed = 0;
    for (const hand of record.hands) {
      removed += taken(hand.events);
      expect(sum(hand.stacks) + removed).toBe(total);
      expect(sum(hand.pots.map(p => p.amount))).toBe(hand.pot);
    }
    expect(sum(record.final_stacks) + removed).toBe(total);
    for (const snapshot of [...Object.values(room), ...Object.values(watch)]) {
      if (snapshot.view === null) continue;
      const left = new Set(
        snapshot.seats.filter(s => s.status === 'left').map(s => s.seat),
      );
      const removedHere = taken(
        eventsOf(record).filter(e => e.type === 'leave' && left.has(e.seat)),
      );
      expect(
        sum(snapshot.seats.map(s => s.stack)) + snapshot.view.pot + removedHere,
      ).toBe(total);
    }
  });

  it('uses six entries for by-seat arrays, null opponent fields, and coherent last-hand deltas', () => {
    const { room, watch, record, summary } = table();
    for (const status of Object.values(room)) {
      expect(status.opponent_name).toBeNull();
      expect(status.opponent_display_name).toBeNull();
      if (status.view !== null) {
        expect(status.view.opponent_stack).toBeNull();
        expect(status.view.opponent_bet_this_street).toBeNull();
        expect(sum(status.view.pots)).toBe(status.view.pot);
        expect(status.view.my_stack).toBe(
          status.seats[status.view.my_seat]?.stack,
        );
      }
      expect(status.seats.map(s => s.seat)).toEqual(
        status.room_status === 'waiting' ? [0, 1, 2] : [0, 1, 2, 3, 4, 5],
      );
      if (status.status === 'waiting') continue;
      if (status.status === 'match_over')
        expect(status.final_stacks).toHaveLength(6);
      const hands = [
        ...status.hands_since_your_turn,
        ...(status.last_hand ? [status.last_hand] : []),
      ];
      for (const hand of hands) {
        expect(hand.stacks).toHaveLength(6);
        expect(hand.stack_changes).toHaveLength(6);
        if (hand.hole_cards !== null) expect(hand.hole_cards).toHaveLength(6);
        expect(sum(hand.pots.map(p => p.amount))).toBe(hand.pot);
        const publicHand = required(
          record.hands.find(h => h.hand_number === hand.hand_number),
        );
        expect(hand.stacks).toEqual(publicHand.stacks);
        const before =
          record.hands.find(h => h.hand_number === hand.hand_number - 1)
            ?.stacks ?? Array<number>(6).fill(record.settings.starting_stack);
        expect(hand.stack_changes).toEqual(
          hand.stacks.map((stack, seat) => stack - before[seat]),
        );
        if (!publicHand.events.some(e => e.type === 'leave'))
          expect(sum(hand.stack_changes)).toBe(0);
      }
    }
    for (const response of Object.values(watch)) {
      const n = response.room_status === 'waiting' ? 3 : 6;
      for (const array of [
        response.players,
        response.display_names,
        response.seats,
      ])
        expect(array).toHaveLength(n);
      if (response.view !== null) {
        expect(response.view.opponent_stack).toBeNull();
        expect(response.view.opponent_bet_this_street).toBeNull();
        expect(sum(response.view.pots)).toBe(response.view.pot);
      }
      for (const hand of response.hands) {
        expect(sum(hand.pots.map(p => p.amount))).toBe(hand.pot);
        for (const array of [hand.hole_cards, hand.stacks])
          expect(array).toHaveLength(6);
      }
    }
    for (const array of [
      record.players,
      record.display_names,
      record.final_stacks,
      required(record.places),
      required(record.rating_changes),
      summary.players,
      summary.display_names,
      required(summary.places),
    ])
      expect(array).toHaveLength(6);
    for (const hand of record.hands)
      for (const array of [hand.hole_cards, hand.stacks])
        expect(array).toHaveLength(6);
  });

  it('reveals only own cards and showdown cards while playing, then every dealt card after finish', () => {
    const { watch, record } = table();
    expect(watch.playing.hands.length).toBeGreaterThan(0);
    for (const hand of watch.playing.hands) {
      const publicHand = required(
        record.hands.find(h => h.hand_number === hand.hand_number),
      );
      const prefix = record.hands
        .filter(h => h.hand_number <= hand.hand_number)
        .flatMap(h => h.events);
      const engineHand = required(replay(record, prefix).hands.at(-1));
      expect(hand.hole_cards[0]).toEqual(publicHand.hole_cards[0]);
      for (let seat = 1; seat < 6; seat++)
        expect(hand.hole_cards[seat]).toEqual(
          engineHand.hole_cards?.[seat] ?? null,
        );
    }
    let active = [0, 1, 2, 3, 4, 5];
    for (const hand of record.hands) {
      const deal = dealTable(record.seed, hand.hand_number, active.length);
      expect(hand.hole_cards).toEqual(
        Array.from({ length: 6 }, (_, seat) => {
          const index = active.indexOf(seat);
          return index < 0 ? null : deal.holeCards[index];
        }),
      );
      active = active.filter(
        seat =>
          hand.stacks[seat] > 0 &&
          !hand.events.some(e => e.type === 'leave' && e.seat === seat),
      );
    }
    expect(watch.finished.hands.map(h => h.hole_cards)).toEqual(
      record.hands.map(h => h.hole_cards),
    );
  });

  it('finishes consistently across the host room, watch, record and separate summary', () => {
    const { room, watch, record, summary } = table();
    expect(room.finished).toMatchObject({
      status: 'match_over',
      room_status: 'finished',
      is_host: true,
      place: required(record.places)[0],
      final_stacks: record.final_stacks,
    });
    if (room.finished.status !== 'match_over')
      throw new Error('Expected match_over');
    expect(room.finished.ratings).toHaveLength(6);
    const champion = required(record.places)[0] === 1;
    expect(room.finished.result).toBe(champion ? 'win' : 'loss');
    expect(watch.finished).toMatchObject({
      room_status: 'finished',
      match_id: record.match_id,
      places: record.places,
      result: record.result,
      final_stacks: record.final_stacks,
      ratings: room.finished.ratings,
    });
    expect(room.finished.ratings).toEqual(
      required(record.rating_changes).map(c => ({
        name: c.name,
        rating: c.after,
        change: c.after - c.before,
      })),
    );
    expect(record).toMatchObject(summary);
    expect(data.match(record.match_id)).toEqual(record);
    let page = data.matches();
    for (let i = 0; i < 100; i++) {
      expect(page.matches.map(s => s.match_id)).not.toContain(record.match_id);
      if (page.next === null) break;
      page = data.matches({ before: page.next });
      if (i === 99) throw new Error('Pagination did not end');
    }
  });

  it('lists waiting public, full public and private rooms oldest first without invite codes', () => {
    const { lobby } = table();
    expect(
      lobby.rooms.some(r => r.visibility === 'public' && r.seats_open > 0),
    ).toBe(true);
    expect(
      lobby.rooms.some(
        r =>
          r.visibility === 'public' &&
          r.seats_open === 0 &&
          r.seats.length === 6,
      ),
    ).toBe(true);
    expect(lobby.rooms.some(r => r.visibility === 'private')).toBe(true);
    for (const room of lobby.rooms) {
      expect(room).not.toHaveProperty('invite_code');
      expect(room.seats_open).toBe(6 - room.seats.length);
    }
    const times = lobby.rooms.map(r => r.created_at);
    expect(times).toEqual([...times].sort());
  });

  it('returns identical table fixtures for repeated calls with the same seed', () => {
    expect(tableOf(makeFakeData({ seed: 1 }))).toEqual(
      tableOf(makeFakeData({ seed: 1 })),
    );
  });
});
