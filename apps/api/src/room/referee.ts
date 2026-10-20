// The referee of one room (casino-api skill: 房間狀態, 狀況處理, wait, state,
// actions, A1, A3, A6, A8, A9, A15, A25). Kept free of `cloudflare:workers` so
// it runs in Node tests; the Room DO hands it its storage and forwards its RPC
// calls here. The table itself is the N-seat engine in holdem/table.ts.
import { isDeepStrictEqual } from 'node:util';
import { type ApiError, apiError } from '../contract/errors';
import type {
  ActionAccepted,
  MATCH_END_REASONS,
  MatchOver,
  RoomStatus,
  TestSettings,
  WatchResponse,
} from '../contract/schemas';
import {
  HOUSE_BOT_DISPLAY_NAME,
  MAX_SEATS,
  RESERVED_NAMES,
} from '../contract/schemas';
import type { MatchRecordInput, RecordedMatch } from '../db/records';
import { randomAction } from '../holdem/bot';
import {
  type Action,
  applyTableAction,
  DEFAULT_BLIND_EVERY,
  leaveTable,
  replayTable,
  startTable,
  type TableHandRecord,
  type TableState,
  tableLegalActions,
} from '../holdem/table';
import type { LobbyEntry, LobbyUpdate } from '../matchmaker/lobby';
import {
  type LegacyHand,
  type LegacyRoom,
  upgradeHand,
  upgradeRoom,
} from './legacy';
import { asSeat, lastHandOut, seatInfos, seatView } from './view';
import { type HandNotes, watchView } from './watch';

// What the referee needs from DurableObjectStorage.
export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  // The DO's one alarm, which calls RoomReferee.alarm().
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

type SeatResult = MatchRecordInput['result'];

// A finished match as the Room DO hands it to the Matchmaker to store (A10):
// every seat with its place, and the engine's hands.
export type TableRecordInput = MatchRecordInput & {
  display_names: string[];
  places: number[] | null;
  end_reason: (typeof MATCH_END_REASONS)[number];
  hands: TableHandRecord[];
};

export type { RecordedMatch };

export interface RefereeOptions {
  // How long `wait` holds a request before answering `waiting`.
  waitMs?: number;
  now?: () => number;
  // Stores a finished match and its Elo (the Room DO passes the Matchmaker's
  // recordMatch, A10). Without it a match counts as stored and unrated.
  record?: (input: TableRecordInput) => Promise<RecordedMatch>;
  // Where house-bot draws its random but legal actions from (A1).
  random?: () => number;
  // The web's address (WEB_URL): match_over's hint links the match page
  // (T32). Without it, the hint has no link.
  webUrl?: string;
  // Tells the lobby (the Matchmaker's listRoom, casino-api A2) the room's
  // new lobby row whenever it changes; `entry: null` once it has started or
  // ended. A failure is logged and doesn't fail the room's own request.
  listRoom?: (update: LobbyUpdate) => Promise<void>;
}

// `blind_every` is `null` until the table starts when none was given (A19).
interface RoomSettings {
  starting_stack: number;
  blind_every: number | null;
  max_hands: number;
  turn_seconds: number;
}

type Visibility = 'public' | 'private';

export interface CreateInput {
  room_id: string;
  invite_code: string;
  name: string;
  // Normalized (A20); `name` when left out.
  display_name?: string;
  settings: RoomSettings;
  seed: string;
  // Only where ALLOW_TEST_ROOMS=true.
  test: typeof TestSettings.Type | null;
  // A multiplayer room the host starts, or `null` for the transitional
  // heads-up mode: two seats, started when the second player sits (queue
  // rooms, and POST /v1/rooms without visibility; 房間狀態).
  visibility: Visibility | null;
  // A1: house-bot takes seat 1 and the match starts at once.
  opponent?: 'bot';
  // The host's watch link (A16), for the reminder on its first turn (T46).
  watch_url?: string;
}

type SeatInfoBody = RoomStatus['seats'][number];
type Seat = SeatInfoBody['seat'];

// The room's part of a seat answer (contract SeatResponse, A25): the Worker
// adds the token, watch_url, tell_owner and hint.
export interface SeatAnswer {
  room_id: string;
  visibility: Visibility;
  // Only the host of a private room gets it.
  invite_code: string | null;
  seat: Seat;
  is_host: boolean;
  display_name: string;
  opponent_name: string | null;
  opponent_display_name: string | null;
  seats: SeatInfoBody[];
  seats_open: number;
  settings: RoomSettings;
}

type Result<T, C extends ApiError['code']> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError<C> };

interface Turn {
  id: string;
  seat: number;
  // Epoch ms.
  deadline: number;
}

// One seat. Before the table starts, seats close up when someone leaves, so
// everything kept per seat lives here and moves with its player.
interface SeatData {
  name: string;
  // What people see of the seat (A20).
  display_name: string;
  // The seat's watch link (A16), given on its first turn (T46); `null` for
  // house-bot, and until the Worker has signed it.
  watch_url: string | null;
  bot: boolean;
  // Epoch ms: when it sat down, and its latest request (狀況處理: 不見).
  joined_at: number;
  last_seen: number;
  // Timeouts in a row; the seat's own action resets the count.
  timeouts: number;
  // A9: three timeouts in a row; the server plays every later turn of the
  // seat at once, for the rest of the match.
  absent: boolean;
  // Left mid-match (A9).
  left: boolean;
  // Completed hands before the seat's last accepted action (A21).
  acted_after_hand: number;
  // A11 reject_first_action: its first action was refused.
  chaos_rejected: boolean;
  // A11 fail_request_every: its requests to the room so far.
  chaos_requests: number;
}

// The room as one JSON value under KEY. Finished hands (the match record of
// casino-api A15) are kept apart, one per key `hand:<hand_number>`, so this
// value stays well under the DO's 128 KiB per value on long matches; so are
// each seat's notes of a hand (A16), under `notes:<hand_number>:<seat>`.
interface RoomData {
  version: 2;
  room_id: string;
  invite_code: string;
  visibility: Visibility | null;
  settings: RoomSettings;
  seed: string;
  test: typeof TestSettings.Type | null;
  seats: SeatData[];
  // `null` until the table starts.
  table: TableState | null;
  turn: Turn | null;
  // How many turns have been handed out; the next turn is `t_<count + 1>`.
  turn_count: number;
  // Turns already used up, by turn_id (A3): who acted, and whether the
  // server acted for them.
  used_turns: Record<string, { seat: number; timeout?: true }>;
  ended: Ended | null;
  // Epoch ms.
  created_at: number;
  // A11 extra_waiting: `waiting` answered instead of the turn `turn_id`.
  fake_waits: { turn_id: string; count: number } | null;
  // Set once a played match is stored (A10); match_over shows its ratings.
  recorded: { ratings: RecordedMatch['ratings'] } | null;
  // The lobby row last sent to the lobby, as JSON, and its rev (A2); left
  // out until the room is first listed.
  listed?: { rev: number; entry: string | null };
}

// `complete`: the engine played the match out (one seat left with chips, or
// max_hands). `left`: a leave left fewer than two seats at the table.
// `bots_only`: nobody but house-bot (and absent seats) still at the table.
// `cancelled`: the host left or went missing before the start. `void`:
// aborted by an admin, or the platform failed; never rated.
export interface Ended {
  reason: 'complete' | 'left' | 'bots_only' | 'cancelled' | 'void';
  final_stacks: number[];
  // Each seat's place; `null` for cancelled and void.
  places: number[] | null;
  // Epoch ms.
  at: number;
}

interface ActionInput {
  turn_id: string;
  type: Action['type'];
  amount?: number;
  note?: string;
}

type ActionAcceptedBody = typeof ActionAccepted.Type;
type MatchOverBody = typeof MatchOver.Type;
type LastHandBody = NonNullable<MatchOverBody['last_hand']>;

// What routes/room.ts calls on a room's DO stub (the Room DO forwards each
// call to its referee).
export type RoomApi = Pick<
  RoomReferee,
  | 'create'
  | 'join'
  | 'setWatchUrl'
  | 'start'
  | 'status'
  | 'act'
  | 'leave'
  | 'abort'
  | 'watch'
>;

const KEY = 'room';
// A1: the built-in bot.
const HOUSE_BOT = RESERVED_NAMES[0];
const WAIT_MS = 30_000;
// 狀況處理: three timeouts in a row and the seat is absent.
const ABSENT_AFTER_TIMEOUTS = 3;
// 狀況處理: before the start, a seat with no request for 2 minutes is gone.
const MISSING_AFTER_MS = 2 * 60 * 1000;
// A18: a seat that joined this long ago is told to check with its owner.
const LONG_WAIT_MS = 180 * 1000;
// The transitional heads-up mode seats two.
const HEADS_UP_SEATS = 2;
// A failed write of a finished match is tried again after as long as the
// match has been over, so about twice as long each time: at least 10 seconds,
// at most an hour, and no more alarms once it ended 24 hours ago (T22: a write
// that always fails would otherwise wake the room forever).
const RECORD_RETRY_MIN_MS = 10_000;
const RECORD_RETRY_MAX_MS = 60 * 60 * 1000;
const RECORD_GIVE_UP_AFTER_MS = 24 * 60 * 60 * 1000;
// A8: an hour after the room ended, its tokens stop working.
const EXPIRES_AFTER_END_MS = 60 * 60 * 1000;
const PLAY_AGAIN =
  'To play again, open a room with POST /v1/rooms or join the queue with POST /v1/queue';

const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = <C extends ApiError['code']>(error: ApiError<C>) => ({
  ok: false as const,
  error,
});

const waitPath = (data: RoomData) => `GET /v1/rooms/${data.room_id}/wait`;
const startPath = (data: RoomData) => `POST /v1/rooms/${data.room_id}/start`;

const notesKey = (hand: number, seat: number) => `notes:${hand}:${seat}`;

const accepted = (data: RoomData): ActionAcceptedBody => ({
  status: 'accepted',
  hint: `Accepted. Call ${waitPath(data)} for your next turn`,
});

const isHeadsUpMode = (data: RoomData) => data.visibility === null;
const seatLimit = (data: RoomData) =>
  isHeadsUpMode(data) ? HEADS_UP_SEATS : MAX_SEATS;

const newSeat = (
  player: { name: string; display_name: string; watch_url?: string | null },
  at: number,
  bot = false,
): SeatData => ({
  name: player.name,
  display_name: player.display_name,
  watch_url: player.watch_url ?? null,
  bot,
  joined_at: at,
  last_seen: at,
  timeouts: 0,
  absent: false,
  left: false,
  acted_after_hand: 0,
  chaos_rejected: false,
  chaos_requests: 0,
});

// A1: `House Bot`, then `House Bot 2`, `House Bot 3`…
const botSeat = (data: RoomData, at: number) => {
  const count = data.seats.filter(seat => seat.bot).length;
  return newSeat(
    {
      name: HOUSE_BOT,
      display_name:
        count === 0
          ? HOUSE_BOT_DISPLAY_NAME
          : `${HOUSE_BOT_DISPLAY_NAME} ${count + 1}`,
    },
    at,
    true,
  );
};

// Names match without case (名字規則); house-bot never sends requests.
const seatOf = (data: RoomData, name: string): number =>
  data.seats.findIndex(
    seat => !seat.bot && seat.name.toLowerCase() === name.toLowerCase(),
  );

const notSeated = (data: RoomData) =>
  apiError(
    'invalid_token',
    `You are no longer seated in room ${data.room_id}: you left before the table started, or made no request for 2 minutes`,
    `Join a table again with POST /v1/rooms/${data.room_id}/join or open a room with POST /v1/rooms`,
  );

export class RoomReferee {
  readonly #storage: RoomStorage;
  readonly #waitMs: number;
  readonly #now: () => number;
  readonly #recordMatch: (input: TableRecordInput) => Promise<RecordedMatch>;
  readonly #random: () => number;
  readonly #webUrl: string | undefined;
  readonly #listRoom: RefereeOptions['listRoom'];
  // RoomData.listed as last saved.
  #listed: RoomData['listed'];
  // The lobby updates sent and not yet answered.
  #telling: Promise<unknown> = Promise.resolve();
  #data: Promise<RoomData | undefined> | undefined;
  // The write of the finished match in flight, so it runs once at a time.
  #recording: Promise<boolean> | undefined;
  // Resolved, then cleared, whenever the room changes; `wait` listens here.
  readonly #listeners = new Set<() => void>();

  constructor(storage: RoomStorage, options: RefereeOptions = {}) {
    this.#storage = storage;
    this.#waitMs = options.waitMs ?? WAIT_MS;
    this.#now = options.now ?? Date.now;
    this.#recordMatch =
      options.record ?? (async () => ({ rated: false, ratings: null }));
    this.#random = options.random ?? Math.random;
    this.#webUrl = options.webUrl;
    this.#listRoom = options.listRoom;
  }

  // Fails only when the room id is already taken.
  async create(input: CreateInput): Promise<Result<SeatAnswer, 'internal'>> {
    if (await this.#load()) {
      return fail(
        apiError(
          'internal',
          `Room ${input.room_id} already exists`,
          'Open the room again with POST /v1/rooms',
        ),
      );
    }
    const { opponent, display_name, watch_url, name, ...room } = input;
    const at = this.#now();
    const data: RoomData = {
      version: 2,
      ...room,
      // A1: a room with house-bot is a private room.
      visibility:
        opponent === 'bot' && input.visibility !== null
          ? 'private'
          : input.visibility,
      seats: [
        newSeat({ name, display_name: display_name ?? name, watch_url }, at),
      ],
      table: null,
      turn: null,
      turn_count: 0,
      used_turns: {},
      ended: null,
      created_at: at,
      fake_waits: null,
      recorded: null,
    };
    const opened =
      opponent === 'bot'
        ? this.#begin(
            { ...data, seats: [...data.seats, botSeat(data, at)] },
            at,
          )
        : data;
    await this.#save(opened);
    await this.#told();
    return ok(seatAnswer(opened, 0));
  }

  async join(input: {
    name: string;
    // Normalized (A20); `name` when left out.
    display_name?: string;
    // Only private rooms need it (A25).
    invite_code?: string;
  }): Promise<
    Result<
      SeatAnswer,
      | 'room_not_found'
      | 'wrong_invite_code'
      | 'room_full'
      | 'match_over'
      | 'name_invalid'
    >
  > {
    const loaded = await this.#load();
    if (!loaded) return fail(roomNotFound());
    if (
      loaded.visibility !== 'public' &&
      (input.invite_code ?? '').toUpperCase() !== loaded.invite_code
    ) {
      return fail(
        apiError(
          'wrong_invite_code',
          `That invite code is not the code of room ${loaded.room_id}`,
          'Ask your opponent for the invite_code of this room and resend the join with it',
        ),
      );
    }
    const data = await this.#settle(loaded);
    if (data.ended) return fail(matchOverError());
    if (data.table || data.seats.length >= seatLimit(data)) {
      return fail(roomFull(data));
    }
    if (
      data.seats.some(s => s.name.toLowerCase() === input.name.toLowerCase())
    ) {
      return fail(
        apiError(
          'name_invalid',
          `The name ${input.name} is already taken by ${isHeadsUpMode(data) ? 'the other player' : 'another player'} in room ${data.room_id}; pick a different name`,
          `Pick a different name and resend POST /v1/rooms/${data.room_id}/join`,
        ),
      );
    }
    const at = this.#now();
    const seated: RoomData = {
      ...data,
      seats: [
        ...data.seats,
        newSeat(
          { name: input.name, display_name: input.display_name ?? input.name },
          at,
        ),
      ],
    };
    // The heads-up mode starts as soon as the second player sits.
    const next =
      isHeadsUpMode(seated) && seated.seats.length === HEADS_UP_SEATS
        ? this.#begin(seated, at)
        : seated;
    await this.#save(next);
    await this.#told();
    return ok(seatAnswer(next, next.seats.length - 1));
  }

  // The Worker signs a seat's watch link once join has told it the seat.
  async setWatchUrl(
    name: string,
    watch_url: string,
  ): Promise<Result<null, 'room_not_found'>> {
    const data = await this.#load();
    if (!data) return fail(roomNotFound());
    const seat = seatOf(data, name);
    if (seat >= 0) await this.#save(updateSeat(data, seat, { watch_url }));
    return ok(null);
  }

  // A25: the host starts the table, filling `bots` empty seats with
  // house-bot. Sent again once started, it answers the table as it is.
  async start(
    name: string,
    input: { bots?: number },
  ): Promise<
    Result<
      RoomStatus,
      | 'room_not_found'
      | 'invalid_token'
      | 'not_host'
      | 'not_enough_players'
      | 'invalid_request'
      | 'match_over'
      | 'unavailable'
    >
  > {
    const arrived = await this.#arrive(name);
    if (arrived) return fail(arrived);
    const opened = await this.#open();
    if (!opened.ok) return opened;
    const data = opened.value;
    const seat = seatOf(data, name);
    if (seat < 0) return fail(notSeated(data));
    if (seat !== 0) {
      return fail(
        apiError(
          'not_host',
          'Only the host (seat 0, who opened the room) can start the table',
          `Wait for the host to start: call ${waitPath(data)}`,
        ),
      );
    }
    if (data.ended) {
      return fail(
        matchOverError(
          statusFor(data, seat, await this.#answering(data, seat)),
        ),
      );
    }
    if (data.table) {
      const now = await this.#status(name, { wait: false });
      // A25: a seat out of the match can't start anything.
      if (now.ok && now.value.status === 'match_over') {
        return fail(matchOverError(now.value));
      }
      return now;
    }
    const bots = input.bots ?? 0;
    const open = seatLimit(data) - data.seats.length;
    if (bots > open) {
      return fail(
        apiError(
          'invalid_request',
          `There ${open === 1 ? 'is 1 empty seat' : `are ${open} empty seats`}, so bots can be at most ${open}; you sent ${bots}`,
          `Resend ${startPath(data)} with bots from 0 to ${open}`,
        ),
      );
    }
    if (data.seats.length + bots < 2) {
      return fail(
        apiError(
          'not_enough_players',
          'A table needs at least 2 players to start, house-bot included; you are alone',
          `Keep waiting with ${waitPath(data)}, or start with house-bot: ${startPath(data)} with {"bots":1} (unrated)`,
        ),
      );
    }
    const at = this.#now();
    let seated = data;
    for (let i = 0; i < bots; i++) {
      seated = { ...seated, seats: [...seated.seats, botSeat(seated, at)] };
    }
    await this.#save(this.#begin(seated, at));
    return this.#status(name, { wait: false });
  }

  // Deals hand 1 to everyone seated; `at` (epoch ms) is when.
  #begin(data: RoomData, at: number): RoomData {
    const players = data.seats.length;
    const blindEvery =
      data.settings.blind_every ?? DEFAULT_BLIND_EVERY[players];
    const table = startTable({
      seed: data.seed,
      players,
      startingStack: data.settings.starting_stack,
      blindEvery,
      maxHands: data.settings.max_hands,
    });
    return this.#nextTurn(
      {
        ...data,
        settings: { ...data.settings, blind_every: blindEvery },
        table,
      },
      at,
    );
  }

  // `wait: true` holds the request until it is the seat's turn, the match is
  // over, the seats change before the start, or the wait window ends.
  async status(
    name: string,
    options: { wait: boolean },
  ): Promise<
    Result<RoomStatus, 'room_not_found' | 'invalid_token' | 'unavailable'>
  > {
    const arrived = await this.#arrive(name);
    if (arrived) return fail(arrived);
    return this.#status(name, options);
  }

  // `status` without counting a request: `act` and `start` call it too.
  async #status(
    name: string,
    options: { wait: boolean },
  ): Promise<
    Result<RoomStatus, 'room_not_found' | 'invalid_token' | 'unavailable'>
  > {
    let timedOut = !options.wait;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const windowEnd = new Promise<void>(resolve => {
      if (timedOut) return resolve();
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.#waitMs);
    });
    let seen: string | undefined;
    try {
      for (;;) {
        const opened = await this.#open();
        if (!opened.ok) return opened;
        const data = opened.value;
        const seat = seatOf(data, name);
        if (seat < 0) return fail(notSeated(data));
        const status = statusFor(data, seat, await this.#answering(data, seat));
        if (options.wait && status.status === 'your_turn') {
          const fake = await this.#fakeWaiting(data, status);
          if (fake) return ok(fake);
        }
        // A6: before the start, a change of seats answers at once.
        const seats = data.table ? undefined : seatList(data);
        const changed = seen !== undefined && seats !== seen;
        seen ??= seats;
        if (status.status !== 'waiting' || timedOut || changed) {
          return ok(status);
        }
        const change = this.#nextChange();
        await Promise.race([change.promise, windowEnd]);
        change.cancel();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // A3: a used turn_id answers its first result again; a rejected action
  // leaves the turn_id usable. T47: with `wait`, an accepted action (or the
  // resend of one) answers what `wait` would right after it; a rejected one
  // answers its error at once.
  async act(
    name: string,
    input: ActionInput,
    options: { wait?: boolean } = {},
  ): Promise<
    Result<
      ActionAcceptedBody | RoomStatus,
      | 'room_not_found'
      | 'not_your_turn'
      | 'stale_turn'
      | 'invalid_action'
      | 'match_over'
      | 'invalid_token'
      | 'unavailable'
    >
  > {
    const arrived = await this.#arrive(name);
    if (arrived) return fail(arrived);
    // A3 first: the resend of an accepted action answers the same even
    // while the finished match can't be stored.
    const opened = await this.#open({ record: false });
    if (!opened.ok) return opened;
    const seat = seatOf(opened.value, name);
    if (seat < 0) return fail(notSeated(opened.value));
    const used = opened.value.used_turns[input.turn_id];
    if (used?.seat === seat && !used.timeout) {
      // T50: the seat is on a newer turn already, so say this send did
      // nothing and which turn_id to use (an old turn_id looked like success).
      const newer = opened.value.ended ? undefined : opened.value.turn;
      if (newer?.seat === seat && newer.id !== input.turn_id) {
        const unused = `turn_id ${input.turn_id} was already used, so nothing was sent`;
        if (!options.wait) {
          return ok({
            status: 'accepted',
            duplicate: true,
            hint: `${unused}; your current turn is turn_id ${newer.id}: act on it, after reading the table with ${waitPath(opened.value)}.`,
          });
        }
        const now = await this.#status(name, { wait: false });
        if (now.ok && now.value.status === 'your_turn') {
          return ok({
            ...now.value,
            duplicate: true,
            hint: `${unused}; act again with turn_id ${now.value.turn_id} from this response. ${now.value.hint}`,
          });
        }
        return now;
      }
      if (options.wait) return this.#status(name, { wait: true });
      return ok({ ...accepted(opened.value), duplicate: true });
    }
    const stored = await this.#stored(opened.value);
    if (!stored.ok) return stored;
    const data = stored.value;
    const state = statusFor(data, seat, await this.#answering(data, seat));
    if (data.ended || state.status === 'match_over') {
      return fail(matchOverError(state));
    }
    const { table, turn } = data;
    // A3: the server already played this turn when it timed out.
    if (used?.seat === seat) {
      return fail(
        apiError(
          'stale_turn',
          `Turn ${input.turn_id} timed out, so the server checked or folded for you`,
          doNotResend(data),
          { state },
        ),
      );
    }
    if (!table || turn?.seat !== seat) {
      return fail(
        apiError('not_your_turn', 'It is not your turn', doNotResend(data), {
          state,
        }),
      );
    }
    if (input.turn_id !== turn.id) {
      return fail(
        apiError(
          'stale_turn',
          `That turn_id is not your current turn`,
          doNotResend(data),
          { state },
        ),
      );
    }
    if (
      data.test?.chaos?.reject_first_action &&
      !data.seats[seat].chaos_rejected
    ) {
      await this.#save(updateSeat(data, seat, { chaos_rejected: true }));
      return fail(
        apiError(
          'invalid_action',
          'This test room refuses the first action of each player on purpose (chaos reject_first_action)',
          `Pick a legal action from legal_actions and resubmit it with the same turn_id before the deadline`,
          { state },
        ),
      );
    }
    // A raise without an amount is passed on for the engine to refuse.
    const action = (
      input.type === 'raise'
        ? { type: 'raise', amount: input.amount }
        : { type: input.type }
    ) as Action;
    const done = this.#perform(data, table, turn, action, this.#now());
    if (!done.ok) {
      return fail(
        apiError(
          'invalid_action',
          done.message,
          `Pick a legal action from legal_actions and resubmit it with the same turn_id before the deadline`,
          { state },
        ),
      );
    }
    // A16: the note goes with the step this action becomes in the hand.
    const notes: Record<string, HandNotes> = {};
    if (input.note !== undefined) {
      const key = notesKey(table.handNumber, seat);
      notes[key] = {
        ...(await this.#storage.get<HandNotes>(key)),
        [table.history.length]: input.note,
      };
    }
    await this.#save(
      updateSeat(done.data, seat, {
        acted_after_hand: table.lastHand?.hand_number ?? 0,
      }),
      done.finishedHands,
      notes,
    );
    if (options.wait) return this.#status(name, { wait: true });
    return ok(accepted(data));
  }

  // A9: before the start the host closes the room and anyone else frees a
  // seat; while playing the seat is out in last place, and the match ends
  // when fewer than two are left at the table.
  async leave(
    name: string,
  ): Promise<
    Result<
      MatchOverBody,
      'room_not_found' | 'match_over' | 'invalid_token' | 'unavailable'
    >
  > {
    const arrived = await this.#arrive(name);
    if (arrived) return fail(arrived);
    const opened = await this.#open();
    if (!opened.ok) return opened;
    const data = opened.value;
    const seat = seatOf(data, name);
    if (seat < 0) return fail(notSeated(data));
    const at = this.#now();
    const answering = await this.#answering(data, seat);
    const state = statusFor(data, seat, answering);
    if (data.ended || state.status === 'match_over') {
      return fail(matchOverError(state));
    }
    const { table } = data;
    if (!table) {
      if (seat === 0) {
        await this.#save(this.#finish(data, at, cancelled(data)));
      } else {
        const next = removeSeat(data, seat);
        await this.#save(next);
        return ok(leftBeforeStart(data, seat, next));
      }
    } else {
      const left = updateSeat(data, seat, { left: true });
      const seated = table.places.filter(place => place === null).length;
      if (seated - 1 < 2) {
        // The unfinished hand is called off, as heads-up (A9).
        const places = [...table.places];
        places[seat] = seated;
        const winner = places.indexOf(null);
        if (winner >= 0) places[winner] = 1;
        await this.#save(
          this.#finish(left, at, {
            reason: 'left',
            final_stacks: calledOff(left),
            places: places as number[],
          }),
        );
      } else {
        const result = leaveTable(table, seat);
        if (!result.ok)
          throw new Error(`Room ${data.room_id}: ${result.message}`);
        const turnGoes =
          result.finishedHands.length > 0 ||
          result.state.toAct !== data.turn?.seat;
        const next = this.#afterChange(
          { ...left, table: result.state },
          at,
          turnGoes,
        );
        await this.#save(next, result.finishedHands);
      }
    }
    const saved = await this.#load();
    if (!saved) return fail(roomNotFound());
    if (saved.ended && unrecorded(saved)) return fail(recordFailed());
    const answer = statusFor(saved, seat, await this.#answering(saved, seat));
    if (answer.status !== 'match_over') {
      throw new Error(`Room ${data.room_id}: seat ${seat} left but plays on`);
    }
    return ok(answer);
  }

  // A9: an admin calls the match off; it is void and never rated. Unlike the
  // seats' requests, a room that ended over an hour ago still answers
  // match_over here.
  async abort(): Promise<Result<null, 'room_not_found' | 'match_over'>> {
    const loaded = await this.#load();
    if (!loaded) return fail(roomNotFound());
    const data = await this.#settle(loaded);
    // No seat, so no state to show (A4 attaches it on room endpoints).
    if (data.ended) {
      return fail(
        apiError(
          'match_over',
          `The match in room ${data.room_id} already ended, so there is nothing to abort`,
          'Nothing to do: the room already ended and keeps its result',
        ),
      );
    }
    await this.#save(
      this.#finish(data, this.#now(), {
        reason: 'void',
        final_stacks: calledOff(data),
        places: null,
      }),
    );
    return ok(null);
  }

  // A16: the owner's view of the seat of `name`. Answers at once, and still
  // after the hour that ends the seats' tokens (A8); not a seat's request,
  // so chaos and 不見 leave it alone.
  async watch(
    name: string,
  ): Promise<
    Result<WatchResponse, 'room_not_found' | 'invalid_token' | 'unavailable'>
  > {
    const loaded = await this.#load();
    if (!loaded) return fail(roomNotFound());
    const stored = await this.#stored(await this.#settle(loaded));
    if (!stored.ok) return stored;
    const data = stored.value;
    const seat = seatOf(data, name);
    if (seat < 0) return fail(notSeated(data));
    const { table, ended } = data;
    const notes: Record<number, HandNotes> = {};
    for (let n = 1; n <= (table?.handNumber ?? 0); n++) {
      const hand = await this.#storage.get<HandNotes>(notesKey(n, seat));
      if (hand) notes[n] = hand;
    }
    return ok(
      watchView({
        room_id: data.room_id,
        seat,
        names: data.seats.map(s => s.name),
        display_names: data.seats.map(s => s.display_name),
        settings: data.settings,
        visibility: data.visibility ?? 'private',
        left: data.seats.map(s => s.left),
        seats_open: seatsOpen(data),
        seed: data.seed,
        table,
        hands: table ? await this.#hands(table.handNumber) : [],
        notes,
        deadline: data.turn?.seat === seat ? data.turn.deadline : null,
        ended: ended && {
          result: seatResult(ended),
          places: ended.places,
          final_stacks: ended.final_stacks,
          ratings: data.recorded?.ratings ?? null,
        },
      }),
    );
  }

  // What an answer to `seat` needs besides the room (A15, A21): the hands
  // finished since the seat last acted, and the last finished hand. Worked
  // out from the hand records, since hands played out on all-ins have no
  // turn to show them.
  async #answering(data: RoomData, seat: number): Promise<Answering> {
    const base = {
      now: this.#now(),
      webUrl: this.#webUrl,
      since: [] as LastHandBody[],
      last: null as LastHandBody | null,
    };
    const last = data.table?.lastHand?.hand_number ?? 0;
    if (last === 0) return base;
    const cursor = Math.min(data.seats[seat]?.acted_after_hand ?? 0, last - 1);
    const start = data.settings.starting_stack;
    let previous: number[] = data.seats.map(() => start);
    if (cursor > 0) previous = (await this.#hand(cursor)).stacks;
    for (let number = cursor + 1; number <= last; number++) {
      const hand = await this.#hand(number);
      const out = lastHandOut(hand, previous) as LastHandBody;
      if (number > (data.seats[seat]?.acted_after_hand ?? 0))
        base.since.push(out);
      if (number === last) base.last = out;
      previous = hand.stacks;
    }
    return base;
  }

  async #hand(number: number): Promise<TableHandRecord> {
    const hand = await this.#storage.get<TableHandRecord | LegacyHand>(
      `hand:${number}`,
    );
    if (!hand) throw new Error(`Room has no hand ${number} stored`);
    return upgradeHand(hand);
  }

  // The finished hands of the match, in order.
  async #hands(through: number): Promise<TableHandRecord[]> {
    const hands: TableHandRecord[] = [];
    for (let n = 1; n <= through; n++) {
      const hand = await this.#storage.get<TableHandRecord | LegacyHand>(
        `hand:${n}`,
      );
      if (hand) hands.push(upgradeHand(hand));
    }
    return hands;
  }

  // Every seat's request comes in here first. A11 fail_request_every counts
  // the seat's requests and refuses every Nth one before anything else (this
  // 503 is made on purpose, unlike the one client.ts answers when the DO
  // can't be reached); before the start, the request also shows the seat is
  // still there (狀況處理: 不見).
  async #arrive(name: string): Promise<ApiError<'unavailable'> | undefined> {
    const loaded = await this.#load();
    if (!loaded) return undefined;
    const data = await this.#settle(loaded);
    const seat = seatOf(data, name);
    if (seat < 0) return undefined;
    const every = data.test?.chaos?.fail_request_every;
    const waiting = !data.table && !data.ended;
    if (every === undefined && !waiting) return undefined;
    const requests = data.seats[seat].chaos_requests + 1;
    await this.#save(
      updateSeat(data, seat, {
        ...(every !== undefined && { chaos_requests: requests }),
        ...(waiting && { last_seen: this.#now() }),
      }),
    );
    if (every === undefined || requests % every !== 0) return undefined;
    return apiError(
      'unavailable',
      'This test room dropped the request on purpose (chaos fail_request_every)',
      'Resend the same request',
    );
  }

  // A11 extra_waiting: the first N waits of each turn answer `waiting` at
  // once instead of `your_turn`; the deadline does not move.
  async #fakeWaiting(
    data: RoomData,
    turn: RoomStatus & { status: 'your_turn' },
  ): Promise<RoomStatus | undefined> {
    const extra = data.test?.chaos?.extra_waiting ?? 0;
    const done = data.fake_waits;
    const count = done?.turn_id === turn.turn_id ? done.count : 0;
    if (count >= extra) return undefined;
    await this.#save({
      ...data,
      fake_waits: { turn_id: turn.turn_id, count: count + 1 },
    });
    return {
      status: 'waiting',
      room_status: turn.room_status,
      opponent_name: turn.opponent_name,
      display_name: turn.display_name,
      opponent_display_name: turn.opponent_display_name,
      settings: turn.settings,
      to_act_seat: turn.to_act_seat,
      hand_number: turn.hand_number,
      view: turn.view,
      hint: `Not your turn yet. Call ${waitPath(data)} again`,
      visibility: turn.visibility,
      is_host: turn.is_host,
      seats_open: turn.seats_open,
      seats: turn.seats,
    };
  }

  // Loads the room, refusing a missing one or one that ended over an hour
  // ago (A8).
  // A10: no match_over before a played match is stored, unless `record` is
  // false; then the caller calls #stored itself.
  async #open(
    options: { record: boolean } = { record: true },
  ): Promise<
    Result<RoomData, 'room_not_found' | 'invalid_token' | 'unavailable'>
  > {
    const loaded = await this.#load();
    if (!loaded) return fail(roomNotFound());
    const data = await this.#settle(loaded);
    if (data.ended && this.#now() - data.ended.at > EXPIRES_AFTER_END_MS) {
      return fail(
        apiError(
          'invalid_token',
          `Room ${data.room_id} ended over an hour ago, so its tokens no longer work`,
          PLAY_AGAIN,
        ),
      );
    }
    return options.record ? this.#stored(data) : ok(data);
  }

  // The room once a match that ended is stored; `unavailable` if it can't
  // be yet.
  async #stored(data: RoomData): Promise<Result<RoomData, 'unavailable'>> {
    if (!unrecorded(data)) return ok(data);
    if (!(await this.#record())) return fail(recordFailed());
    return ok((await this.#load()) ?? data);
  }

  // The one way an action is applied: by a player now, by the server on a
  // timeout or for house-bot. `at` (epoch ms) is when it happened, which
  // starts the next turn.
  #perform(
    data: RoomData,
    table: TableState,
    turn: Turn,
    action: Action,
    at: number,
    options: { timeout?: true } = {},
  ):
    | { ok: true; data: RoomData; finishedHands: TableHandRecord[] }
    | { ok: false; message: string } {
    const result = applyTableAction(table, turn.seat, action, options);
    if (!result.ok) return result;
    const { finishedHands } = result;
    const before = data.seats[turn.seat];
    const timeouts = options.timeout ? before.timeouts + 1 : 0;
    const next: RoomData = {
      ...updateSeat(data, turn.seat, {
        timeouts,
        absent: before.absent || timeouts >= ABSENT_AFTER_TIMEOUTS,
      }),
      table: result.state,
      used_turns: {
        ...data.used_turns,
        [turn.id]: { seat: turn.seat, ...options },
      },
    };
    return { ok: true, data: this.#afterChange(next, at, true), finishedHands };
  }

  // After the table changed at `at`: the match may be over, or only
  // house-bot may be left (狀況處理); otherwise a new turn when `newTurn`.
  #afterChange(data: RoomData, at: number, newTurn: boolean): RoomData {
    const { table } = data;
    if (!table) return data;
    if (table.over) {
      return this.#finish(data, at, {
        reason: 'complete',
        final_stacks: [...table.stacks],
        places: table.places.map(place => place ?? 1),
      });
    }
    if (botsOnly(data)) {
      // House-bot first by chips, then the absent seats by chips: they are
      // gone like the seats out of the match (狀況處理).
      const final = calledOff(data);
      const rank = (seat: number) => (data.seats[seat].absent ? 1 : 0);
      const places = table.places.map((place, seat) =>
        place !== null
          ? place
          : 1 +
            table.places.filter(
              (other, o) =>
                other === null &&
                (rank(o) < rank(seat) ||
                  (rank(o) === rank(seat) && final[o] > final[seat])),
            ).length,
      );
      return this.#finish(data, at, {
        reason: 'bots_only',
        final_stacks: final,
        places,
      });
    }
    return newTurn ? this.#nextTurn(data, at) : data;
  }

  // Plays everything due by now, each at the time it fell due, so a late
  // alarm or a request ends up where an alarm on time would have: a turn past
  // its deadline, and an absent seat's turn the moment it starts, get the
  // timeout action (holdem-rules 超時動作: check if it can, else fold);
  // house-bot plays its turn the moment it starts (A1). Before the start, a
  // seat with no request for 2 minutes is gone (狀況處理: 不見).
  #due(data: RoomData) {
    let next = data;
    const finishedHands: TableHandRecord[] = [];
    for (;;) {
      const { table, turn } = next;
      if (next.ended) break;
      if (!table) {
        const missing = missingSeat(next);
        if (!missing || this.#now() < missing.at) break;
        next =
          missing.seat === 0
            ? this.#finish(next, missing.at, cancelled(next))
            : removeSeat(next, missing.seat);
        continue;
      }
      if (!turn) break;
      const player = next.seats[turn.seat];
      const atOnce = player.bot || player.absent;
      const at = atOnce
        ? turn.deadline - turnMs(next, turn.seat)
        : turn.deadline;
      if (!atOnce && this.#now() < turn.deadline) break;
      const legal = tableLegalActions(table);
      const canCheck = legal.some(a => a.type === 'check');
      const done = player.bot
        ? this.#perform(
            next,
            table,
            turn,
            randomAction(legal, this.#random),
            at,
          )
        : this.#perform(
            next,
            table,
            turn,
            { type: canCheck ? 'check' : 'fold' },
            at,
            { timeout: true },
          );
      if (!done.ok) {
        // An action of the server's own the engine refuses is a bug of ours:
        // the match is void (狀況處理: 平台出錯) rather than stuck.
        console.error(`Room ${next.room_id}: action refused: ${done.message}`);
        next = this.#finish(next, at, {
          reason: 'void',
          final_stacks: calledOff(next),
          places: null,
        });
        break;
      }
      next = done.data;
      finishedHands.push(...done.finishedHands);
    }
    return { data: next, finishedHands };
  }

  // Saves whatever fell due before the caller looks at the room.
  async #settle(data: RoomData): Promise<RoomData> {
    const due = this.#due(data);
    if (due.data !== data) await this.#save(due.data, due.finishedHands);
    return due.data;
  }

  // The Room DO's alarm: play what is due and set the next alarm.
  async alarm(): Promise<void> {
    const data = await this.#load();
    if (!data) return;
    const settled = await this.#settle(data);
    // A save already tried to store a match that just ended.
    if (settled === data && unrecorded(data)) await this.#record();
  }

  // A10: replays the match from its seed and actions, then stores it; a
  // replay that differs from what was played makes the match void. True once
  // stored; false if storing failed, to be tried again by the next request
  // or the alarm.
  #record(): Promise<boolean> {
    this.#recording ??= this.#writeRecord().finally(() => {
      this.#recording = undefined;
    });
    return this.#recording;
  }

  async #writeRecord(): Promise<boolean> {
    const loaded = await this.#load();
    if (!loaded || !unrecorded(loaded)) return true;
    const { table, ended } = loaded;
    const hands = await this.#hands(table.handNumber);
    const notes: NonNullable<TableRecordInput['notes']> = [];
    for (const { hand_number } of hands) {
      for (const [seat] of loaded.seats.entries()) {
        const hand = await this.#storage.get<HandNotes>(
          notesKey(hand_number, seat),
        );
        for (const [seq, note] of Object.entries(hand ?? {})) {
          notes.push({ hand_number, seq: Number(seq), note });
        }
      }
    }
    const final: Ended = replays(table, hands)
      ? ended
      : { ...ended, reason: 'void', places: null };
    if (final !== ended) {
      console.error(
        `Room ${loaded.room_id}: replay differs; the match is void`,
      );
    }
    let recorded: RecordedMatch;
    try {
      recorded = await this.#recordMatch({
        match_id: loaded.room_id,
        players: loaded.seats.map(seat => seat.name),
        display_names: loaded.seats.map(seat => seat.display_name),
        settings: { ...loaded.settings, blind_every: table.config.blindEvery },
        seed: loaded.seed,
        result: seatResult(final),
        places: final.places,
        end_reason: endReason(final),
        ended_at: new Date(final.at).toISOString(),
        final_stacks: final.final_stacks,
        hands,
        ...(notes.length > 0 && { notes }),
      });
    } catch (error) {
      console.error(`Room ${loaded.room_id}: storing the match failed`, error);
      const retry = recordRetryAt(ended, this.#now());
      if (retry === null) {
        console.error(
          `Room ${loaded.room_id}: gave up storing the match a day after it ended`,
        );
        await this.#storage.deleteAlarm();
      } else {
        await this.#storage.setAlarm(retry);
      }
      return false;
    }
    // Reloaded: other requests may have saved while D1 was busy.
    const latest = (await this.#load()) ?? loaded;
    await this.#save({
      ...latest,
      ended: final,
      recorded: { ratings: recorded.ratings },
    });
    return true;
  }

  // Where every match ends; `at` is when (epoch ms).
  #finish(
    data: RoomData,
    at: number,
    ended: Omit<Ended, 'at'>,
  ): RoomData & { ended: Ended } {
    return { ...data, turn: null, ended: { ...ended, at } };
  }

  #load(): Promise<RoomData | undefined> {
    this.#data ??= this.#storage
      .get<RoomData | LegacyRoom>(KEY)
      .then(data => data && upgradeRoom<RoomData>(data));
    return this.#data;
  }

  // Every change goes through here, so a match that just ended is stored
  // here, before the caller answers (A10).
  // `notes`: values to store under their keys in the same commit.
  async #save(
    unsettled: RoomData,
    unsettledHands: TableHandRecord[] = [],
    notes: Record<string, HandNotes> = {},
  ): Promise<void> {
    // An absent seat may be next to act: it is played before anyone looks.
    const due = this.#due(unsettled);
    // Callers may save again from data older than the last save: what was
    // last sent is the instance's, or storage's after an eviction.
    const { data, listing } = relisted(
      due.data,
      this.#listed ?? due.data.listed,
    );
    const finishedHands = [...unsettledHands, ...due.finishedHands];
    this.#data = Promise.resolve(data);
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) listener();
    // Started together, the DO commits these writes as one.
    const alarm = alarmAt(data, this.#now());
    const writes = [
      ...finishedHands.map(hand =>
        this.#storage.put(`hand:${hand.hand_number}`, hand),
      ),
      ...Object.entries(notes).map(([key, value]) =>
        this.#storage.put(key, value),
      ),
      this.#storage.put(KEY, data),
      alarm === null
        ? this.#storage.deleteAlarm()
        : this.#storage.setAlarm(alarm),
    ];
    try {
      await Promise.all(writes);
    } catch (error) {
      // Forget the unsaved change: the next request reads storage again.
      this.#data = undefined;
      throw error;
    }
    this.#listed = data.listed;
    // Not awaited: callers go on from the data they saved, which another
    // request could change while this call is out. Updates arriving out of
    // order are fine, the lobby goes by rev.
    if (listing) this.#tell(listing);
    // A failure is retried by the next request or the alarm.
    if (unrecorded(data)) await this.#record();
  }

  #tell(listing: LobbyUpdate) {
    const listRoom = this.#listRoom;
    if (!listRoom) return;
    const told = (async () => {
      try {
        await listRoom(listing);
      } catch (error) {
        // The lobby catches up with the next change; quick seats go by
        // what join answers anyway.
        console.error(`Room ${listing.room_id}: lobby not told`, error);
      }
    })();
    this.#telling = Promise.all([this.#telling, told]);
  }

  // Waits until the lobby has heard of every change so far. create and join
  // answer only after it, so the lobby's next quick seat sees the seat just
  // taken (A2: people arriving together fill one room).
  async #told(): Promise<void> {
    await this.#telling;
  }

  #nextChange() {
    let listener = () => {};
    const promise = new Promise<void>(resolve => {
      listener = resolve;
      this.#listeners.add(listener);
    });
    return { promise, cancel: () => this.#listeners.delete(listener) };
  }

  // Hands the next turn to whoever is to act, with a fresh turn_id; `at`
  // (epoch ms) is when the turn starts.
  #nextTurn(data: RoomData, at: number): RoomData {
    const seat = data.table?.toAct ?? null;
    if (seat === null) return { ...data, turn: null };
    const count = data.turn_count + 1;
    return {
      ...data,
      turn_count: count,
      turn: {
        id: `t_${count}`,
        seat,
        deadline: at + turnMs(data, seat),
      },
    };
  }
}

const updateSeat = (
  data: RoomData,
  seat: number,
  change: Partial<SeatData>,
): RoomData => ({
  ...data,
  seats: data.seats.map((s, i) => (i === seat ? { ...s, ...change } : s)),
});

// Before the start: the seats after `seat` close up (A25).
// The room's row in the lobby (A2, A25 GET /v1/lobby), while it waits.
const lobbyEntry = (data: RoomData): LobbyEntry | null =>
  data.table || data.ended
    ? null
    : {
        room_id: data.room_id,
        visibility: data.visibility ?? 'private',
        seats: data.seats.map(({ name, display_name }, seat) => ({
          seat: asSeat(seat),
          name,
          display_name,
        })),
        seats_open: seatLimit(data) - data.seats.length,
        settings: data.settings,
        created_at: new Date(data.created_at).toISOString(),
        test: data.test,
      };

// The room with its lobby row brought up to date, and the update to send
// the lobby if the row changed.
const relisted = (
  data: RoomData,
  last: RoomData['listed'] = { rev: 0, entry: null },
): { data: RoomData; listing: LobbyUpdate | null } => {
  const entry = lobbyEntry(data);
  const json = entry && JSON.stringify(entry);
  if (json === last.entry)
    return { data: { ...data, listed: last }, listing: null };
  const rev = last.rev + 1;
  return {
    data: { ...data, listed: { rev, entry: json } },
    listing: { room_id: data.room_id, rev, entry },
  };
};

const removeSeat = (data: RoomData, seat: number): RoomData => ({
  ...data,
  seats: data.seats.filter((_, i) => i !== seat),
});

const seatList = (data: RoomData) => data.seats.map(s => s.name).join(',');

// The first seat to go missing before the start, and when (狀況處理: 不見).
const missingSeat = (data: RoomData) => {
  let found: { seat: number; at: number } | undefined;
  for (const [seat, player] of data.seats.entries()) {
    if (player.bot) continue;
    const at = player.last_seen + MISSING_AFTER_MS;
    if (!found || at < found.at) found = { seat, at };
  }
  return found;
};

// 狀況處理: nobody but house-bot, or seats the server plays for, at the table.
const botsOnly = ({ seats, table }: RoomData) =>
  table !== null &&
  seats.some(seat => seat.bot) &&
  seats.every((seat, i) => table.places[i] !== null || seat.bot || seat.absent);

const cancelled = (data: RoomData): Omit<Ended, 'at'> => ({
  reason: 'cancelled',
  final_stacks: calledOff(data),
  places: null,
});

// How long `seat`'s turn lasts: twice turn_seconds for its first turn of
// the match, whoever ended it (A22), else turn_seconds.
const turnMs = (data: RoomData, seat: number): number => {
  const hadTurn = Object.values(data.used_turns).some(
    used => used.seat === seat,
  );
  return data.settings.turn_seconds * 1000 * (hadTurn ? 1 : 2);
};

// A played match that ended but is not stored yet. Rooms that never started
// are never stored (A9).
const unrecorded = (
  data: RoomData,
): data is RoomData & { table: TableState; ended: Ended } =>
  data.ended !== null && data.table !== null && !data.recorded;

// When the room next has something due (epoch ms), or null for nothing.
const alarmAt = (data: RoomData, now: number): number | null =>
  data.ended
    ? unrecorded(data)
      ? recordRetryAt(data.ended, now)
      : null
    : data.table
      ? (data.turn?.deadline ?? null)
      : (missingSeat(data)?.at ?? null);

// When to try again to store a match that ended at `ended.at` (epoch ms), or
// null once it is too late.
const recordRetryAt = (ended: Ended, now: number): number | null => {
  const age = now - ended.at;
  if (age >= RECORD_GIVE_UP_AFTER_MS) return null;
  return (
    now + Math.min(RECORD_RETRY_MAX_MS, Math.max(RECORD_RETRY_MIN_MS, age))
  );
};

// The stacks with the unfinished hand called off: chips in its pot go back.
const calledOff = ({ table, settings, seats }: RoomData): number[] =>
  table
    ? table.stacks.map((stack, seat) => stack + table.contributed[seat])
    : seats.map(() => settings.starting_stack);

// 收到什麼就做什麼: too late or not your turn → do not resend, wait.
const doNotResend = (data: RoomData) =>
  `Do not resend. Call ${waitPath(data)} and act when it answers your_turn`;

const matchOverError = (state?: RoomStatus) =>
  apiError(
    'match_over',
    'The match in this room is over; it takes no more requests',
    `Read the result in state. ${PLAY_AGAIN}`,
    state ? { state } : {},
  );

const recordFailed = () =>
  apiError(
    'unavailable',
    'The match is over, but its result could not be saved yet',
    'Resend the same request in a few seconds',
  );

const roomFull = (data: RoomData) =>
  apiError(
    'room_full',
    isHeadsUpMode(data)
      ? `Room ${data.room_id} already has two players`
      : data.table
        ? `The table in room ${data.room_id} has already started`
        : `Room ${data.room_id} is full: ${MAX_SEATS} players are seated`,
    'Open your own room with POST /v1/rooms, or join the queue with POST /v1/queue',
  );

// The finished hands and the hand in progress, played again from the seed,
// must end up exactly where the match did (資料與積分: 賽後重播).
function replays(table: TableState, hands: TableHandRecord[]): boolean {
  const events = [
    ...hands.flatMap(hand => hand.events),
    ...(table.over ? [] : table.history),
  ];
  try {
    const result = replayTable(table.config, events);
    // Through JSON, as storage keeps it: absent and undefined are the same.
    const plain = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value));
    return (
      result.ok &&
      isDeepStrictEqual(plain(result.state), plain(table)) &&
      isDeepStrictEqual(plain(result.hands), plain(hands))
    );
  } catch {
    return false;
  }
}

function endReason(ended: Ended): TableRecordInput['end_reason'] {
  switch (ended.reason) {
    case 'complete':
      return ended.final_stacks.filter(stack => stack > 0).length <= 1
        ? 'bust'
        : 'max_hands';
    case 'left':
      return 'leave';
    default:
      return ended.reason;
  }
}

// The result from the seats' point of view (matches, A15).
function seatResult(ended: Ended): SeatResult {
  if (
    !ended.places ||
    ended.reason === 'void' ||
    ended.reason === 'cancelled'
  ) {
    return ended.reason === 'cancelled' ? 'cancelled' : 'void';
  }
  const firsts = ended.places.flatMap((place, seat) =>
    place === 1 ? [seat] : [],
  );
  return firsts.length === 1 ? (`seat${firsts[0]}_win` as SeatResult) : 'draw';
}

const roomNotFound = () =>
  apiError(
    'room_not_found',
    'There is no such room',
    'Check the room_id, or open a room with POST /v1/rooms',
  );

const seatsOpen = (data: RoomData) =>
  data.table || data.ended ? 0 : seatLimit(data) - data.seats.length;

const seatsOf = (data: RoomData) =>
  seatInfos({
    names: data.seats.map(seat => seat.name),
    display_names: data.seats.map(seat => seat.display_name),
    starting_stack: data.settings.starting_stack,
    table: data.table,
    ended: data.ended,
    left: data.seats.map(seat => seat.left),
  });

// A25: the opponent_* fields only at a table of exactly two seats.
const opponentOf = (data: RoomData, seat: number) => {
  const other = data.seats.length === 2 ? data.seats[1 - seat] : undefined;
  return {
    opponent_name: other?.name ?? null,
    opponent_display_name: other?.display_name ?? null,
  };
};

function seatAnswer(data: RoomData, seat: number): SeatAnswer {
  const visibility = data.visibility ?? 'private';
  return {
    room_id: data.room_id,
    visibility,
    invite_code:
      seat === 0 && visibility === 'private' ? data.invite_code : null,
    seat: asSeat(seat),
    is_host: seat === 0,
    display_name: data.seats[seat].display_name,
    ...opponentOf(data, seat),
    seats: seatsOf(data),
    seats_open: seatsOpen(data),
    settings: data.settings,
  };
}

// A16: who the seat plays, and with what settings.
const seatFields = (data: RoomData, seat: number) => ({
  ...opponentOf(data, seat),
  display_name: data.seats[seat].display_name,
  settings: data.settings,
});

// A25, spread last so a 2-seat answer reads as before up to these fields.
const tableFields = (data: RoomData, seat: number) => ({
  visibility: data.visibility ?? ('private' as const),
  is_host: seat === 0,
  seats_open: seatsOpen(data),
  seats: seatsOf(data),
});

// `now`: when the answer is made (epoch ms). `since`: the hands finished
// since the seat last acted; `last`: the last finished hand.
interface Answering {
  now: number;
  webUrl: string | undefined;
  since: LastHandBody[];
  last: LastHandBody | null;
}

const shownNames = (data: RoomData, seats: number[]) =>
  seats.map(seat => data.seats[seat].display_name).join(', ');

// A6: what a seat is told before the table starts.
function waitingHint(data: RoomData, seat: number, now: number): string {
  const again = `Call ${waitPath(data)} again`;
  if (isHeadsUpMode(data)) {
    return `Waiting for your opponent to join with the invite code. ${again}`;
  }
  const seated = `Seated now (${data.seats.length} of ${MAX_SEATS}): ${shownNames(
    data,
    data.seats.map((_, i) => i),
  )}`;
  const keepCalling =
    'Keep calling wait while you wait for their answer: after 2 minutes without a request';
  if (seat === 0) {
    const open = seatsOpen(data);
    const choices =
      open === 0
        ? `The table is full, so you can only start or leave. If this list changed since you last told your owner, tell them who is seated and ask whether to start now (${startPath(data)} with {}) or leave (POST /v1/rooms/${data.room_id}/leave, which closes the room)`
        : `If this list changed since you last told your owner, tell them who is seated and ask: start now (${startPath(data)} with {}), fill the ${open} empty seat${open === 1 ? '' : 's'} with house-bot (${startPath(data)} with {"bots":N}, unrated), or keep waiting`;
    return `${seated}. ${choices}. ${keepCalling} the room closes. ${again}`;
  }
  const waited = now - data.seats[seat].joined_at;
  if (waited >= LONG_WAIT_MS) {
    return `${seated}. The host has not started the table for ${Math.floor(waited / 60_000)} minutes. Tell your owner how long you have waited and who is seated, and ask whether to keep waiting or leave (POST /v1/rooms/${data.room_id}/leave, which costs nothing before the start). ${keepCalling} you lose your seat. ${again}`;
  }
  return `${seated}. Waiting for the host to start the table. ${again}`;
}

// What `state` and `wait` answer to `seat` (A15).
function statusFor(
  data: RoomData,
  seat: number,
  answering: Answering,
): RoomStatus {
  const { table, turn } = data;
  if (data.ended) return matchOver(data, data.ended, seat, answering);
  if (!table) {
    return {
      status: 'waiting',
      room_status: 'waiting',
      ...seatFields(data, seat),
      to_act_seat: null,
      hand_number: null,
      view: null,
      hint: waitingHint(data, seat, answering.now),
      ...tableFields(data, seat),
    };
  }
  if (table.places[seat] !== null) return outOfMatch(data, seat, answering);
  const view = seatView(table, seat);
  const common = {
    room_status: 'playing' as const,
    ...seatFields(data, seat),
    to_act_seat: table.toAct === null ? null : asSeat(table.toAct),
    hand_number: table.handNumber,
    view,
  };
  const others = data.seats.flatMap((_, i) => (i === seat ? [] : [i]));
  const table_ = tableFields(data, seat);
  const [first, ...rest] = tableLegalActions(table);
  if (turn && turn.seat === seat && first) {
    // T46, T48: until the seat's own first action is accepted, remind it to
    // give its owner the watch link, in the hint and as tell_owner (A22); the
    // server can't tell whether it already has. Turns the server played for
    // it don't count.
    const watchUrl = data.seats[seat].watch_url;
    const hasActed = Object.values(data.used_turns).some(
      used => used.seat === seat && !used.timeout,
    );
    const remind = watchUrl && !hasActed ? watchUrl : null;
    const giveLink = remind
      ? `. If you have not given your owner the watch link yet, give it now: ${remind}`
      : '';
    const against =
      others.length === 1
        ? `Playing against ${shownNames(data, others)}`
        : `Playing at a table of ${data.seats.length} with ${shownNames(data, others)}`;
    return {
      status: 'your_turn',
      ...common,
      turn_id: turn.id,
      deadline: new Date(turn.deadline).toISOString(),
      seconds_remaining: Math.max(
        0,
        Math.floor((turn.deadline - answering.now) / 1000),
      ),
      legal_actions: [first, ...rest],
      last_hand: answering.last,
      hands_since_your_turn: answering.since,
      hint: `Your turn. Before the deadline, pick one of legal_actions and send it with turn_id to POST /v1/rooms/${data.room_id}/actions?wait=1. Write your note in your owner's language and script (Traditional and Simplified Chinese are different scripts)${giveLink}`,
      ...(remind && { tell_owner: `${against}. Watch: ${remind}` }),
      ...table_,
    };
  }
  const acting =
    data.seats.length === 2 || table.toAct === null
      ? 'Your opponent is'
      : `${data.seats[table.toAct].display_name} is`;
  return {
    status: 'waiting',
    ...common,
    hint: `${acting} to act. Call ${waitPath(data)} again`,
    ...table_,
  };
}

// A25: a seat out or gone while the table plays on hears its place at once.
function outOfMatch(
  data: RoomData,
  seat: number,
  answering: Answering,
): MatchOverBody {
  const table = data.table as TableState;
  const place = table.places[seat] as number;
  const n = data.seats.length;
  const watchUrl = data.seats[seat].watch_url ?? '';
  const why = data.seats[seat].left
    ? 'You left the match'
    : 'You are out of chips';
  return {
    status: 'match_over',
    room_status: 'playing',
    ...seatFields(data, seat),
    to_act_seat: null,
    hand_number: table.handNumber,
    view: null,
    match_id: data.room_id,
    result: 'loss',
    place,
    final_stacks: [...table.stacks],
    ratings: null,
    last_hand: answering.last,
    hands_since_your_turn: answering.since,
    watch_url: watchUrl,
    tell_owner: `${why}: place ${place} of ${n}. The table plays on; ratings are counted when it ends.${watchUrl ? ` Watch: ${watchUrl}` : ''}`,
    hint: `${why} and finished in place ${place} of ${n}: there is nothing more to do in this room, so do not call wait again. Ratings are counted when the whole table ends; your owner can watch it play on at watch_url and see the result on the web. Report this to your owner in their language and script (Traditional and Simplified Chinese are different scripts)`,
    ...tableFields(data, seat),
  };
}

// A9: a seat that left before the start; `before` still has it, `after`
// does not.
function leftBeforeStart(
  before: RoomData,
  seat: number,
  after: RoomData,
): MatchOverBody {
  const player = before.seats[seat];
  return {
    status: 'match_over',
    room_status: 'waiting',
    opponent_name: null,
    opponent_display_name: null,
    display_name: player.display_name,
    settings: after.settings,
    to_act_seat: null,
    hand_number: null,
    view: null,
    match_id: before.room_id,
    result: 'cancelled',
    place: null,
    final_stacks: after.seats.map(() => after.settings.starting_stack),
    ratings: null,
    last_hand: null,
    hands_since_your_turn: [],
    watch_url: player.watch_url ?? '',
    tell_owner: `Left the table of ${before.seats[0].display_name} before it started; nothing was played.`,
    hint: `You left before the table started, so nothing counts. ${PLAY_AGAIN}`,
    ...tableFields(after, -1),
  };
}

function matchOver(
  data: RoomData,
  ended: Ended,
  seat: number,
  answering: Answering,
): MatchOverBody {
  const { table } = data;
  const view = table && seatView(table, seat);
  const place = ended.places?.[seat] ?? null;
  const firsts = ended.places?.filter(p => p === 1).length ?? 0;
  const result: MatchOverBody['result'] =
    ended.reason === 'cancelled' || ended.reason === 'void'
      ? ended.reason
      : place === 1
        ? firsts === 1
          ? 'win'
          : 'draw'
        : 'loss';
  const page = matchPage(data, answering);
  return {
    status: 'match_over',
    room_status: ended.reason === 'void' ? 'void' : 'finished',
    ...seatFields(data, seat),
    to_act_seat: null,
    hand_number: table?.handNumber ?? null,
    // Also after a leave or an abort mid-match: the blinds never rise again.
    view: view && { ...view, next_blinds_at_hand: null },
    match_id: data.room_id,
    result,
    final_stacks: ended.final_stacks,
    ratings: data.recorded?.ratings ?? null,
    last_hand: answering.last,
    hands_since_your_turn: answering.since,
    tell_owner: ownerResult(data, result, seat, place, page),
    hint: matchOverHint(data, ended, seat, result, page),
    place: result === 'cancelled' || result === 'void' ? null : place,
    // Rooms from before T46 kept no watch link.
    watch_url: data.seats[seat].watch_url ?? '',
    ...tableFields(data, seat),
  } as MatchOverBody;
}

// A21: a complete report that needs only translation, including every seat.
function ownerResult(
  data: RoomData,
  result: MatchOverBody['result'],
  seat: number,
  place: number | null,
  page: string | null,
): string {
  const stacks = data.ended?.final_stacks ?? calledOff(data);
  const order = [
    seat,
    ...data.seats.flatMap((_, i) => (i === seat ? [] : [i])),
  ];
  const chips = order
    .map(s => `${data.seats[s].display_name}: ${stacks[s]}`)
    .join(', ');
  const ratings = data.recorded?.ratings;
  const elo = ratings
    ? order
        .map(s => {
          const r = ratings[s];
          // Ratings go by name: show it after the display name (T51).
          const shown = data.seats[s].display_name;
          const who = shown === r.name ? r.name : `${shown} (${r.name})`;
          return `${who}: ${r.rating} (${r.change >= 0 ? '+' : ''}${r.change})`;
        })
        .join(', ')
    : 'unrated (no change)';
  const placed =
    data.seats.length > 2 &&
    place !== null &&
    result !== 'cancelled' &&
    result !== 'void'
      ? ` (place ${place} of ${data.seats.length})`
      : '';
  return `Result: ${result}${placed}. Final chips: ${chips}. Elo: ${elo}.${page ? ` Record: ${page}` : ''}`;
}

// The web page of a played match, once it is stored (T32). Rooms that never
// started are never stored (A9), so they have none.
const matchPage = (data: RoomData, { webUrl }: Answering) =>
  webUrl && data.table ? `${webUrl}/matches/${data.room_id}` : null;

function matchOverHint(
  data: RoomData,
  ended: Ended,
  seat: number,
  result: MatchOverBody['result'],
  page: string | null,
) {
  const see = page ? `. Your owner can see the whole match at ${page}` : '';
  if (result === 'cancelled') {
    return `The room closed before the match started. ${PLAY_AGAIN}`;
  }
  if (result === 'void') {
    return `The match was called off by the platform and does not count${see}. ${PLAY_AGAIN}`;
  }
  const how =
    ended.reason === 'left'
      ? data.seats[seat].left
        ? 'you lost because you left'
        : result === 'win'
          ? 'you won because your opponent left'
          : `you finished in place ${ended.places?.[seat]}`
      : ended.reason === 'bots_only'
        ? `it ended with only house-bot left at the table and you finished in place ${ended.places?.[seat]}`
        : { win: 'you won', loss: 'you lost', draw: 'it is a draw' }[result];
  return `The match is over and ${how}. Report the result to your owner in their language and script (Traditional and Simplified Chinese are different scripts), and see the rankings with GET /v1/leaderboard${see}`;
}
