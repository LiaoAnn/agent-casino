import { Exit, Schema, SchemaAST } from 'effect';
import { HttpApi } from 'effect/http-api';
import { describe, expect, it } from 'vitest';
import { CasinoApi } from './api';
import { apiErrors, ERROR_CODES, ERROR_STATUS } from './errors';
import {
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRequest,
  JoinResponse,
  Leaderboard,
  Lobby,
  MAX_SEATS,
  MatchDetail,
  MatchList,
  MatchOver,
  MatchSummary,
  QuickRoomRequest,
  RoomStatus,
  SeatInfo,
  SeatResponse,
  StartRequest,
  WatchResponse,
} from './schemas';

const decode = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.Codec<unknown>)(value);
const decodes = (schema: Schema.Top, value: unknown) =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(value),
  );

// Fixtures follow casino-api A13/A15/A19/A25; no room or engine imports.
const ROOM = 'r_abcde12345';
const watchUrl = `https://web.test/watch/${ROOM}?token=abc.def`;
const settings = {
  starting_stack: 40,
  blind_every: 5,
  max_hands: 50,
  turn_seconds: 30,
};
const players = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank'];
const seats = players.map((name, seat) => ({
  seat,
  name,
  display_name: name,
  stack: 40,
  bet_this_street: 0,
  status: 'playing',
  place: null,
}));
const lastHand = {
  hand_number: 1,
  blinds: [1, 2],
  winner_seat: null,
  pot: 12,
  pots: [
    { amount: 9, winner_seats: [2] },
    { amount: 3, winner_seats: [5] },
  ],
  ended_by: 'showdown',
  board: ['2h', '3h', '9c', 'Td', 'Js'],
  hole_cards: [null, ['As', 'Qd'], ['9h', '9d'], null, null, ['Ts', 'Th']],
  stacks: [39, 38, 46, 40, 40, 37],
  stack_changes: [-1, -2, 6, 0, 0, -3],
};
const view = {
  blinds: [1, 2],
  next_blinds_at_hand: 6,
  street: 'flop',
  my_seat: 5,
  button_seat: 2,
  my_cards: ['Ah', 'Kd'],
  board: ['7s', '2c', 'Kh'],
  pot: 12,
  pots: [9, 3],
  my_stack: 36,
  opponent_stack: null,
  my_bet_this_street: 4,
  opponent_bet_this_street: null,
  history: [{ seat: 5, street: 'flop', type: 'raise', amount: 4 }],
};
const roomFields = {
  room_status: 'playing',
  visibility: 'public',
  is_host: false,
  seats_open: 0,
  seats,
  display_name: 'frank',
  opponent_name: null,
  opponent_display_name: null,
  settings,
  to_act_seat: 5,
  hand_number: 2,
  view,
  hint: 'Call wait again',
};
const yourTurn = {
  ...roomFields,
  status: 'your_turn',
  turn_id: 't_41',
  deadline: '2026-10-20T12:50:30Z',
  seconds_remaining: 30,
  legal_actions: [{ type: 'check' }, { type: 'raise', min: 4, max: 36 }],
  last_hand: lastHand,
  hands_since_your_turn: [lastHand],
};
const waiting = {
  ...roomFields,
  status: 'waiting',
  room_status: 'waiting',
  is_host: true,
  seats: seats.slice(0, 3).map(seat => ({ ...seat, status: 'waiting' })),
  seats_open: 3,
  settings: { ...settings, blind_every: null },
  to_act_seat: null,
  hand_number: null,
  view: null,
};
const eliminated = {
  ...roomFields,
  status: 'match_over',
  to_act_seat: 2,
  view: null,
  seats: seats.map(seat =>
    seat.seat === 5 ? { ...seat, stack: 0, status: 'out', place: 6 } : seat,
  ),
  match_id: ROOM,
  result: 'loss',
  place: 6,
  watch_url: watchUrl,
  final_stacks: [40, 40, 80, 40, 40, 0],
  ratings: null,
  last_hand: lastHand,
  hands_since_your_turn: [lastHand],
  tell_owner: `Eliminated in place 6. Watch: ${watchUrl}`,
  hint: 'Ratings are calculated when the table finishes. Check the website.',
};
const finished = {
  ...eliminated,
  room_status: 'finished',
  to_act_seat: null,
  seats: seats.map(seat => ({
    ...seat,
    stack: seat.seat === 2 ? 240 : 0,
    status: seat.seat === 2 ? 'playing' : 'out',
    place: [2, 3, 1, 4, 5, 6][seat.seat],
  })),
  final_stacks: [0, 0, 240, 0, 0, 0],
  ratings: players.map(name => ({ name, rating: 1500, change: 0 })),
};
const seatResponse = {
  room_id: ROOM,
  visibility: 'public',
  invite_code: null,
  seat: 2,
  token: 'abc.def',
  is_host: false,
  display_name: 'carol',
  opponent_name: null,
  opponent_display_name: null,
  seats: waiting.seats,
  seats_open: 3,
  settings: waiting.settings,
  watch_url: watchUrl,
  tell_owner: `Joined a table. Watch: ${watchUrl}`,
  hint: 'Call wait',
};
const summary = {
  match_id: ROOM,
  players,
  display_names: players,
  result: 'seat2_win',
  places: [2, 3, 1, 4, 5, 6],
  ended_at: '2026-10-20T12:50:30Z',
  rated: true,
};
const publicHand = {
  hand_number: lastHand.hand_number,
  blinds: lastHand.blinds,
  button_seat: 5,
  board: lastHand.board,
  hole_cards: lastHand.hole_cards,
  events: [{ seat: 5, street: 'preflop', type: 'fold' }],
  winner_seat: lastHand.winner_seat,
  pot: lastHand.pot,
  pots: lastHand.pots,
  ended_by: lastHand.ended_by,
  stacks: lastHand.stacks,
};
const detail = {
  ...summary,
  settings,
  seed: 'a'.repeat(64),
  end_reason: 'bots_only',
  final_stacks: finished.final_stacks,
  rating_changes: players.map(name => ({ name, before: 1500, after: 1500 })),
  hands: [publicHand],
};
const lobby = {
  rooms: [
    {
      room_id: ROOM,
      visibility: 'public',
      seats: waiting.seats.map(({ seat, name, display_name }) => ({
        seat,
        name,
        display_name,
      })),
      seats_open: 3,
      settings: waiting.settings,
      created_at: '2026-10-20T12:00:00Z',
    },
  ],
};

describe('T37 multiplayer room responses (A25)', () => {
  it('decodes and preserves a leave event with chips taken (A15)', () => {
    const event = { seat: 4, street: 'turn', type: 'leave', amount: 17 };
    const room = { ...yourTurn, view: { ...view, history: [event] } };
    expect(decode(RoomStatus, room)).toEqual(room);
    const record = { ...detail, hands: [{ ...publicHand, events: [event] }] };
    expect(decode(MatchDetail, record)).toEqual(record);
  });

  it('exports the six-seat limit', () => expect(MAX_SEATS).toBe(6));

  it.each([
    ['your_turn', RoomStatus, yourTurn],
    ['waiting before start', RoomStatus, waiting],
    ['eliminated while table plays', RoomStatus, eliminated],
    ['eliminated MatchOver', MatchOver, eliminated],
    ['finished', RoomStatus, finished],
    ['finished MatchOver', MatchOver, finished],
  ] as const)('decodes and preserves %s', (_label, schema, body) => {
    expect(decode(schema, body)).toEqual(body);
  });

  it.each(['waiting', 'playing', 'folded', 'all_in', 'out', 'left'])(
    'accepts seat status %s',
    status => {
      const seat = {
        ...seats[5],
        status,
        place: status === 'out' || status === 'left' ? 6 : null,
      };
      expect(decode(SeatInfo, seat)).toEqual(seat);
    },
  );
  it.each(['finished', 'eliminated', 'bot', '', null])(
    'rejects seat status %j',
    status => {
      expect(decodes(SeatInfo, { ...seats[0], status })).toBe(false);
    },
  );
  it.each([-1, 6, 7, 1.5])('rejects seat %s', seat => {
    expect(decodes(SeatInfo, { ...seats[0], seat })).toBe(false);
    expect(decodes(SeatResponse, { ...seatResponse, seat })).toBe(false);
    expect(decodes(RoomStatus, { ...yourTurn, to_act_seat: seat })).toBe(false);
    expect(
      decodes(RoomStatus, { ...yourTurn, view: { ...view, my_seat: seat } }),
    ).toBe(false);
    expect(
      decodes(RoomStatus, {
        ...yourTurn,
        view: { ...view, button_seat: seat },
      }),
    ).toBe(false);
  });
  it('rejects more than six seats', () => {
    const tooMany = [...seats, { ...seats[0], seat: 0 }];
    // Repeat a valid seat index so this tests array length, not the index bound.
    expect(decodes(RoomStatus, { ...yourTurn, seats: tooMany })).toBe(false);
    expect(decodes(SeatResponse, { ...seatResponse, seats: tooMany })).toBe(
      false,
    );
  });
  it('keeps heads-up opponent fields while allowing null for multiplayer', () => {
    const headsUp = {
      ...yourTurn,
      seats: seats.slice(0, 2),
      display_name: 'alice',
      opponent_name: 'bob',
      opponent_display_name: 'bob',
      to_act_seat: 0,
      last_hand: null,
      hands_since_your_turn: [],
      view: {
        ...view,
        my_seat: 0,
        button_seat: 1,
        opponent_stack: 36,
        opponent_bet_this_street: 4,
      },
    };
    expect(decode(RoomStatus, headsUp)).toEqual(headsUp);
    expect(decode(RoomStatus, yourTurn)).toEqual(yourTurn);
  });
  it('preserves a single main pot as well as side pots and split winners', () => {
    const hand = { ...lastHand, pots: [{ amount: 12, winner_seats: [2, 5] }] };
    const body = {
      ...yourTurn,
      view: { ...view, pots: [12] },
      last_hand: hand,
      hands_since_your_turn: [hand],
    };
    expect(decode(RoomStatus, body)).toEqual(body);
  });
});

describe('T37 admission and start requests', () => {
  it.each([{}, ...Array.from({ length: 6 }, (_, bots) => ({ bots }))])(
    'accepts StartRequest %j',
    body => {
      expect(decode(StartRequest, body)).toEqual(body);
    },
  );
  it.each([6, -1, 1.5])('rejects bots = %s', bots => {
    expect(decodes(StartRequest, { bots })).toBe(false);
  });
  it('accepts quick admission with an optional display name', () => {
    for (const body of [
      { game: 'holdem', name: 'alice' },
      { game: 'holdem', name: 'alice', display_name: '愛麗絲' },
    ]) {
      expect(decode(QuickRoomRequest, body)).toEqual(body);
    }
  });
  it('keeps the default excess-key policy for other create-room keys', () => {
    const body = { game: 'holdem', name: 'alice' };
    expect(decode(CreateRoomRequest, { ...body, unknown_key: true })).toEqual(
      body,
    );
  });
  it.each([{ settings }, { test: { seed: 'a'.repeat(64) } }])(
    'rejects quick admission with %j instead of silently dropping it (A25)',
    extra => {
      expect(
        decodes(QuickRoomRequest, {
          game: 'holdem',
          name: 'alice',
          ...extra,
        }),
      ).toBe(false);
    },
  );
  it.each([undefined, 'public', 'private'])(
    'accepts room visibility %j',
    visibility => {
      const body = {
        game: 'holdem',
        name: 'alice',
        ...(visibility === undefined ? {} : { visibility }),
      };
      expect(decode(CreateRoomRequest, body)).toEqual(body);
    },
  );
  it('rejects unknown visibility and permits joining without an invite code', () => {
    expect(
      decodes(CreateRoomRequest, {
        game: 'holdem',
        name: 'alice',
        visibility: 'friends',
      }),
    ).toBe(false);
    expect(decode(JoinRequest, { name: 'alice' })).toEqual({ name: 'alice' });
  });
  it.each([
    ['seat', SeatResponse],
    ['join', JoinResponse],
    ['create', CreateRoomResponse],
  ] as const)(
    '%s uses the shared seat response including null invite_code',
    (_label, schema) => {
      expect(decode(schema, seatResponse)).toEqual(seatResponse);
    },
  );
  it('retains JoinResponse and CreateRoomResponse as SeatResponse aliases', () => {
    expect(JoinResponse).toBe(SeatResponse);
    expect(CreateRoomResponse).toBe(SeatResponse);
  });
  it('allows the host to sit alone without tell_owner before anyone joins', () => {
    const { tell_owner: _message, ...base } = seatResponse;
    const body = {
      ...base,
      visibility: 'private',
      invite_code: 'K7Q2MX',
      seat: 0,
      is_host: true,
      display_name: 'alice',
      seats: [{ ...seats[0], status: 'waiting' }],
      seats_open: 5,
    };
    expect(decode(SeatResponse, body)).toEqual(body);
  });
});

describe('T37 records, watch, lobby and rankings', () => {
  it.each(['seat2_win', 'seat3_win', 'seat4_win', 'seat5_win'])(
    'decodes %s in match records',
    result => {
      const places = players.map((_, seat) =>
        seat === Number(result[4]) ? 1 : 2,
      );
      expect(decode(MatchSummary, { ...summary, result, places })).toEqual({
        ...summary,
        result,
        places,
      });
      expect(decode(MatchDetail, { ...detail, result, places })).toEqual({
        ...detail,
        result,
        places,
      });
    },
  );
  it('preserves six-seat arrays, pots and nullable per-seat hole cards in detail and list', () => {
    expect(decode(MatchDetail, detail)).toEqual(detail);
    const body = { matches: [summary], next: null };
    expect(decode(MatchList, body)).toEqual(body);
  });
  it.each(['void', 'cancelled'])('allows null places for %s', result => {
    expect(decode(MatchSummary, { ...summary, result, places: null })).toEqual({
      ...summary,
      result,
      places: null,
    });
  });
  it('preserves championships on leaderboard entries', () => {
    const body = {
      entries: [
        {
          rank: 1,
          name: 'alice',
          display_name: 'Alice',
          rating: 1500,
          games: 4,
          wins: 3,
          losses: 1,
          draws: 0,
          championships: 3,
        },
      ],
    };
    expect(decode(Leaderboard, body)).toEqual(body);
  });
  it.each(['public', 'private'])(
    'decodes a %s lobby room without an invite code',
    visibility => {
      const body = {
        rooms: lobby.rooms.map(room => ({ ...room, visibility })),
      };
      expect(decode(Lobby, body)).toEqual(body);
      expect(decode(Lobby, { rooms: [] })).toEqual({ rooms: [] });
    },
  );
  it('decodes waiting watch with only occupied seats and deferred blind interval', () => {
    const body = {
      room_id: ROOM,
      seat: 0,
      players: ['alice'],
      display_names: ['alice'],
      settings: waiting.settings,
      room_status: 'waiting',
      visibility: 'private',
      seats: [{ ...seats[0], status: 'waiting' }],
      seats_open: 5,
      hand_number: null,
      to_act_seat: null,
      deadline: null,
      view: null,
      hands: [],
    };
    expect(decode(WatchResponse, body)).toEqual(body);
  });
  it('decodes six-seat playing and finished watch responses', () => {
    const body = {
      room_id: ROOM,
      seat: 5,
      players,
      display_names: players,
      settings,
      room_status: 'playing',
      visibility: 'public',
      seats,
      seats_open: 0,
      hand_number: 2,
      to_act_seat: 5,
      deadline: yourTurn.deadline,
      view,
      hands: [publicHand],
    };
    expect(decode(WatchResponse, body)).toEqual(body);
    const ended = {
      ...body,
      room_status: 'finished',
      seats: finished.seats,
      to_act_seat: null,
      deadline: null,
      view: null,
      match_id: ROOM,
      result: summary.result,
      places: summary.places,
      final_stacks: finished.final_stacks,
      ratings: finished.ratings,
    };
    expect(decode(WatchResponse, ended)).toEqual(ended);
  });
});

describe('T37 error and endpoint schemas', () => {
  it.each([
    ['not_host', 403],
    ['not_enough_players', 409],
    ['gone', 410],
  ] as const)('declares %s with status %s', (code, status) => {
    expect(ERROR_CODES).toContain(code);
    expect(ERROR_STATUS[code]).toBe(status);
    const [schema] = apiErrors(code);
    expect(schema).toBeDefined();
    if (!schema) throw new Error(`Missing ${code} schema`);
    expect(SchemaAST.resolveAt<number>('httpApiStatus')(schema.ast)).toBe(
      status,
    );
    expect(
      decodes(schema, {
        status: 'error',
        code,
        message: 'Use quick admission',
        hint: 'Read /skill.md',
        retryable: false,
      }),
    ).toBe(true);
  });

  it.each([
    ['lobby.quickRoom', seatResponse],
    ['room.start', yourTurn],
    ['read.lobby', lobby],
  ] as const)('%s declares the expected success body', (key, body) => {
    let found = false;
    HttpApi.reflect(CasinoApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint, successes }) => {
        if (`${group.identifier}.${endpoint.identifier}` !== key) return;
        found = true;
        expect(
          (successes.get(200) ?? []).some(schema => decodes(schema, body)),
        ).toBe(true);
      },
    });
    expect(found, `Missing endpoint ${key}`).toBe(true);
  });

  it.each([
    [
      'lobby.quickRoom',
      { game: 'holdem', name: 'alice' },
      { game: 'chess', name: 'alice' },
    ],
    ['room.start', { bots: 5 }, { bots: 6 }],
  ] as const)(
    '%s validates its declared JSON payload',
    (key, valid, invalid) => {
      let found = false;
      HttpApi.reflect(CasinoApi, {
        onGroup: () => {},
        onEndpoint: ({ group, endpoint }) => {
          if (`${group.identifier}.${endpoint.identifier}` !== key) return;
          found = true;
          const schemas =
            endpoint.payload.get('application/json')?.schemas ?? [];
          expect(
            schemas.some(schema => decodes(Schema.toType(schema), valid)),
          ).toBe(true);
          expect(
            schemas.some(schema => decodes(Schema.toType(schema), invalid)),
          ).toBe(false);
        },
      });
      expect(found, `Missing endpoint ${key}`).toBe(true);
    },
  );
});
