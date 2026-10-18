import { Exit, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { apiErrors } from './errors';
import {
  ActionAccepted,
  ActionRequest,
  Card,
  CreateRoomRequest,
  CreateRoomResponse,
  InviteCode,
  IsoTime,
  JoinRequest,
  JoinResponse,
  Leaderboard,
  MatchDetail,
  MatchList,
  NAME_PATTERN,
  Name,
  QUEUE_KEY_PATTERN,
  QueueRequest,
  QueueResponse,
  RESERVED_NAMES,
  RoomId,
  RoomStatus,
  SETTINGS_DEFAULTS,
  SETTINGS_LIMITS,
  Settings,
  TestSettings,
  WatchResponse,
} from './schemas';

const decodes = (schema: Schema.Top, value: unknown): boolean =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(value),
  );

// The casino-api skill examples, with room_id / invite_code adjusted to the
// A14 formats (the skill's prose uses short placeholders like "r_8f2").
const ROOM = 'r_8f2abc0001';

// A 256-bit match seed: exactly 64 lowercase hex characters.
const SEED = 'df8d15e60f92a61bdf85b01a4424129de138488006fbee6493bff146e37de76e';

const BAD_SEEDS = [
  { case: 'as an integer (the old 32-bit seed)', seed: 12345 },
  { case: 'as zero', seed: 0 },
  { case: 'as a hex string of a number', seed: '3039' },
  { case: 'in uppercase', seed: SEED.toUpperCase() },
  { case: 'with one uppercase letter', seed: `D${SEED.slice(1)}` },
  { case: 'with 63 characters', seed: SEED.slice(1) },
  { case: 'with 65 characters', seed: `${SEED}0` },
  { case: 'with a non-hex character', seed: `${SEED.slice(0, 63)}g` },
  { case: 'with a 0x prefix', seed: `0x${SEED.slice(2)}` },
  { case: 'with surrounding whitespace', seed: ` ${SEED.slice(1)}` },
  { case: 'empty', seed: '' },
  { case: 'as null', seed: null },
] as const;

const view = {
  blinds: [1, 2],
  next_blinds_at_hand: null,
  street: 'flop',
  my_seat: 0,
  button_seat: 0,
  my_cards: ['Ah', 'Kd'],
  board: ['7s', '2c', 'Kh'],
  pot: 12,
  my_stack: 34,
  opponent_stack: 30,
  my_bet_this_street: 0,
  opponent_bet_this_street: 4,
  history: [{ seat: 1, street: 'flop', type: 'raise', amount: 4 }],
};

const settings = {
  max_hands: 10,
  turn_seconds: 60,
  blind_every: 50,
  starting_stack: 40,
};
const watchUrl = `https://web.test/watch/${ROOM}?token=abc.def`;

const yourTurn = {
  status: 'your_turn',
  room_status: 'playing',
  opponent_name: 'bob',
  settings,
  to_act_seat: 0,
  turn_id: 't_41',
  deadline: '2026-10-16T12:50:30Z',
  seconds_remaining: 30,
  hand_number: 3,
  view,
  legal_actions: [
    { type: 'fold' },
    { type: 'call', amount: 4 },
    { type: 'raise', min: 8, max: 34 },
  ],
  last_hand: {
    hand_number: 2,
    blinds: [1, 2],
    winner_seat: 1,
    pot: 8,
    ended_by: 'showdown',
    board: ['2h', '3h', '9c', 'Td', 'Js'],
    hole_cards: [
      ['As', 'Qd'],
      ['9h', '9d'],
    ],
    stacks: [36, 44],
    stack_changes: [-4, 4],
  },
  hint: `Your turn. Before the deadline, pick one of legal_actions and send it with turn_id to POST /v1/rooms/${ROOM}/actions`,
};

const matchOver = {
  status: 'match_over',
  room_status: 'finished',
  opponent_name: 'bob',
  settings,
  to_act_seat: null,
  hand_number: 10,
  view: null,
  match_id: ROOM,
  result: 'win',
  final_stacks: [55, 25],
  ratings: [
    { name: 'alice', rating: 1516, change: 16 },
    { name: 'bob', rating: 1484, change: -16 },
  ],
  last_hand: null,
  hint: 'Report the result to your owner',
};

describe('constants', () => {
  it('match the skill defaults and holdem-rules ranges', () => {
    expect(SETTINGS_DEFAULTS).toEqual({
      max_hands: 50,
      turn_seconds: 30,
      blind_every: 5,
      starting_stack: 40,
    });
    expect(SETTINGS_LIMITS).toEqual({
      max_hands: [1, 100],
      turn_seconds: [5, 300],
      blind_every: [1, 50],
      starting_stack: [10, 2000],
    });
    expect(RESERVED_NAMES).toEqual(['house-bot']);
    expect(NAME_PATTERN.test('Agent_007-x')).toBe(true);
    expect(NAME_PATTERN.test('a'.repeat(33))).toBe(false);
  });
});

describe('primitives', () => {
  it.each([
    [Name, 'alice', true],
    [Name, 'a b', false],
    [Name, '', false],
    [Name, 'a'.repeat(32), true],
    [RoomId, 'r_abcde12345', true],
    [RoomId, 'r_8f2', false],
    [RoomId, 'r_ABCDE12345', false],
    [RoomId, 'x_abcde12345', false],
    [Card, 'Ah', true],
    [Card, 'Tc', true],
    [Card, '1h', false],
    [Card, '10h', false],
    [Card, 'AH', false],
    [InviteCode, 'K7Q2MX', true],
    [InviteCode, 'K7Q2', false],
    [InviteCode, 'K7Q2M0', false],
    [InviteCode, 'K7Q2MO', false],
    [InviteCode, 'K7Q2M1', false],
    [InviteCode, 'K7Q2MI', false],
    [IsoTime, '2026-10-16T12:50:30Z', true],
    [IsoTime, '2026-10-16T12:50:30.123Z', true],
    [IsoTime, 'tomorrow', false],
  ] as const)('case %#', (schema, value, ok) => {
    expect(decodes(schema, value)).toBe(ok);
  });
});

describe('requests', () => {
  it('decodes the skill request examples', () => {
    expect(
      decodes(QueueRequest, {
        queue_key: 'alice-queue-key-1',
        game: 'holdem',
        name: 'alice',
      }),
    ).toBe(true);
    expect(
      decodes(CreateRoomRequest, {
        game: 'holdem',
        name: 'alice',
        settings: {
          max_hands: 10,
          turn_seconds: 60,
          blind_every: 50,
          starting_stack: 40,
        },
      }),
    ).toBe(true);
    expect(
      decodes(CreateRoomRequest, {
        game: 'holdem',
        name: 'alice',
        opponent: 'bot',
        test: {
          seed: SEED,
          chaos: {
            reject_first_action: true,
            extra_waiting: 2,
            fail_request_every: 7,
          },
        },
      }),
    ).toBe(true);
    expect(decodes(JoinRequest, { name: 'bob', invite_code: 'K7Q2MX' })).toBe(
      true,
    );
    expect(
      decodes(ActionRequest, { turn_id: 't_41', type: 'raise', amount: 8 }),
    ).toBe(true);
    expect(decodes(ActionRequest, { turn_id: 't_41', type: 'fold' })).toBe(
      true,
    );
  });

  it('leaves name and invite code validation to the handlers', () => {
    expect(
      decodes(QueueRequest, {
        queue_key: 'alice-queue-key-1',
        game: 'holdem',
        name: 'a b',
      }),
    ).toBe(true);
    expect(decodes(JoinRequest, { name: 'bob', invite_code: 'nope' })).toBe(
      true,
    );
  });

  it('rejects unknown games and action types', () => {
    expect(
      decodes(QueueRequest, {
        queue_key: 'alice-queue-key-1',
        game: 'chess',
        name: 'alice',
      }),
    ).toBe(false);
    expect(decodes(ActionRequest, { turn_id: 't_1', type: 'bet' })).toBe(false);
    expect(
      decodes(ActionRequest, { turn_id: 't_1', type: 'raise', amount: 8.5 }),
    ).toBe(false);
    expect(
      decodes(CreateRoomRequest, {
        game: 'holdem',
        name: 'alice',
        opponent: 'human',
      }),
    ).toBe(false);
  });

  it('accepts settings at the limits and rejects them outside', () => {
    expect(decodes(Settings, {})).toBe(true);
    expect(
      decodes(Settings, {
        max_hands: 1,
        turn_seconds: 5,
        blind_every: 1,
        starting_stack: 10,
      }),
    ).toBe(true);
    expect(
      decodes(Settings, {
        max_hands: 100,
        turn_seconds: 300,
        blind_every: 50,
        starting_stack: 2000,
      }),
    ).toBe(true);
    for (const bad of [
      { max_hands: 0 },
      { max_hands: 101 },
      { max_hands: 2.5 },
      { turn_seconds: 4 },
      { turn_seconds: 301 },
      { blind_every: 50, starting_stack: 9 },
      { blind_every: 50, starting_stack: 2001 },
      { max_hands: '10' },
      { blind_every: 0 },
      { blind_every: 51 },
      { blind_every: 1.5 },
      { blind_every: '5' },
    ]) {
      expect(decodes(Settings, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('validates test settings', () => {
    expect(decodes(TestSettings, {})).toBe(true);
    expect(decodes(TestSettings, { seed: SEED })).toBe(true);
    expect(decodes(TestSettings, { seed: '0'.repeat(64) })).toBe(true);
    expect(decodes(TestSettings, { seed: 'f'.repeat(64) })).toBe(true);
    expect(decodes(TestSettings, { chaos: { fail_request_every: 1 } })).toBe(
      false,
    );
    expect(decodes(TestSettings, { chaos: { extra_waiting: -1 } })).toBe(false);
  });

  // holdem-rules 種子與洗牌: a 256-bit seed written as exactly 64 lowercase
  // hex characters. Numbers (the old 32-bit seed) no longer decode.
  it.each(BAD_SEEDS)('rejects test.seed $case', ({ seed }) => {
    expect(decodes(TestSettings, { seed })).toBe(false);
    expect(
      decodes(CreateRoomRequest, {
        game: 'holdem',
        name: 'alice',
        test: { seed },
      }),
    ).toBe(false);
    expect(
      decodes(QueueRequest, {
        queue_key: 'alice-queue-key-1',
        game: 'holdem',
        name: 'alice',
        test: { seed },
      }),
    ).toBe(false);
  });
});

describe('responses', () => {
  it('decodes queue matched and waiting', () => {
    expect(
      decodes(QueueResponse, {
        status: 'matched',
        room_id: ROOM,
        seat: 0,
        token: 'abc.def',
        opponent_name: 'bob',
        settings,
        watch_url: watchUrl,
        hint: `Matched. Next, call GET /v1/rooms/${ROOM}/wait`,
      }),
    ).toBe(true);
    expect(
      decodes(QueueResponse, {
        status: 'waiting',
        waited_seconds: 0,
        queue_size: 1,
        hint: 'No opponent yet. Call POST /v1/queue again',
      }),
    ).toBe(true);
    expect(decodes(QueueResponse, { status: 'matched', hint: 'x' })).toBe(
      false,
    );
  });

  it('decodes the create room response', () => {
    expect(
      decodes(CreateRoomResponse, {
        room_id: ROOM,
        invite_code: 'K7Q2MX',
        seat: 0,
        token: 'abc.def',
        settings,
        watch_url: watchUrl,
        hint: 'Give room_id and invite_code to your opponent',
      }),
    ).toBe(true);
  });

  it('decodes your_turn, waiting and match_over room statuses', () => {
    expect(decodes(RoomStatus, yourTurn)).toBe(true);
    expect(decodes(RoomStatus, matchOver)).toBe(true);
    expect(
      decodes(RoomStatus, {
        status: 'waiting',
        room_status: 'waiting',
        opponent_name: null,
        settings,
        to_act_seat: null,
        hand_number: null,
        view: null,
        hint: 'Waiting for an opponent. Call wait again',
      }),
    ).toBe(true);
    expect(
      decodes(RoomStatus, { ...matchOver, result: 'cancelled', ratings: null }),
    ).toBe(true);
  });

  it('rejects malformed room statuses', () => {
    const { room_status: _rs, ...noRoomStatus } = yourTurn;
    expect(decodes(RoomStatus, noRoomStatus)).toBe(false);
    expect(decodes(RoomStatus, { ...yourTurn, legal_actions: [] })).toBe(false);
    expect(decodes(RoomStatus, { ...yourTurn, status: 'error' })).toBe(false);
    expect(
      decodes(RoomStatus, { ...yourTurn, view: { ...view, my_cards: ['Ah'] } }),
    ).toBe(false);
    expect(
      decodes(RoomStatus, {
        ...yourTurn,
        view: { ...view, board: ['7s', '2c', '1h'] },
      }),
    ).toBe(false);
    expect(
      decodes(RoomStatus, {
        ...yourTurn,
        view: { ...view, board: ['2s', '3s', '4s', '5s', '6s', '7s'] },
      }),
    ).toBe(false);
    expect(decodes(RoomStatus, { ...yourTurn, to_act_seat: 2 })).toBe(false);
    expect(decodes(RoomStatus, { ...matchOver, result: 'seat0_win' })).toBe(
      false,
    );
  });

  it('decodes the join response with opponent_name, settings and watch_url', () => {
    const joined = {
      room_id: ROOM,
      seat: 1,
      token: 'abc.def',
      opponent_name: 'alice',
      settings,
      watch_url: watchUrl,
      hint: `Joined. Next, call GET /v1/rooms/${ROOM}/wait`,
    };
    expect(decodes(JoinResponse, joined)).toBe(true);
    for (const key of ['opponent_name', 'settings', 'watch_url'] as const) {
      const { [key]: _removed, ...without } = joined;
      expect(decodes(JoinResponse, without), key).toBe(false);
    }
  });

  it('requires settings and watch_url in the create room response, and watch_url in queue matched', () => {
    const created = {
      room_id: ROOM,
      invite_code: 'K7Q2MX',
      seat: 0,
      token: 'abc.def',
      settings,
      watch_url: watchUrl,
      hint: 'Give room_id and invite_code to your opponent',
    };
    for (const key of ['settings', 'watch_url'] as const) {
      const { [key]: _removed, ...without } = created;
      expect(decodes(CreateRoomResponse, without), key).toBe(false);
    }
    const matched = {
      status: 'matched',
      room_id: ROOM,
      seat: 0,
      token: 'abc.def',
      opponent_name: 'bob',
      settings,
      watch_url: watchUrl,
      hint: 'Matched',
    };
    expect(decodes(QueueResponse, matched)).toBe(true);
    for (const key of ['opponent_name', 'settings', 'watch_url'] as const) {
      const { [key]: _removed, ...without } = matched;
      expect(decodes(QueueResponse, without), key).toBe(false);
    }
  });

  it('requires opponent_name (null allowed) and complete settings in every room status', () => {
    for (const status of [yourTurn, matchOver]) {
      const { opponent_name: _name, ...noName } = status;
      expect(decodes(RoomStatus, noName)).toBe(false);
      const { settings: _settings, ...noSettings } = status;
      expect(decodes(RoomStatus, noSettings)).toBe(false);
      expect(decodes(RoomStatus, { ...status, opponent_name: null })).toBe(
        true,
      );
      expect(
        decodes(RoomStatus, { ...status, settings: { max_hands: 10 } }),
      ).toBe(false);
    }
  });

  it('accepts an action note up to 500 characters and rejects longer or non-text notes', () => {
    const base = { turn_id: 't_41', type: 'call' };
    expect(decodes(ActionRequest, { ...base, note: 'pot odds are fine' })).toBe(
      true,
    );
    expect(decodes(ActionRequest, { ...base, note: '' })).toBe(true);
    expect(decodes(ActionRequest, { ...base, note: 'x'.repeat(500) })).toBe(
      true,
    );
    expect(decodes(ActionRequest, { ...base, note: '牌'.repeat(500) })).toBe(
      true,
    );
    expect(decodes(ActionRequest, { ...base, note: 'x'.repeat(501) })).toBe(
      false,
    );
    expect(decodes(ActionRequest, { ...base, note: 5 })).toBe(false);
    expect(decodes(ActionRequest, { ...base, note: null })).toBe(false);
    expect(decodes(ActionRequest, base)).toBe(true);
  });

  it('decodes accepted, with and without duplicate', () => {
    const accepted = { status: 'accepted', hint: 'Accepted. Call wait' };
    expect(decodes(ActionAccepted, accepted)).toBe(true);
    expect(decodes(ActionAccepted, { ...accepted, duplicate: true })).toBe(
      true,
    );
  });

  it('decodes the leaderboard and match list examples', () => {
    expect(
      decodes(Leaderboard, {
        entries: [
          {
            rank: 1,
            name: 'alice',
            rating: 1532,
            games: 4,
            wins: 3,
            losses: 1,
            draws: 0,
          },
        ],
      }),
    ).toBe(true);
    const summary = {
      match_id: ROOM,
      players: ['alice', 'bob'],
      result: 'seat0_win',
      ended_at: '2026-10-16T12:50:30Z',
      rated: true,
    };
    expect(decodes(MatchList, { matches: [summary], next: null })).toBe(true);
    expect(decodes(MatchList, { matches: [summary], next: ROOM })).toBe(true);
    expect(
      decodes(MatchList, {
        matches: [{ ...summary, result: 'win' }],
        next: null,
      }),
    ).toBe(false);
  });

  // The match record publishes the seed after the match (holdem-rules
  // 種子與洗牌), in the same 64-lowercase-hex format as test.seed.
  const detail = {
    match_id: ROOM,
    players: ['alice', 'bob'],
    settings: {
      max_hands: 1,
      turn_seconds: 60,
      blind_every: 50,
      starting_stack: 40,
    },
    seed: SEED,
    result: 'seat1_win',
    rated: true,
    ended_at: '2026-10-16T12:50:30Z',
    final_stacks: [39, 41],
    rating_changes: [
      { name: 'alice', before: 1200, after: 1184 },
      { name: 'bob', before: 1200, after: 1216 },
    ],
    hands: [
      {
        hand_number: 1,
        button_seat: 0,
        board: [],
        hole_cards: [
          ['As', 'Qd'],
          ['9h', '9d'],
        ],
        events: [
          { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
          { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
          { seat: 0, street: 'preflop', type: 'fold' },
        ],
        blinds: [1, 2],
        winner_seat: 1,
        pot: 2,
        ended_by: 'fold',
        stacks: [39, 41],
      },
    ],
  };

  it('decodes a match detail whose seed is 64 lowercase hex characters', () => {
    expect(decodes(MatchDetail, detail)).toBe(true);
    expect(decodes(MatchDetail, { ...detail, seed: '0'.repeat(64) })).toBe(
      true,
    );
  });

  it.each(['fold', 'showdown'])(
    'rejects null hole cards in a public %s hand',
    ended_by => {
      expect(
        decodes(MatchDetail, {
          ...detail,
          hands: detail.hands.map(hand => ({
            ...hand,
            ended_by,
            hole_cards: null,
          })),
        }),
      ).toBe(false);
    },
  );

  it('still decodes null hole cards in the last folded hand of a playing room', () => {
    expect(
      decodes(RoomStatus, {
        ...yourTurn,
        last_hand: {
          ...yourTurn.last_hand,
          ended_by: 'fold',
          board: [],
          hole_cards: null,
        },
      }),
    ).toBe(true);
  });

  it.each(BAD_SEEDS)(
    'rejects a match detail with the seed $case',
    ({ seed }) => {
      expect(decodes(MatchDetail, { ...detail, seed })).toBe(false);
    },
  );

  it('accepts legacy match settings with a null blind interval', () => {
    expect(
      decodes(MatchDetail, {
        ...detail,
        settings: { ...detail.settings, blind_every: null },
      }),
    ).toBe(true);
    expect(
      decodes(RoomStatus, {
        ...yourTurn,
        settings: { ...settings, blind_every: null },
      }),
    ).toBe(false);
  });

  it('requires blinds on each public hand', () => {
    const hands = detail.hands.map(({ blinds: _blinds, ...hand }) => hand);
    expect(decodes(MatchDetail, { ...detail, hands })).toBe(false);
  });

  it('decodes the skill error example', () => {
    const [schema] = apiErrors('invalid_action');
    if (schema === undefined) throw new Error('no schema');
    expect(
      decodes(schema, {
        status: 'error',
        code: 'invalid_action',
        message: 'Raise must be to at least 8; you sent 5',
        hint: 'Pick a legal action from legal_actions and resubmit before the deadline',
        retryable: true,
      }),
    ).toBe(true);
  });
});

// --- WatchResponse (A16) ------------------------------------------------------

describe('WatchResponse', () => {
  const noted = (note: string) => ({
    seat: 0,
    street: 'preflop',
    type: 'call',
    amount: 1,
    note,
  });
  const hand = (overrides: Record<string, unknown> = {}) => ({
    hand_number: 1,
    button_seat: 0,
    board: ['2h', '3h', '9c'],
    hole_cards: [['As', 'Qd'], null],
    events: [
      { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
      { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
      noted('call to see a flop'),
      { seat: 1, street: 'preflop', type: 'check' },
      { seat: 1, street: 'flop', type: 'fold' },
    ],
    blinds: [1, 2],
    winner_seat: 0,
    pot: 4,
    ended_by: 'fold',
    stacks: [42, 38],
    ...overrides,
  });
  const playing = {
    room_id: ROOM,
    seat: 0,
    players: ['alice', 'bob'],
    settings,
    room_status: 'playing',
    hand_number: 2,
    to_act_seat: 0,
    deadline: '2026-10-16T12:50:30Z',
    view: { ...view, history: [noted('opening note')] },
    hands: [hand()],
  };
  const finished = {
    ...playing,
    room_status: 'finished',
    hand_number: 2,
    to_act_seat: null,
    deadline: null,
    hands: [
      hand({
        hole_cards: [
          ['As', 'Qd'],
          ['9h', '9d'],
        ],
      }),
    ],
    match_id: ROOM,
    result: 'seat0_win',
    final_stacks: [55, 25],
    ratings: [
      { name: 'alice', rating: 1516, change: 16 },
      { name: 'bob', rating: 1484, change: -16 },
    ],
  };

  it('decodes a playing room, with notes on the own steps and the opponent hole cards null', () => {
    expect(decodes(WatchResponse, playing)).toBe(true);
    const decoded = Schema.decodeUnknownSync(WatchResponse)(playing);
    expect(decoded.view?.history[0]?.note).toBe('opening note');
    expect(decoded.hands[0]?.events[2]?.note).toBe('call to see a flop');
    expect(decoded.hands[0]?.hole_cards[1]).toBeNull();
  });

  it('decodes a playing room on the opponent turn: no deadline, to_act_seat 1', () => {
    expect(
      decodes(WatchResponse, { ...playing, to_act_seat: 1, deadline: null }),
    ).toBe(true);
  });

  it('decodes a waiting room: second player, view and hand number null, no hands', () => {
    expect(
      decodes(WatchResponse, {
        room_id: ROOM,
        seat: 0,
        players: ['alice', null],
        settings,
        room_status: 'waiting',
        hand_number: null,
        to_act_seat: null,
        deadline: null,
        view: null,
        hands: [],
      }),
    ).toBe(true);
  });

  it('decodes a finished room with both seats hole cards, result, final stacks and ratings', () => {
    expect(decodes(WatchResponse, finished)).toBe(true);
    expect(decodes(WatchResponse, { ...finished, ratings: null })).toBe(true);
    for (const result of ['seat1_win', 'draw', 'void', 'cancelled']) {
      expect(decodes(WatchResponse, { ...finished, result }), result).toBe(
        true,
      );
    }
    expect(decodes(WatchResponse, { ...finished, room_status: 'void' })).toBe(
      true,
    );
  });

  it('rejects results that use the agent angle, or a seat other than 0 or 1', () => {
    expect(decodes(WatchResponse, { ...finished, result: 'win' })).toBe(false);
    expect(decodes(WatchResponse, { ...playing, seat: 2 })).toBe(false);
    expect(decodes(WatchResponse, { ...playing, to_act_seat: 2 })).toBe(false);
    expect(decodes(WatchResponse, { ...playing, room_status: 'over' })).toBe(
      false,
    );
  });

  it('rejects malformed pieces: players, hole cards, hand_number 0, events', () => {
    expect(decodes(WatchResponse, { ...playing, players: ['alice'] })).toBe(
      false,
    );
    expect(decodes(WatchResponse, { ...playing, hand_number: 0 })).toBe(false);
    expect(
      decodes(WatchResponse, {
        ...playing,
        hands: [hand({ hole_cards: [['As'], null] })],
      }),
    ).toBe(false);
    expect(
      decodes(WatchResponse, {
        ...playing,
        hands: [hand({ ended_by: 'timeout' })],
      }),
    ).toBe(false);
    expect(
      decodes(WatchResponse, {
        ...playing,
        view: { ...view, history: [{ ...noted('x'), type: 'bet' }] },
      }),
    ).toBe(false);
    const { room_id: _room, ...noRoom } = playing;
    expect(decodes(WatchResponse, noRoom)).toBe(false);
    const { hands: _hands, ...noHands } = playing;
    expect(decodes(WatchResponse, noHands)).toBe(false);
  });

  it('does not carry seed, turn_id or legal_actions through decoding', () => {
    const decoded = Schema.decodeUnknownSync(WatchResponse)({
      ...playing,
      seed: SEED,
      turn_id: 't_1',
      legal_actions: [{ type: 'fold' }],
    });
    expect(decoded).not.toHaveProperty('seed');
    expect(decoded).not.toHaveProperty('turn_id');
    expect(decoded).not.toHaveProperty('legal_actions');
  });
});

describe('queue_key contract (A17)', () => {
  const request = { game: 'holdem', name: 'alice' };
  it('requires a string queue_key while leaving format validation to the handler', () => {
    expect(decodes(QueueRequest, request)).toBe(false);
    for (const queue_key of [null, 123, {}, []])
      expect(decodes(QueueRequest, { ...request, queue_key })).toBe(false);
    for (const queue_key of ['alice-queue-key-1', '', 'bad key'])
      expect(decodes(QueueRequest, { ...request, queue_key })).toBe(true);
  });

  it.each(['A'.repeat(16), 'a'.repeat(64), 'Az09_-'.repeat(3)])(
    'accepts valid queue key %s',
    queue_key => {
      expect(QUEUE_KEY_PATTERN?.test(queue_key)).toBe(true);
    },
  );

  it.each([
    '',
    'a'.repeat(15),
    'a'.repeat(65),
    `${'a'.repeat(16)} `,
    `${'a'.repeat(16)}.`,
    `${'a'.repeat(16)}中`,
  ])('rejects invalid queue key %j', queue_key => {
    expect(QUEUE_KEY_PATTERN?.test(queue_key)).toBe(false);
  });
});

// T28 A6/A15: exercise both envelopes so match_over cannot omit the field.
describe('T28 S2 last_hand.stack_changes contract', () => {
  it.each(['your_turn', 'match_over'] as const)(
    '%s requires signed integer changes for both seats',
    status => {
      const envelope = status === 'your_turn' ? yourTurn : matchOver;
      const last = { ...yourTurn.last_hand, stack_changes: [-4, 4] };
      const complete = { ...envelope, seconds_remaining: 30, last_hand: last };
      expect(decodes(RoomStatus, complete)).toBe(true);
      const { stack_changes: _changes, ...without } = last;
      expect(decodes(RoomStatus, { ...complete, last_hand: without })).toBe(
        false,
      );
    },
  );

  it.each([
    { stack_changes: [1.5, -1.5] },
    { stack_changes: [1] },
    { stack_changes: [1, -1, 0] },
    { stack_changes: ['-4', 4] },
  ])('rejects malformed seat changes $stack_changes', ({ stack_changes }) => {
    expect(
      decodes(RoomStatus, {
        ...yourTurn,
        seconds_remaining: 30,
        last_hand: { ...yourTurn.last_hand, stack_changes },
      }),
    ).toBe(false);
  });
});

describe('T30 waiting information contract (A18)', () => {
  const waiting = {
    status: 'waiting',
    waited_seconds: 0,
    queue_size: 1,
    hint: 'No opponent yet. Call POST /v1/queue again',
  };

  it.each(['waited_seconds', 'queue_size'] as const)(
    'requires %s in waiting responses',
    key => {
      const { [key]: _removed, ...without } = waiting;
      expect(decodes(QueueResponse, without)).toBe(false);
    },
  );

  it.each([
    ['waited_seconds', -1],
    ['waited_seconds', 1.5],
    ['waited_seconds', '30'],
    ['waited_seconds', null],
    ['queue_size', 0],
    ['queue_size', -1],
    ['queue_size', 1.5],
    ['queue_size', '1'],
    ['queue_size', null],
  ])('rejects %s = %j', (key, value) => {
    expect(decodes(QueueResponse, { ...waiting, [key]: value })).toBe(false);
  });

  it.each([
    [0, 1],
    [179, 2],
    [180, 3],
    [600, 1],
  ])(
    'preserves valid waited_seconds %s and queue_size %s when decoding',
    (waited_seconds, queue_size) => {
      const response = { ...waiting, waited_seconds, queue_size };
      expect(decodes(QueueResponse, response)).toBe(true);
      expect(Schema.decodeUnknownSync(QueueResponse)(response)).toEqual(
        response,
      );
    },
  );
});

describe('T28 S3 seconds_remaining contract', () => {
  it('requires seconds_remaining on your_turn', () => {
    expect(decodes(RoomStatus, yourTurn)).toBe(true);
    const { seconds_remaining: _seconds, ...without } = yourTurn;
    expect(decodes(RoomStatus, without)).toBe(false);
  });

  it.each([0, 1, 29, 30])('accepts %s whole seconds', seconds_remaining => {
    expect(decodes(RoomStatus, { ...yourTurn, seconds_remaining })).toBe(true);
  });

  it.each([-1, 29.4, '30', null])('rejects %j seconds', seconds_remaining => {
    expect(decodes(RoomStatus, { ...yourTurn, seconds_remaining })).toBe(false);
  });
});

describe('T34 required freezeout fields', () => {
  it.each(['blinds', 'next_blinds_at_hand'] as const)(
    'requires view.%s',
    key => {
      const { [key]: _removed, ...without } = view;
      expect(decodes(RoomStatus, { ...yourTurn, view: without })).toBe(false);
    },
  );

  it.each(['your_turn', 'match_over'] as const)(
    '%s requires last_hand.blinds',
    status => {
      const { blinds: _blinds, ...without } = yourTurn.last_hand;
      const envelope = status === 'your_turn' ? yourTurn : matchOver;
      expect(decodes(RoomStatus, { ...envelope, last_hand: without })).toBe(
        false,
      );
    },
  );

  it.each([
    'starting_stack',
    'blind_every',
    'max_hands',
    'turn_seconds',
  ] as const)('requires complete response settings: %s', key => {
    const { [key]: _removed, ...without } = settings;
    expect(decodes(RoomStatus, { ...yourTurn, settings: without })).toBe(false);
  });

  it('preserves both a future upgrade and null when decoding', () => {
    for (const next of [6, null]) {
      const response = {
        ...yourTurn,
        settings: { ...settings, blind_every: 5 },
        view: { ...view, next_blinds_at_hand: next },
      };
      expect(Schema.decodeUnknownSync(RoomStatus)(response)).toEqual(response);
    }
  });
});
