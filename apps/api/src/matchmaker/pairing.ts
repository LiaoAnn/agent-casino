// The queue of POST /v1/queue (casino-api skill: POST /v1/queue, A2). Kept
// free of `cloudflare:workers` so it runs in Node tests; the Matchmaker DO
// holds one MatchQueue and forwards its RPC calls here.
//
// State lives in memory only: a DO restart (a deploy) drops the queue, and
// the agents simply queue again.
import { Effect } from 'effect';
import type { ApiError } from '../contract/errors';
import {
  type QueueResponse,
  SETTINGS_DEFAULTS,
  type Settings,
  type TestSettings,
} from '../contract/schemas';
import * as Rooms from '../room/client';
import type { Bindings } from '../routes/env';

export interface QueueInput {
  // Checked (name rules, house-bot, bans) by the handler.
  name: string;
  settings?: typeof Settings.Type;
  // Only where ALLOW_TEST_ROOMS=true; the handler drops it otherwise.
  test?: typeof TestSettings.Type;
}

export interface Seated {
  room_id: string;
  seat: 0 | 1;
  token: string;
}

type Result<T, C extends ApiError['code']> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError<C> };

// Opens a room for a pair: `first` (queued first) in seat 0, `second` in
// seat 1. Answers both seats, in seat order.
export type OpenMatch = (
  first: QueueInput,
  second: QueueInput,
) => Promise<Result<[Seated, Seated], 'unavailable'>>;

export interface MatchQueueOptions {
  // How long a call waits for an opponent before answering `waiting`.
  waitMs?: number;
  // How long a queue entry is kept after `waiting`, and a `matched` answer
  // after the match.
  holdMs?: number;
  now?: () => number;
}

type Answer = typeof QueueResponse.Type;
type Matched = Extract<Answer, { status: 'matched' }>;

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
  done: boolean;
}

export class MatchQueue {
  readonly #openMatch: OpenMatch;
  readonly #waitMs: number;
  readonly #holdMs: number;
  readonly #now: () => number;
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
  }

  async queue(input: QueueInput): Promise<Result<Answer, 'unavailable'>> {
    const key = input.name.toLowerCase();
    this.#prune();
    const pairing = this.#pairings.get(key);
    if (pairing) {
      const answer = await this.#answerOf(pairing, key);
      if (answer) return { ok: true, value: answer };
      this.#prune();
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
    for (const other of this.#waiting.values()) {
      if (other !== entry && other.pairingKey === entry.pairingKey) {
        return this.#pair(other, entry);
      }
    }
    return this.#poll(entry);
  }

  // Drops expired entries and answers; pairings still opening stay.
  #prune() {
    const now = this.#now();
    for (const [key, pairing] of this.#pairings) {
      if (pairing.done && now - pairing.at > this.#holdMs) {
        this.#pairings.delete(key);
      }
    }
    for (const [key, entry] of this.#waiting) {
      if (entry.polls === 0 && now > entry.expiresAt) this.#waiting.delete(key);
    }
  }

  async #answerOf(pairing: Pairing, key: string) {
    const answers = await pairing.answers;
    return answers?.[pairing.keys.indexOf(key)];
  }

  // Takes both out of the queue before the room is opened, so nobody else
  // is paired with them meanwhile. Answers `second`, the caller.
  async #pair(
    first: Entry,
    second: Entry,
  ): Promise<Result<Answer, 'unavailable'>> {
    this.#waiting.delete(first.key);
    this.#waiting.delete(second.key);
    const opened = Promise.withResolvers<[Matched, Matched] | undefined>();
    const pairing: Pairing = {
      keys: [first.key, second.key],
      at: this.#now(),
      answers: opened.promise,
      done: false,
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
    };
    let result: Awaited<ReturnType<OpenMatch>>;
    try {
      result = await this.#openMatch(first.input, second.input);
    } catch (error) {
      unpair();
      throw error;
    }
    if (!result.ok) {
      unpair();
      return result;
    }
    const answers: [Matched, Matched] = [
      matchedAnswer(result.value[0]),
      matchedAnswer(result.value[1]),
    ];
    pairing.done = true;
    opened.resolve(answers);
    return { ok: true, value: answers[1] };
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
      }
    }
  }

  #wake() {
    this.#change.resolve();
    this.#change = Promise.withResolvers<void>();
  }
}

// Opens real rooms through the Room DOs (room/client.ts): `first` opens the
// room, `second` joins it with the invite code.
export const openMatchIn =
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
          { room_id: room.room_id, seat: room.seat, token: room.token },
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
