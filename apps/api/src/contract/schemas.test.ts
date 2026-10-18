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
  Leaderboard,
  MatchDetail,
  MatchList,
  NAME_PATTERN,
  Name,
  QueueRequest,
  QueueResponse,
  RESERVED_NAMES,
  RoomId,
  RoomStatus,
  SETTINGS_DEFAULTS,
  SETTINGS_LIMITS,
  Settings,
  TestSettings,
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

const yourTurn = {
  status: 'your_turn',
  room_status: 'playing',
  to_act_seat: 0,
  turn_id: 't_41',
  deadline: '2026-10-16T12:50:30Z',
  hand_number: 3,
  view,
  legal_actions: [
    { type: 'fold' },
    { type: 'call', amount: 4 },
    { type: 'raise', min: 8, max: 34 },
  ],
  last_hand: {
    hand_number: 2,
    winner_seat: 1,
    pot: 8,
    ended_by: 'showdown',
    board: ['2h', '3h', '9c', 'Td', 'Js'],
    hole_cards: [
      ['As', 'Qd'],
      ['9h', '9d'],
    ],
    stacks: [36, 44],
  },
  hint: `Your turn. Before the deadline, pick one of legal_actions and send it with turn_id to POST /v1/rooms/${ROOM}/actions`,
};

const matchOver = {
  status: 'match_over',
  room_status: 'finished',
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
      hands: 10,
      turn_seconds: 60,
      starting_stack: 40,
    });
    expect(SETTINGS_LIMITS).toEqual({
      hands: [1, 200],
      turn_seconds: [5, 300],
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
    expect(decodes(QueueRequest, { game: 'holdem', name: 'alice' })).toBe(true);
    expect(
      decodes(CreateRoomRequest, {
        game: 'holdem',
        name: 'alice',
        settings: { hands: 10, turn_seconds: 60, starting_stack: 40 },
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
    expect(decodes(QueueRequest, { game: 'holdem', name: 'a b' })).toBe(true);
    expect(decodes(JoinRequest, { name: 'bob', invite_code: 'nope' })).toBe(
      true,
    );
  });

  it('rejects unknown games and action types', () => {
    expect(decodes(QueueRequest, { game: 'chess', name: 'alice' })).toBe(false);
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
      decodes(Settings, { hands: 1, turn_seconds: 5, starting_stack: 10 }),
    ).toBe(true);
    expect(
      decodes(Settings, {
        hands: 200,
        turn_seconds: 300,
        starting_stack: 2000,
      }),
    ).toBe(true);
    for (const bad of [
      { hands: 0 },
      { hands: 201 },
      { hands: 2.5 },
      { turn_seconds: 4 },
      { turn_seconds: 301 },
      { starting_stack: 9 },
      { starting_stack: 2001 },
      { hands: '10' },
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
      decodes(QueueRequest, { game: 'holdem', name: 'alice', test: { seed } }),
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
        hint: `Matched. Next, call GET /v1/rooms/${ROOM}/wait`,
      }),
    ).toBe(true);
    expect(
      decodes(QueueResponse, {
        status: 'waiting',
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
    settings: { hands: 1, turn_seconds: 60, starting_stack: 40 },
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
        hole_cards: null,
        events: [
          { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
          { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
          { seat: 0, street: 'preflop', type: 'fold' },
        ],
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

  it.each(BAD_SEEDS)(
    'rejects a match detail with the seed $case',
    ({ seed }) => {
      expect(decodes(MatchDetail, { ...detail, seed })).toBe(false);
    },
  );

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
