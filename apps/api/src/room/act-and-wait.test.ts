import { Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomStatus } from '../contract/schemas';
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
  room_id: 'r_actwait001',
  invite_code: 'ABCDEF',
  name: 'alice',
  settings: {
    starting_stack: 40,
    blind_every: 50,
    max_hands: 3,
    turn_seconds: 5,
  },
  seed: '0'.repeat(64),
  test: null,
  visibility: null,
};
const WAIT_MS = 100;
const fixture = async (input: Partial<CreateInput> = {}) => {
  const room = new RoomReferee(new MemoryStorage(), {
    now: () => Date.now(),
    waitMs: WAIT_MS,
    webUrl: 'https://web.test',
  });
  expect(await room.create({ ...INPUT, ...input })).toMatchObject({ ok: true });
  expect(
    await room.join({ name: 'bob', invite_code: INPUT.invite_code }),
  ).toMatchObject({ ok: true });
  return room;
};
const turn = async (room: RoomReferee, seat: 0 | 1) => {
  const result = await room.status(['alice', 'bob'][seat], { wait: false });
  if (!result.ok || result.value.status !== 'your_turn')
    throw new Error('Expected your_turn');
  return result.value;
};
const fold = async (room: RoomReferee, seat: 0 | 1) => {
  const current = await turn(room, seat);
  return room.act(['alice', 'bob'][seat], {
    turn_id: current.turn_id,
    type: 'fold',
  });
};
const observe = <T>(promise: Promise<T>) => {
  const settled = vi.fn();
  const result = promise.then(value => {
    settled(value);
    return value;
  });
  return { result, settled };
};

describe('T47 RoomReferee act with wait', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('waits for this seat, including a duplicate while pending, and returns the same full your_turn as GET wait', async () => {
    const room = await fixture();
    const first = await turn(room, 0);
    const action = { turn_id: first.turn_id, type: 'fold' as const };
    const pending = observe(room.act('alice', action, { wait: true }));
    await vi.advanceTimersByTimeAsync(0);
    // A different payload for an already accepted turn must not be executed.
    const duplicate = observe(
      room.act(
        'alice',
        { ...action, type: 'raise', amount: 999 },
        { wait: true },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(pending.settled).not.toHaveBeenCalled();
    expect.soft(duplicate.settled).not.toHaveBeenCalled();
    expect(await turn(room, 1)).toMatchObject({ hand_number: 2 });
    await fold(room, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.settled).toHaveBeenCalledTimes(1);
    expect(duplicate.settled).toHaveBeenCalledTimes(1);
    const expected = await room.status('alice', { wait: true });
    expect(await pending.result).toEqual(expected);
    expect(await duplicate.result).toEqual(expected);
    if (!expected.ok) throw new Error('Expected status');
    Schema.decodeUnknownSync(RoomStatus)(expected.value);
    expect(expected.value).toMatchObject({
      status: 'your_turn',
      hand_number: 3,
      hands_since_your_turn: [
        expect.objectContaining({ hand_number: 1 }),
        expect.objectContaining({ hand_number: 2 }),
      ],
    });
    expect(expected.value.hint).toContain(
      `POST /v1/rooms/${INPUT.room_id}/actions?wait=1`,
    );
    expect(expected.value.hint).toMatch(/note/i);
    expect(expected.value.hint).toMatch(/language/i);
    expect(expected.value.hint).not.toMatch(/watch link/i);
  });

  it('waits until the opponent ends the match and preserves tell_owner and completed hands', async () => {
    const room = await fixture({
      settings: { ...INPUT.settings, max_hands: 2 },
    });
    const first = await turn(room, 0);
    const pending = observe(
      room.act(
        'alice',
        { turn_id: first.turn_id, type: 'fold' },
        { wait: true },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(pending.settled).not.toHaveBeenCalled();
    await fold(room, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.settled).toHaveBeenCalledTimes(1);
    const expected = await room.status('alice', { wait: true });
    expect(await pending.result).toEqual(expected);
    expect(expected).toMatchObject({
      ok: true,
      value: {
        status: 'match_over',
        tell_owner: expect.any(String),
        hands_since_your_turn: [
          expect.objectContaining({ hand_number: 1 }),
          expect.objectContaining({ hand_number: 2 }),
        ],
      },
    });
  });

  it('returns match_over when the accepted action itself finishes the match', async () => {
    const room = await fixture({
      settings: { ...INPUT.settings, max_hands: 1 },
    });
    const first = await turn(room, 0);
    const response = await room.act(
      'alice',
      { turn_id: first.turn_id, type: 'fold' },
      { wait: true },
    );
    expect(response).toEqual(await room.status('alice', { wait: true }));
    expect(response).toMatchObject({
      ok: true,
      value: { status: 'match_over' },
    });
  });

  it('uses waitMs and returns the same waiting response as GET wait at its timeout', async () => {
    const room = await fixture();
    const first = await turn(room, 0);
    const pending = observe(
      room.act(
        'alice',
        { turn_id: first.turn_id, type: 'call' },
        { wait: true },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    const getWait = observe(room.status('alice', { wait: true }));
    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect.soft(pending.settled).not.toHaveBeenCalled();
    expect(getWait.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.settled).toHaveBeenCalledTimes(1);
    expect(getWait.settled).toHaveBeenCalledTimes(1);
    expect(await pending.result).toEqual(await getWait.result);
    expect(await pending.result).toMatchObject({
      ok: true,
      value: { status: 'waiting', to_act_seat: 1 },
    });
  });

  it.each([
    'invalid_action',
    'not_your_turn',
    'stale_turn',
    'match_over',
  ] as const)('returns %s without starting a wait', async code => {
    const room = await fixture();
    const first = await turn(room, 0);
    if (code === 'match_over') await room.leave('bob');
    const pending = observe(
      room.act(
        code === 'not_your_turn' ? 'bob' : 'alice',
        {
          turn_id: code === 'stale_turn' ? 't_999' : first.turn_id,
          type: code === 'invalid_action' ? 'check' : 'fold',
        },
        { wait: true },
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.settled).toHaveBeenCalledTimes(1);
    expect(await pending.result).toMatchObject({
      ok: false,
      error: {
        code,
        ...(code === 'invalid_action' ? {} : { state: expect.any(Object) }),
      },
    });
    if (code === 'invalid_action')
      expect(await fold(room, 0)).toMatchObject({
        ok: true,
        value: { status: 'accepted' },
      });
  });

  it.each([undefined, { wait: false }])(
    'preserves accepted and duplicate without wait: %j',
    async options => {
      const room = await fixture();
      const first = await turn(room, 0);
      const action = { turn_id: first.turn_id, type: 'call' as const };
      const accepted = await room.act('alice', action, options);
      expect(accepted).toMatchObject({
        ok: true,
        value: { status: 'accepted' },
      });
      if (!accepted.ok) throw new Error('Expected accepted');
      expect(await room.act('alice', action, options)).toEqual({
        ok: true,
        value: { ...accepted.value, duplicate: true },
      });
    },
  );

  it('counts actions plus its wait as one chaos request', async () => {
    const room = await fixture({ test: { chaos: { fail_request_every: 3 } } });
    const first = await turn(room, 0); // seat 0 request 1
    const pending = room.act(
      'alice',
      { turn_id: first.turn_id, type: 'fold' },
      { wait: true },
    ); // request 2
    await vi.advanceTimersByTimeAsync(0);
    await fold(room, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({
      ok: true,
      value: { status: 'your_turn' },
    });
    expect(await room.status('alice', { wait: false })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    }); // request 3
    expect(await room.status('alice', { wait: false })).toMatchObject({
      ok: true,
      value: { status: 'your_turn', hand_number: 3 },
    });
  });

  it('applies extra_waiting to the wait portion and leaves the next turn available', async () => {
    const room = await fixture({ test: { chaos: { extra_waiting: 1 } } });
    const first = await turn(room, 0);
    const pending = room.act(
      'alice',
      { turn_id: first.turn_id, type: 'fold' },
      { wait: true },
    );
    await vi.advanceTimersByTimeAsync(0);
    await fold(room, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({
      ok: true,
      value: { status: 'waiting', to_act_seat: 0 },
    });
    expect(await room.status('alice', { wait: true })).toMatchObject({
      ok: true,
      value: { status: 'your_turn', hand_number: 3 },
    });
  });
});
