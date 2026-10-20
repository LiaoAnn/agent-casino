import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordedMatch, TableRecordInput } from './referee';
import { RoomReferee, type RoomStorage } from './referee';

const SECOND = 1_000;
const HOUR = 60 * 60 * SECOND;
const MAX_ALARMS = 10_000;
const RECORDED: RecordedMatch = {
  rated: true,
  ratings: [
    { name: 'Alice', rating: 1484, change: -16 },
    { name: 'Bob', rating: 1516, change: 16 },
  ],
};

class MemoryStorage implements RoomStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

async function fixture(
  record: (input: TableRecordInput) => Promise<RecordedMatch>,
) {
  const storage = new MemoryStorage();
  const clock = { ms: Date.parse('2026-10-18T00:00:00.000Z') };
  const spy = vi.fn(record);
  const referee = new RoomReferee(storage, {
    now: () => clock.ms,
    waitMs: 1,
    record: spy,
  });
  expect(
    await referee.create({
      room_id: 'r_retry00001',
      invite_code: 'ABC234',
      name: 'Alice',
      settings: {
        max_hands: 2,
        turn_seconds: 10,
        blind_every: 50,
        starting_stack: 40,
      },
      seed: '0'.repeat(64),
      test: null,
      visibility: null,
    }),
  ).toEqual({
    ok: true,
    value: createdSeat({
      room_id: 'r_retry00001',
      invite_code: 'ABC234',
      name: 'Alice',
      settings: {
        max_hands: 2,
        turn_seconds: 10,
        blind_every: 50,
        starting_stack: 40,
      },
    }),
  });
  expect(
    await referee.join({ name: 'Bob', invite_code: 'ABC234' }),
  ).toMatchObject({ ok: true });
  // Finish at a distinct time so retry age must be measured from match end.
  clock.ms += 1_234;
  const endedAt = clock.ms;
  expect(await referee.leave('Alice')).toMatchObject({
    ok: false,
    error: { code: 'unavailable', retryable: true },
  });
  expect(spy).toHaveBeenCalledTimes(1);
  return { storage, clock, spy, referee, endedAt };
}

async function runAlarms(t: Awaited<ReturnType<typeof fixture>>) {
  const times: number[] = [];
  while (t.storage.alarm !== null && times.length < MAX_ALARMS) {
    t.clock.ms = t.storage.alarm;
    times.push(t.clock.ms);
    await t.referee.alarm();
  }
  return times;
}

describe('T22 S1: bounded match-record retries', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('backs off failed writes to at most hourly and stops after 24 hours', async () => {
    const t = await fixture(async () => {
      throw new Error('D1 unavailable');
    });
    const times = await runAlarms(t);

    expect
      .soft(times.length, 'retry loop must stop before its safety cap')
      .toBeLessThan(MAX_ALARMS);
    expect.soft(t.storage.alarm).toBeNull();
    expect.soft(times.length).toBeLessThanOrEqual(40);
    expect.soft(t.spy.mock.calls.length).toBeLessThanOrEqual(41);
    expect(times.length).toBeGreaterThan(0);
    expect(times[0] - t.endedAt).toBe(10 * SECOND);
    expect.soft(times.at(-1)).toBeGreaterThanOrEqual(t.endedAt + 24 * HOUR);
    expect.soft(times.at(-1)).toBeLessThanOrEqual(t.endedAt + 25 * HOUR);

    let previousTime = t.endedAt;
    let previousInterval = 0;
    for (const time of times) {
      const interval = time - previousTime;
      expect(interval).toBeGreaterThanOrEqual(previousInterval);
      expect(interval).toBeLessThanOrEqual(HOUR);
      expect(interval).toBe(
        Math.min(HOUR, Math.max(10 * SECOND, previousTime - t.endedAt)),
      );
      previousTime = time;
      previousInterval = interval;
    }
  });

  it('clears the alarm and returns recorded ratings when a retry succeeds', async () => {
    let attempts = 0;
    const t = await fixture(async () => {
      if (++attempts <= 3) throw new Error('D1 temporarily unavailable');
      return RECORDED;
    });
    const times = await runAlarms(t);

    expect(times).toHaveLength(3);
    expect(t.spy).toHaveBeenCalledTimes(4);
    expect(t.storage.alarm).toBeNull();
    expect(await t.referee.status('Alice', { wait: false })).toMatchObject({
      ok: true,
      value: { status: 'match_over', ratings: RECORDED.ratings },
    });
    expect(t.spy).toHaveBeenCalledTimes(4);
    expect(t.storage.alarm).toBeNull();
  });

  it('does not schedule another alarm if alarm runs again after giving up', async () => {
    const t = await fixture(async () => {
      throw new Error('D1 unavailable');
    });
    await runAlarms(t);
    expect(
      t.storage.alarm,
      'must reach abandonment before testing a repeated alarm',
    ).toBeNull();

    await t.referee.alarm();

    expect(t.storage.alarm).toBeNull();
  });
});

// Transitional heads-up seat answer (A25); keep exact create assertions.
const createdSeat = (input: {
  room_id: string;
  invite_code: string;
  name: string;
  settings: {
    starting_stack: number;
    max_hands: number;
    turn_seconds: number;
    blind_every: number | null;
  };
  opponent?: 'bot';
}) => {
  const bot = input.opponent === 'bot';
  return {
    room_id: input.room_id,
    visibility: 'private',
    invite_code: input.invite_code,
    seat: 0,
    is_host: true,
    display_name: input.name,
    opponent_name: bot ? 'house-bot' : null,
    opponent_display_name: bot ? 'House Bot' : null,
    seats: [
      {
        seat: 0,
        name: input.name,
        display_name: input.name,
        stack: input.settings.starting_stack - (bot ? 1 : 0),
        bet_this_street: bot ? 1 : 0,
        status: bot ? 'playing' : 'waiting',
        place: null,
      },
      ...(bot
        ? [
            {
              seat: 1,
              name: 'house-bot',
              display_name: 'House Bot',
              stack: input.settings.starting_stack - 2,
              bet_this_street: 2,
              status: 'playing',
              place: null,
            },
          ]
        : []),
    ],
    seats_open: bot ? 0 : 1,
    settings: input.settings,
  };
};
