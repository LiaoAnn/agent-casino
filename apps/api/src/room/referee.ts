// The referee of one room (casino-api skill: 房間狀態, wait, state, actions,
// A3, A8, A9, A15). Kept free of `cloudflare:workers` so it runs in Node
// tests; the Room DO hands it its storage and forwards its RPC calls here.
import { isDeepStrictEqual } from 'node:util';
import { type ApiError, apiError } from '../contract/errors';
import type {
  ActionAccepted,
  MatchOver,
  RoomStatus,
  TestSettings,
} from '../contract/schemas';
import { RESERVED_NAMES } from '../contract/schemas';
import type { MatchRecordInput, RecordedMatch } from '../db/records';
import { randomAction } from '../holdem/bot';
import {
  type Action,
  applyAction,
  type HandRecord,
  legalActions,
  type MatchState,
  otherSeat,
  type Seat,
  startMatch,
} from '../holdem/match';
import { replay } from '../holdem/replay';
import { viewFor } from '../holdem/view';

// What the referee needs from DurableObjectStorage.
export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  // The DO's one alarm, which calls RoomReferee.alarm().
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface RefereeOptions {
  // How long `wait` holds a request before answering `waiting`.
  waitMs?: number;
  now?: () => number;
  // Stores a finished match and its Elo (the Room DO passes the Matchmaker's
  // recordMatch, A10). Without it a match counts as stored and unrated.
  record?: (input: MatchRecordInput) => Promise<RecordedMatch>;
  // Where house-bot draws its random but legal actions from (A1).
  random?: () => number;
}

interface RoomSettings {
  hands: number;
  turn_seconds: number;
  starting_stack: number;
}

export interface CreateInput {
  room_id: string;
  invite_code: string;
  name: string;
  settings: RoomSettings;
  seed: string;
  // Only where ALLOW_TEST_ROOMS=true; `chaos` is for T11.
  test: typeof TestSettings.Type | null;
  // A1: house-bot takes seat 1 and the match starts at once.
  opponent?: 'bot';
}

type Result<T, C extends ApiError['code']> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError<C> };

interface Turn {
  id: string;
  seat: Seat;
  // Epoch ms.
  deadline: number;
}

// The room as one JSON value under KEY. Finished hands (the match record of
// casino-api A15) are kept apart, one per key `hand:<hand_number>`, so this
// value stays well under the DO's 128 KiB per value on 200-hand matches.
interface RoomData {
  room_id: string;
  invite_code: string;
  settings: RoomSettings;
  seed: string;
  test: typeof TestSettings.Type | null;
  names: [string, string | null];
  // `null` until the second player joins.
  match: MatchState | null;
  turn: Turn | null;
  // How many turns have been handed out; the next turn is `t_<count + 1>`.
  turn_count: number;
  // Turns already used up, by turn_id (A3): who acted, and whether the
  // server acted for them.
  used_turns: Record<string, { seat: Seat; timeout?: true }>;
  ended: Ended | null;
  // Epoch ms.
  created_at: number;
  // Timeouts in a row per seat; a seat's own action resets its count.
  timeouts: [number, number];
  // A9: three timeouts in a row; the server plays every later turn of the
  // seat at once, for the rest of the match.
  absent: [boolean, boolean];
  // What test.chaos (A11) has done so far.
  chaos_done: ChaosDone;
  // Set once a played match is stored (A10); match_over shows its ratings.
  recorded: { ratings: RecordedMatch['ratings'] } | null;
}

interface ChaosDone {
  // reject_first_action: the seats whose first action was refused.
  rejected: [boolean, boolean];
  // extra_waiting: `waiting` answered instead of the turn `turn_id`.
  fake_waits: { turn_id: string; count: number } | null;
  // fail_request_every: each seat's requests to the room so far.
  requests: [number, number];
}

// `complete`: all hands played or someone ran out of chips. `left`: `loser`
// left while playing. `cancelled`: seat 0 left, or nobody joined in time.
// `void`: aborted by an admin, or the platform failed; never rated.
type Ended = (
  | { reason: 'complete' | 'cancelled' | 'void' }
  | { reason: 'left'; loser: Seat }
) & {
  final_stacks: [number, number];
  // Epoch ms.
  at: number;
};

interface ActionInput {
  turn_id: string;
  type: Action['type'];
  amount?: number;
}

type ActionAcceptedBody = typeof ActionAccepted.Type;
type MatchOverBody = typeof MatchOver.Type;

// What routes/room.ts calls on a room's DO stub (the Room DO forwards each
// call to its referee).
export type RoomApi = Pick<
  RoomReferee,
  'create' | 'join' | 'status' | 'act' | 'leave' | 'abort'
>;

const KEY = 'room';
// A1: the built-in bot, always in seat 1 of the rooms opened with it.
const HOUSE_BOT = RESERVED_NAMES[0];
const WAIT_MS = 30_000;
// 狀況處理: three timeouts in a row and the seat is absent.
const ABSENT_AFTER_TIMEOUTS = 3;
// 狀況處理: a room nobody joins in 5 minutes is dissolved.
const DISSOLVE_AFTER_MS = 5 * 60 * 1000;
// How soon a failed write of a finished match is tried again.
const RECORD_RETRY_MS = 10_000;
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

const accepted = (data: RoomData): ActionAcceptedBody => ({
  status: 'accepted',
  hint: `Accepted. Call ${waitPath(data)} for your next turn`,
});

export class RoomReferee {
  readonly #storage: RoomStorage;
  readonly #waitMs: number;
  readonly #now: () => number;
  readonly #recordMatch: (input: MatchRecordInput) => Promise<RecordedMatch>;
  readonly #random: () => number;
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
  }

  // Fails only when the room id is already taken.
  async create(input: CreateInput): Promise<Result<null, 'internal'>> {
    if (await this.#load()) {
      return fail(
        apiError(
          'internal',
          `Room ${input.room_id} already exists`,
          'Open the room again with POST /v1/rooms',
        ),
      );
    }
    const { opponent, ...room } = input;
    const data: RoomData = {
      ...room,
      names: [input.name, null],
      match: null,
      turn: null,
      turn_count: 0,
      used_turns: {},
      ended: null,
      created_at: this.#now(),
      timeouts: [0, 0],
      absent: [false, false],
      chaos_done: {
        rejected: [false, false],
        fake_waits: null,
        requests: [0, 0],
      },
      recorded: null,
    };
    await this.#save(
      opponent === 'bot' ? this.#start(data, HOUSE_BOT, this.#now()) : data,
    );
    return ok(null);
  }

  async join(input: {
    name: string;
    invite_code: string;
  }): Promise<
    Result<
      { seat: 1 },
      | 'room_not_found'
      | 'wrong_invite_code'
      | 'room_full'
      | 'match_over'
      | 'name_invalid'
    >
  > {
    const loaded = await this.#load();
    if (!loaded) return fail(roomNotFound());
    if (input.invite_code.toUpperCase() !== loaded.invite_code) {
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
    if (data.names[1] !== null) {
      return fail(
        apiError(
          'room_full',
          `Room ${data.room_id} already has two players`,
          'Open your own room with POST /v1/rooms, or join the queue with POST /v1/queue',
        ),
      );
    }
    if (input.name.toLowerCase() === data.names[0].toLowerCase()) {
      return fail(
        apiError(
          'name_invalid',
          `The name ${input.name} is already taken by the other player in room ${data.room_id}; pick a different name`,
          `Pick a different name and resend POST /v1/rooms/${data.room_id}/join`,
        ),
      );
    }
    await this.#save(this.#start(data, input.name, this.#now()));
    return ok({ seat: 1 });
  }

  // Seats `name` in seat 1 and deals hand 1; `at` (epoch ms) is when.
  #start(data: RoomData, name: string, at: number): RoomData {
    const match = startMatch({
      seed: data.seed,
      hands: data.settings.hands,
      startingStack: data.settings.starting_stack,
    });
    return this.#nextTurn({ ...data, names: [data.names[0], name], match }, at);
  }

  // `wait: true` holds the request until it is the seat's turn, the match is
  // over, or the wait window ends.
  async status(
    seat: Seat,
    options: { wait: boolean },
  ): Promise<
    Result<RoomStatus, 'room_not_found' | 'invalid_token' | 'unavailable'>
  > {
    const dropped = await this.#dropRequest(seat);
    if (dropped) return fail(dropped);
    let timedOut = !options.wait;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const windowEnd = new Promise<void>(resolve => {
      if (timedOut) return resolve();
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.#waitMs);
    });
    try {
      for (;;) {
        const opened = await this.#open();
        if (!opened.ok) return opened;
        const status = statusFor(opened.value, seat);
        if (options.wait && status.status === 'your_turn') {
          const fake = await this.#fakeWaiting(opened.value, status);
          if (fake) return ok(fake);
        }
        if (status.status !== 'waiting' || timedOut) return ok(status);
        const change = this.#nextChange();
        await Promise.race([change.promise, windowEnd]);
        change.cancel();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // A3: a used turn_id answers its first result again; a rejected action
  // leaves the turn_id usable.
  async act(
    seat: Seat,
    input: ActionInput,
  ): Promise<
    Result<
      ActionAcceptedBody,
      | 'room_not_found'
      | 'not_your_turn'
      | 'stale_turn'
      | 'invalid_action'
      | 'match_over'
      | 'invalid_token'
      | 'unavailable'
    >
  > {
    const dropped = await this.#dropRequest(seat);
    if (dropped) return fail(dropped);
    const opened = await this.#open();
    if (!opened.ok) return opened;
    const data = opened.value;
    const used = data.used_turns[input.turn_id];
    if (used?.seat === seat && !used.timeout) {
      return ok({ ...accepted(data), duplicate: true });
    }
    const state = statusFor(data, seat);
    if (data.ended) return fail(matchOverError(state));
    const { match, turn } = data;
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
    if (!match || turn?.seat !== seat) {
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
      !data.chaos_done.rejected[seat]
    ) {
      const rejected: [boolean, boolean] = [...data.chaos_done.rejected];
      rejected[seat] = true;
      await this.#save({
        ...data,
        chaos_done: { ...data.chaos_done, rejected },
      });
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
    const done = this.#perform(data, match, turn, action, this.#now());
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
    await this.#save(done.data, done.finishedHands);
    return ok(accepted(data));
  }

  // A9: leaving while playing loses at once; leaving an unjoined room
  // closes it without a match.
  async leave(
    seat: Seat,
  ): Promise<
    Result<
      MatchOverBody,
      'room_not_found' | 'match_over' | 'invalid_token' | 'unavailable'
    >
  > {
    const dropped = await this.#dropRequest(seat);
    if (dropped) return fail(dropped);
    const opened = await this.#open();
    if (!opened.ok) return opened;
    const data = opened.value;
    if (data.ended) return fail(matchOverError(statusFor(data, seat)));
    const next = this.#finish(
      data,
      this.#now(),
      data.match
        ? { reason: 'left', loser: seat, final_stacks: calledOff(data) }
        : { reason: 'cancelled', final_stacks: calledOff(data) },
    );
    await this.#save(next);
    const saved = await this.#load();
    if (!saved?.ended || unrecorded(saved)) return fail(recordFailed());
    return ok(matchOver(saved, saved.ended, seat));
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
      }),
    );
    return ok(null);
  }

  // A11 fail_request_every: counts the seat's requests and refuses every
  // Nth one before anything else. This 503 is made on purpose, unlike the one
  // client.ts answers when the DO can't be reached.
  async #dropRequest(seat: Seat): Promise<ApiError<'unavailable'> | undefined> {
    const data = await this.#load();
    const every = data?.test?.chaos?.fail_request_every;
    if (!data || every === undefined) return undefined;
    const requests: [number, number] = [...data.chaos_done.requests];
    requests[seat] += 1;
    await this.#save({ ...data, chaos_done: { ...data.chaos_done, requests } });
    if (requests[seat] % every !== 0) return undefined;
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
    const done = data.chaos_done.fake_waits;
    const count = done?.turn_id === turn.turn_id ? done.count : 0;
    if (count >= extra) return undefined;
    await this.#save({
      ...data,
      chaos_done: {
        ...data.chaos_done,
        fake_waits: { turn_id: turn.turn_id, count: count + 1 },
      },
    });
    return {
      status: 'waiting',
      room_status: turn.room_status,
      to_act_seat: turn.to_act_seat,
      hand_number: turn.hand_number,
      view: turn.view,
      hint: `Not your turn yet. Call ${waitPath(data)} again`,
    };
  }

  // Loads the room, refusing a missing one or one that ended over an hour
  // ago (A8).
  async #open(): Promise<
    Result<RoomData, 'room_not_found' | 'invalid_token' | 'unavailable'>
  > {
    const loaded = await this.#load();
    if (!loaded) return fail(roomNotFound());
    let data = await this.#settle(loaded);
    // A10: no match_over before the match is stored.
    if (unrecorded(data)) {
      if (!(await this.#record())) return fail(recordFailed());
      data = (await this.#load()) ?? data;
    }
    if (data.ended && this.#now() - data.ended.at > EXPIRES_AFTER_END_MS) {
      return fail(
        apiError(
          'invalid_token',
          `Room ${data.room_id} ended over an hour ago, so its tokens no longer work`,
          PLAY_AGAIN,
        ),
      );
    }
    return ok(data);
  }

  // The one way an action is applied: by a player now, by the server on a
  // timeout. `at` (epoch ms) is when it happened, which starts the next turn.
  #perform(
    data: RoomData,
    match: MatchState,
    turn: Turn,
    action: Action,
    at: number,
    options: { timeout?: true } = {},
  ):
    | { ok: true; data: RoomData; finishedHands: HandRecord[] }
    | { ok: false; message: string } {
    const result = applyAction(match, turn.seat, action, options);
    if (!result.ok) return result;
    const { finishedHands } = result;
    const timeouts: [number, number] = [...data.timeouts];
    timeouts[turn.seat] = options.timeout ? timeouts[turn.seat] + 1 : 0;
    const absent: [boolean, boolean] = [...data.absent];
    absent[turn.seat] ||= timeouts[turn.seat] >= ABSENT_AFTER_TIMEOUTS;
    const next: RoomData = {
      ...data,
      match: result.state,
      used_turns: {
        ...data.used_turns,
        [turn.id]: { seat: turn.seat, ...options },
      },
      timeouts,
      absent,
    };
    if (result.state.over) {
      return {
        ok: true,
        data: this.#finish(next, at, {
          reason: 'complete',
          final_stacks: result.state.stacks,
        }),
        finishedHands,
      };
    }
    return { ok: true, data: this.#nextTurn(next, at), finishedHands };
  }

  // Plays everything due by now, each at the time it fell due, so a late
  // alarm or a request ends up where an alarm on time would have: a turn past
  // its deadline, and an absent seat's turn the moment it starts, get the
  // timeout action (holdem-rules 超時動作: check if it can, else fold);
  // house-bot plays its turn the moment it starts (A1).
  #due(data: RoomData) {
    let next = data;
    const finishedHands: HandRecord[] = [];
    for (;;) {
      const { match, turn } = next;
      if (next.ended) break;
      if (!match) {
        const at = next.created_at + DISSOLVE_AFTER_MS;
        if (this.#now() < at) break;
        next = this.#finish(next, at, {
          reason: 'cancelled',
          final_stacks: calledOff(next),
        });
        break;
      }
      if (!turn) break;
      const bot = turn.seat === 1 && next.names[1] === HOUSE_BOT;
      const atOnce = bot || next.absent[turn.seat];
      const at = atOnce
        ? turn.deadline - next.settings.turn_seconds * 1000
        : turn.deadline;
      if (!atOnce && this.#now() < turn.deadline) break;
      const legal = legalActions(match);
      const canCheck = legal.some(a => a.type === 'check');
      const done = bot
        ? this.#perform(
            next,
            match,
            turn,
            randomAction(legal, this.#random),
            at,
          )
        : this.#perform(
            next,
            match,
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
    const { match, ended } = loaded;
    const hands: HandRecord[] = [];
    for (let n = 1; n <= match.handNumber; n++) {
      const hand = await this.#storage.get<HandRecord>(`hand:${n}`);
      if (hand) hands.push(hand);
    }
    const final: Ended = replays(match, hands)
      ? ended
      : { reason: 'void', final_stacks: ended.final_stacks, at: ended.at };
    if (final !== ended) {
      console.error(
        `Room ${loaded.room_id}: replay differs; the match is void`,
      );
    }
    let recorded: RecordedMatch;
    try {
      recorded = await this.#recordMatch({
        match_id: loaded.room_id,
        players: [loaded.names[0], loaded.names[1] ?? ''],
        settings: loaded.settings,
        seed: loaded.seed,
        result: seatResult(final),
        ended_at: new Date(final.at).toISOString(),
        final_stacks: final.final_stacks,
        hands,
      });
    } catch (error) {
      console.error(`Room ${loaded.room_id}: storing the match failed`, error);
      await this.#storage.setAlarm(this.#now() + RECORD_RETRY_MS);
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
    ended: DistributiveOmit<Ended, 'at'>,
  ): RoomData & { ended: Ended } {
    return { ...data, turn: null, ended: { ...ended, at } };
  }

  #load(): Promise<RoomData | undefined> {
    this.#data ??= this.#storage.get<RoomData>(KEY);
    return this.#data;
  }

  // Every change goes through here, so a match that just ended is stored
  // here, before the caller answers (A10).
  async #save(
    unsettled: RoomData,
    unsettledHands: HandRecord[] = [],
  ): Promise<void> {
    // An absent seat may be next to act: it is played before anyone looks.
    const due = this.#due(unsettled);
    const data = due.data;
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
    // A failure is retried by the next request or the alarm.
    if (unrecorded(data)) await this.#record();
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
    const seat = data.match?.toAct ?? null;
    if (seat === null) return { ...data, turn: null };
    const count = data.turn_count + 1;
    return {
      ...data,
      turn_count: count,
      turn: {
        id: `t_${count}`,
        seat,
        deadline: at + data.settings.turn_seconds * 1000,
      },
    };
  }
}

// A played match that ended but is not stored yet. Rooms nobody joined are
// never stored (A9).
const unrecorded = (
  data: RoomData,
): data is RoomData & { match: MatchState; ended: Ended } =>
  data.ended !== null && data.match !== null && !data.recorded;

// When the room next has something due (epoch ms), or null for nothing.
const alarmAt = (data: RoomData, now: number): number | null =>
  data.ended
    ? unrecorded(data)
      ? now + RECORD_RETRY_MS
      : null
    : data.match
      ? (data.turn?.deadline ?? null)
      : data.created_at + DISSOLVE_AFTER_MS;

// The stacks with the unfinished hand called off: chips in its pot go back.
const calledOff = ({ match, settings }: RoomData): [number, number] =>
  match
    ? [
        match.stacks[0] + match.contributed[0],
        match.stacks[1] + match.contributed[1],
      ]
    : [settings.starting_stack, settings.starting_stack];

// 收到什麼就做什麼: too late or not your turn → do not resend, wait.
const doNotResend = (data: RoomData) =>
  `Do not resend. Call ${waitPath(data)} and act when it answers your_turn`;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

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

// The finished hands and the hand in progress, played again from the seed,
// must end up exactly where the match did (資料與積分: 賽後重播).
function replays(match: MatchState, hands: HandRecord[]): boolean {
  const events = [
    ...hands.flatMap(hand => hand.events),
    ...(match.over ? [] : match.history),
  ];
  try {
    const result = replay(match.config, events);
    // Through JSON, as storage keeps it: absent and undefined are the same.
    const plain = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value));
    return (
      result.ok &&
      isDeepStrictEqual(plain(result.state), plain(match)) &&
      isDeepStrictEqual(plain(result.hands), plain(hands))
    );
  } catch {
    return false;
  }
}

// The result from the seats' point of view (matches, A15).
function seatResult(ended: Ended): MatchRecordInput['result'] {
  if (ended.reason === 'void' || ended.reason === 'cancelled') {
    return ended.reason;
  }
  if (ended.reason === 'left') {
    return ended.loser === 0 ? 'seat1_win' : 'seat0_win';
  }
  const [a, b] = ended.final_stacks;
  return a > b ? 'seat0_win' : a < b ? 'seat1_win' : 'draw';
}

const roomNotFound = () =>
  apiError(
    'room_not_found',
    'There is no such room',
    'Check the room_id, or open a room with POST /v1/rooms',
  );

// What `state` and `wait` answer to `seat` (A15).
function statusFor(data: RoomData, seat: Seat): RoomStatus {
  const { match, turn } = data;
  if (data.ended) return matchOver(data, data.ended, seat);
  if (!match) {
    return {
      status: 'waiting',
      room_status: 'waiting',
      to_act_seat: null,
      hand_number: null,
      view: null,
      hint: `Waiting for your opponent to join with the invite code. Call ${waitPath(data)} again`,
    };
  }
  const seen = viewFor(match, seat);
  const common = {
    room_status: 'playing' as const,
    to_act_seat: seen.to_act_seat,
    hand_number: seen.hand_number,
    view: seen.view,
  };
  const [first, ...rest] = legalActions(match);
  if (turn && turn.seat === seat && first) {
    return {
      status: 'your_turn',
      ...common,
      turn_id: turn.id,
      deadline: new Date(turn.deadline).toISOString(),
      legal_actions: [first, ...rest],
      last_hand: seen.last_hand,
      hint: `Your turn. Before the deadline, pick one of legal_actions and send it with turn_id to POST /v1/rooms/${data.room_id}/actions`,
    };
  }
  return {
    status: 'waiting',
    ...common,
    hint: `Your opponent is to act. Call ${waitPath(data)} again`,
  };
}

function matchOver(data: RoomData, ended: Ended, seat: Seat): MatchOverBody {
  const { match } = data;
  const seen = match ? viewFor(match, seat) : null;
  const [mine, theirs] = [
    ended.final_stacks[seat],
    ended.final_stacks[otherSeat(seat)],
  ];
  const result: MatchOverBody['result'] =
    ended.reason === 'cancelled' || ended.reason === 'void'
      ? ended.reason
      : ended.reason === 'left'
        ? ended.loser === seat
          ? 'loss'
          : 'win'
        : mine > theirs
          ? 'win'
          : mine < theirs
            ? 'loss'
            : 'draw';
  return {
    status: 'match_over',
    room_status: ended.reason === 'void' ? 'void' : 'finished',
    to_act_seat: null,
    hand_number: seen?.hand_number ?? null,
    view: seen?.view ?? null,
    match_id: data.room_id,
    result,
    final_stacks: ended.final_stacks,
    ratings: data.recorded?.ratings ?? null,
    last_hand: seen?.last_hand ?? null,
    hint: matchOverHint(ended, result),
  };
}

function matchOverHint(ended: Ended, result: MatchOverBody['result']) {
  if (result === 'cancelled') {
    return `The room closed before the match started. ${PLAY_AGAIN}`;
  }
  if (result === 'void') {
    return `The match was called off by the platform and does not count. ${PLAY_AGAIN}`;
  }
  const how =
    ended.reason !== 'left'
      ? { win: 'you won', loss: 'you lost', draw: 'it is a draw' }[result]
      : result === 'loss'
        ? 'you lost because you left'
        : 'you won because your opponent left';
  return `The match is over and ${how}. Report the result to your owner, and see the rankings with GET /v1/leaderboard`;
}
