import { describe, expect, it, vi } from 'vitest';
import {
  type JoinCode,
  type LobbyEntry,
  type LobbyStorage,
  type QuickInput,
  RoomLobby,
  type Seating,
} from './lobby';

class MemoryStorage implements LobbyStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

const settings: QuickInput['settings'] = {
  starting_stack: 200,
  blind_every: null,
  max_hands: 100,
  turn_seconds: 30,
};

const input: QuickInput = { name: 'alice', settings, test: null };

function entry(room_id: string, patch: Partial<LobbyEntry> = {}): LobbyEntry {
  return {
    room_id,
    visibility: 'public',
    seats: [{ seat: 0, name: 'host', display_name: 'Host' }],
    seats_open: 5,
    settings,
    created_at: '2026-10-20T00:00:00.000Z',
    test: null,
    ...patch,
  };
}

function success(value: string) {
  return { ok: true as const, value };
}

function failure<C extends JoinCode>(code: C) {
  return {
    ok: false as const,
    error: {
      status: 'error' as const,
      code,
      message: `Cannot seat: ${code}`,
      hint: 'Try again later.',
      retryable: code === 'unavailable',
    },
  };
}

function fakeSeating(
  results: Record<string, Awaited<ReturnType<Seating<string>['join']>>> = {},
  opened: Awaited<ReturnType<Seating<string>['open']>> = success('opened'),
) {
  return {
    join: vi.fn(
      async (room_id: string) => results[room_id] ?? success(room_id),
    ),
    open: vi.fn(async () => opened),
  } satisfies Seating<string>;
}

async function add(lobby: RoomLobby, row: LobbyEntry, rev = 1) {
  await lobby.update({ room_id: row.room_id, rev, entry: row });
}

function listed(row: LobbyEntry) {
  const { test: _test, ...room } = row;
  return room;
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('RoomLobby updates and list', () => {
  it('returns an empty contract lobby before any update', async () => {
    expect(await new RoomLobby(new MemoryStorage()).list()).toEqual({
      rooms: [],
    });
  });

  it('accepts newer revisions and ignores equal or older revisions per room', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    const original = entry('r_original');
    const newer = entry('r_original', { seats_open: 3 });
    await add(lobby, original, 2);
    await add(lobby, newer, 4);
    await add(lobby, original, 4);
    await add(lobby, original, 3);
    const other = entry('r_other');
    await add(lobby, other, 1);
    expect(await lobby.list()).toEqual({
      rooms: expect.arrayContaining([listed(newer), listed(other)]),
    });
    expect((await lobby.list()).rooms).toHaveLength(2);
  });

  it('removes a room and rejects late equal or older notifications', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    const row = entry('r_removed');
    await add(lobby, row, 1);
    await lobby.update({ room_id: row.room_id, rev: 3, entry: null });
    await add(lobby, row, 2);
    await add(lobby, row, 3);
    expect(await lobby.list()).toEqual({ rooms: [] });
  });

  it('remembers removal even when the removal notification arrives first', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    await lobby.update({ room_id: 'r_removed', rev: 3, entry: null });
    await add(lobby, entry('r_removed'), 1);
    expect(await lobby.list()).toEqual({ rooms: [] });
  });

  it('ignores an old or equal removal of a newer listed room', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    const row = entry('r_current');
    await add(lobby, row, 3);
    await lobby.update({ room_id: row.room_id, rev: 2, entry: null });
    await lobby.update({ room_id: row.room_id, rev: 3, entry: null });
    expect(await lobby.list()).toEqual({ rooms: [listed(row)] });
  });

  it('lists public and private rooms oldest first without test settings', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    const newest = entry('r_newest', {
      created_at: '2026-10-20T00:02:00.000Z',
      test: { seed: 'newest' },
    });
    const oldest = entry('r_oldest', {
      visibility: 'private',
      test: { chaos: { extra_waiting: 1 } },
    });
    const middle = entry('r_middle', {
      created_at: '2026-10-20T00:01:00.000Z',
    });
    for (const row of [newest, oldest, middle]) await add(lobby, row);
    expect(await lobby.list()).toEqual({
      rooms: [listed(oldest), listed(middle), listed(newest)],
    });
  });
});

describe('RoomLobby quick candidates', () => {
  it('opens once and returns the open result when the lobby is empty', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    const seating = fakeSeating();
    expect(await lobby.quick(input, seating)).toEqual(success('opened'));
    expect(seating.join).not.toHaveBeenCalled();
    expect(seating.open).toHaveBeenCalledTimes(1);
  });

  it('joins the oldest matching room and stops after success', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    await add(
      lobby,
      entry('r_newer', { created_at: '2026-10-20T01:00:00.000Z' }),
    );
    await add(lobby, entry('r_oldest'));
    const seating = fakeSeating({ r_oldest: success('seat-and-token') });
    expect(await lobby.quick(input, seating)).toEqual(
      success('seat-and-token'),
    );
    expect(seating.join.mock.calls).toEqual([['r_oldest']]);
    expect(seating.open).not.toHaveBeenCalled();
  });

  const mismatches: [string, Partial<LobbyEntry>][] = [
    ['private visibility', { visibility: 'private' }],
    ['no open seats', { seats_open: 0 }],
    ['starting stack', { settings: { ...settings, starting_stack: 300 } }],
    [
      'blind_every null versus number',
      { settings: { ...settings, blind_every: 5 } },
    ],
    ['max hands', { settings: { ...settings, max_hands: 150 } }],
    ['turn seconds', { settings: { ...settings, turn_seconds: 60 } }],
    ['test null versus object', { test: {} }],
  ];

  it.each(mismatches)('skips a room with %s', async (_label, patch) => {
    const lobby = new RoomLobby(new MemoryStorage());
    await add(lobby, entry('r_ineligible', patch));
    const seating = fakeSeating();
    expect(await lobby.quick(input, seating)).toEqual(success('opened'));
    expect(seating.join).not.toHaveBeenCalled();
    expect(seating.open).toHaveBeenCalledTimes(1);
    expect((await lobby.list()).rooms.map(room => room.room_id)).toEqual([
      'r_ineligible',
    ]);
  });

  it('compares test objects by value regardless of key order, including nested keys', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    await add(
      lobby,
      entry('r_match', {
        test: {
          seed: 'same',
          chaos: { extra_waiting: 2, reject_first_action: true },
        },
      }),
    );
    const seating = fakeSeating();
    const request: QuickInput = {
      ...input,
      test: {
        chaos: { reject_first_action: true, extra_waiting: 2 },
        seed: 'same',
      },
    };
    expect(await lobby.quick(request, seating)).toEqual(success('r_match'));
    expect(seating.join.mock.calls).toEqual([['r_match']]);
    expect(seating.open).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['different seed', { seed: 'other', chaos: { extra_waiting: 2 } }],
    ['different chaos value', { seed: 'same', chaos: { extra_waiting: 3 } }],
    ['missing chaos', { seed: 'same' }],
  ] satisfies [string, QuickInput['test']][])(
    'skips %s test settings when the request has a test object',
    async (_label, test) => {
      const lobby = new RoomLobby(new MemoryStorage());
      await add(lobby, entry('r_different', { test }));
      const seating = fakeSeating();
      await lobby.quick(
        {
          ...input,
          test: { seed: 'same', chaos: { extra_waiting: 2 } },
        },
        seating,
      );
      expect(seating.join).not.toHaveBeenCalled();
      expect(seating.open).toHaveBeenCalledTimes(1);
    },
  );

  it('matches equal numeric blind settings and settings with reordered keys', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    await add(
      lobby,
      entry('r_match', { settings: { ...settings, blind_every: 5 } }),
    );
    const seating = fakeSeating();
    await lobby.quick(
      {
        ...input,
        settings: {
          turn_seconds: 30,
          max_hands: 100,
          blind_every: 5,
          starting_stack: 200,
        },
      },
      seating,
    );
    expect(seating.join.mock.calls).toEqual([['r_match']]);
    expect(seating.open).not.toHaveBeenCalled();
  });
});

describe('RoomLobby quick join outcomes', () => {
  it.each([
    'room_full',
    'match_over',
    'room_not_found',
    'wrong_invite_code',
  ] as const)(
    'removes a room after %s and tries the next oldest room',
    async code => {
      const lobby = new RoomLobby(new MemoryStorage());
      await add(
        lobby,
        entry('r_newest', { created_at: '2026-10-20T00:02:00.000Z' }),
      );
      await add(lobby, entry('r_oldest'));
      await add(
        lobby,
        entry('r_middle', { created_at: '2026-10-20T00:01:00.000Z' }),
      );
      const seating = fakeSeating({ r_oldest: failure(code) });
      expect(await lobby.quick(input, seating)).toEqual(success('r_middle'));
      expect(seating.join.mock.calls).toEqual([['r_oldest'], ['r_middle']]);
      expect((await lobby.list()).rooms.map(room => room.room_id)).toEqual([
        'r_middle',
        'r_newest',
      ]);
      seating.join.mockClear();
      await lobby.quick(input, seating);
      expect(seating.join.mock.calls).toEqual([['r_middle']]);
      expect(seating.open).not.toHaveBeenCalled();
    },
  );

  it('skips name_invalid without removing the room', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    const oldest = entry('r_oldest');
    const next = entry('r_next', { created_at: '2026-10-20T00:01:00.000Z' });
    await add(lobby, oldest);
    await add(lobby, next);
    const seating = fakeSeating({ r_oldest: failure('name_invalid') });
    expect(await lobby.quick(input, seating)).toEqual(success('r_next'));
    expect(seating.join.mock.calls).toEqual([['r_oldest'], ['r_next']]);
    expect(await lobby.list()).toEqual({
      rooms: [listed(oldest), listed(next)],
    });
    const otherPlayer = fakeSeating();
    await lobby.quick({ ...input, name: 'bob' }, otherPlayer);
    expect(otherPlayer.join.mock.calls).toEqual([['r_oldest']]);
    expect(seating.open).not.toHaveBeenCalled();
  });

  it('opens once after all candidates fail or are skipped', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    await add(lobby, entry('r_full'));
    await add(
      lobby,
      entry('r_same_name', { created_at: '2026-10-20T00:01:00.000Z' }),
    );
    const seating = fakeSeating({
      r_full: failure('room_full'),
      r_same_name: failure('name_invalid'),
    });
    expect(await lobby.quick(input, seating)).toEqual(success('opened'));
    expect(seating.join.mock.calls).toEqual([['r_full'], ['r_same_name']]);
    expect(seating.open).toHaveBeenCalledTimes(1);
    expect((await lobby.list()).rooms.map(room => room.room_id)).toEqual([
      'r_same_name',
    ]);
  });

  it('returns unavailable immediately without trying another room or opening', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    await add(lobby, entry('r_oldest'));
    await add(
      lobby,
      entry('r_next', { created_at: '2026-10-20T00:01:00.000Z' }),
    );
    const unavailable = failure('unavailable');
    const seating = fakeSeating({ r_oldest: unavailable });
    expect(await lobby.quick(input, seating)).toEqual(unavailable);
    expect(seating.join.mock.calls).toEqual([['r_oldest']]);
    expect(seating.open).not.toHaveBeenCalled();
  });

  it('returns the open unavailable result without retrying', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    const unavailable = failure('unavailable');
    const seating = fakeSeating({}, unavailable);
    expect(await lobby.quick(input, seating)).toEqual(unavailable);
    expect(seating.open).toHaveBeenCalledTimes(1);
    expect(seating.join).not.toHaveBeenCalled();
  });
});

describe('RoomLobby quick serialization', () => {
  it('waits for open and join to resolve: six concurrent callers share a table, the seventh opens another', async () => {
    const lobby = new RoomLobby(new MemoryStorage());
    expect(await lobby.list()).toEqual({ rooms: [] });
    const openStarted = deferred();
    const releaseOpen = deferred();
    const joinStarted = deferred();
    const releaseJoin = deferred();
    const calls: string[] = [];
    let occupied = 0;
    let opens = 0;
    const seating: Seating<string> = {
      open: async () => {
        opens += 1;
        const room_id = opens === 1 ? 'r_first' : 'r_second';
        calls.push(`open:${room_id}`);
        if (room_id === 'r_first') {
          occupied = 1;
          await add(lobby, entry(room_id), occupied);
          openStarted.resolve();
          await releaseOpen.promise;
        } else {
          await add(
            lobby,
            entry(room_id, { created_at: '2026-10-20T01:00:00.000Z' }),
          );
        }
        return success(room_id);
      },
      join: async room_id => {
        calls.push(`join:${room_id}`);
        occupied += 1;
        await add(
          lobby,
          entry(room_id, { seats_open: 6 - occupied }),
          occupied,
        );
        if (occupied === 2) {
          joinStarted.resolve();
          await releaseJoin.promise;
        }
        return success(room_id);
      },
    };

    const requests = Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        lobby.quick({ ...input, name: `player${index}` }, seating),
      ),
    );
    try {
      await openStarted.promise;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toEqual(['open:r_first']);
      releaseOpen.resolve();
      await joinStarted.promise;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toEqual(['open:r_first', 'join:r_first']);
      releaseJoin.resolve();
      expect(await requests).toEqual(
        Array.from({ length: 6 }, () => success('r_first')),
      );
      expect(calls).toEqual([
        'open:r_first',
        ...Array<string>(5).fill('join:r_first'),
      ]);
      expect((await lobby.list()).rooms[0]?.seats_open).toBe(0);
      expect(await lobby.quick({ ...input, name: 'seventh' }, seating)).toEqual(
        success('r_second'),
      );
      expect(calls).toEqual([
        'open:r_first',
        ...Array<string>(5).fill('join:r_first'),
        'open:r_second',
      ]);
    } finally {
      releaseOpen.resolve();
      releaseJoin.resolve();
      await Promise.allSettled([requests]);
    }
  });
});
