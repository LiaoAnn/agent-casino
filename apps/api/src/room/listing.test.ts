// T39 S2: casino-api A2/A25 lobby rows, A1 bot rooms, waiting-seat expiry.
import { describe, expect, it, vi } from 'vitest';
import type { LobbyEntry, LobbyUpdate } from '../matchmaker/lobby';
import { RoomReferee, type RoomStorage } from './referee';

const ID = 'r_listing001';
const CREATED = Date.parse('2026-10-20T00:00:00Z');
const SETTINGS = {
  starting_stack: 40,
  blind_every: null as number | null,
  max_hands: 50,
  turn_seconds: 30,
};
const HOST = { seat: 0, name: 'alice', display_name: 'Alice Shark' } as const;
const BOB = { seat: 1, name: 'bob', display_name: 'BOB' } as const;
const CAROL = { seat: 2, name: 'carol', display_name: 'CAROL' } as const;

class MemoryStorage implements RoomStorage {
  private readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async setAlarm(_time: number): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}

function value<T>(result: { ok: true; value: T } | { ok: false }): T {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('Expected successful public call');
  return result.value;
}

function fixture() {
  const storage = new MemoryStorage();
  const clock = { ms: CREATED };
  const updates: LobbyUpdate[] = [];
  const listRoom = vi.fn(async (update: LobbyUpdate) => {
    updates.push(structuredClone(update));
  });
  const options = {
    listRoom,
    now: () => clock.ms,
    waitMs: 1,
    random: () => 0.6,
  };
  const room = new RoomReferee(storage, options);
  const input = {
    room_id: ID,
    invite_code: 'ABC234',
    name: HOST.name,
    display_name: HOST.display_name,
    visibility: 'public' as 'public' | 'private' | null,
    settings: SETTINGS,
    seed: '0'.repeat(64),
    test: null as LobbyEntry['test'],
  };
  const join = (name: string) =>
    room.join({
      name,
      display_name: name.toUpperCase(),
      invite_code: 'ABC234',
    });
  const state = (name = 'alice', wait = false) => room.status(name, { wait });
  const row = (overrides: Partial<LobbyEntry> = {}): LobbyEntry => ({
    room_id: ID,
    visibility: 'public',
    seats: [HOST],
    seats_open: 5,
    settings: SETTINGS,
    created_at: new Date(CREATED).toISOString(),
    test: null,
    ...overrides,
  });
  const update = (rev: number, entry: LobbyEntry | null): LobbyUpdate => ({
    room_id: ID,
    rev,
    entry,
  });
  return {
    storage,
    clock,
    updates,
    listRoom,
    options,
    room,
    input,
    join,
    state,
    row,
    update,
  };
}

describe('T39 RoomReferee lobby listing', () => {
  it.each(['public', 'private'] as const)(
    'lists a new %s multiplayer room once, with its settings and test configuration',
    async visibility => {
      const f = fixture();
      const settings = { ...SETTINGS, starting_stack: 80, blind_every: 7 };
      const test = { seed: '1'.repeat(64), chaos: { extra_waiting: 1 } };
      value(await f.room.create({ ...f.input, visibility, settings, test }));
      expect(f.updates).toEqual([
        f.update(1, f.row({ visibility, settings, test })),
      ]);
      expect(f.listRoom).toHaveBeenCalledTimes(1);
    },
  );

  it('lists a join with the next rev, the new seat, and one fewer opening', async () => {
    const f = fixture();
    value(await f.room.create(f.input));
    f.clock.ms += 1_000;
    value(await f.join('bob'));
    expect(f.updates).toEqual([
      f.update(1, f.row()),
      f.update(2, f.row({ seats: [HOST, BOB], seats_open: 4 })),
    ]);
  });

  it('state and wait refresh presence without notifying the lobby', async () => {
    const f = fixture();
    value(await f.room.create(f.input));
    const before = f.listRoom.mock.calls.length;
    f.clock.ms += 30_000;
    value(await f.state('alice', false));
    f.clock.ms += 30_000;
    value(await f.state('alice', true));
    expect(f.listRoom).toHaveBeenCalledTimes(before);
  });

  it('compacts seats and lists the new row when a guest leaves before start', async () => {
    const f = fixture();
    value(await f.room.create(f.input));
    value(await f.join('bob'));
    value(await f.join('carol'));
    value(await f.room.leave('bob'));
    expect(f.updates).toEqual([
      f.update(1, f.row()),
      f.update(2, f.row({ seats: [HOST, BOB], seats_open: 4 })),
      f.update(3, f.row({ seats: [HOST, BOB, CAROL], seats_open: 3 })),
      f.update(
        4,
        f.row({ seats: [HOST, { ...CAROL, seat: 1 }], seats_open: 4 }),
      ),
    ]);
  });

  it('removes the listing when the host leaves before start', async () => {
    const f = fixture();
    value(await f.room.create(f.input));
    value(await f.join('bob'));
    value(await f.room.leave('alice'));
    expect(f.updates).toEqual([
      f.update(1, f.row()),
      f.update(2, f.row({ seats: [HOST, BOB], seats_open: 4 })),
      f.update(3, null),
    ]);
  });

  it('removes the listing on start and sends no more notifications while playing or finishing', async () => {
    const f = fixture();
    value(await f.room.create(f.input));
    value(await f.join('bob'));
    value(await f.room.start('alice', {}));
    const before = f.listRoom.mock.calls.length;
    const turns = await Promise.all(
      ['alice', 'bob'].map(name => f.state(name)),
    );
    const actor = turns.findIndex(
      result => value(result).status === 'your_turn',
    );
    expect(actor).toBeGreaterThanOrEqual(0);
    const turn = value(turns[actor]);
    if (turn.status !== 'your_turn')
      throw new Error('Expected a playable turn');
    value(
      await f.room.act(['alice', 'bob'][actor], {
        turn_id: turn.turn_id,
        type: 'fold',
      }),
    );
    await f.room.alarm();
    value(await f.room.leave('bob'));
    value(await f.state());
    expect(f.listRoom).toHaveBeenCalledTimes(before);
    expect(f.updates).toEqual([
      f.update(1, f.row()),
      f.update(2, f.row({ seats: [HOST, BOB], seats_open: 4 })),
      f.update(3, null),
    ]);
  });

  it.each(['alarm', 'request'] as const)(
    '%s removes an idle guest at two minutes and lists the compacted seats',
    async trigger => {
      const f = fixture();
      value(await f.room.create(f.input));
      value(await f.join('bob'));
      value(await f.join('carol'));
      f.clock.ms += 119_999;
      value(await f.state('alice'));
      value(await f.state('carol'));
      await f.room.alarm();
      expect(f.listRoom).toHaveBeenCalledTimes(3);
      f.clock.ms += 1;
      if (trigger === 'alarm') await f.room.alarm();
      else value(await f.state('alice'));
      expect(f.updates.at(-1)).toEqual(
        f.update(
          4,
          f.row({ seats: [HOST, { ...CAROL, seat: 1 }], seats_open: 4 }),
        ),
      );
      expect(f.listRoom).toHaveBeenCalledTimes(4);
      expect(
        value(await f.state('carol')).seats.map(seat => seat.name),
      ).toEqual(['alice', 'carol']);
    },
  );

  it.each(['alarm', 'request'] as const)(
    '%s removes the listing when the host is idle for two minutes',
    async trigger => {
      const f = fixture();
      value(await f.room.create(f.input));
      value(await f.join('bob'));
      f.clock.ms += 119_999;
      value(await f.state('bob'));
      await f.room.alarm();
      expect(f.listRoom).toHaveBeenCalledTimes(2);
      f.clock.ms += 1;
      if (trigger === 'alarm') await f.room.alarm();
      else value(await f.state('bob'));
      expect(f.updates.at(-1)).toEqual(f.update(3, null));
      expect(f.listRoom).toHaveBeenCalledTimes(3);
      expect(value(await f.state('bob'))).toMatchObject({
        status: 'match_over',
        result: 'cancelled',
      });
    },
  );

  it('never lists an opponent bot room, including its play and finish', async () => {
    const f = fixture();
    value(await f.room.create({ ...f.input, opponent: 'bot' }));
    const turn = value(await f.state());
    expect(turn.room_status).toBe('playing');
    if (turn.status !== 'your_turn')
      throw new Error('Expected human bot-room turn');
    value(await f.room.act('alice', { turn_id: turn.turn_id, type: 'fold' }));
    await f.room.alarm();
    value(await f.room.leave('alice'));
    value(await f.state());
    expect(f.listRoom).not.toHaveBeenCalled();
  });

  it('lists legacy heads-up as private with one opening, then removes it on the second join', async () => {
    const f = fixture();
    value(await f.room.create({ ...f.input, visibility: null }));
    value(await f.join('bob'));
    expect(value(await f.state()).room_status).toBe('playing');
    expect(f.updates).toEqual([
      f.update(1, f.row({ visibility: 'private', seats_open: 1 })),
      f.update(2, null),
    ]);
  });

  it('persists successive revisions across referee eviction and reconstruction', async () => {
    const f = fixture();
    value(await f.room.create(f.input));
    value(await f.join('bob'));
    value(await f.room.leave('bob'));
    const restored = new RoomReferee(f.storage, f.options);
    value(await restored.join({ name: 'carol', display_name: 'CAROL' }));
    value(await restored.start('alice', {}));
    expect(f.updates.map(update => update.rev)).toEqual([1, 2, 3, 4, 5]);
    expect(f.updates[3]).toEqual(
      f.update(
        4,
        f.row({ seats: [HOST, { ...CAROL, seat: 1 }], seats_open: 4 }),
      ),
    );
    expect(f.updates[4]).toEqual(f.update(5, null));
  });

  it('keeps create and join successful when listing rejects, and sends the next change again', async () => {
    const f = fixture();
    f.listRoom.mockRejectedValue(new Error('Lobby unavailable'));
    value(await f.room.create(f.input));
    value(await f.join('bob'));
    expect(value(await f.state())).toMatchObject({
      room_status: 'waiting',
      seats_open: 4,
      seats: [HOST, BOB],
    });
    expect(f.listRoom).toHaveBeenCalledTimes(2);
    f.listRoom.mockImplementation(async update => {
      f.updates.push(structuredClone(update));
    });
    value(await f.join('carol'));
    expect(f.updates).toEqual([
      f.update(3, f.row({ seats: [HOST, BOB, CAROL], seats_open: 3 })),
    ]);
  });

  it('still creates, joins, and starts without a listing callback', async () => {
    const f = fixture();
    const room = new RoomReferee(new MemoryStorage(), {
      now: f.options.now,
      waitMs: 1,
    });
    value(await room.create(f.input));
    value(await room.join({ name: 'bob', display_name: 'BOB' }));
    value(await room.start('alice', {}));
    expect(value(await room.status('bob', { wait: false })).room_status).toBe(
      'playing',
    );
  });
});
