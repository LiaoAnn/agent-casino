import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchRecordInput, RecordedMatch } from '../db/records';
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
  seed: '0'.repeat(64),
  test: null,
};

const joinedRoom = async () => {
  const storage = new MemoryStorage();
  const recorded: RecordedMatch = {
    rated: true,
    ratings: [
      { name: 'alice', rating: 1484, change: -16 },
      { name: 'bob', rating: 1516, change: 16 },
    ],
  };
  const recordMatch = vi.fn(async (_input: MatchRecordInput) => recorded);
  const stub = { recordMatch };
  const id = { name: 'global' };
  const matchmaker = {
    idFromName: vi.fn((_name: string) => id),
    get: vi.fn((_id: unknown) => stub),
  };
  const room = new Room(
    { storage } as unknown as DurableObjectState,
    { MATCHMAKER: matchmaker } as unknown as Env,
  );
  expect(await room.create(INPUT)).toEqual({ ok: true, value: null });
  expect(
    await room.join({ name: 'bob', invite_code: INPUT.invite_code }),
  ).toEqual({
    ok: true,
    value: { seat: 1, opponent_name: 'alice', settings: INPUT.settings },
  });
  return { room, storage, matchmaker, id, recordMatch, recorded };
};

describe('Room Durable Object wrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a finished room through the global Matchmaker and returns its ratings', async () => {
    const { room, matchmaker, id, recordMatch, recorded } = await joinedRoom();
    expect(matchmaker.get).not.toHaveBeenCalled();
    const turn = await room.status(0, { wait: false });
    if (!turn.ok || turn.value.status !== 'your_turn') {
      throw new Error('Expected the first turn');
    }
    expect(
      await room.act(0, { turn_id: turn.value.turn_id, type: 'fold' }),
    ).toMatchObject({ ok: true, value: { status: 'accepted' } });
    expect(matchmaker.idFromName).toHaveBeenCalledWith('global');
    expect(matchmaker.get).toHaveBeenCalledWith(id);
    expect(recordMatch).toHaveBeenCalledTimes(1);
    expect(recordMatch.mock.calls[0][0]).toMatchObject({
      match_id: INPUT.room_id,
      players: ['alice', 'bob'],
    });
    for (const wait of [false, true]) {
      expect(await room.status(0, { wait })).toMatchObject({
        ok: true,
        value: { status: 'match_over', ratings: recorded.ratings },
      });
    }
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
