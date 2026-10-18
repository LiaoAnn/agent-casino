import { describe, expect, it, vi } from 'vitest';
import { apiError } from '../contract/errors';
import { SETTINGS_DEFAULTS } from '../contract/schemas';
import {
  MatchQueue,
  type OpenMatch,
  type QueueInput,
  type Seated,
} from './pairing';

const WAIT_MS = 60;
const HOLD_MS = 45_000;
const ROOM = 'r_0123456789';
const seats: [Seated, Seated] = [
  { room_id: ROOM, seat: 0, token: 'alice-token' },
  { room_id: ROOM, seat: 1, token: 'bob-token' },
];
const opened = { ok: true as const, value: seats };
const waiting = {
  ok: true,
  value: {
    status: 'waiting',
    hint: 'No opponent yet. Call POST /v1/queue again',
  },
};
const matched = (seat: 0 | 1) => ({
  ok: true,
  value: {
    status: 'matched',
    ...seats[seat],
    hint: `Matched. Next, call GET /v1/rooms/${ROOM}/wait`,
  },
});

const fixture = () => {
  const clock = { ms: 0 };
  const openMatch = vi.fn<OpenMatch>().mockResolvedValue(opened);
  const queue = new MatchQueue(openMatch, {
    waitMs: WAIT_MS,
    now: () => clock.ms,
  });
  return { clock, openMatch, queue };
};

class MemoryQueueStorage {
  readonly #data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#data.set(key, structuredClone(value));
  }
}

const persistentFixture = () => {
  const clock = { ms: 0 };
  const openMatch = vi.fn<OpenMatch>().mockResolvedValue(opened);
  const options = {
    storage: new MemoryQueueStorage(),
    waitMs: WAIT_MS,
    holdMs: HOLD_MS,
    now: () => clock.ms,
  };
  const recreate = () => new MatchQueue(openMatch, options);
  return { clock, openMatch, queue: recreate(), recreate };
};

// Attach a rejection handler while another request is being arranged. The
// original promise still rejects when awaited, including against the RED stub.
const start = (queue: MatchQueue, input: QueueInput) => {
  const pending = queue.queue(input);
  void pending.catch(() => {});
  return pending;
};

describe('MatchQueue (A2)', () => {
  it('does not pair settings changed while the waiter ban check is pending', async () => {
    vi.useFakeTimers();
    try {
      const checks: { name: string; resolve: (banned: boolean) => void }[] = [];
      const isBanned = (name: string) =>
        new Promise<boolean>(resolve => checks.push({ name, resolve }));
      const openMatch = vi.fn<OpenMatch>().mockResolvedValue(opened);
      const queue = new MatchQueue(openMatch, { waitMs: WAIT_MS, isBanned });
      const alice = start(queue, {
        name: 'Alice',
        settings: { ...SETTINGS_DEFAULTS, hands: 3 },
      });
      await vi.advanceTimersByTimeAsync(0);
      const bob = start(queue, {
        name: 'Bob',
        settings: { ...SETTINGS_DEFAULTS, hands: 3 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(checks.map(check => check.name.toLowerCase())).toEqual(['alice']);

      const aliceRetry = start(queue, {
        name: 'Alice',
        settings: { ...SETTINGS_DEFAULTS, hands: 10 },
      });
      await vi.advanceTimersByTimeAsync(0);
      checks[0]?.resolve(false);
      await vi.advanceTimersByTimeAsync(WAIT_MS);

      expect.soft(openMatch).not.toHaveBeenCalled();
      expect(await Promise.all([alice, bob, aliceRetry])).toEqual([
        waiting,
        waiting,
        waiting,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the earlier waiter in seat 0 when concurrent ban checks finish in reverse order', async () => {
    vi.useFakeTimers();
    try {
      const checks: { name: string; resolve: (banned: boolean) => void }[] = [];
      const isBanned = (name: string) =>
        new Promise<boolean>(resolve => checks.push({ name, resolve }));
      const openMatch = vi
        .fn<OpenMatch>()
        .mockImplementation(async (first, second) => ({
          ok: true,
          value: [
            { room_id: ROOM, seat: 0, token: `${first.name}-token` },
            { room_id: ROOM, seat: 1, token: `${second.name}-token` },
          ],
        }));
      const queue = new MatchQueue(openMatch, { waitMs: WAIT_MS, isBanned });
      const aliceInput = { name: 'Alice' };
      const bobInput = { name: 'Bob' };
      const alice = start(queue, aliceInput);
      await vi.advanceTimersByTimeAsync(0);
      const bob = start(queue, bobInput);
      await vi.advanceTimersByTimeAsync(0);
      expect(checks.map(check => check.name.toLowerCase())).toEqual(['alice']);
      const aliceRetry = start(queue, aliceInput);
      await vi.advanceTimersByTimeAsync(0);
      expect(checks.map(check => check.name.toLowerCase())).toEqual([
        'alice',
        'bob',
      ]);

      checks[1]?.resolve(false);
      await vi.advanceTimersByTimeAsync(0);
      checks[0]?.resolve(false);
      await vi.advanceTimersByTimeAsync(WAIT_MS);

      expect
        .soft(openMatch)
        .toHaveBeenCalledExactlyOnceWith(aliceInput, bobInput);
      const aliceMatch = {
        ok: true,
        value: {
          status: 'matched',
          room_id: ROOM,
          seat: 0,
          token: 'Alice-token',
        },
      };
      expect(await Promise.all([alice, aliceRetry, bob])).toMatchObject([
        aliceMatch,
        aliceMatch,
        {
          ok: true,
          value: {
            status: 'matched',
            room_id: ROOM,
            seat: 1,
            token: 'Bob-token',
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults to a 30 second long poll', async () => {
    vi.useFakeTimers();
    try {
      const openMatch = vi.fn<OpenMatch>().mockResolvedValue(opened);
      const queue = new MatchQueue(openMatch);
      const settled = vi.fn();
      const alice = start(queue, { name: 'Alice' });
      void alice.then(settled);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await alice).toEqual(waiting);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(openMatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pair with a retained waiter banned after receiving waiting', async () => {
    const banned = new Set<string>();
    const openMatch = vi.fn<OpenMatch>().mockResolvedValue(opened);
    const queue = new MatchQueue(openMatch, {
      waitMs: WAIT_MS,
      isBanned: async name => banned.has(name.toLowerCase()),
    });
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    banned.add('alice');
    expect(await queue.queue({ name: 'Bob' })).toEqual(waiting);
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('skips a banned waiter and pairs the next compatible earlier waiter', async () => {
    const banned = new Set<string>();
    const openMatch = vi.fn<OpenMatch>().mockResolvedValue(opened);
    const queue = new MatchQueue(openMatch, {
      waitMs: WAIT_MS,
      isBanned: async name => banned.has(name.toLowerCase()),
    });
    let release!: (value: Awaited<ReturnType<OpenMatch>>) => void;
    let notifyOpening!: () => void;
    let releaseCarol!: (value: Awaited<ReturnType<OpenMatch>>) => void;
    let notifyCarolOpening!: () => void;
    const opening = new Promise<void>(resolve => {
      notifyOpening = resolve;
    });
    const carolOpening = new Promise<void>(resolve => {
      notifyCarolOpening = resolve;
    });
    openMatch.mockImplementationOnce(() => {
      notifyOpening();
      return new Promise(resolve => {
        release = resolve;
      });
    });
    openMatch.mockImplementationOnce(() => {
      notifyCarolOpening();
      return new Promise(resolve => {
        releaseCarol = resolve;
      });
    });
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    const dave = start(queue, { name: 'Dave' });
    await opening;
    const carol = { name: 'Carol' };
    expect(await queue.queue(carol)).toEqual(waiting);
    const eve = start(queue, { name: 'Eve' });
    await carolOpening;
    const failed = {
      ok: false as const,
      error: apiError('unavailable', 'Try again', 'Call POST /v1/queue again'),
    };
    release(failed);
    expect(await dave).toEqual(failed);
    releaseCarol(failed);
    expect(await eve).toEqual(failed);
    // Restore Alice first, then Carol, so the banned waiter is encountered first.
    banned.add('alice');
    const bob = { name: 'Bob' };
    expect(await queue.queue(bob)).toEqual(matched(1));
    expect(await queue.queue(carol)).toEqual(matched(0));
    expect(openMatch.mock.calls).toEqual([
      [{ name: 'Alice' }, { name: 'Dave' }],
      [carol, { name: 'Eve' }],
      [carol, bob],
    ]);
  });

  it('returns unavailable when checking a retained waiter ban fails', async () => {
    const isBanned = vi
      .fn<(name: string) => Promise<boolean>>()
      .mockResolvedValue(false);
    const openMatch = vi.fn<OpenMatch>().mockResolvedValue(opened);
    const queue = new MatchQueue(openMatch, { waitMs: WAIT_MS, isBanned });
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    isBanned.mockRejectedValueOnce(new Error('D1 unavailable'));
    expect(await queue.queue({ name: 'Bob' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('replays both matched results after recreation without opening another match', async () => {
    const { queue, recreate, clock, openMatch } = persistentFixture();
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    clock.ms = 1_000;
    const bob = await queue.queue({ name: 'Bob' });
    const alice = await queue.queue({ name: 'Alice' });
    expect([alice, bob]).toEqual([matched(0), matched(1)]);

    clock.ms += 30_000;
    const restored = recreate();
    clock.ms += HOLD_MS - 30_000 - 1;
    const replayed = await Promise.all([
      restored.queue({ name: 'Alice' }),
      restored.queue({ name: 'Bob' }),
    ]);
    expect(replayed).toEqual([alice, bob]);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('expires matched results after recreation using the original pairing time', async () => {
    const { queue, recreate, clock, openMatch } = persistentFixture();
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    clock.ms = 1_000;
    expect(await queue.queue({ name: 'Bob' })).toEqual(matched(1));

    clock.ms += 30_000;
    const restored = recreate();
    clock.ms += HOLD_MS - 30_000 + 1;
    expect(await restored.queue({ name: 'Alice' })).toEqual(waiting);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('pairs a retained waiter after recreation and preserves its first seat', async () => {
    const { queue, recreate, clock, openMatch } = persistentFixture();
    const alice = { name: 'Alice' };
    const bob = { name: 'Bob' };
    expect(await queue.queue(alice)).toEqual(waiting);

    clock.ms += 30_000;
    const restored = recreate();
    clock.ms += HOLD_MS - 30_000 - 1;
    expect(await restored.queue(bob)).toEqual(matched(1));
    expect(await restored.queue(alice)).toEqual(matched(0));
    expect(openMatch).toHaveBeenCalledExactlyOnceWith(alice, bob);
  });

  it('expires a retained waiter after recreation using the original hold period', async () => {
    const { queue, recreate, clock, openMatch } = persistentFixture();
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);

    clock.ms += 30_000;
    const restored = recreate();
    clock.ms += HOLD_MS - 30_000 + 1;
    expect(await restored.queue({ name: 'Bob' })).toEqual(waiting);
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('holds a lone request until waitMs, then returns the exact waiting hint', async () => {
    const { queue, openMatch } = fixture();
    const started = performance.now();
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    expect(performance.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 5);
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('pairs concurrent requests once, preserving order and name spelling', async () => {
    const { queue, openMatch } = fixture();
    const first = { name: 'AlIce' };
    const second = { name: 'bOB' };
    expect(
      await Promise.all([queue.queue(first), queue.queue(second)]),
    ).toEqual([matched(0), matched(1)]);
    expect(openMatch).toHaveBeenCalledExactlyOnceWith(first, second);
  });

  it('matches a retained waiter and returns its result on the next call', async () => {
    const { queue, clock } = fixture();
    const alice = start(queue, { name: 'Alice' });
    clock.ms += 1_000;
    expect(await alice).toEqual(waiting);
    clock.ms += HOLD_MS - 1;
    expect(await queue.queue({ name: 'Bob' })).toEqual(matched(1));
    expect(await queue.queue({ name: 'Alice' })).toEqual(matched(0));
  });

  it('wakes an outstanding long poll as soon as an opponent arrives', async () => {
    const queue = new MatchQueue(vi.fn<OpenMatch>().mockResolvedValue(opened), {
      waitMs: 60_000,
    });
    const alice = start(queue, { name: 'Alice' });
    expect(await queue.queue({ name: 'Bob' })).toEqual(matched(1));
    expect(await alice).toEqual(matched(0));
  });

  it('expires queue eligibility 45 seconds after waiting is returned', async () => {
    const { queue, clock, openMatch } = fixture();
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    clock.ms += HOLD_MS + 1;
    expect(await queue.queue({ name: 'Bob' })).toEqual(waiting);
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('replays matched results for 45 seconds from pairing, then queues anew', async () => {
    const { queue, clock, openMatch } = fixture();
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    clock.ms = HOLD_MS - 1;
    const [alice, bob] = await Promise.all([
      queue.queue({ name: 'Alice' }),
      queue.queue({ name: 'Bob' }),
    ]);
    expect([alice, bob]).toEqual([matched(0), matched(1)]);
    clock.ms += HOLD_MS - 1;
    expect(await queue.queue({ name: 'ALICE' })).toEqual(alice);
    expect(await queue.queue({ name: 'BOB' })).toEqual(bob);
    expect(openMatch).toHaveBeenCalledTimes(1);
    clock.ms += 2;
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('treats case variants as one person renewing their wait', async () => {
    const { queue, openMatch } = fixture();
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    expect(await queue.queue({ name: 'ALICE' })).toEqual(waiting);
    expect(openMatch).not.toHaveBeenCalled();
    expect(await queue.queue({ name: 'Bob' })).toEqual(matched(1));
    expect(await queue.queue({ name: 'alice' })).toEqual(matched(0));
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('wakes both simultaneous calls for the same name with the same match', async () => {
    const { queue, openMatch } = fixture();
    const a = start(queue, { name: 'Alice' });
    const duplicate = start(queue, { name: 'ALICE' });
    expect(await queue.queue({ name: 'Bob' })).toEqual(matched(1));
    expect(await Promise.all([a, duplicate])).toEqual([matched(0), matched(0)]);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { settings: { ...SETTINGS_DEFAULTS, hands: 2 } },
      { settings: { ...SETTINGS_DEFAULTS, hands: 3 } },
    ],
    [
      { settings: { ...SETTINGS_DEFAULTS, turn_seconds: 5 } },
      { settings: { ...SETTINGS_DEFAULTS, turn_seconds: 10 } },
    ],
    [
      { settings: { ...SETTINGS_DEFAULTS, starting_stack: 50 } },
      { settings: { ...SETTINGS_DEFAULTS, starting_stack: 60 } },
    ],
    [{ test: { seed: '00'.repeat(32) } }, { test: { seed: '01'.repeat(32) } }],
    [
      { test: { chaos: { extra_waiting: 1 } } },
      { test: { chaos: { extra_waiting: 2 } } },
    ],
  ])(
    'does not pair incompatible settings or test options: %j / %j',
    async (a, b) => {
      const { queue, openMatch } = fixture();
      expect(
        await Promise.all([
          queue.queue({ name: 'Alice', ...a }),
          queue.queue({ name: 'Bob', ...b }),
        ]),
      ).toEqual([waiting, waiting]);
      expect(openMatch).not.toHaveBeenCalled();
    },
  );

  it('pairs omitted settings with explicit defaults', async () => {
    const { queue } = fixture();
    expect(
      await Promise.all([
        queue.queue({ name: 'Alice' }),
        queue.queue({ name: 'Bob', settings: SETTINGS_DEFAULTS }),
      ]),
    ).toEqual([matched(0), matched(1)]);
  });

  it('pairs identical settings and test options and passes them to openMatch', async () => {
    const { queue, openMatch } = fixture();
    const options = {
      settings: { hands: 2, turn_seconds: 5, starting_stack: 100 },
      test: { seed: '00'.repeat(32), chaos: { extra_waiting: 2 } },
    };
    const a = { name: 'Alice', ...options };
    const b = { name: 'Bob', ...structuredClone(options) };
    expect(await Promise.all([queue.queue(a), queue.queue(b)])).toEqual([
      matched(0),
      matched(1),
    ]);
    expect(openMatch).toHaveBeenCalledExactlyOnceWith(a, b);
  });

  it('returns an opening failure to the newcomer and retains the first waiter', async () => {
    const { queue, openMatch } = fixture();
    const failed = {
      ok: false as const,
      error: apiError('unavailable', 'Try again', 'Call POST /v1/queue again'),
    };
    openMatch.mockResolvedValueOnce(failed);
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    expect(await queue.queue({ name: 'Bob' })).toEqual(failed);
    expect(await queue.queue({ name: 'Carol' })).toEqual(matched(1));
    expect(await queue.queue({ name: 'Alice' })).toEqual(matched(0));
    expect(openMatch.mock.calls).toEqual([
      [{ name: 'Alice' }, { name: 'Bob' }],
      [{ name: 'Alice' }, { name: 'Carol' }],
    ]);
  });

  it('reserves both people while opening and deduplicates the first person', async () => {
    const { queue, openMatch } = fixture();
    let release!: (value: Awaited<ReturnType<OpenMatch>>) => void;
    openMatch.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    const bob = start(queue, { name: 'Bob' });
    await vi.waitFor(() => expect(openMatch).toHaveBeenCalledTimes(1), {
      timeout: 300,
      interval: 5,
    });
    const carol = start(queue, { name: 'Carol' });
    // Let Carol finish a complete long poll while the opening is still pending.
    expect(await carol).toEqual(waiting);
    expect(openMatch).toHaveBeenCalledTimes(1);
    const duplicate = start(queue, { name: 'ALICE' });
    release(opened);
    expect(await Promise.all([bob, duplicate])).toEqual([
      matched(1),
      matched(0),
    ]);
    expect(await queue.queue({ name: 'Alice' })).toEqual(matched(0));
  });

  it('deduplicates retries after opening fails so Alice joins only one successful room', async () => {
    const { queue, openMatch } = fixture();
    let release!: (value: Awaited<ReturnType<OpenMatch>>) => void;
    let notifyOpening!: () => void;
    const opening = new Promise<void>(resolve => {
      notifyOpening = resolve;
    });
    openMatch.mockImplementationOnce(() => {
      notifyOpening();
      return new Promise(resolve => {
        release = resolve;
      });
    });
    expect(await queue.queue({ name: 'Alice' })).toEqual(waiting);
    const bob = start(queue, { name: 'Bob' });
    await opening;
    const firstRetry = start(queue, { name: 'ALICE' });
    const secondRetry = start(queue, { name: 'ALICE' });
    expect(await queue.queue({ name: 'Carol' })).toEqual(waiting);
    expect(openMatch).toHaveBeenCalledTimes(1);
    const failed = {
      ok: false as const,
      error: apiError('unavailable', 'Try again', 'Call POST /v1/queue again'),
    };
    release(failed);
    expect(await bob).toEqual(failed);
    const [first, second] = await Promise.all([firstRetry, secondRetry]);
    expect(first).toMatchObject({
      ok: true,
      value: { status: 'matched', room_id: ROOM },
    });
    expect(second).toEqual(first);
    expect(await queue.queue({ name: 'Dave' })).toEqual(waiting);
    const aliceOpenings = openMatch.mock.calls.filter(players =>
      players.some(player => player.name.toLowerCase() === 'alice'),
    );
    expect(aliceOpenings).toHaveLength(2);
    expect(openMatch).toHaveBeenCalledTimes(2);
    expect(
      openMatch.mock.calls[1]?.map(player => player.name.toLowerCase()).sort(),
    ).toEqual(['alice', 'carol']);
  });
});
