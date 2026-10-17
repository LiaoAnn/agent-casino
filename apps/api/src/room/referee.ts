// The referee of one room (casino-api skill: 房間狀態, wait, state, actions,
// A3, A8, A9, A15). Kept free of `cloudflare:workers` so it runs in Node
// tests; the Room DO hands it its storage and forwards its RPC calls here.
import { type ApiError, apiError } from '../contract/errors';
import type { ActionAccepted, RoomStatus } from '../contract/schemas';
import {
  type Action,
  applyAction,
  type HandRecord,
  legalActions,
  type MatchState,
  type Seat,
  startMatch,
} from '../holdem/match';
import { viewFor } from '../holdem/view';

// What the referee needs from DurableObjectStorage.
export interface RoomStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface RefereeOptions {
  // How long `wait` holds a request before answering `waiting`.
  waitMs?: number;
  now?: () => number;
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
  seed: number;
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

// Everything the room keeps, as one JSON value in storage.
interface RoomData {
  room_id: string;
  invite_code: string;
  settings: RoomSettings;
  seed: number;
  names: [string, string | null];
  // `null` until the second player joins.
  match: MatchState | null;
  // Every finished hand, in order (the match record of casino-api A15).
  hands: HandRecord[];
  turn: Turn | null;
  // How many turns have been handed out; the next turn is `t_<count + 1>`.
  turn_count: number;
  // Turns already used up, by turn_id (A3): who acted, and whether the
  // server acted for them.
  used_turns: Record<string, { seat: Seat; timeout?: true }>;
  ended: Ended | null;
}

interface Ended {
  // `complete`: all hands played or someone ran out of chips.
  reason: 'complete';
  final_stacks: [number, number];
  // Epoch ms.
  at: number;
}

interface ActionInput {
  turn_id: string;
  type: Action['type'];
  amount?: number;
}

type ActionAcceptedBody = typeof ActionAccepted.Type;

// What routes/room.ts calls on a room's DO stub (the Room DO forwards each
// call to its referee).
export type RoomApi = Pick<RoomReferee, 'create' | 'join' | 'status' | 'act'>;

const KEY = 'room';
const WAIT_MS = 30_000;

const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = <C extends ApiError['code']>(error: ApiError<C>) => ({
  ok: false as const,
  error,
});

const waitPath = (data: RoomData) => `GET /v1/rooms/${data.room_id}/wait`;
const actionsPath = (data: RoomData) =>
  `POST /v1/rooms/${data.room_id}/actions`;

const accepted = (data: RoomData): ActionAcceptedBody => ({
  status: 'accepted',
  hint: `Accepted. Call ${waitPath(data)} for your next turn`,
});

export class RoomReferee {
  readonly #storage: RoomStorage;
  readonly #waitMs: number;
  readonly #now: () => number;
  #data: Promise<RoomData | undefined> | undefined;
  // Resolved, then cleared, whenever the room changes; `wait` listens here.
  readonly #listeners = new Set<() => void>();

  constructor(storage: RoomStorage, options: RefereeOptions = {}) {
    this.#storage = storage;
    this.#waitMs = options.waitMs ?? WAIT_MS;
    this.#now = options.now ?? Date.now;
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
    await this.#save({
      ...input,
      names: [input.name, null],
      match: null,
      hands: [],
      turn: null,
      turn_count: 0,
      used_turns: {},
      ended: null,
    });
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
    const data = await this.#load();
    if (!data) return fail(roomNotFound());
    if (input.invite_code.toUpperCase() !== data.invite_code) {
      return fail(
        apiError(
          'wrong_invite_code',
          `The invite code ${JSON.stringify(input.invite_code)} is not the code of room ${data.room_id}`,
          'Ask your opponent for the invite_code of this room and resend the join with it',
        ),
      );
    }
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
    const match = startMatch({
      seed: data.seed,
      hands: data.settings.hands,
      startingStack: data.settings.starting_stack,
    });
    await this.#save(
      this.#nextTurn({ ...data, names: [data.names[0], input.name], match }),
    );
    return ok({ seat: 1 });
  }

  // `wait: true` holds the request until it is the seat's turn, the match is
  // over, or the wait window ends.
  async status(
    seat: Seat,
    options: { wait: boolean },
  ): Promise<Result<RoomStatus, 'room_not_found'>> {
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
        const data = await this.#load();
        if (!data) return fail(roomNotFound());
        const status = statusFor(data, seat);
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
    >
  > {
    const data = await this.#load();
    if (!data) return fail(roomNotFound());
    const used = data.used_turns[input.turn_id];
    if (used?.seat === seat && !used.timeout) {
      return ok({ ...accepted(data), duplicate: true });
    }
    const state = statusFor(data, seat);
    if (data.ended) {
      return fail(
        apiError(
          'match_over',
          'The match is over; no more actions are accepted',
          `Read the result in state. To play again, open a room with POST /v1/rooms or join the queue with POST /v1/queue`,
          { state },
        ),
      );
    }
    const { match, turn } = data;
    if (!match || turn?.seat !== seat) {
      return fail(
        apiError(
          'not_your_turn',
          'It is not your turn',
          `Do not resend. Call ${waitPath(data)} and act when it answers your_turn`,
          { state },
        ),
      );
    }
    if (input.turn_id !== turn.id) {
      return fail(
        apiError(
          'stale_turn',
          `turn_id ${JSON.stringify(input.turn_id)} is not your current turn; the current turn_id is ${turn.id}`,
          `Pick an action from legal_actions in state and send it with turn_id ${turn.id} to ${actionsPath(data)}`,
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
    const done = this.#perform(data, match, turn, action);
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
    await this.#save(done.data);
    return ok(accepted(data));
  }

  // The one way an action is applied: by a player now, by the server on a
  // timeout later (T11).
  #perform(
    data: RoomData,
    match: MatchState,
    turn: Turn,
    action: Action,
    options: { timeout?: true } = {},
  ): { ok: true; data: RoomData } | { ok: false; message: string } {
    const result = applyAction(match, turn.seat, action, options);
    if (!result.ok) return result;
    const next: RoomData = {
      ...data,
      match: result.state,
      hands: [...data.hands, ...result.finishedHands],
      used_turns: {
        ...data.used_turns,
        [turn.id]: { seat: turn.seat, ...options },
      },
    };
    if (result.state.over) {
      return {
        ok: true,
        data: this.#finish(next, {
          reason: 'complete',
          final_stacks: result.state.stacks,
        }),
      };
    }
    return { ok: true, data: this.#nextTurn(next) };
  }

  // Where every match ends. Recording the match (T13) hooks in here.
  #finish(data: RoomData, ended: Omit<Ended, 'at'>): RoomData {
    return { ...data, turn: null, ended: { ...ended, at: this.#now() } };
  }

  #load(): Promise<RoomData | undefined> {
    this.#data ??= this.#storage.get<RoomData>(KEY);
    return this.#data;
  }

  async #save(data: RoomData): Promise<void> {
    this.#data = Promise.resolve(data);
    const listeners = [...this.#listeners];
    this.#listeners.clear();
    for (const listener of listeners) listener();
    await this.#storage.put(KEY, data);
  }

  #nextChange() {
    let listener = () => {};
    const promise = new Promise<void>(resolve => {
      listener = resolve;
      this.#listeners.add(listener);
    });
    return { promise, cancel: () => this.#listeners.delete(listener) };
  }

  // Hands the next turn to whoever is to act, with a fresh turn_id.
  #nextTurn(data: RoomData): RoomData {
    const seat = data.match?.toAct ?? null;
    if (seat === null) return { ...data, turn: null };
    const count = data.turn_count + 1;
    return {
      ...data,
      turn_count: count,
      turn: {
        id: `t_${count}`,
        seat,
        deadline: this.#now() + data.settings.turn_seconds * 1000,
      },
    };
  }
}

const roomNotFound = () =>
  apiError(
    'room_not_found',
    'There is no such room',
    'Check the room_id, or open a room with POST /v1/rooms',
  );

// What `state` and `wait` answer to `seat` (A15).
function statusFor(data: RoomData, seat: Seat): RoomStatus {
  const { match, turn, ended } = data;
  if (ended) return matchOver(data, ended, seat);
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

function matchOver(data: RoomData, ended: Ended, seat: Seat): RoomStatus {
  const { match } = data;
  const seen = match ? viewFor(match, seat) : null;
  const [mine, theirs] = [
    ended.final_stacks[seat],
    ended.final_stacks[seat === 0 ? 1 : 0],
  ];
  const result = mine > theirs ? 'win' : mine < theirs ? 'loss' : 'draw';
  const told = { win: 'you won', loss: 'you lost', draw: 'it is a draw' };
  return {
    status: 'match_over',
    room_status: 'finished',
    to_act_seat: null,
    hand_number: seen?.hand_number ?? null,
    view: seen?.view ?? null,
    match_id: data.room_id,
    result,
    final_stacks: ended.final_stacks,
    ratings: null,
    last_hand: seen?.last_hand ?? null,
    hint: `The match is over and ${told[result]}. Report the result to your owner, and see the rankings with GET /v1/leaderboard`,
  };
}
