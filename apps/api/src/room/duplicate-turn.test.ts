import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CreateInput, RoomReferee, type RoomStorage } from './referee';

class MemoryStorage implements RoomStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async setAlarm(_time: number): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}

const INPUT: CreateInput = {
  room_id: 'r_duplicate1',
  invite_code: 'ABCDEF',
  name: 'alice',
  settings: {
    starting_stack: 40,
    blind_every: 50,
    max_hands: 4,
    turn_seconds: 5,
  },
  seed: '0'.repeat(64),
  test: null,
};
const turn = async (room: RoomReferee, seat: 0 | 1) => {
  const current = await room.status(seat, { wait: false });
  if (!current.ok || current.value.status !== 'your_turn')
    throw new Error('Expected your_turn');
  return current.value;
};

describe('T50 duplicate turn waiting semantics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const fixture = async (test: CreateInput['test'] = null) => {
    const room = new RoomReferee(new MemoryStorage(), {
      now: () => Date.now(),
      waitMs: 100,
    });
    expect(await room.create({ ...INPUT, test })).toMatchObject({ ok: true });
    expect(
      await room.join({ name: 'bob', invite_code: INPUT.invite_code }),
    ).toMatchObject({ ok: true });
    const first = await turn(room, 0);
    const action = { turn_id: first.turn_id, type: 'fold' as const };
    expect(await room.act(0, action)).toMatchObject({
      ok: true,
      value: { status: 'accepted' },
    });
    return { room, action };
  };

  it('immediately returns the newer own turn for a duplicate with wait', async () => {
    const { room, action } = await fixture();
    const bob = await turn(room, 1);
    await room.act(1, { turn_id: bob.turn_id, type: 'fold' });
    const current = await turn(room, 0);
    expect(current.turn_id).not.toBe(action.turn_id);
    const settled = vi.fn();
    const pending = room.act(0, action, { wait: true }).then(value => {
      settled(value);
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(await pending).toMatchObject({
      ok: true,
      value: { status: 'your_turn', turn_id: current.turn_id, duplicate: true },
    });
  });

  it('immediately returns the newer turn without consuming chaos fake waits', async () => {
    const { room, action } = await fixture({
      seed: INPUT.seed,
      chaos: { extra_waiting: 2 },
    });
    const bob = await turn(room, 1);
    expect(
      await room.act(1, { turn_id: bob.turn_id, type: 'fold' }),
    ).toMatchObject({ ok: true, value: { status: 'accepted' } });
    const current = await turn(room, 0);
    expect(current.turn_id).not.toBe(action.turn_id);

    const settled = vi.fn();
    const pending = room.act(0, action, { wait: true }).then(value => {
      settled(value);
      return value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(await pending).toMatchObject({
      ok: true,
      value: { status: 'your_turn', turn_id: current.turn_id, duplicate: true },
    });

    for (let i = 0; i < 2; i++) {
      expect(await room.status(0, { wait: true })).toMatchObject({
        ok: true,
        value: { status: 'waiting', to_act_seat: 0 },
      });
    }
    expect(await room.status(0, { wait: true })).toEqual({
      ok: true,
      value: current,
    });
  });

  it('waits while the opponent acts, then returns the next turn without duplicate', async () => {
    const { room, action } = await fixture();
    const settled = vi.fn();
    const pending = room.act(0, action, { wait: true }).then(value => {
      settled(value);
      return value;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).not.toHaveBeenCalled();
    const bob = await turn(room, 1);
    expect(
      await room.act(1, { turn_id: bob.turn_id, type: 'fold' }),
    ).toMatchObject({
      ok: true,
      value: { status: 'accepted' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledTimes(1);
    const result = await pending;
    expect(result).toEqual(await room.status(0, { wait: true }));
    expect(result).toMatchObject({
      ok: true,
      value: { status: 'your_turn', hand_number: 3 },
    });
    if (!result.ok) throw new Error('Expected your_turn');
    expect(result.value).not.toHaveProperty('duplicate');
    expect(await turn(room, 0)).toMatchObject({ hand_number: 3 });
  });
});
