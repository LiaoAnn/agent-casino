// The lobby (casino-api A2, A25): the rooms not started yet, for
// GET /v1/lobby and POST /v1/rooms/quick. Kept free of `cloudflare:workers`
// so it runs in Node tests; the Matchmaker DO holds one RoomLobby.
import { Effect } from 'effect';
import type { ApiError } from '../contract/errors';
import type { Lobby, TestSettings } from '../contract/schemas';
import * as Rooms from '../room/client';
import type { Bindings } from '../routes/env';

type LobbyRoom = Lobby['rooms'][number];

// One room as its Room DO lists it: the lobby row, and the test settings it
// was opened with, which the lobby keeps to itself.
export type LobbyEntry = LobbyRoom & {
  test: typeof TestSettings.Type | null;
};

// What a Room DO sends whenever its row changes. `rev` goes up by one with
// every change of the room; `entry` is `null` once the room has started or
// ended, which takes it out of the lobby for good.
export interface LobbyUpdate {
  room_id: string;
  rev: number;
  entry: LobbyEntry | null;
}

// What the lobby needs from DurableObjectStorage.
export interface LobbyStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

type Result<T, C extends ApiError['code']> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError<C> };

// The codes a join of a listed room can fail with.
export type JoinCode =
  | 'room_not_found'
  | 'wrong_invite_code'
  | 'room_full'
  | 'match_over'
  | 'name_invalid'
  | 'unavailable';

// How the lobby seats someone: join a listed room, or open a public one
// with the caller as host.
export interface Seating<T> {
  join: (room_id: string) => Promise<Result<T, JoinCode>>;
  open: () => Promise<Result<T, 'unavailable'>>;
}

export interface QuickInput {
  // Checked (name rules, house-bot, bans) by the handler.
  name: string;
  // What a public room of this deployment is opened with (blind_every
  // `null` when it goes by player count): only rooms with exactly these are
  // auto-seated.
  settings: LobbyRoom['settings'];
  test: typeof TestSettings.Type | null;
}

// Rooms taken out are remembered this long, so a late update of theirs
// can't list them again (updates of one room arrive within moments).
const FORGET_MS = 60 * 60 * 1000;
const KEY = 'lobby';

// Per room: its latest rev, and its row, or when it was taken out.
type Listing = Record<
  string,
  { rev: number; entry: LobbyEntry } | { rev: number; removed_at: number }
>;

// JSON with keys sorted, to compare settings regardless of key order.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );

// A join that fails like this means the room can't seat anyone any more.
const CLOSED: readonly JoinCode[] = [
  'room_full',
  'match_over',
  'room_not_found',
  'wrong_invite_code',
];

export class RoomLobby {
  readonly #storage: LobbyStorage;
  readonly #now: () => number;
  // The quick seat in flight: they run one at a time.
  #last: Promise<unknown> = Promise.resolve();

  constructor(storage: LobbyStorage, options: { now?: () => number } = {}) {
    this.#storage = storage;
    this.#now = options.now ?? Date.now;
  }

  async #rooms(): Promise<Listing> {
    return (await this.#storage.get<Listing>(KEY)) ?? {};
  }

  // Takes a Room DO's update unless one with the same or a later rev of
  // that room came first.
  async update({ room_id, rev, entry }: LobbyUpdate): Promise<void> {
    const rooms = await this.#rooms();
    if ((rooms[room_id]?.rev ?? 0) >= rev) return;
    const at = this.#now();
    rooms[room_id] = entry ? { rev, entry } : { rev, removed_at: at };
    for (const [id, room] of Object.entries(rooms)) {
      if ('removed_at' in room && at - room.removed_at > FORGET_MS) {
        delete rooms[id];
      }
    }
    await this.#storage.put(KEY, rooms);
  }

  // The listed rooms, oldest first.
  async #listed(): Promise<LobbyEntry[]> {
    return Object.values(await this.#rooms())
      .flatMap(room => ('entry' in room ? [room.entry] : []))
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) ||
          a.room_id.localeCompare(b.room_id),
      );
  }

  // GET /v1/lobby: the listed rooms, oldest first, without `test`.
  async list(): Promise<Lobby> {
    const listed = await this.#listed();
    return { rooms: listed.map(({ test: _test, ...room }) => room) };
  }

  // A join found the room closed: it leaves the lobby until it tells
  // otherwise with a later rev.
  async #drop(room_id: string): Promise<void> {
    const rooms = await this.#rooms();
    const room = rooms[room_id];
    if (!room || !('entry' in room)) return;
    rooms[room_id] = { rev: room.rev, removed_at: this.#now() };
    await this.#storage.put(KEY, rooms);
  }

  // POST /v1/rooms/quick, one at a time, so people arriving together fill
  // one room rather than racing for a seat or each opening a room.
  quick<T>(
    input: QuickInput,
    seating: Seating<T>,
  ): Promise<Result<T, JoinCode>> {
    const run = this.#last.then(() => this.#quick(input, seating));
    this.#last = run.catch(() => {});
    return run;
  }

  async #quick<T>(
    input: QuickInput,
    seating: Seating<T>,
  ): Promise<Result<T, JoinCode>> {
    const wanted = canonical({ settings: input.settings, test: input.test });
    const candidates = (await this.#listed()).filter(
      room =>
        room.visibility === 'public' &&
        room.seats_open > 0 &&
        canonical({ settings: room.settings, test: room.test }) === wanted,
    );
    for (const room of candidates) {
      const joined = await seating.join(room.room_id);
      if (joined.ok) return joined;
      const { code } = joined.error;
      // Already seated there under this name: another room (A2).
      if (code === 'name_invalid') continue;
      if (!CLOSED.includes(code)) return joined;
      await this.#drop(room.room_id);
    }
    return seating.open();
  }
}

// Runs a room call to the lobby's Result; a refusal no seating expects (say
// `internal` from opening a room) is a bug and rejects.
const outcome = <T, C extends ApiError['code']>(
  call: Effect.Effect<T, ApiError<C>>,
): Promise<Result<T, C>> =>
  Effect.runPromise(
    call.pipe(
      Effect.result,
      Effect.map(
        (result): Result<T, C> =>
          result._tag === 'Success'
            ? { ok: true, value: result.success }
            : { ok: false, error: result.failure },
      ),
    ),
  );

// A seat as POST /v1/rooms/quick answers it, before the hint.
export type Seated = Effect.Success<ReturnType<typeof Rooms.joinRoom>>;

// The lobby of a deployment, seating people in real rooms through the Room
// DOs (room/client.ts).
export const lobbyIn = (
  env: Bindings,
  options: { storage: LobbyStorage; now?: () => number },
) => {
  const lobby = new RoomLobby(options.storage, options);
  return {
    update: (update: LobbyUpdate) => lobby.update(update),
    list: () => lobby.list(),
    // The handler checked the name; display_name is normalized (A20).
    quick: (input: { name: string; display_name: string }) =>
      lobby.quick(
        { name: input.name, ...Rooms.publicDefaults(env) },
        {
          join: room_id => outcome(Rooms.joinRoom(env, room_id, input)),
          open: async () => {
            const opened = await outcome(
              Rooms.openRoom(env, { ...input, visibility: 'public' }),
            );
            if (!opened.ok && opened.error.code !== 'unavailable') {
              throw new Error(opened.error.message);
            }
            return opened as Result<Seated, 'unavailable'>;
          },
        },
      ),
  };
};
