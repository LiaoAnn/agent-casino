// Fake data of one six-seat public table (casino-api A25), for the web (T41)
// and as examples for T38 and T42: played by the N-seat engine from a seed,
// so every answer agrees with the others and with a replay of its record.
// It covers the four states a table goes through: waiting to start, in
// play, a seat knocked out while the others play on, and finished.
import { dealTable, mulberry32 } from '../holdem/shuffle';
import {
  applyTableAction,
  blindsAt,
  DEFAULT_BLIND_EVERY,
  leaveTable,
  startTable,
  type TableApplyResult,
  type TableHandRecord,
  type TableLastHand,
  type TableSeat,
  type TableState,
  tableLegalActions,
} from '../holdem/table';
import type {
  Lobby,
  MatchDetail,
  MatchSummary,
  RoomStatus,
  SeatInfo,
  WatchResponse,
} from './schemas';

type SeatBody = typeof SeatInfo.Type;
type Seat = SeatBody['seat'];
type Card = NonNullable<TableState['holeCards'][number]>[number];
type HandBody = MatchDetail['hands'][number];
type LastHandBody = NonNullable<
  Extract<RoomStatus, { status: 'match_over' }>['last_hand']
>;
type WatchHand = WatchResponse['hands'][number];

const PLAYERS = 6;
const NAMES = ['alice', 'Bob', 'carol', 'dave-7', 'eve_x', 'grace'];
const DISPLAY_NAMES = [
  '愛麗絲 Alice',
  'Bob 🃏',
  '卡蘿的撲克機器人',
  'Dave',
  'eve_x',
  '葛瑞絲的德州撲克機器人二號專打錦標賽那一隻🃏',
];
// The seat watched and answered for: alice, the host.
const HOST = 0;
// grace walks away from the table on her first turn after someone is out.
const LEAVER = 5;
const SETTINGS = {
  starting_stack: 40,
  blind_every: DEFAULT_BLIND_EVERY[PLAYERS] ?? 3,
  max_hands: 100,
  turn_seconds: 30,
};
const ROOM = 'r_t6seatsfk1';
const WATCH_URL = (seat: number) =>
  `https://casino.example/watch/${ROOM}?token=fake.watch${seat}`;
const START = Date.parse('2026-11-01T12:00:00Z');
const NOTES = {
  fold: 'Too weak against this many players; folding.',
  check: 'Nothing to call; seeing the next card for free.',
  call: 'A fair price with the pot this size, so calling.',
  raise: 'Short stack and a decent hand: moving in.',
} as const;

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const asSeat = (seat: number) => seat as Seat;
const hexSeed = (n: number) =>
  Array.from({ length: 8 }, (_, i) =>
    ((n * 0x9e3779b1 + i * 0x85ebca6b) >>> 0).toString(16).padStart(8, '0'),
  ).join('');

interface Snapshot {
  state: TableState;
  // The hands finished so far.
  hands: number;
  // How many hands were finished when each seat last acted itself.
  actedAfter: number[];
}

interface Played {
  seed: string;
  hands: TableHandRecord[];
  // Seat 0's note on each of its steps, by hand and position in its events.
  notes: Record<number, Record<number, string>>;
  playing: Snapshot;
  out: { seat: number; snapshot: Snapshot };
  final: Snapshot;
}

// Each seat's stack before hand `n`'s blinds: what the hand before left.
const stacksBefore = (hands: TableHandRecord[], n: number): number[] =>
  hands.find(hand => hand.hand_number === n - 1)?.stacks ??
  Array(PLAYERS).fill(SETTINGS.starting_stack);

// Hand `n`'s hole cards by seat: the seats with chips are dealt in seat
// order (holdem-rules 種子與洗牌); `null` for a seat already out. Worked
// out from the records, as hands played out on all-ins have no turn.
function holeCardsOf(played: Played, n: number): ([Card, Card] | null)[] {
  const active = stacksBefore(played.hands, n).flatMap((stack, seat) =>
    stack > 0 ? [seat] : [],
  );
  const { holeCards } = dealTable(played.seed, n, active.length);
  return Array.from({ length: PLAYERS }, (_, seat) => {
    const cards = holeCards[active.indexOf(seat)];
    return cards ? [cards[0], cards[1]] : null;
  });
}

// A loose table: short stacks move in, so busts and side pots come soon.
function play(seed: string): Played | null {
  const random = mulberry32(Number.parseInt(seed.slice(0, 8), 16));
  let state = startTable({
    seed,
    players: PLAYERS,
    startingStack: SETTINGS.starting_stack,
    blindEvery: SETTINGS.blind_every,
    maxHands: SETTINGS.max_hands,
  });
  const hands: TableHandRecord[] = [];
  const notes: Played['notes'] = {};
  const actedAfter = Array<number>(PLAYERS).fill(0);
  const snap = (): Snapshot => ({
    state: structuredClone(state),
    hands: hands.length,
    actedAfter: [...actedAfter],
  });
  let playing: Snapshot | null = null;
  let out: Played['out'] | null = null;
  for (let step = 0; !state.over && state.toAct !== null; step++) {
    if (step > 5000) return null;
    const seat = state.toAct;
    const someoneOut = state.places.some(place => place !== null);
    const liveAllIn = state.stacks.some(
      (stack, s) => stack === 0 && state.contributed[s] > 0 && !state.folded[s],
    );
    if (seat === HOST && someoneOut && liveAllIn && !playing) {
      playing = snap();
    }
    let result: TableApplyResult;
    if (seat === LEAVER && someoneOut) {
      result = leaveTable(state, seat);
    } else {
      const legal = tableLegalActions(state);
      const raise = legal.find(a => a.type === 'raise');
      const call = legal.find(a => a.type === 'call');
      const check = legal.some(a => a.type === 'check');
      const roll = random();
      const action =
        raise && (roll < 0.2 || state.stacks[seat] < 15)
          ? { type: 'raise' as const, amount: raise.max }
          : check
            ? { type: 'check' as const }
            : call && roll < 0.6
              ? { type: 'call' as const }
              : { type: 'fold' as const };
      if (seat === HOST) {
        notes[state.handNumber] = {
          ...notes[state.handNumber],
          [state.history.length]: NOTES[action.type],
        };
      }
      result = applyTableAction(state, seat, action);
      actedAfter[seat] = hands.length;
    }
    if (!result.ok)
      throw new Error(`Fake table broke a rule: ${result.message}`);
    hands.push(...result.finishedHands);
    const before = state;
    state = result.state;
    if (!out) {
      const first = state.places.findIndex(
        (place, s) => place !== null && before.places[s] === null,
      );
      if (first >= 0 && !state.over) {
        out = { seat: first, snapshot: snap() };
      }
    }
  }
  const final = snap();
  const ok =
    playing &&
    out &&
    out.seat !== HOST &&
    out.seat !== LEAVER &&
    hands.some(hand => hand.events.some(e => e.type === 'leave')) &&
    playing.state.places[HOST] === null &&
    hands.some(hand => hand.pots.length >= 2) &&
    final.state.places.filter(place => place === 1).length === 1 &&
    hands.at(-1)?.stacks.filter(stack => stack > 0).length === 1;
  if (!ok || !playing || !out) return null;
  return { seed, hands, notes, playing, out, final };
}

// The first seed whose match shows everything the fixtures need.
function firstGoodMatch(seed: number): Played {
  for (let n = seed; n < seed + 1000; n++) {
    const played = play(hexSeed(n));
    if (played) return played;
  }
  throw new Error('No seed made a complete fake table');
}

// Main pot first: a new pot starts above each all-in of a seat still in the
// hand; everything else is in the top pot (A25).
function livePots(state: TableState): number[] {
  const allIns = [
    ...new Set(
      state.contributed.filter(
        (put, seat) =>
          put > 0 &&
          state.stacks[seat] === 0 &&
          !state.folded[seat] &&
          state.places[seat] === null,
      ),
    ),
  ].sort((a, b) => a - b);
  const pots: number[] = [];
  let floor = 0;
  for (const level of allIns) {
    pots.push(
      sum(
        state.contributed.map(put => Math.max(0, Math.min(put, level) - floor)),
      ),
    );
    floor = level;
  }
  const top = sum(state.contributed) - sum(pots);
  return top > 0 || pots.length === 0 ? [...pots, top] : pots;
}

const potsOut = (hand: TableLastHand) =>
  hand.pots.map(({ amount, winners }) => ({
    amount,
    winner_seats: winners.map(asSeat),
  }));

function seatsOf(state: TableState): SeatBody[] {
  return state.stacks.map((stack, seat) => {
    const place = state.places[seat] ?? null;
    const left = seat === LEAVER && place !== null;
    return {
      seat: asSeat(seat),
      name: NAMES[seat],
      display_name: DISPLAY_NAMES[seat],
      stack,
      bet_this_street: state.bets[seat],
      status:
        place !== null
          ? state.over && stack > 0
            ? 'playing'
            : left
              ? 'left'
              : 'out'
          : state.folded[seat]
            ? 'folded'
            : stack === 0
              ? 'all_in'
              : 'playing',
      place,
    };
  });
}

const tableFields = (state: TableState) => ({
  visibility: 'public' as const,
  seats_open: 0,
  seats: seatsOf(state),
});

function viewOf(state: TableState, seat: TableSeat) {
  const cards = state.holeCards[seat];
  if (!cards || state.over) return null;
  const nextLevel =
    (Math.floor((state.handNumber - 1) / SETTINGS.blind_every) + 1) *
      SETTINGS.blind_every +
    1;
  return {
    blinds: blindsAt(state.handNumber, SETTINGS.blind_every),
    next_blinds_at_hand: nextLevel > SETTINGS.max_hands ? null : nextLevel,
    street: state.street,
    my_seat: asSeat(seat),
    button_seat: asSeat(state.button),
    my_cards: [cards[0], cards[1]] as [Card, Card],
    board: [...state.board],
    pot: sum(state.contributed),
    pots: livePots(state),
    my_stack: state.stacks[seat],
    opponent_stack: null,
    my_bet_this_street: state.bets[seat],
    opponent_bet_this_street: null,
    history: state.history.map(event => ({
      ...event,
      seat: asSeat(event.seat),
    })),
  };
}

function lastHandOf(played: Played, hand: TableHandRecord): LastHandBody {
  const before = stacksBefore(played.hands, hand.hand_number);
  return {
    hand_number: hand.hand_number,
    blinds: hand.blinds,
    winner_seat: hand.winner_seat === null ? null : asSeat(hand.winner_seat),
    pot: hand.pot,
    pots: potsOut(hand),
    ended_by: hand.ended_by,
    board: hand.board,
    hole_cards: hand.hole_cards,
    stacks: hand.stacks,
    stack_changes: hand.stacks.map((stack, seat) => stack - before[seat]),
  };
}

const sinceLastMove = (played: Played, snapshot: Snapshot, seat: number) =>
  played.hands
    .slice(snapshot.actedAfter[seat], snapshot.hands)
    .map(hand => lastHandOf(played, hand));

const lastHand = (played: Played, snapshot: Snapshot) => {
  const hand = played.hands[snapshot.hands - 1];
  return hand ? lastHandOf(played, hand) : null;
};

const roomFields = (seat: number) => ({
  opponent_name: null,
  display_name: DISPLAY_NAMES[seat],
  opponent_display_name: null,
  settings: SETTINGS,
});

// Elo pairwise by place (T40's rule, for the fixture): K = 32 / (N - 1).
function ratingsOf(places: number[]) {
  const k = 32 / (places.length - 1);
  return places.map((place, seat) => {
    const change = places.reduce(
      (total, other, o) =>
        o === seat
          ? total
          : total + k * ((place < other ? 1 : place === other ? 0.5 : 0) - 0.5),
      0,
    );
    return {
      name: NAMES[seat],
      before: 1500,
      after: Math.round(1500 + change),
    };
  });
}

function publicHand(played: Played, hand: TableHandRecord): HandBody {
  return {
    hand_number: hand.hand_number,
    blinds: hand.blinds,
    button_seat: asSeat(hand.button_seat),
    board: hand.board,
    hole_cards: holeCardsOf(played, hand.hand_number),
    events: hand.events.map(event => ({ ...event, seat: asSeat(event.seat) })),
    winner_seat: hand.winner_seat === null ? null : asSeat(hand.winner_seat),
    pot: hand.pot,
    pots: potsOut(hand),
    ended_by: hand.ended_by,
    stacks: hand.stacks,
  };
}

// The host's watch link: its own cards and notes, others' cards only when
// shown at showdown until the match is over (A16).
function watchHands(played: Played, count: number, over: boolean): WatchHand[] {
  return played.hands.slice(0, count).map(hand => {
    const shown = publicHand(played, hand);
    const notes = played.notes[hand.hand_number] ?? {};
    return {
      ...shown,
      hole_cards: over
        ? shown.hole_cards
        : shown.hole_cards.map((cards, seat) =>
            seat === HOST ? cards : (hand.hole_cards?.[seat] ?? null),
          ),
      events: shown.events.map((event, i) =>
        notes[i] === undefined ? event : { ...event, note: notes[i] },
      ),
    };
  });
}

export function fakeTable(seed: number) {
  const played = firstGoodMatch(seed);
  const { playing, out, final } = played;
  const places = final.state.places.map(place => place ?? PLAYERS);
  const winner = places.indexOf(1);
  const result = `seat${winner}_win` as MatchDetail['result'];
  const ratingChanges = ratingsOf(places);
  const ratings = ratingChanges.map(r => ({
    name: r.name,
    rating: r.after,
    change: r.after - r.before,
  }));
  const endedAt = new Date(START + 15 * 60_000).toISOString();

  // Before the start: the host and two who sat down after.
  const waitingSettings = { ...SETTINGS, blind_every: null };
  const waitingSeats: SeatBody[] = [0, 1, 2].map(seat => ({
    seat: asSeat(seat),
    name: NAMES[seat],
    display_name: DISPLAY_NAMES[seat],
    stack: SETTINGS.starting_stack,
    bet_this_street: 0,
    status: 'waiting',
    place: null,
  }));
  const waitingTable = {
    visibility: 'public' as const,
    seats_open: PLAYERS - waitingSeats.length,
    seats: waitingSeats,
  };

  const legal = tableLegalActions(playing.state);
  const view = viewOf(playing.state, HOST);
  if (!view || legal.length === 0) throw new Error('Fake table: no turn');
  const [first, ...rest] = legal;
  const room = {
    waiting: {
      status: 'waiting',
      room_status: 'waiting',
      ...roomFields(HOST),
      settings: waitingSettings,
      to_act_seat: null,
      hand_number: null,
      view: null,
      hint: `3 of 6 seats are taken. Ask your owner: start now, fill the empty seats with house-bot (unrated), or keep waiting? Call GET /v1/rooms/${ROOM}/wait again`,
      ...waitingTable,
      is_host: true,
    },
    playing: {
      status: 'your_turn',
      room_status: 'playing',
      ...roomFields(HOST),
      to_act_seat: asSeat(HOST),
      hand_number: playing.state.handNumber,
      view,
      hint: `Your turn. Before the deadline, pick one of legal_actions and send it with turn_id to POST /v1/rooms/${ROOM}/actions?wait=1`,
      turn_id: 't_57',
      deadline: new Date(START + 6 * 60_000).toISOString(),
      seconds_remaining: 30,
      legal_actions: [first, ...rest],
      last_hand: lastHand(played, playing),
      hands_since_your_turn: sinceLastMove(played, playing, HOST),
      ...tableFields(playing.state),
      is_host: true,
    },
    out: {
      status: 'match_over',
      room_status: 'playing',
      ...roomFields(out.seat),
      to_act_seat: asSeat(out.snapshot.state.toAct ?? 0),
      hand_number: out.snapshot.state.handNumber,
      view: null,
      hint: 'You are out of chips. Ratings are calculated when the whole table finishes; your owner can see them on the website',
      match_id: ROOM,
      result: 'loss',
      place: out.snapshot.state.places[out.seat] ?? null,
      final_stacks: out.snapshot.state.stacks,
      ratings: null,
      last_hand: lastHand(played, out.snapshot),
      hands_since_your_turn: sinceLastMove(played, out.snapshot, out.seat),
      watch_url: WATCH_URL(out.seat),
      tell_owner: `Out in place ${out.snapshot.state.places[out.seat]} of 6. The table plays on: ${WATCH_URL(out.seat)}`,
      ...tableFields(out.snapshot.state),
      is_host: false,
    },
    finished: {
      status: 'match_over',
      room_status: 'finished',
      ...roomFields(HOST),
      to_act_seat: null,
      hand_number: final.state.handNumber,
      view: null,
      hint: `The table is over. Report the result to your owner. Your owner can see the whole match at https://casino.example/matches/${ROOM}`,
      match_id: ROOM,
      result: places[HOST] === 1 ? 'win' : 'loss',
      place: places[HOST],
      final_stacks: final.state.stacks,
      ratings,
      last_hand: lastHand(played, final),
      hands_since_your_turn: sinceLastMove(played, final, HOST),
      watch_url: WATCH_URL(HOST),
      tell_owner: `Result: place ${places[HOST]} of 6. Record: https://casino.example/matches/${ROOM}`,
      ...tableFields(final.state),
      is_host: true,
    },
  } satisfies Record<string, RoomStatus>;

  const watchCommon = {
    room_id: ROOM,
    seat: asSeat(HOST),
    players: NAMES,
    display_names: DISPLAY_NAMES,
    settings: SETTINGS,
  };
  const notedView = {
    ...view,
    history: view.history.map((event, i) => {
      const note = played.notes[playing.state.handNumber]?.[i];
      return note === undefined ? event : { ...event, note };
    }),
  };
  const watch = {
    waiting: {
      ...watchCommon,
      players: waitingSeats.map(s => s.name),
      display_names: waitingSeats.map(s => s.display_name),
      settings: waitingSettings,
      ...waitingTable,
      room_status: 'waiting',
      hand_number: null,
      to_act_seat: null,
      deadline: null,
      view: null,
      hands: [],
    },
    playing: {
      ...watchCommon,
      ...tableFields(playing.state),
      room_status: 'playing',
      hand_number: playing.state.handNumber,
      to_act_seat: asSeat(HOST),
      deadline: room.playing.deadline,
      view: notedView,
      hands: watchHands(played, playing.hands, false),
    },
    finished: {
      ...watchCommon,
      ...tableFields(final.state),
      room_status: 'finished',
      hand_number: final.state.handNumber,
      to_act_seat: null,
      deadline: null,
      view: null,
      hands: watchHands(played, final.hands, true),
      match_id: ROOM,
      result,
      places,
      final_stacks: final.state.stacks,
      ratings,
    },
  } satisfies Record<string, WatchResponse>;

  const summary: MatchSummary = {
    match_id: ROOM,
    players: NAMES,
    display_names: DISPLAY_NAMES,
    result,
    places,
    ended_at: endedAt,
    rated: true,
  };
  const record: MatchDetail = {
    ...summary,
    settings: SETTINGS,
    seed: played.seed,
    end_reason: 'bust',
    final_stacks: final.state.stacks,
    rating_changes: ratingChanges,
    hands: played.hands.map(hand => publicHand(played, hand)),
  };

  const lobbySeats = (names: number[]) =>
    names.map(seat => ({
      seat: asSeat(names.indexOf(seat)),
      name: NAMES[seat],
      display_name: DISPLAY_NAMES[seat],
    }));
  const lobby: Lobby = {
    rooms: [
      {
        room_id: 'r_lobbyfull6',
        visibility: 'public',
        seats: lobbySeats([0, 1, 2, 3, 4, 5]),
        seats_open: 0,
        settings: waitingSettings,
        created_at: new Date(START - 10 * 60_000).toISOString(),
      },
      {
        room_id: ROOM,
        visibility: 'public',
        seats: lobbySeats([0, 1, 2]),
        seats_open: 3,
        settings: waitingSettings,
        created_at: new Date(START - 5 * 60_000).toISOString(),
      },
      {
        // Custom settings: only joined with its invite code, never shown.
        room_id: 'r_lobbypriv2',
        visibility: 'private',
        seats: lobbySeats([3, 4]),
        seats_open: 4,
        settings: { ...SETTINGS, starting_stack: 100, blind_every: 5 },
        created_at: new Date(START - 2 * 60_000).toISOString(),
      },
      {
        room_id: 'r_lobbysolo1',
        visibility: 'public',
        seats: lobbySeats([1]),
        seats_open: 5,
        settings: waitingSettings,
        created_at: new Date(START - 60_000).toISOString(),
      },
    ],
  };
  return { lobby, room, watch, record, summary };
}
