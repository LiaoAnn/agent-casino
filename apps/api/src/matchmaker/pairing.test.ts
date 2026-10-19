import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError } from '../contract/errors';
import { SETTINGS_DEFAULTS } from '../contract/schemas';
import {
  MatchQueue,
  type MatchQueueOptions,
  type OpenMatch,
  type QueueInput,
  type QueueStorage,
  type Seated,
} from './pairing';

const WAIT_MS = 60;
const HOLD_MS = 45_000;
const ROOM = 'r_0123456789';
const seats: [Seated, Seated] = [
  {
    room_id: ROOM,
    seat: 0,
    token: 'alice-token',
    opponent_name: 'bob',
    display_name: 'alice',
    opponent_display_name: 'bob',
    settings: SETTINGS_DEFAULTS,
    watch_url: `https://web.test/watch/${ROOM}?token=alice-watch`,
  },
  {
    room_id: ROOM,
    seat: 1,
    token: 'bob-token',
    opponent_name: 'alice',
    display_name: 'bob',
    opponent_display_name: 'alice',
    settings: SETTINGS_DEFAULTS,
    watch_url: `https://web.test/watch/${ROOM}?token=bob-watch`,
  },
];
const opened = { ok: true as const, value: seats };
const waiting = {
  ok: true,
  value: {
    status: 'waiting',
    waited_seconds: 0,
    queue_size: 1,
    hint: 'No opponent yet. Call POST /v1/queue again',
  },
};
const waitingFor = (waited_seconds: number, queue_size = 1) => ({
  ...waiting,
  value: { ...waiting.value, waited_seconds, queue_size },
});
const matched = (seat: 0 | 1) => ({
  ok: true,
  value: {
    status: 'matched',
    ...seats[seat],
    tell_owner: `Playing against ${seats[seat].opponent_display_name}. Watch: ${seats[seat].watch_url}`,
    hint: expect.stringMatching(
      new RegExp(`watch_url[\\s\\S]*GET /v1/rooms/${ROOM}/wait`),
    ),
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
  return {
    clock,
    openMatch,
    storage: options.storage,
    queue: recreate(),
    recreate,
  };
};

const withKey = (
  input: Omit<QueueInput, 'queue_key'> & { queue_key?: string },
): QueueInput => ({
  queue_key: `queue-key-${input.name.toLowerCase().padEnd(16, '_')}`,
  ...input,
});

// Attach a rejection handler while another request is being arranged. The
// original promise still rejects when awaited, including against the RED stub.
const start = (
  queue: MatchQueue,
  input: Omit<QueueInput, 'queue_key'> & { queue_key?: string },
) => {
  const pending = queue.queue(withKey(input));
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
        settings: { ...SETTINGS_DEFAULTS, max_hands: 3 },
      });
      await vi.advanceTimersByTimeAsync(0);
      const bob = start(queue, {
        name: 'Bob',
        settings: { ...SETTINGS_DEFAULTS, max_hands: 3 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(checks.map(check => check.name.toLowerCase())).toEqual(['alice']);

      const aliceRetry = start(queue, {
        name: 'Alice',
        settings: { ...SETTINGS_DEFAULTS, max_hands: 10 },
      });
      await vi.advanceTimersByTimeAsync(0);
      checks[0]?.resolve(false);
      await vi.advanceTimersByTimeAsync(WAIT_MS);

      expect.soft(openMatch).not.toHaveBeenCalled();
      expect(await Promise.all([alice, bob, aliceRetry])).toEqual([
        waitingFor(0, 2),
        waitingFor(0, 2),
        waitingFor(0, 2),
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
            {
              room_id: ROOM,
              seat: 0,
              token: `${first.name}-token`,
              opponent_name: second.name,
              display_name: first.name,
              opponent_display_name: second.name,
              settings: SETTINGS_DEFAULTS,
              watch_url: `https://web.test/watch/${ROOM}?token=${first.name}-watch`,
            },
            {
              room_id: ROOM,
              seat: 1,
              token: `${second.name}-token`,
              opponent_name: first.name,
              display_name: second.name,
              opponent_display_name: first.name,
              settings: SETTINGS_DEFAULTS,
              watch_url: `https://web.test/watch/${ROOM}?token=${second.name}-watch`,
            },
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
      expect(await alice).toEqual(waitingFor(30));
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
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    banned.add('alice');
    expect(await queue.queue(withKey({ name: 'Bob' }))).toEqual(waiting);
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
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    const dave = start(queue, { name: 'Dave' });
    await opening;
    const carol = { name: 'Carol' };
    expect(await queue.queue(withKey(carol))).toEqual(waiting);
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
    expect(await queue.queue(withKey(bob))).toEqual(matched(1));
    expect(await queue.queue(withKey(carol))).toEqual(matched(0));
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
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    isBanned.mockRejectedValueOnce(new Error('D1 unavailable'));
    expect(await queue.queue(withKey({ name: 'Bob' }))).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('replays both matched results after recreation without opening another match', async () => {
    const { queue, recreate, clock, openMatch } = persistentFixture();
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    clock.ms = 1_000;
    const bob = await queue.queue(withKey({ name: 'Bob' }));
    const alice = await queue.queue(withKey({ name: 'Alice' }));
    expect([alice, bob]).toEqual([matched(0), matched(1)]);

    clock.ms += 30_000;
    const restored = recreate();
    clock.ms += HOLD_MS - 30_000 - 1;
    const replayed = await Promise.all([
      restored.queue(withKey({ name: 'Alice' })),
      restored.queue(withKey({ name: 'Bob' })),
    ]);
    expect(replayed).toEqual([alice, bob]);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('expires matched results after recreation using the original pairing time', async () => {
    const { queue, recreate, clock, openMatch } = persistentFixture();
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    clock.ms = 1_000;
    expect(await queue.queue(withKey({ name: 'Bob' }))).toEqual(matched(1));

    clock.ms += 30_000;
    const restored = recreate();
    clock.ms += HOLD_MS - 30_000 + 1;
    expect(await restored.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('pairs a retained waiter after recreation and preserves its first seat', async () => {
    const { queue, recreate, clock, openMatch } = persistentFixture();
    const alice = { name: 'Alice' };
    const bob = { name: 'Bob' };
    expect(await queue.queue(withKey(alice))).toEqual(waiting);

    clock.ms += 30_000;
    const restored = recreate();
    clock.ms += HOLD_MS - 30_000 - 1;
    expect(await restored.queue(withKey(bob))).toEqual(matched(1));
    expect(await restored.queue(withKey(alice))).toEqual(matched(0));
    expect(openMatch).toHaveBeenCalledExactlyOnceWith(alice, bob);
  });

  it('expires a retained waiter after recreation using the original hold period', async () => {
    const { queue, recreate, clock, openMatch } = persistentFixture();
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);

    clock.ms += 30_000;
    const restored = recreate();
    clock.ms += HOLD_MS - 30_000 + 1;
    expect(await restored.queue(withKey({ name: 'Bob' }))).toEqual(waiting);
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('holds a lone request until waitMs, then returns the exact waiting hint', async () => {
    const { queue, openMatch } = fixture();
    const started = performance.now();
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    expect(performance.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 5);
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('pairs concurrent requests once, preserving order and name spelling', async () => {
    const { queue, openMatch } = fixture();
    const first = { name: 'AlIce' };
    const second = { name: 'bOB' };
    expect(
      await Promise.all([
        queue.queue(withKey(first)),
        queue.queue(withKey(second)),
      ]),
    ).toEqual([matched(0), matched(1)]);
    expect(openMatch).toHaveBeenCalledExactlyOnceWith(first, second);
  });

  it('matches a retained waiter and returns its result on the next call', async () => {
    const { queue, clock } = fixture();
    const alice = start(queue, { name: 'Alice' });
    clock.ms += 1_000;
    expect(await alice).toEqual(waitingFor(1));
    clock.ms += HOLD_MS - 1;
    expect(await queue.queue(withKey({ name: 'Bob' }))).toEqual(matched(1));
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(matched(0));
  });

  it('wakes an outstanding long poll as soon as an opponent arrives', async () => {
    const queue = new MatchQueue(vi.fn<OpenMatch>().mockResolvedValue(opened), {
      waitMs: 60_000,
    });
    const alice = start(queue, { name: 'Alice' });
    expect(await queue.queue(withKey({ name: 'Bob' }))).toEqual(matched(1));
    expect(await alice).toEqual(matched(0));
  });

  it('expires queue eligibility 45 seconds after waiting is returned', async () => {
    const { queue, clock, openMatch } = fixture();
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    clock.ms += HOLD_MS + 1;
    expect(await queue.queue(withKey({ name: 'Bob' }))).toEqual(waiting);
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('replays matched results for 45 seconds from pairing, then queues anew', async () => {
    const { queue, clock, openMatch } = fixture();
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    clock.ms = HOLD_MS - 1;
    const [alice, bob] = await Promise.all([
      queue.queue(withKey({ name: 'Alice' })),
      queue.queue(withKey({ name: 'Bob' })),
    ]);
    expect([alice, bob]).toEqual([matched(0), matched(1)]);
    clock.ms += HOLD_MS - 1;
    expect(await queue.queue(withKey({ name: 'ALICE' }))).toEqual(alice);
    expect(await queue.queue(withKey({ name: 'BOB' }))).toEqual(bob);
    expect(openMatch).toHaveBeenCalledTimes(1);
    clock.ms += 2;
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('treats case variants as one person renewing their wait', async () => {
    const { queue, openMatch } = fixture();
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    expect(await queue.queue(withKey({ name: 'ALICE' }))).toEqual(waiting);
    expect(openMatch).not.toHaveBeenCalled();
    expect(await queue.queue(withKey({ name: 'Bob' }))).toEqual(matched(1));
    expect(await queue.queue(withKey({ name: 'alice' }))).toEqual(matched(0));
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('wakes both simultaneous calls for the same name with the same match', async () => {
    const { queue, openMatch } = fixture();
    const a = start(queue, { name: 'Alice' });
    const duplicate = start(queue, { name: 'ALICE' });
    expect(await queue.queue(withKey({ name: 'Bob' }))).toEqual(matched(1));
    expect(await Promise.all([a, duplicate])).toEqual([matched(0), matched(0)]);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      { settings: { ...SETTINGS_DEFAULTS, blind_every: 1 } },
      { settings: { ...SETTINGS_DEFAULTS, blind_every: 5 } },
    ],
    [
      { settings: { ...SETTINGS_DEFAULTS, max_hands: 2 } },
      { settings: { ...SETTINGS_DEFAULTS, max_hands: 3 } },
    ],
    [
      { settings: { ...SETTINGS_DEFAULTS, turn_seconds: 5 } },
      { settings: { ...SETTINGS_DEFAULTS, turn_seconds: 10 } },
    ],
    [
      {
        settings: { ...SETTINGS_DEFAULTS, blind_every: 50, starting_stack: 50 },
      },
      {
        settings: { ...SETTINGS_DEFAULTS, blind_every: 50, starting_stack: 60 },
      },
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
          queue.queue(withKey({ name: 'Alice', ...a })),
          queue.queue(withKey({ name: 'Bob', ...b })),
        ]),
      ).toEqual([waitingFor(0, 2), waitingFor(0, 2)]);
      expect(openMatch).not.toHaveBeenCalled();
    },
  );

  it('pairs omitted settings with explicit defaults', async () => {
    const { queue } = fixture();
    expect(
      await Promise.all([
        queue.queue(withKey({ name: 'Alice' })),
        queue.queue(
          withKey({
            name: 'Bob',
            settings: {
              starting_stack: 40,
              blind_every: 5,
              max_hands: 50,
              turn_seconds: 30,
            },
          }),
        ),
      ]),
    ).toEqual([matched(0), matched(1)]);
  });

  it('pairs identical settings and test options and passes them to openMatch', async () => {
    const { queue, openMatch } = fixture();
    const options = {
      settings: {
        max_hands: 2,
        turn_seconds: 5,
        blind_every: 50,
        starting_stack: 100,
      },
      test: { seed: '00'.repeat(32), chaos: { extra_waiting: 2 } },
    };
    const a = { name: 'Alice', ...options };
    const b = { name: 'Bob', ...structuredClone(options) };
    expect(
      await Promise.all([queue.queue(withKey(a)), queue.queue(withKey(b))]),
    ).toEqual([matched(0), matched(1)]);
    expect(openMatch).toHaveBeenCalledExactlyOnceWith(a, b);
  });

  it('returns an opening failure to the newcomer and retains the first waiter', async () => {
    const { queue, openMatch } = fixture();
    const failed = {
      ok: false as const,
      error: apiError('unavailable', 'Try again', 'Call POST /v1/queue again'),
    };
    openMatch.mockResolvedValueOnce(failed);
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    expect(await queue.queue(withKey({ name: 'Bob' }))).toEqual(failed);
    expect(await queue.queue(withKey({ name: 'Carol' }))).toEqual(matched(1));
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(matched(0));
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
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
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
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(matched(0));
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
    expect(await queue.queue(withKey({ name: 'Alice' }))).toEqual(waiting);
    const bob = start(queue, { name: 'Bob' });
    await opening;
    const firstRetry = start(queue, { name: 'ALICE' });
    const secondRetry = start(queue, { name: 'ALICE' });
    expect(await queue.queue(withKey({ name: 'Carol' }))).toEqual(waiting);
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
    expect(await queue.queue(withKey({ name: 'Dave' }))).toEqual(waiting);
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

describe('MatchQueue waiting information (A18)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const poll = async (
    queue: MatchQueue,
    input: Omit<QueueInput, 'queue_key'> & { queue_key?: string },
  ) => {
    const pending = start(queue, input);
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    return pending;
  };

  it('accumulates continuous waiting for the same name and key, rounding down seconds', async () => {
    const { queue, clock, openMatch } = fixture();
    await poll(queue, { name: 'Alice' });
    clock.ms = 30_999;
    expect.soft(await poll(queue, { name: 'ALICE' })).toEqual(waitingFor(30));
    clock.ms = 61_999;
    expect.soft(await poll(queue, { name: 'alice' })).toEqual(waitingFor(61));
    expect(openMatch).not.toHaveBeenCalled();
  });

  it('counts time spent in the current long poll using the injected clock', async () => {
    const { queue, clock } = fixture();
    const pending = start(queue, { name: 'Alice' });
    await vi.advanceTimersByTimeAsync(0);
    clock.ms = 30_999;
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(await pending).toEqual(waitingFor(30));
  });

  it('preserves continuous waiting after a failed room opening returns the waiter to the queue', async () => {
    const { queue, clock, openMatch } = fixture();
    const failed = {
      ok: false as const,
      error: apiError('unavailable', 'Try again', 'Call POST /v1/queue again'),
    };
    await poll(queue, { name: 'Alice' });
    clock.ms = 30_000;
    expect(await poll(queue, { name: 'Alice' })).toEqual(waitingFor(30));

    clock.ms = 40_000;
    openMatch.mockResolvedValueOnce(failed);
    expect(await queue.queue(withKey({ name: 'Bob' }))).toEqual(failed);
    expect(openMatch).toHaveBeenCalledExactlyOnceWith(
      { name: 'Alice' },
      { name: 'Bob' },
    );

    clock.ms = 60_999;
    expect(await poll(queue, { name: 'Alice' })).toEqual(waitingFor(60));
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('excludes a different-settings waiter that expires during the current long poll', async () => {
    const { queue, clock, openMatch } = fixture();
    await poll(queue, {
      name: 'Bob',
      settings: { ...SETTINGS_DEFAULTS, max_hands: 3 },
    });

    clock.ms = 30_000;
    const pending = start(queue, {
      name: 'Alice',
      settings: { ...SETTINGS_DEFAULTS, max_hands: 2 },
    });
    await vi.advanceTimersByTimeAsync(0);
    clock.ms = HOLD_MS + 1;
    await vi.advanceTimersByTimeAsync(WAIT_MS);

    expect(await pending).toEqual(waitingFor(15, 1));
    expect(openMatch).not.toHaveBeenCalled();
  });

  it.each(['same-key', 'new-key'] as const)(
    'starts waiting from zero after eligibility expires with %s',
    async key => {
      const { queue, clock } = fixture();
      await poll(queue, { name: 'Alice' });
      clock.ms = 30_000;
      await poll(queue, { name: 'Alice' });
      clock.ms += HOLD_MS + 1;
      expect(
        await poll(queue, {
          name: 'Alice',
          ...(key === 'new-key' ? { queue_key: 'new-alice-key-123' } : {}),
        }),
      ).toEqual(waiting);
    },
  );

  it('preserves the continuous start time and renewed hold period across recreation', async () => {
    const { queue, recreate, clock } = persistentFixture();
    await poll(queue, { name: 'Alice' });
    clock.ms = 30_000;
    await poll(queue, { name: 'Alice' });
    clock.ms = 60_000;
    await poll(queue, { name: 'Alice' });
    clock.ms = 90_999;
    const restored = recreate();
    expect(await poll(restored, { name: 'ALICE' })).toEqual(waitingFor(90));
  });

  it('counts all live names across settings, includes self, deduplicates retries and excludes expired names', async () => {
    const { queue, clock, openMatch } = fixture();
    const alice = {
      name: 'Alice',
      settings: { ...SETTINGS_DEFAULTS, max_hands: 2 },
    };
    const bob = {
      name: 'Bob',
      settings: { ...SETTINGS_DEFAULTS, max_hands: 3 },
    };
    const carol = {
      name: 'Carol',
      settings: { ...SETTINGS_DEFAULTS, max_hands: 4 },
    };
    expect.soft(await poll(queue, alice)).toEqual(waitingFor(0, 1));
    clock.ms = 30_000;
    expect.soft(await poll(queue, bob)).toEqual(waitingFor(0, 2));
    clock.ms = HOLD_MS + 1;
    expect.soft(await poll(queue, carol)).toEqual(waitingFor(0, 2));
    clock.ms = 46_999;
    expect
      .soft(await poll(queue, { ...bob, name: 'BOB' }))
      .toEqual(waitingFor(16, 2));
    expect(openMatch).not.toHaveBeenCalled();
  });

  it.each([179_999, 180_000])(
    'uses the correct hint at %s milliseconds of continuous waiting',
    async elapsed => {
      const { queue, clock } = fixture();
      await poll(queue, { name: 'Alice' });
      for (clock.ms = 30_000; clock.ms < elapsed; clock.ms += 30_000)
        await poll(queue, { name: 'Alice' });
      clock.ms = elapsed;
      const expected = waitingFor(Math.floor(elapsed / 1_000));
      if (elapsed >= 180_000)
        expected.value.hint =
          'No opponent for 3 minutes. Tell your owner how long you have waited and ask whether to keep waiting (and for how long), play the house-bot instead (unrated), or stop.';
      expect(await poll(queue, { name: 'Alice' })).toEqual(expected);
    },
  );

  it.each(['Alice', 'Bob'])(
    'discards a legacy waiter with a queue key but no start time before %s queues',
    async name => {
      const storage: QueueStorage = new MemoryQueueStorage();
      const openMatch = vi.fn<OpenMatch>().mockResolvedValue(opened);
      const options = {
        storage,
        waitMs: WAIT_MS,
        holdMs: HOLD_MS,
        now: () => 1_000,
      };
      await poll(new MatchQueue(openMatch, options), { name: 'Alice' });
      const saved = await storage.get<{
        waiting: {
          key: string;
          input: QueueInput;
          pairingKey: string;
          expiresAt: number;
        }[];
        pairings: unknown[];
      }>('queue');
      expect(saved?.waiting).toHaveLength(1);
      // Keep exactly the pre-T30 fields, including the real pairing key and
      // queue_key; discard the new start time to simulate persisted old data.
      await storage.put('queue', {
        ...saved,
        waiting: saved?.waiting.map(
          ({ key, input, pairingKey, expiresAt }) => ({
            key,
            input,
            pairingKey,
            expiresAt,
          }),
        ),
      });
      const queue = new MatchQueue(openMatch, options);
      expect(
        await poll(queue, { name, queue_key: 'new-owner-key-123' }),
      ).toEqual(waiting);
      expect(openMatch).not.toHaveBeenCalled();
    },
  );
});

describe('MatchQueue queue_key ownership (A17)', () => {
  const ALICE_KEY = 'alice-private-key-1';
  const OTHER_KEY = 'other-private-key-2';
  const alice = { name: 'Alice', queue_key: ALICE_KEY };
  const impostor = { name: 'ALICE', queue_key: OTHER_KEY };
  const bob = { name: 'Bob', queue_key: 'bob-private-key-01' };

  it('does not give a removed long poll the match of another key with the same name', async () => {
    vi.useFakeTimers();
    try {
      const checks: { name: string; resolve: (banned: boolean) => void }[] = [];
      const openMatch = vi.fn<OpenMatch>().mockResolvedValue(opened);
      const queue = new MatchQueue(openMatch, {
        waitMs: WAIT_MS,
        isBanned: name =>
          new Promise<boolean>(resolve => checks.push({ name, resolve })),
      });
      const original = start(queue, alice);
      await vi.advanceTimersByTimeAsync(0);

      const carol = start(queue, {
        name: 'Carol',
        queue_key: 'carol-private-key-1',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(checks.map(check => check.name)).toEqual(['Alice']);
      checks[0]?.resolve(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(openMatch).not.toHaveBeenCalled();

      // This request passed the handler before the ban; only Carol is retained.
      const replacement = start(queue, impostor);
      await vi.advanceTimersByTimeAsync(0);
      expect(checks.map(check => check.name)).toEqual(['Alice', 'Carol']);
      checks[1]?.resolve(false);
      await vi.advanceTimersByTimeAsync(WAIT_MS);

      const replacementMatch = await replacement;
      expect(replacementMatch).toEqual(matched(1));
      expect(await carol).toEqual(matched(0));
      expect(openMatch).toHaveBeenCalledExactlyOnceWith(
        { name: 'Carol' },
        { name: 'ALICE' },
      );
      const originalAnswer = await original;
      expect.soft(originalAnswer).not.toEqual(replacementMatch);
      expect(JSON.stringify(originalAnswer)).not.toContain(ROOM);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards legacy storage without queue keys instead of failing or replaying old matches', async () => {
    const legacyRoom = 'r_legacy0001';
    const results = await Promise.all(
      [alice, { ...bob, queue_key: OTHER_KEY }].map(async input => {
        const storage: QueueStorage = new MemoryQueueStorage();
        await storage.put('queue', {
          waiting: [
            {
              key: 'alice',
              input: { name: 'Alice' },
              pairingKey: JSON.stringify({ settings: SETTINGS_DEFAULTS }),
              expiresAt: HOLD_MS,
            },
          ],
          pairings: [
            {
              keys: ['bob', 'dave'],
              at: 0,
              matched: [0, 1].map(seat => ({
                ...matched(seat as 0 | 1).value,
                room_id: legacyRoom,
                token: `legacy-token-${seat}`,
                hint: `Matched. First give watch_url to your owner so they can watch, then call GET /v1/rooms/${legacyRoom}/wait`,
              })),
            },
          ],
        });
        const options: MatchQueueOptions = {
          storage,
          waitMs: WAIT_MS,
          holdMs: HOLD_MS,
          now: () => 1_000,
        };
        const queue = new MatchQueue(
          vi.fn<OpenMatch>().mockResolvedValue(opened),
          options,
        );
        return queue.queue(input);
      }),
    );
    for (const result of results) {
      expect(result).toMatchObject({ ok: true });
      expect(
        result.ok && ['waiting', 'matched'].includes(result.value.status),
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain(legacyRoom);
      expect(JSON.stringify(result)).not.toContain('legacy-token-');
    }
  });

  const expectConflict = (answer: unknown) => {
    expect(answer).toMatchObject({
      ok: false,
      error: { status: 'error', code: 'name_in_use', retryable: false },
    });
    const serialized = JSON.stringify(answer);
    for (const field of [
      'room_id',
      'token',
      'watch_url',
      'seat',
      ALICE_KEY,
      OTHER_KEY,
    ])
      expect(serialized).not.toContain(field);
  };

  it('rejects another key during a long poll without disturbing the original caller', async () => {
    const { queue, openMatch } = fixture();
    const pending = start(queue, alice);
    const conflict = await queue.queue(impostor);
    const opponent = await queue.queue(bob);
    const original = await pending;
    expectConflict(conflict);
    expect(opponent).toEqual(matched(1));
    expect(original).toEqual(matched(0));
    expect(openMatch).toHaveBeenCalledExactlyOnceWith(
      { name: 'Alice' },
      { name: 'Bob' },
    );
  });

  it('retains waiting settings and test options when another key tries to replace them', async () => {
    const { queue, openMatch } = fixture();
    const options = {
      settings: { ...SETTINGS_DEFAULTS, max_hands: 3 },
      test: { seed: '00'.repeat(32) },
    };
    expect(await queue.queue({ ...alice, ...options })).toEqual(waiting);
    const conflict = await queue.queue({
      ...impostor,
      settings: { ...SETTINGS_DEFAULTS, max_hands: 10 },
      test: { seed: '01'.repeat(32) },
    });
    const opponent = await queue.queue({ ...bob, ...options });
    const original = await queue.queue(alice);
    expectConflict(conflict);
    expect(opponent).toEqual(matched(1));
    expect(original).toEqual(matched(0));
    expect(openMatch).toHaveBeenCalledExactlyOnceWith(
      { name: 'Alice', ...options },
      { name: 'Bob', ...options },
    );
  });

  it('same key renews waiting eligibility and replays the exact matched including watch_url', async () => {
    const { queue, clock, openMatch } = fixture();
    expect(await queue.queue(alice)).toEqual(waiting);
    clock.ms = HOLD_MS - 1;
    expect(await queue.queue({ ...alice, name: 'ALICE' })).toEqual(
      waitingFor(44),
    );
    clock.ms += HOLD_MS - 1;
    expect(await queue.queue(bob)).toEqual(matched(1));
    const first = await queue.queue(alice);
    expect(first).toEqual(matched(0));
    expect(await queue.queue({ ...alice, name: 'alice' })).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(ALICE_KEY);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it('rejects another key after matching and preserves the owner result', async () => {
    const { queue, clock, openMatch } = fixture();
    expect(await queue.queue(alice)).toEqual(waiting);
    expect(await queue.queue(bob)).toEqual(matched(1));
    clock.ms = HOLD_MS - 1;
    const conflict = await queue.queue(impostor);
    const original = await queue.queue(alice);
    expectConflict(conflict);
    expect(original).toEqual(matched(0));
    expect(openMatch).toHaveBeenCalledTimes(1);
  });

  it.each(['waiting', 'matched'] as const)(
    'a rejected key does not renew %s eligibility; a new key can queue after expiry',
    async status => {
      const { queue, clock, openMatch } = fixture();
      expect(await queue.queue(alice)).toEqual(waiting);
      if (status === 'matched')
        expect(await queue.queue(bob)).toEqual(matched(1));
      const openedBefore = openMatch.mock.calls.length;
      clock.ms = HOLD_MS - 1;
      const conflict = await queue.queue(impostor);
      clock.ms = HOLD_MS + 1;
      const renewed = await queue.queue(impostor);
      expectConflict(conflict);
      expect(renewed).toEqual(waiting);
      expect(openMatch).toHaveBeenCalledTimes(openedBefore);
      expect(
        await queue.queue({ name: 'Carol', queue_key: 'carol-private-key-1' }),
      ).toEqual(matched(1));
      expect(await queue.queue(impostor)).toEqual(matched(0));
      expect(openMatch.mock.calls.at(-1)).toEqual([
        { name: 'ALICE' },
        { name: 'Carol' },
      ]);
    },
  );

  it.each(['waiting', 'matched'] as const)(
    'restores %s ownership from storage and rejects another key',
    async status => {
      const { queue, recreate, clock, openMatch } = persistentFixture();
      expect(await queue.queue(alice)).toEqual(waiting);
      if (status === 'matched')
        expect(await queue.queue(bob)).toEqual(matched(1));
      clock.ms = HOLD_MS - 1;
      const restored = recreate();
      const conflict = await restored.queue(impostor);
      if (status === 'waiting')
        expect(await restored.queue(bob)).toEqual(matched(1));
      const original = await restored.queue(alice);
      expectConflict(conflict);
      expect(original).toEqual(matched(0));
      expect(openMatch).toHaveBeenCalledTimes(1);
    },
  );
});

describe('T35 persisted queue display names', () => {
  it.each([0, 1] as const)(
    'restores a pre-T35 matched answer for seat %s with default display names',
    async seat => {
      const { queue, storage, recreate, clock, openMatch } =
        persistentFixture();
      const players: [QueueInput, QueueInput] = [
        withKey({ name: 'alice' }),
        withKey({ name: 'bob' }),
      ];
      await queue.queue(players[0]);
      await queue.queue(players[1]);
      const saved = await storage.get<{
        pairings: { matched: (Seated & { tell_owner?: string })[] }[];
      }>('queue');
      expect(saved?.pairings).toHaveLength(1);
      await storage.put('queue', {
        ...saved,
        pairings: saved?.pairings.map(pairing => ({
          ...pairing,
          matched: pairing.matched.map(
            ({
              display_name: _displayName,
              opponent_display_name: _opponentDisplayName,
              tell_owner: _tellOwner,
              ...legacy
            }) => legacy,
          ),
        })),
      });
      clock.ms = HOLD_MS - 1;

      expect(await recreate().queue(players[seat])).toEqual(matched(seat));
      expect(openMatch).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the first display name through waiting retries and queue recreation, then returns the same matched answer', async () => {
    const { queue, openMatch, recreate } = persistentFixture();
    openMatch.mockResolvedValue({
      ok: true,
      value: [
        {
          ...seats[0],
          display_name: '小愛 🃏',
          opponent_display_name: '小包 🎲',
        },
        {
          ...seats[1],
          display_name: '小包 🎲',
          opponent_display_name: '小愛 🃏',
        },
      ],
    });
    const alice = withKey({
      name: 'alice',
      display_name: '小愛 🃏',
      settings: SETTINGS_DEFAULTS,
    });
    expect(await queue.queue(alice)).toMatchObject({
      ok: true,
      value: { status: 'waiting' },
    });
    const restored = recreate();
    expect(
      await restored.queue({ ...alice, display_name: '改名' }),
    ).toMatchObject({ ok: true, value: { status: 'waiting' } });
    const bob = await restored.queue(
      withKey({
        name: 'bob',
        display_name: '小包 🎲',
        settings: SETTINGS_DEFAULTS,
      }),
    );
    expect(openMatch).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alice', display_name: '小愛 🃏' }),
      expect.objectContaining({ name: 'bob', display_name: '小包 🎲' }),
    );
    expect(bob).toMatchObject({
      ok: true,
      value: { display_name: '小包 🎲', opponent_display_name: '小愛 🃏' },
    });
    const matched = await restored.queue({
      ...alice,
      display_name: '第三個名字',
    });
    expect(matched).toMatchObject({
      ok: true,
      value: { display_name: '小愛 🃏', opponent_display_name: '小包 🎲' },
    });
    expect(
      await recreate().queue({ ...alice, display_name: '第四個名字' }),
    ).toEqual(matched);
    expect(openMatch).toHaveBeenCalledTimes(1);
  });
});
