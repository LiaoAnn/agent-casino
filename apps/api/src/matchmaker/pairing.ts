// The queue of POST /v1/queue (casino-api skill: POST /v1/queue, A2). Kept
// free of `cloudflare:workers` so it runs in Node tests; the Matchmaker DO
// holds one MatchQueue and forwards its RPC calls here.
//
// The queue and recent matches are written to the DO's storage: a DO with
// no request for a few seconds may be evicted from memory, and a player who
// got `waiting` or `matched` must still find them when they call again.
import { Effect } from 'effect';
import { type ApiError, apiError } from '../contract/errors';
import {
  type QueueResponse,
  SETTINGS_DEFAULTS,
  type Settings,
  type TestSettings,
} from '../contract/schemas';
import { isBanned } from '../db/bans';
import { openDb } from '../db/client';
import * as Rooms from '../room/client';
import type { Bindings } from '../routes/env';

type Answer = typeof QueueResponse.Type;
type Matched = Extract<Answer, { status: 'matched' }>;

export interface QueueInput {
  // Checked (name rules, house-bot, bans) by the handler.
  name: string;
  settings?: typeof Settings.Type;
  // Only where ALLOW_TEST_ROOMS=true; the handler drops it otherwise.
  test?: typeof TestSettings.Type;
}

// One seat of a fresh room, as `matched` shows it (A16 adds the opponent,
// the settings and the owner's watch link).
export type Seated = Omit<Matched, 'status' | 'hint'>;

type Result<T, C extends ApiError['code']> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError<C> };

// Opens a room for a pair: `first` (queued first) in seat 0, `second` in
// seat 1. Answers both seats, in seat order.
export type OpenMatch = (
  first: QueueInput,
  second: QueueInput,
) => Promise<Result<[Seated, Seated], 'unavailable'>>;

// What the queue needs from DurableObjectStorage.
export interface QueueStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface MatchQueueOptions {
  // Where the queue and recent matches are kept, so they outlive the DO
  // being evicted from memory. Defaults to memory only (tests).
  storage?: QueueStorage;
  // How long a call waits for an opponent before answering `waiting`.
  waitMs?: number;
  // How long a queue entry is kept after `waiting`, and a `matched` answer
  // after the match.
  holdMs?: number;
  now?: () => number;
  // Whether a name is banned now; checked for the waiting partner before a
  // room is opened (A9). Defaults to never.
  isBanned?: (name: string) => Promise<boolean>;
}

const WAIT_MS = 30_000;
const HOLD_MS = 45_000;

const WAITING: Answer = {
  status: 'waiting',
  hint: 'No opponent yet. Call POST /v1/queue again',
};

const matchedAnswer = (seated: Seated): Matched => ({
  status: 'matched',
  ...seated,
  hint: `Matched. Next, call GET /v1/rooms/${seated.room_id}/wait`,
});

// JSON with object keys sorted, so equal settings give equal strings.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );

// Only people with the same settings (defaults filled in) and test options
// are paired (A2).
const pairingKey = (input: QueueInput) =>
  canonical([{ ...SETTINGS_DEFAULTS, ...input.settings }, input.test ?? null]);

// One name (lowercased) in the queue.
interface Entry {
  key: string;
  input: QueueInput;
  pairingKey: string;
  // Calls of this name now in their long poll; the entry never expires
  // while one is.
  polls: number;
  // Epoch ms; renewed each time a call answers `waiting`.
  expiresAt: number;
}

// Two names taken out of the queue for one room.
interface Pairing {
  keys: [string, string];
  // Epoch ms when the pair was made; answers are replayed for holdMs.
  at: number;
  // Both seats' answers, or undefined if the room could not be opened.
  answers: Promise<[Matched, Matched] | undefined>;
  // Set once the room is open.
  matched?: [Matched, Matched];
}

// What STORAGE_KEY holds: entries not in a long poll, and opened pairs.
interface Saved {
  waiting: Omit<Entry, 'polls'>[];
  pairings: {
    keys: [string, string];
    at: number;
    matched: [Matched, Matched];
  }[];
}

const STORAGE_KEY = 'queue';

const memoryStorage = (): QueueStorage => {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => {
      data.set(key, structuredClone(value));
    },
  };
};

export class MatchQueue {
  readonly #openMatch: OpenMatch;
  readonly #waitMs: number;
  readonly #holdMs: number;
  readonly #now: () => number;
  readonly #storage: QueueStorage;
  readonly #isBanned: (name: string) => Promise<boolean>;
  #loaded: Promise<void> | undefined;
  // In arrival order, so the first match found is the one who queued first.
  readonly #waiting = new Map<string, Entry>();
  readonly #pairings = new Map<string, Pairing>();
  // Resolved, then replaced, whenever a pair is made; long polls listen here.
  #change = Promise.withResolvers<void>();

  constructor(openMatch: OpenMatch, options: MatchQueueOptions = {}) {
    this.#openMatch = openMatch;
    this.#waitMs = options.waitMs ?? WAIT_MS;
    this.#holdMs = options.holdMs ?? HOLD_MS;
    this.#now = options.now ?? Date.now;
    this.#storage = options.storage ?? memoryStorage();
    this.#isBanned = options.isBanned ?? (async () => false);
  }

  async queue(input: QueueInput): Promise<Result<Answer, 'unavailable'>> {
    const key = input.name.toLowerCase();
    await this.#load();
    this.#prune();
    const pairing = this.#pairings.get(key);
    if (pairing) {
      const answer = await this.#answerOf(pairing, key);
      if (answer) return { ok: true, value: answer };
      // The room couldn't be opened: start over from what is there now.
      return this.queue(input);
    }

    let entry = this.#waiting.get(key);
    if (entry) {
      // The same person waiting on: their latest settings count.
      entry.input = input;
      entry.pairingKey = pairingKey(input);
    } else {
      entry = {
        key,
        input,
        pairingKey: pairingKey(input),
        polls: 0,
        expiresAt: this.#now() + this.#holdMs,
      };
      this.#waiting.set(key, entry);
    }
    const partner = [...this.#waiting.values()].find(
      other => other !== entry && other.pairingKey === entry.pairingKey,
    );
    if (!partner) return this.#poll(entry);

    // The partner passed the ban check when they queued; they may have been
    // banned since (A9). The caller was checked by the handler just now.
    let banned: boolean;
    try {
      banned = await this.#isBanned(partner.input.name);
    } catch {
      return {
        ok: false,
        error: apiError(
          'unavailable',
          'The ban list could not be read',
          'Resend POST /v1/queue in a few seconds',
        ),
      };
    }
    if (banned && this.#waiting.get(partner.key) === partner) {
      this.#waiting.delete(partner.key);
      await this.#save();
    }
    // Others may have paired either of them while the ban list was read.
    if (
      banned ||
      this.#waiting.get(partner.key) !== partner ||
      this.#waiting.get(key) !== entry ||
      partner.pairingKey !== entry.pairingKey
    ) {
      return this.queue(input);
    }
    // Whoever queued first sits in seat 0, even if it is the caller.
    const order = [...this.#waiting.values()];
    return order.indexOf(partner) < order.indexOf(entry)
      ? this.#pair(partner, entry, key)
      : this.#pair(entry, partner, key);
  }

  // Drops expired entries and answers; pairings still opening stay.
  #prune() {
    const now = this.#now();
    for (const [key, pairing] of this.#pairings) {
      if (pairing.matched && now - pairing.at > this.#holdMs) {
        this.#pairings.delete(key);
      }
    }
    for (const [key, entry] of this.#waiting) {
      if (entry.polls === 0 && now > entry.expiresAt) this.#waiting.delete(key);
    }
  }

  #load() {
    this.#loaded ??= this.#storage.get<Saved>(STORAGE_KEY).then(saved => {
      for (const entry of saved?.waiting ?? []) {
        this.#waiting.set(entry.key, { ...entry, polls: 0 });
      }
      for (const { keys, at, matched } of saved?.pairings ?? []) {
        const pairing = {
          keys,
          at,
          answers: Promise.resolve(matched),
          matched,
        };
        for (const key of keys) this.#pairings.set(key, pairing);
      }
    });
    return this.#loaded;
  }

  #save() {
    const pairings = new Set(this.#pairings.values());
    const saved: Saved = {
      waiting: [...this.#waiting.values()].map(
        ({ polls: _, ...entry }) => entry,
      ),
      pairings: [...pairings].flatMap(({ keys, at, matched }) =>
        matched ? [{ keys, at, matched }] : [],
      ),
    };
    return this.#storage.put(STORAGE_KEY, saved);
  }

  async #answerOf(pairing: Pairing, key: string) {
    const answers = await pairing.answers;
    return answers?.[pairing.keys.indexOf(key)];
  }

  // Takes both out of the queue before the room is opened, so nobody else
  // is paired with them meanwhile. Answers the caller, by key.
  async #pair(
    first: Entry,
    second: Entry,
    caller: string,
  ): Promise<Result<Answer, 'unavailable'>> {
    this.#waiting.delete(first.key);
    this.#waiting.delete(second.key);
    const opened = Promise.withResolvers<[Matched, Matched] | undefined>();
    const pairing: Pairing = {
      keys: [first.key, second.key],
      at: this.#now(),
      answers: opened.promise,
    };
    this.#pairings.set(first.key, pairing);
    this.#pairings.set(second.key, pairing);
    this.#wake();

    // On failure the first goes back in the queue, and so does the second
    // if it is also waiting in a long poll; the caller gets the error.
    const unpair = () => {
      for (const entry of [first, second]) {
        if (this.#pairings.get(entry.key) === pairing) {
          this.#pairings.delete(entry.key);
        }
        if (
          (entry === first || entry.polls > 0) &&
          !this.#waiting.has(entry.key)
        ) {
          this.#waiting.set(entry.key, entry);
        }
      }
      opened.resolve(undefined);
      return this.#save();
    };
    let result: Awaited<ReturnType<OpenMatch>>;
    try {
      result = await this.#openMatch(first.input, second.input);
    } catch (error) {
      await unpair();
      throw error;
    }
    if (!result.ok) {
      await unpair();
      return result;
    }
    const answers: [Matched, Matched] = [
      matchedAnswer(result.value[0]),
      matchedAnswer(result.value[1]),
    ];
    pairing.matched = answers;
    opened.resolve(answers);
    await this.#save();
    return { ok: true, value: answers[pairing.keys.indexOf(caller)] };
  }

  // Waits up to waitMs for someone to be paired with `entry`.
  async #poll(entry: Entry): Promise<Result<Answer, 'unavailable'>> {
    entry.polls += 1;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const windowEnd = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.#waitMs);
    });
    try {
      for (;;) {
        const pairing = this.#pairings.get(entry.key);
        if (pairing) {
          const answer = await this.#answerOf(pairing, entry.key);
          if (answer) return { ok: true, value: answer };
          continue;
        }
        if (timedOut) return { ok: true, value: WAITING };
        await Promise.race([this.#change.promise, windowEnd]);
      }
    } finally {
      clearTimeout(timer);
      entry.polls -= 1;
      if (this.#waiting.get(entry.key) === entry) {
        entry.expiresAt = this.#now() + this.#holdMs;
        await this.#save();
      }
    }
  }

  #wake() {
    this.#change.resolve();
    this.#change = Promise.withResolvers<void>();
  }
}

// The queue of a deployment: real rooms, and the ban list in D1.
export const matchQueueIn = (
  env: Bindings,
  options: Omit<MatchQueueOptions, 'isBanned'> = {},
) =>
  new MatchQueue(openMatchIn(env), {
    ...options,
    isBanned: name => isBanned(openDb(env.DB), name),
  });

// Opens real rooms through the Room DOs (room/client.ts): `first` opens the
// room, `second` joins it with the invite code.
const openMatchIn =
  (env: Bindings): OpenMatch =>
  (first, second) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const room = yield* Rooms.openRoom(env, first);
        const joined = yield* Rooms.joinRoom(env, room.room_id, {
          name: second.name,
          invite_code: room.invite_code,
        });
        const seats: [Seated, Seated] = [
          {
            room_id: room.room_id,
            seat: room.seat,
            token: room.token,
            opponent_name: second.name,
            settings: room.settings,
            watch_url: room.watch_url,
          },
          joined,
        ];
        return seats;
      }).pipe(
        Effect.result,
        Effect.flatMap(
          (outcome): Effect.Effect<Result<[Seated, Seated], 'unavailable'>> => {
            if (outcome._tag === 'Success') {
              return Effect.succeed({ ok: true, value: outcome.success });
            }
            const error = outcome.failure;
            // Any other refusal of a fresh room is a bug: 500 internal.
            return error.code === 'unavailable'
              ? Effect.succeed({
                  ok: false,
                  error: error as ApiError<'unavailable'>,
                })
              : Effect.die(error);
          },
        ),
      ),
    );
