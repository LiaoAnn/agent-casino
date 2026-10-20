// T38 S3: casino-api A1/A6/A9/A11/A16/A18/A25; holdem-rules 離開/名次.
// Only public referee calls; the table engine supplies deterministic oracles.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomStatus, TestSettings } from '../contract/schemas';
import {
  type Action,
  applyTableAction,
  leaveTable,
  startTable,
  type TableHandRecord,
  type TableState,
  tableLegalActions,
} from '../holdem/table';
import {
  RoomReferee,
  type RoomStorage,
  type TableRecordInput,
} from './referee';

const ID = 'r_multi00001';
const SEED = '0'.repeat(64);
const NAMES = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank'];
const SETTINGS = {
  starting_stack: 40,
  blind_every: null as number | null,
  max_hands: 50,
  turn_seconds: 30,
};

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

function fixture(
  options: {
    settings?: Partial<typeof SETTINGS>;
    test?: typeof TestSettings.Type;
    waitMs?: number;
    seed?: string;
  } = {},
) {
  const clock = { ms: Date.parse('2026-10-20T00:00:00Z') };
  const records: TableRecordInput[] = [];
  const settings = { ...SETTINGS, ...options.settings };
  const room = new RoomReferee(new MemoryStorage(), {
    now: () => clock.ms,
    waitMs: options.waitMs ?? 1,
    random: () => 0.6, // Existing bot tests pin this stream to check/call.
    record: async (input: TableRecordInput) => {
      records.push(structuredClone(input));
      return { rated: false, ratings: null };
    },
  });
  const open = (
    visibility: 'public' | 'private' = 'public',
    opponent?: 'bot',
  ) =>
    room.create({
      room_id: ID,
      invite_code: 'ABC234',
      name: 'alice',
      display_name: 'Alice Shark',
      visibility,
      settings,
      seed: options.seed ?? SEED,
      test: options.test ?? null,
      ...(opponent ? { opponent } : {}),
    });
  const join = (name: string, invite_code?: string) =>
    room.join({
      name,
      display_name: name.toUpperCase(),
      ...(invite_code ? { invite_code } : {}),
    });
  const sit = async (count: number) => {
    value(await open());
    for (const name of NAMES.slice(1, count)) value(await join(name));
  };
  const state = async (name = 'alice') =>
    value(await room.status(name, { wait: false }));
  return { room, clock, records, settings, open, join, sit, state };
}

afterEach(() => vi.useRealTimers());

describe('T38 visibility and waiting seats', () => {
  it.each(['public', 'private'] as const)(
    'opens %s; only a private host gets the invite code',
    async visibility => {
      const f = fixture();
      expect(value(await f.open(visibility))).toMatchObject({
        visibility,
        invite_code: visibility === 'private' ? 'ABC234' : null,
        seat: 0,
        is_host: true,
        seats_open: 5,
        settings: { blind_every: null },
        opponent_name: null,
        opponent_display_name: null,
        seats: [
          {
            seat: 0,
            name: 'alice',
            display_name: 'Alice Shark',
            stack: 40,
            bet_this_street: 0,
            status: 'waiting',
            place: null,
          },
        ],
      });
      const joined = value(
        await f.join('bob', visibility === 'private' ? 'ABC234' : undefined),
      );
      expect(joined).toMatchObject({
        seat: 1,
        is_host: false,
        invite_code: null,
        seats_open: 4,
        opponent_name: 'alice',
        opponent_display_name: 'Alice Shark',
      });
      expect(await f.state()).toMatchObject({
        room_status: 'waiting',
        opponent_name: 'bob',
        opponent_display_name: 'BOB',
      });
    },
  );

  it('private join requires a matching code; public join ignores a supplied code', async () => {
    const privateRoom = fixture();
    value(await privateRoom.open('private'));
    for (const code of [undefined, 'WRONG']) {
      expect(await privateRoom.join('bob', code)).toMatchObject({
        ok: false,
        error: { code: 'wrong_invite_code' },
      });
    }
    const publicRoom = fixture();
    value(await publicRoom.open());
    expect(await publicRoom.join('bob', 'WRONG')).toMatchObject({ ok: true });
  });

  it('same-room names are case insensitive and a six-seat table is full', async () => {
    const f = fixture();
    await f.sit(1);
    expect(await f.join('ALICE')).toMatchObject({
      ok: false,
      error: { code: 'name_invalid' },
    });
    for (const name of NAMES.slice(1)) value(await f.join(name));
    const state = await f.state();
    expect(state).toMatchObject({
      room_status: 'waiting',
      seats_open: 0,
      opponent_name: null,
      opponent_display_name: null,
    });
    expect(state.seats.map(s => s.seat)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(await f.join('george')).toMatchObject({
      ok: false,
      error: { code: 'room_full' },
    });
    expect(state.hint).toMatch(/full/i);
    expect(state.hint).toMatch(/start/i);
    expect(state.hint).toMatch(/leave/i);
  });

  it('three-seat waiting state has no opponent fields; host asks its owner about all three choices', async () => {
    const f = fixture();
    await f.sit(3);
    const host = await f.state();
    expect(host).toMatchObject({
      status: 'waiting',
      room_status: 'waiting',
      view: null,
      is_host: true,
      seats_open: 3,
      opponent_name: null,
      opponent_display_name: null,
    });
    for (const display of ['Alice Shark', 'BOB', 'CAROL'])
      expect(host.hint).toContain(display);
    expect(host.hint).toContain('3');
    for (const pattern of [
      /owner/i,
      /start/i,
      /bots?/i,
      /unrated|not rated|no rating/i,
      /wait/i,
    ])
      expect(host.hint).toMatch(pattern);
    const guest = await f.state('bob');
    expect(guest).toMatchObject({ is_host: false, seats_open: 3 });
    expect(guest.hint).toMatch(/host/i);
    expect(guest.hint).toMatch(/wait/i);
  });

  it.each(['join', 'leave', 'start', 'close'] as const)(
    'pending host wait wakes on %s without waiting for its limit',
    async event => {
      vi.useFakeTimers();
      const f = fixture({ waitMs: 30_000 });
      await f.sit(2);
      let response: RoomStatus | undefined;
      const pending = f.room.status('alice', { wait: true }).then(result => {
        response = value(result);
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(response).toBeUndefined();
      if (event === 'join') value(await f.join('carol'));
      if (event === 'leave') value(await f.room.leave('bob'));
      if (event === 'start') value(await f.room.start('alice', {}));
      if (event === 'close') value(await f.room.leave('alice'));
      await vi.advanceTimersByTimeAsync(0);
      expect(response).toBeDefined();
      if (event === 'join') expect(response?.seats).toHaveLength(3);
      if (event === 'leave') expect(response?.seats).toHaveLength(1);
      if (event === 'start') expect(response?.room_status).toBe('playing');
      if (event === 'close')
        expect(response).toMatchObject({
          status: 'match_over',
          result: 'cancelled',
        });
      await pending;
    },
  );

  it('A18: after 180 seconds a live joiner is told to ask its owner whether to wait or leave', async () => {
    const f = fixture();
    await f.sit(2);
    for (let step = 0; step < 3; step++) {
      f.clock.ms += 60_000;
      await f.state();
      await f.state('bob');
    }
    f.clock.ms += 1_000;
    const guest = await f.state('bob');
    expect(guest.room_status).toBe('waiting');
    for (const pattern of [/owner/i, /wait/i, /leave/i, /181|180|3 minute/i])
      expect(guest.hint).toMatch(pattern);
    expect(guest.hint).toContain('Alice Shark');
    expect(guest.hint).toContain('BOB');
  });
});

describe('T38 start', () => {
  it('rejects a non-host, fewer than two players, and more bots than vacant seats without starting', async () => {
    const f = fixture();
    await f.sit(1);
    expect(await f.room.start('alice', {})).toMatchObject({
      ok: false,
      error: { code: 'not_enough_players' },
    });
    value(await f.join('bob'));
    expect(await f.room.start('bob', {})).toMatchObject({
      ok: false,
      error: { code: 'not_host' },
    });
    value(await f.join('carol'));
    expect(await f.room.start('alice', { bots: 4 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await f.state()).toMatchObject({
      room_status: 'waiting',
      seats_open: 3,
    });
  });

  it.each([
    [3, 5],
    [4, 4],
    [6, 3],
  ])(
    'resolves null blind_every at start with %i players to %i',
    async (count, blindEvery) => {
      const f = fixture();
      await f.sit(count);
      expect(value(await f.room.start('alice', {}))).toMatchObject({
        room_status: 'playing',
        settings: { blind_every: blindEvery },
        seats_open: 0,
      });
      expect(await f.join('george')).toMatchObject({
        ok: false,
        error: { code: 'room_full' },
      });
    },
  );

  it('adds sequentially named bots in empty seats and preserves explicit blinds', async () => {
    const f = fixture({ settings: { blind_every: 7 } });
    await f.sit(2);
    const started = value(await f.room.start('alice', { bots: 3 }));
    expect(started).toMatchObject({
      room_status: 'playing',
      settings: { blind_every: 7 },
    });
    expect(
      started.seats.slice(2).map(s => [s.seat, s.name, s.display_name]),
    ).toEqual([
      [2, 'house-bot', 'House Bot'],
      [3, 'house-bot', 'House Bot 2'],
      [4, 'house-bot', 'House Bot 3'],
    ]);
  });

  it('start retry returns the current hand without adding bots or restarting', async () => {
    const f = fixture();
    await f.sit(3);
    value(await f.room.start('alice', {}));
    const turn = await f.state();
    expect(turn.status).toBe('your_turn');
    if (turn.status !== 'your_turn')
      throw new Error('Three-seat button acts first');
    value(await f.room.act('alice', { turn_id: turn.turn_id, type: 'call' }));
    const before = await f.state();
    expect(value(await f.room.start('alice', { bots: 1 }))).toEqual(before);
  });

  it('legacy opponent bot opens private and starts immediately even with public visibility', async () => {
    const f = fixture();
    value(await f.open('public', 'bot'));
    expect(await f.state()).toMatchObject({
      room_status: 'playing',
      visibility: 'private',
      opponent_name: 'house-bot',
      opponent_display_name: 'House Bot',
      seats_open: 0,
    });
  });
});

describe('T38 狀況處理：主動離開（開打前）與不見', () => {
  it('主動離開（開打前）：host closes the room as cancelled without recording a match', async () => {
    const f = fixture();
    await f.sit(3);
    expect(value(await f.room.leave('alice'))).toMatchObject({
      status: 'match_over',
      result: 'cancelled',
      place: null,
    });
    for (const name of ['bob', 'carol'])
      expect(await f.state(name)).toMatchObject({
        status: 'match_over',
        result: 'cancelled',
      });
    expect(f.records).toEqual([]);
  });

  it('主動離開（開打前）：guest vacates its seat; later names keep working after compaction', async () => {
    const f = fixture();
    await f.sit(4);
    expect(value(await f.room.leave('bob'))).toMatchObject({
      status: 'match_over',
      result: 'cancelled',
      place: null,
    });
    const state = value(await f.room.status('CAROL', { wait: true }));
    expect(state.seats.map(s => [s.seat, s.name])).toEqual([
      [0, 'alice'],
      [1, 'carol'],
      [2, 'dave'],
    ]);
    expect(state.seats_open).toBe(3);
    expect(value(await f.room.watch('carol')).seat).toBe(1);
    for (const call of [
      () => f.room.status('bob', { wait: false }),
      () => f.room.status('bob', { wait: true }),
      () => f.room.act('bob', { turn_id: 'old', type: 'fold' }),
      () => f.room.leave('bob'),
      () => f.room.start('bob', {}),
      () => f.room.watch('bob'),
    ])
      expect(await call()).toMatchObject({
        ok: false,
        error: { code: 'invalid_token' },
      });
    expect(value(await f.join('eve')).seat).toBe(3);
  });

  it('不見（開打前 2 分鐘沒有請求）：missing host closes the room for a still-present guest', async () => {
    const f = fixture();
    await f.sit(2);
    f.clock.ms += 90_000;
    await f.state('bob');
    f.clock.ms += 30_001;
    await f.room.alarm();
    expect(await f.state('bob')).toMatchObject({
      status: 'match_over',
      result: 'cancelled',
    });
    expect(f.records).toEqual([]);
  });

  it('不見（開打前 2 分鐘沒有請求）：missing guest is removed, seats compact, active waiters can keep waiting indefinitely', async () => {
    const f = fixture();
    await f.sit(3);
    for (let step = 0; step < 8; step++) {
      f.clock.ms += 60_000;
      await f.state();
      await f.state('carol');
      await f.room.alarm();
    }
    expect(await f.state('carol')).toMatchObject({
      room_status: 'waiting',
      seats_open: 4,
    });
    expect(value(await f.room.watch('carol')).seat).toBe(1);
    expect(await f.room.status('bob', { wait: false })).toMatchObject({
      ok: false,
      error: { code: 'invalid_token' },
    });
  });

  it('不見（開打前 2 分鐘沒有請求）：host idle 119 999 ms keeps the room waiting; 120 000 ms closes it', async () => {
    const f = fixture();
    await f.sit(2);
    f.clock.ms += 119_999;
    await f.state('bob');
    await f.room.alarm();
    expect(await f.state('bob')).toMatchObject({
      room_status: 'waiting',
      opponent_name: 'alice',
    });
    f.clock.ms += 1;
    await f.room.alarm();
    expect(await f.state('bob')).toMatchObject({
      status: 'match_over',
      result: 'cancelled',
    });
    expect(f.records).toEqual([]);
  });

  it('不見（開打前 2 分鐘沒有請求）：guest idle 119 999 ms keeps its seat; 120 000 ms removes it', async () => {
    const f = fixture();
    await f.sit(3);
    f.clock.ms += 119_999;
    await f.state('alice');
    await f.state('carol');
    await f.room.alarm();
    expect((await f.state()).seats.map(s => s.name)).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
    f.clock.ms += 1;
    await f.state('alice');
    await f.state('carol');
    await f.room.alarm();
    expect((await f.state()).seats.map(s => s.name)).toEqual([
      'alice',
      'carol',
    ]);
    expect(await f.room.status('bob', { wait: false })).toMatchObject({
      ok: false,
      error: { code: 'invalid_token' },
    });
  });

  it('不見：after start an idle seat times out instead of being removed or compacted', async () => {
    const f = fixture({ settings: { turn_seconds: 120 } });
    await f.sit(3);
    value(await f.room.start('alice', {}));
    f.clock.ms += 120_001;
    await f.room.alarm();
    const state = await f.state('bob');
    expect(state.room_status).toBe('playing');
    expect(state.seats.map(s => s.name)).toEqual(NAMES.slice(0, 3));
  });
});

// Execute the same legal actions through the referee and the pure table engine.
async function step(
  f: ReturnType<typeof fixture>,
  engine: TableState,
  seat: number,
  action: Action,
) {
  const turn = await f.state(NAMES[seat]);
  expect(turn.status).toBe('your_turn');
  if (turn.status !== 'your_turn')
    throw new Error('Expected engine actor to have a turn');
  value(await f.room.act(NAMES[seat], { turn_id: turn.turn_id, ...action }));
  const result = applyTableAction(engine, seat, action);
  if (!result.ok) throw new Error(result.message);
  return result;
}

const engineFor = (
  players: number,
  startingStack = 40,
  maxHands = 50,
  blindEvery = 50,
) => startTable({ seed: SEED, players, startingStack, blindEvery, maxHands });

async function bustFixture() {
  const f = fixture({ settings: { starting_stack: 10, blind_every: 50 } });
  await f.sit(4);
  value(await f.room.start('alice', {}));
  let engine = engineFor(4, 10);
  // Seed 0: the independent engine verifies seat 0 loses its stack, three remain.
  const actions: [number, Action][] = [
    [3, { type: 'raise', amount: 10 }],
    [0, { type: 'call' }],
    [1, { type: 'fold' }],
    [2, { type: 'fold' }],
  ];
  for (const [seat, action] of actions)
    engine = (await step(f, engine, seat, action)).state;
  expect(engine.places[0]).not.toBeNull();
  expect(engine.stacks[0]).toBe(0);
  expect(engine.over).toBe(false);
  return { f, engine };
}

describe('T38 狀況處理：出局、主動離開（進行中）、桌上只剩 house-bot', () => {
  it('桌上只剩 house-bot：human busting ends at once with the two surviving bots ranked by chips', async () => {
    const oracle = humanBustOracle();
    expect(oracle.state.places[0]).not.toBeNull();
    expect(oracle.state.over).toBe(false);
    const f = fixture({
      seed: oracle.seed,
      settings: { starting_stack: 10, blind_every: 50 },
    });
    await f.sit(1);
    value(await f.room.start('alice', { bots: 2 }));
    const turn = await f.state();
    if (turn.status !== 'your_turn')
      throw new Error('Expected human button turn');
    value(
      await f.room.act('alice', {
        turn_id: turn.turn_id,
        type: 'raise',
        amount: 10,
      }),
    );
    const finalStacks = oracle.state.stacks.map(
      (stack, seat) => stack + oracle.state.contributed[seat],
    );
    const expectedPlaces = [
      oracle.state.places[0],
      ...finalStacks
        .slice(1)
        .map(
          stack =>
            1 + finalStacks.slice(1).filter(other => other > stack).length,
        ),
    ];
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({
      end_reason: 'bots_only',
      final_stacks: finalStacks,
      places: expectedPlaces,
      hands: oracle.hands,
    });
    expect(await f.state()).toMatchObject({
      status: 'match_over',
      room_status: 'finished',
      result: 'loss',
      place: expectedPlaces[0],
    });
  });

  it('出局：next wait reports place while the table plays on; later mutations report match_over', async () => {
    const { f, engine } = await bustFixture();
    const out = value(await f.room.status('alice', { wait: true }));
    expect(out).toMatchObject({
      status: 'match_over',
      room_status: 'playing',
      result: 'loss',
      place: engine.places[0],
      ratings: null,
      view: null,
      final_stacks: engine.stacks,
    });
    expect(out.hint).toMatch(/rat(?:ing|ed)|Elo/i);
    expect(out.hint).toMatch(/watch|web/i);
    for (const call of [
      () => f.room.act('alice', { turn_id: 'old', type: 'fold' }),
      () => f.room.leave('alice'),
      () => f.room.start('alice', {}),
    ]) {
      expect(await call()).toMatchObject({
        ok: false,
        error: { code: 'match_over', state: { place: engine.places[0] } },
      });
    }
    expect((await f.state('bob')).room_status).toBe('playing');
    expect(f.records).toEqual([]);
    expect(value(await f.room.watch('alice'))).toMatchObject({
      room_status: 'playing',
      view: null,
    });
  });

  it('主動離開（進行中）：leaver is placed last among remaining players and the other three continue', async () => {
    const f = fixture();
    await f.sit(4);
    value(await f.room.start('alice', {}));
    const expected = leaveTable(engineFor(4, 40, 50, 4), 1);
    if (!expected.ok) throw new Error(expected.message);
    // Seat 1 is not the actor; leaving is permitted out of turn.
    expect(value(await f.room.leave('bob'))).toMatchObject({
      status: 'match_over',
      room_status: 'playing',
      result: 'loss',
      place: 4,
      view: null,
      ratings: null,
    });
    expect((await f.state()).seats[1]).toMatchObject({
      status: 'left',
      place: 4,
      stack: 0,
    });
    const actor = await f.state('dave');
    expect(actor.view?.history).toEqual(expected.state.history);
    expect(actor.seats.map(s => s.stack)).toEqual(expected.state.stacks);
    expect(f.records).toEqual([]);
    expect(await f.state('dave')).toMatchObject({
      status: 'your_turn',
      room_status: 'playing',
    });
  });

  it('主動離開（進行中）：leaving fewer than two ends immediately and refunds the unfinished hand', async () => {
    const f = fixture();
    await f.sit(2);
    value(await f.room.start('alice', {}));
    expect(value(await f.room.leave('bob'))).toMatchObject({
      status: 'match_over',
      room_status: 'finished',
      result: 'loss',
      place: 2,
      final_stacks: [40, 40],
    });
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({
      end_reason: 'leave',
      hands: [],
      final_stacks: [40, 40],
      places: [1, 2],
    });
    expect(await f.room.start('alice', {})).toMatchObject({
      ok: false,
      error: { code: 'match_over' },
    });
    expect(await f.join('carol')).toMatchObject({
      ok: false,
      error: { code: 'match_over' },
    });
  });

  it('桌上只剩 house-bot：last human leaving ends immediately, refunds the hand, ranks bots by chips', async () => {
    const f = fixture();
    await f.sit(1);
    value(await f.room.start('alice', { bots: 2 }));
    value(await f.room.leave('alice'));
    expect(f.records).toHaveLength(1);
    const record = f.records[0];
    expect(record).toMatchObject({
      end_reason: 'bots_only',
      places: [3, 1, 1],
      final_stacks: [0, 40, 40],
      hands: [],
    });
    expect(await f.state()).toMatchObject({
      room_status: 'finished',
      result: 'loss',
      place: 3,
    });
  });

  it('桌上只剩 house-bot：three consecutive human timeouts finish instead of playing bots forever', async () => {
    const f = fixture({ settings: { starting_stack: 1000, turn_seconds: 5 } });
    await f.sit(1);
    value(await f.room.start('alice', { bots: 2 }));
    for (let i = 0; i < 12 && f.records.length === 0; i++) {
      f.clock.ms += 10_001;
      await f.room.alarm();
    }
    expect(f.records).toHaveLength(1);
    expect(f.records[0].end_reason).toBe('bots_only');
    const record = f.records[0];
    // The absent human (seat 0) ranks behind both bots.
    expect(record.places?.[0]).toBe(3);
    for (const seat of [1, 2]) {
      expect(record.places?.[seat]).toBe(
        1 +
          record.final_stacks
            .slice(1)
            .filter(stack => stack > record.final_stacks[seat]).length,
      );
    }
  });
});

describe('T38 N-seat final records and watch privacy', () => {
  it('tied first places report draw while lower places report loss', async () => {
    // Deterministically find a split first place using legal check/call play.
    // The seed and complete action trace are retained; no state is fabricated.
    const oracle = tiedFirstOracle();
    expect(oracle.state.over).toBe(true);
    expect(oracle.state.places.filter(p => p === 1).length).toBeGreaterThan(1);
    const f = fixture({
      seed: oracle.seed,
      settings: { blind_every: 50, max_hands: 1 },
    });
    await f.sit(3);
    value(await f.room.start('alice', {}));
    let engine = startTable({
      seed: oracle.seed,
      players: 3,
      startingStack: 40,
      blindEvery: 50,
      maxHands: 1,
    });
    for (const [seat, action] of oracle.actions)
      engine = (await step(f, engine, seat, action)).state;
    expect(engine.places).toEqual(oracle.state.places);
    expect(engine.places.filter(p => p === 1).length).toBeGreaterThan(1);
    for (const [seat, place] of engine.places.entries()) {
      expect(await f.state(NAMES[seat])).toMatchObject({
        place,
        result: place === 1 ? 'draw' : 'loss',
        final_stacks: engine.stacks,
      });
    }
    expect(f.records[0]).toMatchObject({
      result: 'draw',
      places: engine.places,
      final_stacks: engine.stacks,
    });
  });

  it.each([3, 4, 6])(
    '%i seats finish with engine places, results, N stacks and TableHandRecords',
    async count => {
      const f = fixture({ settings: { blind_every: 50, max_hands: 1 } });
      await f.sit(count);
      value(await f.room.start('alice', {}));
      let engine = engineFor(count, 40, 1);
      const hands: TableHandRecord[] = [];
      while (!engine.over) {
        if (engine.toAct === null) throw new Error('Missing actor');
        const result = await step(f, engine, engine.toAct, { type: 'fold' });
        engine = result.state;
        hands.push(...result.finishedHands);
      }
      expect(f.records).toHaveLength(1);
      expect(f.records[0]).toMatchObject({
        players: NAMES.slice(0, count),
        display_names: [
          'Alice Shark',
          ...NAMES.slice(1, count).map(n => n.toUpperCase()),
        ],
        settings: { blind_every: 50 },
        seed: SEED,
        places: engine.places,
        final_stacks: engine.stacks,
        hands,
        end_reason: 'max_hands',
      });
      for (let seat = 0; seat < count; seat++) {
        const tiedFirst = engine.places.filter(p => p === 1).length > 1;
        const result =
          engine.places[seat] === 1 ? (tiedFirst ? 'draw' : 'win') : 'loss';
        expect(await f.state(NAMES[seat])).toMatchObject({
          status: 'match_over',
          room_status: 'finished',
          result,
          place: engine.places[seat],
          final_stacks: engine.stacks,
        });
      }
      const watch = value(await f.room.watch('alice'));
      expect(watch).toMatchObject({
        room_status: 'finished',
        places: engine.places,
      });
      expect(
        watch.hands[0].hole_cards.every(cards => cards?.length === 2),
      ).toBe(true);
    },
  );

  it('A16: waiting watch lists everyone, no cards, no hands', async () => {
    const f = fixture();
    await f.sit(3);
    expect(value(await f.room.watch('carol'))).toMatchObject({
      room_status: 'waiting',
      seat: 2,
      players: NAMES.slice(0, 3),
      display_names: ['Alice Shark', 'BOB', 'CAROL'],
      view: null,
      hands: [],
      seats_open: 3,
    });
  });

  it('A16: fold-ended hands reveal only own cards; showdown reveals shown cards to an out seat', async () => {
    const f = fixture({ settings: { blind_every: 50 } });
    await f.sit(3);
    value(await f.room.start('alice', {}));
    let engine = engineFor(3);
    while (engine.handNumber === 1) {
      if (engine.toAct === null) throw new Error('Missing actor');
      engine = (await step(f, engine, engine.toAct, { type: 'fold' })).state;
    }
    const watch = value(await f.room.watch('bob'));
    expect(watch.hands[0].hole_cards[1]).toHaveLength(2);
    expect(watch.hands[0].hole_cards[0]).toBeNull();
    expect(watch.hands[0].hole_cards[2]).toBeNull();
    const { f: busted, engine: afterBust } = await bustFixture();
    const publicWatch = value(await busted.room.watch('alice'));
    expect(publicWatch.view).toBeNull();
    expect(publicWatch.hands[0].hole_cards).toEqual(
      afterBust.lastHand?.hole_cards,
    );
    expect(publicWatch).not.toHaveProperty('seed');
    expect(publicWatch).not.toHaveProperty('turn_id');
    expect(publicWatch).not.toHaveProperty('legal_actions');
    let next = afterBust;
    while (next.handNumber === afterBust.handNumber) {
      if (next.toAct === null) throw new Error('Missing actor');
      next = (await step(busted, next, next.toAct, { type: 'fold' })).state;
    }
    const laterWatch = value(await busted.room.watch('alice'));
    expect(laterWatch.view).toBeNull();
    expect(laterWatch.hands[1].hole_cards).toEqual([null, null, null, null]);
  });
});

function tiedFirstOracle() {
  for (let n = 0; n < 2000; n++) {
    const seed = n.toString(16).padStart(64, '0');
    let state = startTable({
      seed,
      players: 3,
      startingStack: 40,
      blindEvery: 50,
      maxHands: 1,
    });
    const actions: [number, Action][] = [];
    while (!state.over) {
      const legal = tableLegalActions(state).find(
        a => a.type === 'check' || a.type === 'call',
      );
      if (!legal || state.toAct === null)
        throw new Error('Missing passive action');
      const action: Action = { type: legal.type };
      const seat = state.toAct;
      const next = applyTableAction(state, seat, action);
      if (!next.ok) throw new Error(next.message);
      actions.push([seat, action]);
      state = next.state;
    }
    if (state.places.filter(p => p === 1).length > 1)
      return { seed, state, actions };
  }
  throw new Error('No tied first-place seed found in deterministic search');
}

function humanBustOracle() {
  for (let n = 0; n < 2000; n++) {
    const seed = n.toString(16).padStart(64, '0');
    let state = startTable({
      seed,
      players: 3,
      startingStack: 10,
      blindEvery: 50,
      maxHands: 50,
    });
    const hands: TableHandRecord[] = [];
    for (const [seat, action] of [
      [0, { type: 'raise', amount: 10 }],
      [1, { type: 'call' }],
      [2, { type: 'call' }],
    ] as [number, Action][]) {
      const next = applyTableAction(state, seat, action);
      if (!next.ok) throw new Error(next.message);
      state = next.state;
      hands.push(...next.finishedHands);
    }
    if (state.places[0] !== null && !state.over) return { seed, state, hands };
  }
  throw new Error('No human-bust/two-surviving-bots seed found');
}

describe('T38 A11 per-seat chaos', () => {
  it('reject_first_action rejects each of three players independently, leaving its turn reusable', async () => {
    const f = fixture({
      test: { seed: SEED, chaos: { reject_first_action: true } },
    });
    await f.sit(3);
    value(await f.room.start('alice', {}));
    for (const name of NAMES.slice(0, 3)) {
      const turn = await f.state(name);
      if (turn.status !== 'your_turn')
        throw new Error('Expected clockwise actor');
      const action = {
        turn_id: turn.turn_id,
        type: name === 'carol' ? ('check' as const) : ('call' as const),
      };
      expect(await f.room.act(name, action)).toMatchObject({
        ok: false,
        error: { code: 'invalid_action' },
      });
      expect(await f.room.act(name, action)).toMatchObject({ ok: true });
    }
  });

  it('extra_waiting applies independently to each player on its own turn', async () => {
    const f = fixture({ test: { seed: SEED, chaos: { extra_waiting: 1 } } });
    await f.sit(3);
    value(await f.room.start('alice', {}));
    let engine = engineFor(3, 40, 50, 5);
    for (const name of NAMES.slice(0, 3)) {
      expect(value(await f.room.status(name, { wait: true })).status).toBe(
        'waiting',
      );
      expect(value(await f.room.status(name, { wait: true })).status).toBe(
        'your_turn',
      );
      if (engine.toAct === null) throw new Error('Missing actor');
      const legal = tableLegalActions(engine).find(
        a => a.type === 'check' || a.type === 'call',
      );
      if (!legal) throw new Error('Expected a legal passive action');
      engine = (await step(f, engine, engine.toAct, { type: legal.type }))
        .state;
    }
  });

  it('fail_request_every counts per name, including start and surviving pre-start compaction', async () => {
    const f = fixture({
      test: { seed: SEED, chaos: { fail_request_every: 3 } },
    });
    await f.sit(3);
    await f.state('carol'); // carol #1
    value(await f.room.leave('bob')); // bob #1, carol moves from seat 2 to 1
    await f.state('carol'); // carol #2
    expect(await f.room.status('carol', { wait: false })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    value(await f.room.start('alice', {})); // alice #1
    await f.state(); // alice #2
    expect(await f.room.start('alice', {})).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(await f.room.status('carol', { wait: false })).toMatchObject({
      ok: true,
    });
  });
});

// A passive all-in line that busts exactly one of three seats in hand 1: the
// button shoves, the next seat calls, the big blind folds; the shover and the
// caller must not split. Found with the pure engine, independent of the referee.
function oneBustOfThreeOracle() {
  for (let n = 0; n < 2000; n++) {
    const seed = n.toString(16).padStart(64, '0');
    const config = {
      seed,
      players: 3,
      startingStack: 10,
      blindEvery: 50,
      maxHands: 50,
    };
    let state = startTable(config);
    const actions: [number, Action][] = [];
    let valid = true;
    for (const action of [
      { type: 'raise', amount: 10 },
      { type: 'call' },
      { type: 'fold' },
    ] as Action[]) {
      const seat = state.toAct;
      const next = seat === null ? null : applyTableAction(state, seat, action);
      if (seat === null || !next?.ok) {
        valid = false;
        break;
      }
      actions.push([seat, action]);
      state = next.state;
    }
    const busted = state.places.findIndex(place => place !== null);
    if (
      valid &&
      !state.over &&
      state.places.filter(place => place !== null).length === 1 &&
      state.places[busted] === 3
    ) {
      const survivors = [0, 1, 2].filter(seat => seat !== busted);
      return {
        seed,
        actions,
        busted,
        leaver: survivors[0],
        winner: survivors[1],
      };
    }
  }
  throw new Error('No one-bust seed found in deterministic search');
}

describe('T38 A9: a leave that ends the match tells every other seat its own result', () => {
  it('busted seat 3 of 3 learns it lost (not that it won) after the second seat leaves; the last seat is told it won', async () => {
    const oracle = oneBustOfThreeOracle();
    const f = fixture({
      seed: oracle.seed,
      settings: { starting_stack: 10, blind_every: 50 },
    });
    await f.sit(3);
    value(await f.room.start('alice', {}));
    let engine = startTable({
      seed: oracle.seed,
      players: 3,
      startingStack: 10,
      blindEvery: 50,
      maxHands: 50,
    });
    for (const [seat, action] of oracle.actions)
      engine = (await step(f, engine, seat, action)).state;
    expect(engine.places[oracle.busted]).toBe(3);
    expect(engine.over).toBe(false);

    expect(value(await f.room.leave(NAMES[oracle.leaver]))).toMatchObject({
      status: 'match_over',
      result: 'loss',
      place: 2,
    });

    const busted = await f.state(NAMES[oracle.busted]);
    expect(busted).toMatchObject({
      status: 'match_over',
      room_status: 'finished',
      result: 'loss',
      place: 3,
    });
    expect(busted.hint).not.toMatch(/you won/i);

    const winner = await f.state(NAMES[oracle.winner]);
    expect(winner).toMatchObject({
      status: 'match_over',
      room_status: 'finished',
      result: 'win',
      place: 1,
    });
    expect(winner.hint).toMatch(/you won/i);

    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toMatchObject({
      end_reason: 'leave',
      places: [0, 1, 2].map(
        seat =>
          ({
            [oracle.busted]: 3,
            [oracle.leaver]: 2,
            [oracle.winner]: 1,
          })[seat],
      ),
    });
  });
});
