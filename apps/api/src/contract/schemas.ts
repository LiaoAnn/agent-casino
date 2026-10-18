// Every request and response body of the API (casino-api skill, A13–A15).
// Names and invite codes in requests are plain strings on purpose: handlers
// check them and answer `name_invalid` / `wrong_invite_code`, which tells an
// agent more than a generic `invalid_request` would.
import { Schema } from 'effect';

export const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const RESERVED_NAMES = ['house-bot'] as const;

export const SETTINGS_DEFAULTS = {
  hands: 10,
  turn_seconds: 60,
  starting_stack: 40,
} as const;

export const SETTINGS_LIMITS = {
  hands: [1, 200],
  turn_seconds: [5, 300],
  starting_stack: [10, 2000],
} as const;

const pattern = (regExp: RegExp) =>
  Schema.String.check(Schema.isPattern(regExp));
const between = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Name = pattern(NAME_PATTERN);
export const RoomId = pattern(/^r_[a-z0-9]{10}$/);
const MatchId = RoomId;
export const InviteCode = pattern(/^[A-HJ-NP-Z2-9]{6}$/);
export const Card = pattern(/^[2-9TJQKA][shdc]$/);
// 256 secret bits (holdem-rules: 種子與洗牌).
const Seed = pattern(/^[0-9a-f]{64}$/);
const Seat = Schema.Literals([0, 1]);
const Street = Schema.Literals(['preflop', 'flop', 'turn', 'river']);
export const IsoTime = pattern(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
);
const Hint = Schema.String;
const Token = Schema.String;
const HoleCards = Schema.Tuple([Card, Card]);
const Board = Schema.Array(Card).check(Schema.isMaxLength(5));
const Stacks = Schema.Tuple([NonNegativeInt, NonNegativeInt]);

// --- Requests ---------------------------------------------------------------

const limited = (key: keyof typeof SETTINGS_LIMITS) => {
  const [minimum, maximum] = SETTINGS_LIMITS[key];
  return between(minimum, maximum);
};

export const Settings = Schema.Struct({
  hands: Schema.optionalKey(limited('hands')),
  turn_seconds: Schema.optionalKey(limited('turn_seconds')),
  starting_stack: Schema.optionalKey(limited('starting_stack')),
});

// Only honoured where ALLOW_TEST_ROOMS=true (A11).
export const TestSettings = Schema.Struct({
  seed: Schema.optionalKey(Seed),
  chaos: Schema.optionalKey(
    Schema.Struct({
      reject_first_action: Schema.optionalKey(Schema.Boolean),
      extra_waiting: Schema.optionalKey(NonNegativeInt),
      fail_request_every: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
      ),
    }),
  ),
});

const Game = Schema.Literal('holdem');

export const QueueRequest = Schema.Struct({
  game: Game,
  name: Schema.String,
  settings: Schema.optionalKey(Settings),
  test: Schema.optionalKey(TestSettings),
});

export const CreateRoomRequest = Schema.Struct({
  game: Game,
  name: Schema.String,
  settings: Schema.optionalKey(Settings),
  opponent: Schema.optionalKey(Schema.Literal('bot')),
  test: Schema.optionalKey(TestSettings),
});

export const JoinRequest = Schema.Struct({
  name: Schema.String,
  invite_code: Schema.String,
});

const ActionType = Schema.Literals(['fold', 'check', 'call', 'raise']);

export const ActionRequest = Schema.Struct({
  turn_id: Schema.String,
  type: ActionType,
  amount: Schema.optionalKey(Schema.Int),
});

// --- Joining ----------------------------------------------------------------

export const QueueResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('matched'),
    room_id: RoomId,
    seat: Seat,
    token: Token,
    hint: Hint,
  }),
  Schema.Struct({ status: Schema.Literal('waiting'), hint: Hint }),
]);

export const CreateRoomResponse = Schema.Struct({
  room_id: RoomId,
  invite_code: InviteCode,
  seat: Seat,
  token: Token,
  hint: Hint,
});

export const JoinResponse = Schema.Struct({
  room_id: RoomId,
  seat: Seat,
  token: Token,
  hint: Hint,
});

// --- Playing ----------------------------------------------------------------

// `call` amount = chips added; `raise` amount = total raised to this street.
const HistoryEntry = Schema.Struct({
  seat: Seat,
  street: Street,
  type: Schema.Literals(['post_blind', 'fold', 'check', 'call', 'raise']),
  amount: Schema.optionalKey(NonNegativeInt),
  timeout: Schema.optionalKey(Schema.Literal(true)),
});

const LegalAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal('fold') }),
  Schema.Struct({ type: Schema.Literal('check') }),
  Schema.Struct({ type: Schema.Literal('call'), amount: NonNegativeInt }),
  Schema.Struct({
    type: Schema.Literal('raise'),
    min: NonNegativeInt,
    max: NonNegativeInt,
  }),
]);

const View = Schema.Struct({
  street: Street,
  my_seat: Seat,
  button_seat: Seat,
  my_cards: HoleCards,
  board: Board,
  pot: NonNegativeInt,
  my_stack: NonNegativeInt,
  opponent_stack: NonNegativeInt,
  my_bet_this_street: NonNegativeInt,
  opponent_bet_this_street: NonNegativeInt,
  history: Schema.Array(HistoryEntry),
});

const EndedBy = Schema.Literals(['fold', 'showdown']);
// Both players' hole cards, only when the hand went to showdown.
const ShownCards = Schema.NullOr(Schema.Tuple([HoleCards, HoleCards]));

const LastHand = Schema.Struct({
  hand_number: Schema.Int,
  winner_seat: Schema.NullOr(Seat),
  pot: NonNegativeInt,
  ended_by: EndedBy,
  board: Board,
  hole_cards: ShownCards,
  stacks: Stacks,
});

const roomFields = {
  room_status: Schema.Literals(['waiting', 'playing', 'finished', 'void']),
  to_act_seat: Schema.NullOr(Seat),
  hand_number: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
  view: Schema.NullOr(View),
  hint: Hint,
};

const YourTurn = Schema.Struct({
  status: Schema.Literal('your_turn'),
  ...roomFields,
  turn_id: Schema.String,
  deadline: IsoTime,
  legal_actions: Schema.NonEmptyArray(LegalAction),
  last_hand: Schema.NullOr(LastHand),
});

const Waiting = Schema.Struct({
  status: Schema.Literal('waiting'),
  ...roomFields,
});

const Rating = Schema.Int;

export const MatchOver = Schema.Struct({
  status: Schema.Literal('match_over'),
  ...roomFields,
  match_id: MatchId,
  result: Schema.Literals(['win', 'loss', 'draw', 'cancelled', 'void']),
  final_stacks: Stacks,
  ratings: Schema.NullOr(
    Schema.Tuple([
      Schema.Struct({ name: Name, rating: Rating, change: Schema.Int }),
      Schema.Struct({ name: Name, rating: Rating, change: Schema.Int }),
    ]),
  ),
  last_hand: Schema.NullOr(LastHand),
});

// What `wait` and `state` answer; also the `state` field of some errors.
export const RoomStatus = Schema.Union([YourTurn, Waiting, MatchOver]);
export type RoomStatus = typeof RoomStatus.Type;

export const ActionAccepted = Schema.Struct({
  status: Schema.Literal('accepted'),
  hint: Hint,
  duplicate: Schema.optionalKey(Schema.Literal(true)),
});

// --- Reading ----------------------------------------------------------------

export const Leaderboard = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      rank: Schema.Int,
      name: Name,
      rating: Rating,
      games: NonNegativeInt,
      wins: NonNegativeInt,
      losses: NonNegativeInt,
      draws: NonNegativeInt,
    }),
  ),
});
export type Leaderboard = typeof Leaderboard.Type;

const Players = Schema.Tuple([Name, Name]);
const SeatResult = Schema.Literals([
  'seat0_win',
  'seat1_win',
  'draw',
  'void',
  'cancelled',
]);

export const MatchSummary = Schema.Struct({
  match_id: MatchId,
  players: Players,
  result: SeatResult,
  ended_at: IsoTime,
  rated: Schema.Boolean,
});
export type MatchSummary = typeof MatchSummary.Type;

export const MatchList = Schema.Struct({
  matches: Schema.Array(MatchSummary),
  next: Schema.NullOr(MatchId),
});
export type MatchList = typeof MatchList.Type;

const RoomSettings = Schema.Struct({
  hands: limited('hands'),
  turn_seconds: limited('turn_seconds'),
  starting_stack: limited('starting_stack'),
});

export const MatchHand = Schema.Struct({
  hand_number: Schema.Int,
  button_seat: Seat,
  board: Board,
  hole_cards: ShownCards,
  events: Schema.Array(HistoryEntry),
  winner_seat: Schema.NullOr(Seat),
  pot: NonNegativeInt,
  ended_by: EndedBy,
  stacks: Stacks,
});
export type MatchHand = typeof MatchHand.Type;

const RatingChange = Schema.Struct({
  name: Name,
  before: Rating,
  after: Rating,
});

export const MatchDetail = Schema.Struct({
  match_id: MatchId,
  players: Players,
  settings: RoomSettings,
  seed: Seed,
  result: SeatResult,
  rated: Schema.Boolean,
  ended_at: IsoTime,
  final_stacks: Stacks,
  rating_changes: Schema.NullOr(Schema.Tuple([RatingChange, RatingChange])),
  hands: Schema.Array(MatchHand),
});
export type MatchDetail = typeof MatchDetail.Type;

// --- Admin ------------------------------------------------------------------

export const AbortResponse = Schema.Struct({
  status: Schema.Literal('aborted'),
  room_id: RoomId,
});

export const BanResponse = Schema.Struct({
  status: Schema.Literal('banned'),
  name: Name,
});
