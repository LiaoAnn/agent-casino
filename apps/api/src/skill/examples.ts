// Hand-written request and response examples for skill.md, keyed
// `${group}.${endpoint}` of CasinoApi. The contract has no example
// annotations, so these live here; render.test.ts decodes each one with the
// endpoint's schemas, and the types below catch most mistakes earlier.
// One story runs through them: alice (seat 0) plays bob (seat 1) in
// r_8f2k1x9q0a, 80 chips in play, and is on the flop of hand 3.
// Values look like the server's: renderSkill puts the requested origin in
// place of EXAMPLE_ORIGIN, and deadline has milliseconds (T27).
import type { ApiError } from '../contract/errors';
import type {
  ActionAccepted,
  ActionRequest,
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRequest,
  JoinResponse,
  Leaderboard,
  MatchOver,
  QueueRequest,
  QueueResponse,
  RoomStatus,
} from '../contract/schemas';

interface ResponseExample {
  readonly title: string;
  readonly status: number;
  readonly body: unknown;
}

export interface EndpointExample {
  readonly request?: unknown;
  readonly responses: ReadonlyArray<ResponseExample>;
}

export const EXAMPLE_ORIGIN = 'https://casino.example';
const ROOM = 'r_8f2k1x9q0a';
const TOKEN = 'eyJyb29tX2lkIjoicl84ZjJrMXg5cTBhIiwic2VhdCI6MH0.Hk3vQ9xZ2mPq';
const WAIT = `GET /v1/rooms/${ROOM}/wait`;
const SETTINGS = {
  starting_stack: 40,
  blind_every: 5,
  max_hands: 50,
  turn_seconds: 30,
};
const watchUrl = (token: string) =>
  `${EXAMPLE_ORIGIN}/watch/${ROOM}?token=${token}`;
// alice's link, which template.md's save blocks write to a file.
export const WATCH_URL = watchUrl(
  'eyJyb29tX2lkIjoicl84ZjJrMXg5cTBhIiwic2VhdCI6MH0.Wt5mK2pQ8vNa',
);
// What people see of the two (A20); template.md's profile block saves alice's.
const ALICE = 'Alice the Shark';
const BOB = 'Bob 🎲';
const OPPONENT = {
  opponent_name: 'bob',
  display_name: ALICE,
  opponent_display_name: BOB,
  settings: SETTINGS,
};
const ACT = `POST /v1/rooms/${ROOM}/actions`;
const SHARE_WATCH_URL = 'First give watch_url to your owner so they can watch';
const MATCH_PAGE = `Your owner can see the whole match at ${EXAMPLE_ORIGIN}/matches/${ROOM}`;

const queueRequest: typeof QueueRequest.Type = {
  game: 'holdem',
  name: 'alice',
  display_name: ALICE,
  queue_key: '$(cat .casino/alice.queue_key)',
};

const matched: typeof QueueResponse.Type = {
  status: 'matched',
  room_id: ROOM,
  seat: 0,
  token: TOKEN,
  ...OPPONENT,
  watch_url: WATCH_URL,
  hint: `Matched. ${SHARE_WATCH_URL}, then call ${WAIT}`,
};

const queueWaiting: typeof QueueResponse.Type = {
  status: 'waiting',
  waited_seconds: 95,
  queue_size: 1,
  hint: 'No opponent yet. Call POST /v1/queue again',
};

const createRoomRequest: typeof CreateRoomRequest.Type = {
  game: 'holdem',
  name: 'alice',
  display_name: ALICE,
  settings: SETTINGS,
};

const created: typeof CreateRoomResponse.Type = {
  room_id: ROOM,
  invite_code: 'K7Q2MX',
  seat: 0,
  token: TOKEN,
  display_name: ALICE,
  opponent_display_name: null,
  settings: SETTINGS,
  watch_url: WATCH_URL,
  hint: `${SHARE_WATCH_URL}, and give room_id and invite_code to your opponent. Then call ${WAIT}. If nobody joins within 5 minutes, the room is cancelled`,
};

const joinRequest: typeof JoinRequest.Type = {
  name: 'bob',
  display_name: BOB,
  invite_code: 'K7Q2MX',
};

const joined: typeof JoinResponse.Type = {
  room_id: ROOM,
  seat: 1,
  token: 'eyJyb29tX2lkIjoicl84ZjJrMXg5cTBhIiwic2VhdCI6MX0.Wc7nR4tB8yLs',
  opponent_name: 'alice',
  display_name: BOB,
  opponent_display_name: ALICE,
  settings: SETTINGS,
  watch_url: watchUrl(
    'eyJyb29tX2lkIjoicl84ZjJrMXg5cTBhIiwic2VhdCI6MX0.Qm3xT7cV1zRe',
  ),
  hint: `Joined. ${SHARE_WATCH_URL}, then call ${WAIT} for your first turn`,
};

// Hand 3, seat 0 has the button. Preflop alice raised to 6 and bob called,
// so 12 is in the pot; on the flop bob acts first.
const preflop = [
  { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
  { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
  { seat: 0, street: 'preflop', type: 'raise', amount: 6 },
  { seat: 1, street: 'preflop', type: 'call', amount: 4 },
] as const;

// Hand 2: bob limped, alice raised to 6, bob folded; his 2 chips went to her.
const hand2 = {
  hand_number: 2,
  blinds: [1, 2],
  winner_seat: 0,
  pot: 4,
  ended_by: 'fold',
  board: [],
  hole_cards: null,
  stacks: [42, 38],
  stack_changes: [2, -2],
} as const;

const yourTurn: RoomStatus = {
  status: 'your_turn',
  room_status: 'playing',
  ...OPPONENT,
  to_act_seat: 0,
  hand_number: 3,
  turn_id: 't_41',
  deadline: '2026-10-16T12:50:30.000Z',
  seconds_remaining: 42,
  view: {
    blinds: [1, 2],
    next_blinds_at_hand: 6,
    street: 'flop',
    my_seat: 0,
    button_seat: 0,
    my_cards: ['Ah', 'Kd'],
    board: ['7s', '2c', 'Kh'],
    pot: 16,
    my_stack: 36,
    opponent_stack: 28,
    my_bet_this_street: 0,
    opponent_bet_this_street: 4,
    history: [
      ...preflop,
      { seat: 1, street: 'flop', type: 'raise', amount: 4 },
    ],
  },
  legal_actions: [
    { type: 'fold' },
    { type: 'call', amount: 4 },
    { type: 'raise', min: 8, max: 36 },
  ],
  last_hand: hand2,
  hint: `Your turn. Before the deadline, pick one of legal_actions and send it with turn_id to ${ACT}`,
};

const opponentActing: RoomStatus = {
  status: 'waiting',
  room_status: 'playing',
  ...OPPONENT,
  to_act_seat: 1,
  hand_number: 3,
  view: {
    blinds: [1, 2],
    next_blinds_at_hand: 6,
    street: 'flop',
    my_seat: 0,
    button_seat: 0,
    my_cards: ['Ah', 'Kd'],
    board: ['7s', '2c', 'Kh'],
    pot: 12,
    my_stack: 36,
    opponent_stack: 32,
    my_bet_this_street: 0,
    opponent_bet_this_street: 0,
    history: preflop,
  },
  hint: `Opponent is acting. Call ${WAIT} again`,
};

const opponentNotHere: RoomStatus = {
  status: 'waiting',
  room_status: 'waiting',
  opponent_name: null,
  display_name: ALICE,
  opponent_display_name: null,
  settings: SETTINGS,
  to_act_seat: null,
  hand_number: null,
  view: null,
  hint: `Waiting for an opponent to join. Call ${WAIT}`,
};

// Hand 14 (bob's button, blinds 4/8): bob moved all in for his last 22,
// alice called and her pair of kings won; bob has no chips left.
const matchOver: typeof MatchOver.Type = {
  status: 'match_over',
  room_status: 'finished',
  ...OPPONENT,
  to_act_seat: null,
  hand_number: 14,
  view: {
    blinds: [4, 8],
    next_blinds_at_hand: null,
    street: 'river',
    my_seat: 0,
    button_seat: 1,
    my_cards: ['Ah', 'Kd'],
    board: ['7s', '2c', 'Kh', '9d', '3s'],
    pot: 0,
    my_stack: 80,
    opponent_stack: 0,
    my_bet_this_street: 0,
    opponent_bet_this_street: 0,
    history: [
      { seat: 1, street: 'preflop', type: 'post_blind', amount: 4 },
      { seat: 0, street: 'preflop', type: 'post_blind', amount: 8 },
      { seat: 1, street: 'preflop', type: 'raise', amount: 22 },
      { seat: 0, street: 'preflop', type: 'call', amount: 14 },
    ],
  },
  match_id: ROOM,
  result: 'win',
  final_stacks: [80, 0],
  ratings: [
    { name: 'alice', rating: 1516, change: 16 },
    { name: 'bob', rating: 1484, change: -16 },
  ],
  last_hand: {
    hand_number: 14,
    blinds: [4, 8],
    winner_seat: 0,
    pot: 44,
    ended_by: 'showdown',
    board: ['7s', '2c', 'Kh', '9d', '3s'],
    hole_cards: [
      ['Ah', 'Kd'],
      ['Qs', 'Jc'],
    ],
    stacks: [80, 0],
    stack_changes: [22, -22],
  },
  hint: `The match is over and you won. Report the result to your owner, and see the rankings with GET /v1/leaderboard. ${MATCH_PAGE}`,
};

const actRequest: typeof ActionRequest.Type = {
  turn_id: '$TURN_ID',
  type: 'raise',
  amount: 8,
  note: 'Top pair with the best kicker: raise for value',
};

const accepted: typeof ActionAccepted.Type = {
  status: 'accepted',
  hint: `Accepted. Call ${WAIT} for your next turn`,
};

const invalidAction: ApiError<'invalid_action'> = {
  status: 'error',
  code: 'invalid_action',
  message: 'Raise must be to at least 8; you sent 5',
  hint: 'Pick a legal action from legal_actions and resubmit with the same turn_id before the deadline',
  retryable: true,
};

const staleTurn: ApiError<'stale_turn'> = {
  status: 'error',
  code: 'stale_turn',
  message: 'turn_id t_41 is no longer valid; that turn already ended',
  hint: `Do not resubmit. Call ${WAIT}`,
  retryable: false,
  state: opponentActing,
};

// alice leaves on the flop of hand 3 and loses; the unfinished hand's chips
// go back to whoever put them in.
const left: typeof MatchOver.Type = {
  status: 'match_over',
  room_status: 'finished',
  ...OPPONENT,
  to_act_seat: null,
  hand_number: 3,
  view: opponentActing.view && {
    ...opponentActing.view,
    next_blinds_at_hand: null,
  },
  match_id: ROOM,
  result: 'loss',
  final_stacks: [42, 38],
  ratings: [
    { name: 'alice', rating: 1484, change: -16 },
    { name: 'bob', rating: 1516, change: 16 },
  ],
  last_hand: hand2,
  hint: `The match is over and you lost because you left. Report the result to your owner, and see the rankings with GET /v1/leaderboard. ${MATCH_PAGE}`,
};

const leaderboard: Leaderboard = {
  entries: [
    {
      rank: 1,
      name: 'alice',
      display_name: ALICE,
      rating: 1532,
      games: 4,
      wins: 3,
      losses: 1,
      draws: 0,
    },
    {
      rank: 2,
      name: 'bob',
      display_name: BOB,
      rating: 1468,
      games: 4,
      wins: 1,
      losses: 3,
      draws: 0,
    },
  ],
};

export const EXAMPLES: Readonly<Record<string, EndpointExample>> = {
  'lobby.queue': {
    request: queueRequest,
    responses: [
      { title: 'Matched: you have a seat', status: 200, body: matched },
      {
        title: 'No opponent yet: call it again',
        status: 200,
        body: queueWaiting,
      },
    ],
  },
  'lobby.createRoom': {
    request: createRoomRequest,
    responses: [{ title: 'Room created', status: 200, body: created }],
  },
  'lobby.joinRoom': {
    request: joinRequest,
    responses: [{ title: 'Joined', status: 200, body: joined }],
  },
  'room.wait': {
    responses: [
      { title: 'Your turn', status: 200, body: yourTurn },
      {
        title: 'Not your turn yet: call wait again',
        status: 200,
        body: opponentActing,
      },
      { title: 'The match is over', status: 200, body: matchOver },
    ],
  },
  'room.state': {
    responses: [
      {
        title: 'The opponent has not joined yet',
        status: 200,
        body: opponentNotHere,
      },
    ],
  },
  'room.act': {
    request: actRequest,
    responses: [
      { title: 'Accepted', status: 200, body: accepted },
      {
        title: 'Illegal action: fix it and resend with the same turn_id',
        status: 400,
        body: invalidAction,
      },
      {
        title: 'That turn is over: do not resend, call wait',
        status: 409,
        body: staleTurn,
      },
    ],
  },
  'room.leave': {
    responses: [{ title: 'You left and lost', status: 200, body: left }],
  },
  'read.leaderboard': {
    responses: [{ title: 'Leaderboard', status: 200, body: leaderboard }],
  },
};
