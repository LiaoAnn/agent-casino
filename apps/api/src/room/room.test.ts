import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateInput, RoomStorage } from './referee';
import { Room } from './room';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: Env,
    ) {}
  },
}));

class MemoryStorage implements RoomStorage {
  readonly #data = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#data.set(key, structuredClone(value));
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

const INPUT: CreateInput = {
  room_id: 'r_abcde12345',
  invite_code: 'ABCDEF',
  name: 'alice',
  settings: { hands: 1, turn_seconds: 5, starting_stack: 40 },
  seed: 12345,
  test: null,
};

const joinedRoom = async () => {
  const storage = new MemoryStorage();
  const room = new Room(
    { storage } as unknown as DurableObjectState,
    {} as Env,
  );
  expect(await room.create(INPUT)).toEqual({ ok: true, value: null });
  expect(
    await room.join({ name: 'bob', invite_code: INPUT.invite_code }),
  ).toEqual({
    ok: true,
    value: { seat: 1 },
  });
  return { room, storage };
};

describe('Room Durable Object wrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('create and join schedule the first deadline; alarm persists the timeout before any status or act call', async () => {
    const joinedAt = Date.now();
    const { room, storage } = await joinedRoom();
    expect(storage.alarm).toBe(joinedAt + 5_000);
    const before = await storage.get('room');

    vi.setSystemTime(joinedAt + 5_001);
    await room.alarm();

    // Inspect persistence first: status() can itself catch up expired turns.
    expect(await storage.get('room')).not.toEqual(before);
    expect(storage.alarm).toBeNull();
    const status = await room.status(0, { wait: false });
    expect(status).toMatchObject({
      ok: true,
      value: {
        status: 'match_over',
        room_status: 'finished',
        result: 'loss',
        last_hand: { ended_by: 'fold', winner_seat: 1 },
      },
    });
  });

  it('abort through Room voids the room and deletes the alarm', async () => {
    const { room, storage } = await joinedRoom();
    expect(await room.abort()).toEqual({ ok: true, value: null });
    expect(storage.alarm).toBeNull();
    for (const seat of [0, 1] as const) {
      expect(await room.status(seat, { wait: false })).toMatchObject({
        ok: true,
        value: { status: 'match_over', room_status: 'void', result: 'void' },
      });
    }
  });
});
