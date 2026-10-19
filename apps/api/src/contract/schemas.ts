// Every request and response body of the API (casino-api skill, A13–A15).
// Names and invite codes in requests are plain strings on purpose: handlers
// check them and answer `name_invalid` / `wrong_invite_code`, which tells an
// agent more than a generic `invalid_request` would.
import { Schema } from 'effect';

export const NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
export const RESERVED_NAMES = ['house-bot'] as const;
// What people see of house-bot (A20).
export const HOUSE_BOT_DISPLAY_NAME = 'House Bot';
// The display name of someone who gave none (A20).
export const defaultDisplayName = (name: string) =>
  name.toLowerCase() === RESERVED_NAMES[0] ? HOUSE_BOT_DISPLAY_NAME : name;
// What an agent makes up once per match and sends on every POST /v1/queue
// (A17); checked by the handler, like names.
export const QUEUE_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// A20: the name people see, apart from `name`, the identity. Any text, but
// no control characters or line breaks.
export const DISPLAY_NAME_MAX = 24;
const FORBIDDEN_IN_DISPLAY_NAME = /[\p{Cc}\u2028\u2029]/u;

// What a display name is stored as: NFC, trimmed, each run of whitespace one
// space, 1-24 code points. `null` when the name can't be used.
export function normalizeDisplayName(raw: string): string | null {
  if (FORBIDDEN_IN_DISPLAY_NAME.test(raw)) return null;
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  const length = [...name].length;
  return length >= 1 && length <= DISPLAY_NAME_MAX ? name : null;
}

// A freezeout: blinds double every `blind_every` hands and the match ends
// when a stack is empty, or after `max_hands` (holdem-rules 賽制, A19).
export const SETTINGS_DEFAULTS = {
  starting_stack: 40,
  blind_every: 5,
  max_hands: 50,
  turn_seconds: 30,
} as const;

export const SETTINGS_LIMITS = {
  starting_stack: [10, 2000],
  blind_every: [1, 50],
  max_hands: [1, 100],
  turn_seconds: [5, 300],
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
// In responses: `name` when none was given, which can be up to 32 characters.
const DisplayName = Schema.String.check(Schema.isMinLength(1));
const Token = Schema.String;
const HoleCards = Schema.Tuple([Card, Card]);
const Board = Schema.Array(Card).check(Schema.isMaxLength(5));
const Stacks = Schema.Tuple([NonNegativeInt, NonNegativeInt]);
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
// [small, big] of one hand, as scheduled (A19).
const Blinds = Schema.Tuple([PositiveInt, PositiveInt]);

// --- Requests ---------------------------------------------------------------

const limited = (key: keyof typeof SETTINGS_LIMITS) => {
  const [minimum, maximum] = SETTINGS_LIMITS[key];
  return between(minimum, maximum);
};

export const Settings = Schema.Struct({
  starting_stack: Schema.optionalKey(limited('starting_stack')),
  blind_every: Schema.optionalKey(limited('blind_every')),
  max_hands: Schema.optionalKey(limited('max_hands')),
  turn_seconds: Schema.optionalKey(limited('turn_seconds')),
  // Before T34 a match was a fixed number of hands; say so instead of
  // quietly ignoring it.
  hands: Schema.optionalKey(
    Schema.Never.annotate({
      message:
        'hands is no longer a setting: a match is played until one player has no chips; use max_hands for the safety cap',
    }),
  ),
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

// Checked here; the handler stores normalizeDisplayName's result (A20).
export const DisplayNameInput = Schema.String.check(
  Schema.makeFilter((raw: string) =>
    normalizeDisplayName(raw) === null
      ? `display_name must be 1-${DISPLAY_NAME_MAX} characters after trimming, with no control characters or line breaks; leave it out to show your name`
      : true,
  ),
);

export const QueueRequest = Schema.Struct({
  game: Game,
  name: Schema.String,
  display_name: Schema.optionalKey(DisplayNameInput),
  queue_key: Schema.String.annotateKey({
    messageMissingKey:
      'Missing queue_key: make one once with `openssl rand -hex 16`, save it, and send it on every POST /v1/queue',
  }),
  settings: Schema.optionalKey(Settings),
  test: Schema.optionalKey(TestSettings),
});

export const CreateRoomRequest = Schema.Struct({
  game: Game,
  name: Schema.String,
  display_name: Schema.optionalKey(DisplayNameInput),
  settings: Schema.optionalKey(Settings),
  opponent: Schema.optionalKey(Schema.Literal('bot')),
  test: Schema.optionalKey(TestSettings),
});

export const JoinRequest = Schema.Struct({
  name: Schema.String,
  display_name: Schema.optionalKey(DisplayNameInput),
  invite_code: Schema.String,
});

const ActionType = Schema.Literals(['fold', 'check', 'call', 'raise']);

// Why the agent played this step, for its owner's watch link only (A16).
const Note = Schema.String.check(Schema.isMaxLength(500));

export const ActionRequest = Schema.Struct({
  turn_id: Schema.String,
  type: ActionType,
  amount: Schema.optionalKey(Schema.Int),
  note: Schema.optionalKey(Note),
});

// --- Joining ----------------------------------------------------------------

// The settings a room is played with, defaults filled in.
const RoomSettings = Schema.Struct({
  starting_stack: limited('starting_stack'),
  blind_every: limited('blind_every'),
  max_hands: limited('max_hands'),
  turn_seconds: limited('turn_seconds'),
});

// `<WEB_URL>/watch/{room_id}?token=<watch token>`: the owner's read-only
// view of this seat (A16).
const WatchUrl = Schema.String;

export const QueueResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('matched'),
    room_id: RoomId,
    seat: Seat,
    token: Token,
    opponent_name: Name,
    display_name: DisplayName,
    opponent_display_name: DisplayName,
    settings: RoomSettings,
    watch_url: WatchUrl,
    tell_owner: Schema.String,
    hint: Hint,
  }),
  Schema.Struct({
    status: Schema.Literal('waiting'),
    // Seconds this name and queue_key have queued without a break of more
    // than 45 s; back to 0 after the place in the queue has lapsed (A18).
    waited_seconds: NonNegativeInt,
    // Names in the queue now, the caller included, whatever their settings
    // (A18).
    queue_size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    hint: Hint,
  }),
]);

export const CreateRoomResponse = Schema.Struct({
  room_id: RoomId,
  invite_code: InviteCode,
  seat: Seat,
  token: Token,
  display_name: DisplayName,
  // `null` until someone joins; "House Bot" against the bot.
  opponent_display_name: Schema.NullOr(DisplayName),
  settings: RoomSettings,
  watch_url: WatchUrl,
  tell_owner: Schema.optionalKey(Schema.String),
  hint: Hint,
});

export const JoinResponse = Schema.Struct({
  room_id: RoomId,
  seat: Seat,
  token: Token,
  opponent_name: Name,
  display_name: DisplayName,
  opponent_display_name: DisplayName,
  settings: RoomSettings,
  watch_url: WatchUrl,
  tell_owner: Schema.String,
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
  blinds: Blinds,
  // The first hand of the next blind level; `null` when there is none.
  next_blinds_at_hand: Schema.NullOr(PositiveInt),
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
// Both players' hole cards, by seat.
const BothHoleCards = Schema.Tuple([HoleCards, HoleCards]);
// During a match, only when the hand went to showdown.
const ShownCards = Schema.NullOr(BothHoleCards);

const LastHand = Schema.Struct({
  hand_number: Schema.Int,
  blinds: Blinds,
  winner_seat: Schema.NullOr(Seat),
  pot: NonNegativeInt,
  ended_by: EndedBy,
  board: Board,
  hole_cards: ShownCards,
  stacks: Stacks,
  // Each seat's chips after this hand minus before it, blinds included;
  // the two add up to 0.
  stack_changes: Schema.Tuple([Schema.Int, Schema.Int]),
});

const roomFields = {
  room_status: Schema.Literals(['waiting', 'playing', 'finished', 'void']),
  // `null` until the opponent joins; "house-bot" against the bot.
  opponent_name: Schema.NullOr(Name),
  display_name: DisplayName,
  // `null` until the opponent joins; "House Bot" against the bot.
  opponent_display_name: Schema.NullOr(DisplayName),
  settings: RoomSettings,
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
  // Whole seconds to the deadline when the server answered, rounded down. A
  // hint only: the deadline is what counts.
  seconds_remaining: NonNegativeInt,
  legal_actions: Schema.NonEmptyArray(LegalAction),
  last_hand: Schema.NullOr(LastHand),
  hands_since_your_turn: Schema.Array(LastHand),
});

const Waiting = Schema.Struct({
  status: Schema.Literal('waiting'),
  ...roomFields,
});

const Rating = Schema.Int;

const SeatRatings = Schema.NullOr(
  Schema.Tuple([
    Schema.Struct({ name: Name, rating: Rating, change: Schema.Int }),
    Schema.Struct({ name: Name, rating: Rating, change: Schema.Int }),
  ]),
);

export const MatchOver = Schema.Struct({
  status: Schema.Literal('match_over'),
  ...roomFields,
  match_id: MatchId,
  result: Schema.Literals(['win', 'loss', 'draw', 'cancelled', 'void']),
  final_stacks: Stacks,
  ratings: SeatRatings,
  last_hand: Schema.NullOr(LastHand),
  hands_since_your_turn: Schema.Array(LastHand),
  tell_owner: Schema.String,
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
      // From the name's latest match.
      display_name: DisplayName,
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
// As the players were shown in that match, by seat.
const DisplayNames = Schema.Tuple([DisplayName, DisplayName]);
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
  display_names: DisplayNames,
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

export const MatchHand = Schema.Struct({
  hand_number: Schema.Int,
  blinds: Blinds,
  button_seat: Seat,
  board: Board,
  // Every hand: the seed is public once the match is over (A13).
  hole_cards: BothHoleCards,
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
  display_names: DisplayNames,
  // `blind_every` is `null` for a match from before T34: fixed 1/2 blinds.
  settings: Schema.Struct({
    ...RoomSettings.fields,
    blind_every: Schema.NullOr(limited('blind_every')),
  }),
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

// --- Watching (A16) ---------------------------------------------------------

// A step as history shows it, with the note the watched seat sent with it.
const WatchEvent = Schema.Struct({
  ...HistoryEntry.fields,
  note: Schema.optionalKey(Note),
});

const WatchView = Schema.Struct({
  ...View.fields,
  history: Schema.Array(WatchEvent),
});

// A finished hand as the match record shows it. While the match is played,
// the opponent's cards are `null` unless the hand went to showdown.
const WatchHand = Schema.Struct({
  ...MatchHand.fields,
  hole_cards: Schema.Tuple([
    Schema.NullOr(HoleCards),
    Schema.NullOr(HoleCards),
  ]),
  events: Schema.Array(WatchEvent),
});

// Nothing the watched seat couldn't get from its own `state` at the same
// time, except its notes: never the seed, a turn_id or legal_actions.
const watchFields = {
  room_id: RoomId,
  // The watched seat.
  seat: Seat,
  players: Schema.Tuple([Name, Schema.NullOr(Name)]),
  display_names: Schema.Tuple([DisplayName, Schema.NullOr(DisplayName)]),
  settings: RoomSettings,
  hand_number: roomFields.hand_number,
  to_act_seat: roomFields.to_act_seat,
  // Only while it is the watched seat's turn.
  deadline: Schema.NullOr(IsoTime),
  view: Schema.NullOr(WatchView),
  // The hands played so far, all of them once the match is over.
  hands: Schema.Array(WatchHand),
};

export const WatchResponse = Schema.Union([
  Schema.Struct({
    ...watchFields,
    room_status: Schema.Literals(['waiting', 'playing']),
  }),
  Schema.Struct({
    ...watchFields,
    room_status: Schema.Literals(['finished', 'void']),
    match_id: MatchId,
    result: SeatResult,
    final_stacks: Stacks,
    ratings: SeatRatings,
  }),
]);
export type WatchResponse = typeof WatchResponse.Type;
