// T11 slice 2: rooms that end without a finished match (casino-api skill:
// 狀況處理 (等人超過 5 分鐘, 主動離開, 平台出錯), A6, A8, A9 (管理員中止), A15;
// holdem-rules: 等人解散). Same harness as timeouts.test.ts: HTTP through
// handle(), one RoomReferee per room id over a memory storage that records
// its one alarm, an injected clock and a seeded deck.
//
// 等人超過 5 分鐘: a room nobody joined is dissolved at created_at + 5 min
// (now >= that), exactly as if seat 0 had left the waiting room. 管理員中止:
// POST /v1/admin/rooms/{room_id}/abort voids the match; the unfinished hand is
// called off like a leave.
import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { ERROR_STATUS, type ErrorCode } from '../contract/errors';
import {
  ActionAccepted,
  CreateRoomResponse,
  JoinResponse,
  RoomStatus,
} from '../contract/schemas';
import { startTestD1, type TestD1 } from '../db/test-d1';
import {
  type Action,
  applyAction,
  type MatchState,
  type Seat,
  startMatch,
} from '../holdem/match';
import type { Bindings } from '../routes/env';
import { RoomReferee, type RoomStorage } from './referee';

let testD1: TestD1;

beforeAll(async () => {
  testD1 = await startTestD1();
}, 30_000);

beforeEach(async () => {
  await testD1.reset();
});

afterAll(async () => {
  await testD1?.dispose();
});

const BASE = 'http://api.test';
const SEED = '0'.repeat(64);
const STACK = 40;
const ADMIN_KEY = 'test-admin-key';
const WAIT_LIMIT_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// --- Fakes ------------------------------------------------------------------

class MemoryStorage implements RoomStorage {
  readonly #data = new Map<string, unknown>();
  // The one scheduled alarm (epoch ms), or null when none is scheduled.
  alarm: number | null = null;
  // Every setAlarm call, in order.
  readonly alarmsSet: number[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#data.set(key, structuredClone(value));
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
    this.alarmsSet.push(scheduledTime);
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

interface TestEnv {
  env: Bindings;
  clock: { ms: number };
  // The referee and storage behind a room id.
  referee: (roomId: string) => RoomReferee;
  storage: (roomId: string) => MemoryStorage;
  restart: (roomId: string) => void;
}

// Whole seconds, so a deadline without milliseconds still compares equal.
const startOfSecond = () => Math.floor(Date.now() / 1000) * 1000;

const makeEnv = (options: { waitMs?: number } = {}): TestEnv => {
  const clock = { ms: startOfSecond() };
  const rooms = new Map<
    string,
    { referee: RoomReferee; storage: MemoryStorage }
  >();
  const room = (id: string) => {
    let entry = rooms.get(id);
    if (entry === undefined) {
      const storage = new MemoryStorage();
      const referee = new RoomReferee(storage, {
        waitMs: options.waitMs ?? 300,
        now: () => clock.ms,
      });
      entry = { referee, storage };
      rooms.set(id, entry);
    }
    return entry;
  };
  const ROOM = {
    idFromName: (name: string) => name,
    get: (id: string) => room(id).referee,
  };
  const env = {
    TOKEN_SECRET: 'test-token-secret',
    WEB_URL: 'https://web.test',
    ADMIN_KEY,
    DB: testD1.d1,
    ROOM,
    MATCHMAKER: {},
    ALLOW_TEST_ROOMS: 'true',
  } as unknown as Bindings;
  return {
    env,
    clock,
    referee: id => room(id).referee,
    storage: id => room(id).storage,
    restart: id => {
      const entry = room(id);
      entry.referee = new RoomReferee(entry.storage, {
        waitMs: options.waitMs ?? 300,
        now: () => clock.ms,
      });
    },
  };
};

// --- HTTP helpers -----------------------------------------------------------

const post = (env: Bindings, path: string, body: unknown, token?: string) =>
  handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
  );

const get = (env: Bindings, path: string, token: string) =>
  handle(
    new Request(`${BASE}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );

const decodeCreate = Schema.decodeUnknownSync(CreateRoomResponse);
const decodeJoin = Schema.decodeUnknownSync(JoinResponse);
const decodeStatus = Schema.decodeUnknownSync(RoomStatus);
const decodeAccepted = Schema.decodeUnknownSync(ActionAccepted);

type Status = typeof RoomStatus.Type;
type YourTurn = Extract<Status, { status: 'your_turn' }>;

interface ErrorBody {
  status: 'error';
  code: string;
  message: string;
  hint: string;
  state?: unknown;
}

const expectError = async (
  response: Response,
  code: ErrorCode,
): Promise<ErrorBody> => {
  const body = (await response.json()) as ErrorBody;
  expect({ status: response.status, code: body.code }).toEqual({
    status: ERROR_STATUS[code],
    code,
  });
  expect(body.message.length).toBeGreaterThan(0);
  expect(body.hint.length).toBeGreaterThan(0);
  return body;
};

const errorState = (body: ErrorBody): Status => {
  expect(body.state).toBeDefined();
  return decodeStatus(body.state);
};

const readStatus = async (response: Response): Promise<Status> => {
  expect(response.status).toBe(200);
  return decodeStatus(await response.json());
};

const state = async (t: TestEnv, roomId: string, token: string) =>
  readStatus(await get(t.env, `/v1/rooms/${roomId}/state`, token));

const wait = async (t: TestEnv, roomId: string, token: string) => {
  const started = performance.now();
  const status = await readStatus(
    await get(t.env, `/v1/rooms/${roomId}/wait`, token),
  );
  return { status, elapsedMs: performance.now() - started };
};

const yourTurn = async (
  t: TestEnv,
  roomId: string,
  token: string,
): Promise<YourTurn> => {
  const status = await state(t, roomId, token);
  expect(status.status).toBe('your_turn');
  if (status.status !== 'your_turn') throw new Error('expected your_turn');
  return status;
};

const actPost = (
  t: TestEnv,
  roomId: string,
  token: string,
  body: Record<string, unknown>,
) => post(t.env, `/v1/rooms/${roomId}/actions`, body, token);

const act = async (
  t: TestEnv,
  roomId: string,
  token: string,
  body: Record<string, unknown>,
) => {
  const response = await actPost(t, roomId, token, body);
  expect(response.status).toBe(200);
  return decodeAccepted(await response.json());
};

const leavePost = (t: TestEnv, roomId: string, token: string) =>
  handle(
    new Request(`${BASE}/v1/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }),
    t.env,
  );

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// A seeded room (seat 0 alice, seat 1 bob), joined at the clock's time.
const seededRoom = async (t: TestEnv, settings: Record<string, unknown>) => {
  const created = await post(t.env, '/v1/rooms', {
    game: 'holdem',
    name: 'alice',
    settings,
    test: { seed: SEED },
  });
  expect(created.status).toBe(200);
  const room = decodeCreate(await created.json());
  const joinedResponse = await post(t.env, `/v1/rooms/${room.room_id}/join`, {
    name: 'bob',
    invite_code: room.invite_code,
  });
  expect(joinedResponse.status).toBe(200);
  const joined = decodeJoin(await joinedResponse.json());
  return {
    roomId: room.room_id,
    tokens: [room.token, joined.token] as const,
    joinedAt: t.clock.ms,
  };
};

// --- Engine oracle ----------------------------------------------------------

const engineStart = (hands: number): MatchState =>
  startMatch({ seed: SEED, hands, startingStack: STACK });

const applyOk = (
  match: MatchState,
  seat: Seat,
  action: Action,
  options: { timeout?: boolean } = {},
): MatchState => {
  const result = applyAction(match, seat, action, options);
  if (!result.ok) throw new Error(result.message);
  return result.state;
};

// --- More helpers -----------------------------------------------------------

type Created = ReturnType<typeof decodeCreate>;
type MatchOverStatus = Extract<Status, { status: 'match_over' }>;

const asMatchOver = (status: Status): MatchOverStatus => {
  expect(status.status).toBe('match_over');
  if (status.status !== 'match_over') throw new Error('expected match_over');
  return status;
};

// Seat 0 opens a room; nobody joins yet.
const openRoom = async (
  t: TestEnv,
  settings: Record<string, unknown> = {},
): Promise<Created & { createdAt: number }> => {
  const createdAt = t.clock.ms;
  const response = await post(t.env, '/v1/rooms', {
    game: 'holdem',
    name: 'alice',
    settings,
    test: { seed: SEED },
  });
  expect(response.status).toBe(200);
  return { ...decodeCreate(await response.json()), createdAt };
};

const joinPost = (t: TestEnv, room: Created, inviteCode = room.invite_code) =>
  post(t.env, `/v1/rooms/${room.room_id}/join`, {
    name: 'bob',
    invite_code: inviteCode,
  });

const abortPost = (t: TestEnv, roomId: string, key = ADMIN_KEY) =>
  handle(
    new Request(`${BASE}/v1/admin/rooms/${roomId}/abort`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
    }),
    t.env,
  );

const abort = async (t: TestEnv, roomId: string) => {
  const response = await abortPost(t, roomId);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'aborted', room_id: roomId });
};

// The cancelled match_over of a waiting room (A6, A15).
const expectCancelled = (status: Status, start: number) => {
  expect(asMatchOver(status)).toMatchObject({
    status: 'match_over',
    result: 'cancelled',
    room_status: 'finished',
    to_act_seat: null,
    hand_number: null,
    view: null,
    final_stacks: [start, start],
    ratings: null,
    last_hand: null,
  });
};

// --- 等人超過 5 分鐘 -------------------------------------------------------------

describe('狀況處理 等人超過 5 分鐘: a room nobody joined is dissolved at created_at + 5 min', () => {
  it('the alarm is scheduled at created_at + 5 min right after the room is created', async () => {
    const t = makeEnv();
    const room = await openRoom(t);
    expect(t.storage(room.room_id).alarm).toBe(room.createdAt + WAIT_LIMIT_MS);
  });

  it('alarm() at created_at + 5 min dissolves it: match_over cancelled, finished, final_stacks [start, start], ratings null; the alarm is deleted', async () => {
    const t = makeEnv();
    const room = await openRoom(t, { starting_stack: 100 });
    t.clock.ms = room.createdAt + WAIT_LIMIT_MS;
    await t.referee(room.room_id).alarm();
    expectCancelled(await state(t, room.room_id, room.token), 100);
    expect(t.storage(room.room_id).alarm).toBeNull();
  });

  it('alarm() 1 ms earlier (created_at + 299_999) changes nothing: still waiting, the alarm stays', async () => {
    const t = makeEnv();
    const room = await openRoom(t);
    t.clock.ms = room.createdAt + WAIT_LIMIT_MS - 1;
    await t.referee(room.room_id).alarm();
    const status = await state(t, room.room_id, room.token);
    expect(status).toMatchObject({ status: 'waiting', room_status: 'waiting' });
    expect(t.storage(room.room_id).alarm).toBe(room.createdAt + WAIT_LIMIT_MS);
  });

  it("seat 0's pending wait answers the cancelled match_over as soon as alarm() fires", async () => {
    const t = makeEnv({ waitMs: 3_000 });
    const room = await openRoom(t);
    const pending = wait(t, room.room_id, room.token);
    await sleep(50);
    t.clock.ms = room.createdAt + WAIT_LIMIT_MS;
    await t.referee(room.room_id).alarm();
    const { status, elapsedMs } = await pending;
    expectCancelled(status, STACK);
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it('catch-up: state and wait after 5 min answer cancelled without alarm()', async () => {
    const t = makeEnv({ waitMs: 3_000 });
    const room = await openRoom(t);
    t.clock.ms = room.createdAt + WAIT_LIMIT_MS;
    expectCancelled(await state(t, room.room_id, room.token), STACK);
    const { status, elapsedMs } = await wait(t, room.room_id, room.token);
    expectCancelled(status, STACK);
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it('it ends exactly like seat 0 leaving the waiting room (same match_over apart from match_id)', async () => {
    const t = makeEnv();
    const dissolved = await openRoom(t);
    // Opened 1 s later, so it is not due yet when the first one dissolves.
    t.clock.ms += 1_000;
    const left = await openRoom(t);
    t.clock.ms = dissolved.createdAt + WAIT_LIMIT_MS;
    const leftOver = asMatchOver(
      await readStatus(await leavePost(t, left.room_id, left.token)),
    );
    const dissolvedOver = asMatchOver(
      await state(t, dissolved.room_id, dissolved.token),
    );
    expect({ ...dissolvedOver, match_id: '' }).toEqual({
      ...leftOver,
      match_id: '',
    });
    expect(dissolvedOver.match_id).toBe(dissolved.room_id);
  });

  it('joining after 5 min with the right invite code answers 409 match_over; a wrong code still answers 403 wrong_invite_code', async () => {
    const t = makeEnv();
    const room = await openRoom(t);
    t.clock.ms = room.createdAt + WAIT_LIMIT_MS;
    await expectError(await joinPost(t, room, 'WRONG1'), 'wrong_invite_code');
    await expectError(await joinPost(t, room), 'match_over');
    expectCancelled(await state(t, room.room_id, room.token), STACK);
  });

  it('after the dissolution, actions and leave of seat 0 answer 409 match_over with the cancelled state', async () => {
    const t = makeEnv();
    const room = await openRoom(t);
    t.clock.ms = room.createdAt + WAIT_LIMIT_MS;
    await t.referee(room.room_id).alarm();
    const acted = await expectError(
      await actPost(t, room.room_id, room.token, {
        turn_id: 't_1',
        type: 'check',
      }),
      'match_over',
    );
    expectCancelled(errorState(acted), STACK);
    const left = await expectError(
      await leavePost(t, room.room_id, room.token),
      'match_over',
    );
    expectCancelled(errorState(left), STACK);
  });

  it('joining at created_at + 299_999 still works and cancels the 5-minute rule: the alarm moves to the first deadline and the room keeps playing past 5 min', async () => {
    const t = makeEnv();
    const room = await openRoom(t, { turn_seconds: 60 });
    t.clock.ms = room.createdAt + WAIT_LIMIT_MS - 1;
    const response = await joinPost(t, room);
    expect(response.status).toBe(200);
    const joinedAt = t.clock.ms;
    expect(t.storage(room.room_id).alarm).toBe(joinedAt + 60_000);
    t.clock.ms = room.createdAt + WAIT_LIMIT_MS + 1_000;
    await t.referee(room.room_id).alarm();
    const alice = await yourTurn(t, room.room_id, room.token);
    expect(alice.room_status).toBe('playing');
    expect(alice.hand_number).toBe(1);
  });

  it('A8: the one hour of the tokens counts from the dissolution (created_at + 5 min), even if nobody asked in between', async () => {
    const t = makeEnv();
    const room = await openRoom(t);
    t.clock.ms = room.createdAt + WAIT_LIMIT_MS + HOUR_MS;
    expectCancelled(await state(t, room.room_id, room.token), STACK);

    const u = makeEnv();
    const other = await openRoom(u);
    u.clock.ms = other.createdAt + WAIT_LIMIT_MS + HOUR_MS + 1;
    await expectError(
      await get(u.env, `/v1/rooms/${other.room_id}/state`, other.token),
      'invalid_token',
    );
  });
});

describe('狀況處理 平台出錯', () => {
  it.each(['alarm()', 'state catch-up without alarm()'] as const)(
    '%s: a rejected timeout action ends the room as void for both seats and clears the alarm',
    async trigger => {
      const t = makeEnv();
      const { roomId, tokens } = await seededRoom(t, {
        hands: 2,
        turn_seconds: 10,
        starting_stack: STACK,
      });
      const turn = await yourTurn(t, roomId, tokens[0]);
      const storage = t.storage(roomId);
      const stored = await storage.get<{
        turn: { seat: Seat };
        match: { toAct: Seat };
      }>('room');
      if (stored === undefined) throw new Error('expected stored room');
      expect(stored.turn.seat).toBe(stored.match.toAct);
      // Model a platform fault: the scheduled actor disagrees with the engine.
      stored.turn.seat = stored.match.toAct === 0 ? 1 : 0;
      await storage.put('room', stored);
      // Eviction and wake-up reload the persisted fault into a fresh referee.
      t.restart(roomId);
      t.clock.ms = Date.parse(turn.deadline) + 1;
      expect(storage.alarm).not.toBeNull();

      const expectVoid = (status: Status) => {
        const over = asMatchOver(status);
        expect(over).toMatchObject({
          result: 'void',
          room_status: 'void',
          ratings: null,
        });
        expect(over.final_stacks).toHaveLength(2);
        for (const stack of over.final_stacks) {
          expect(Number.isInteger(stack)).toBe(true);
          expect(stack).toBeGreaterThanOrEqual(0);
        }
        expect(over.final_stacks[0] + over.final_stacks[1]).toBe(2 * STACK);
      };

      if (trigger === 'alarm()') await t.referee(roomId).alarm();
      else expectVoid(await state(t, roomId, tokens[0]));
      expect(storage.alarm).toBeNull();

      // Repeated reads must keep succeeding rather than retrying the fault.
      for (let read = 0; read < 2; read++) {
        for (const token of tokens) {
          expectVoid(await state(t, roomId, token));
          expectVoid((await wait(t, roomId, token)).status);
        }
      }
      for (const token of tokens) {
        const rejected = await expectError(
          await actPost(t, roomId, token, {
            turn_id: turn.turn_id,
            type: 'check',
          }),
          'match_over',
        );
        expectVoid(errorState(rejected));
      }
      expect(storage.alarm).toBeNull();
    },
  );
});

// --- 管理員中止 (A9) -----------------------------------------------------------

describe('A9 管理員中止: POST /v1/admin/rooms/{room_id}/abort voids the match', () => {
  // Hand 1: seat 0 folds. Hand 2: seat 1 (button) raises to 6. Then abort.
  const midHand = async (t: TestEnv) => {
    const { roomId, tokens } = await seededRoom(t, {
      hands: 3,
      turn_seconds: 60,
    });
    let match = engineStart(3);
    const alice = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'fold' });
    match = applyOk(match, 0, { type: 'fold' });
    const bob = await yourTurn(t, roomId, tokens[1]);
    await act(t, roomId, tokens[1], {
      turn_id: bob.turn_id,
      type: 'raise',
      amount: 6,
    });
    match = applyOk(match, 1, { type: 'raise', amount: 6 });
    const expected: [number, number] = [
      match.stacks[0] + match.contributed[0],
      match.stacks[1] + match.contributed[1],
    ];
    return { roomId, tokens, match, expected };
  };

  it('a playing room: 200 {status:"aborted", room_id}; then both seats get match_over void, room_status void, ratings null, final_stacks with the unfinished hand called off', async () => {
    const t = makeEnv();
    const { roomId, tokens, expected } = await midHand(t);
    expect(expected).toEqual([STACK - 1, STACK + 1]);
    await abort(t, roomId);
    for (const seat of [0, 1] as const) {
      for (const status of [
        await state(t, roomId, tokens[seat]),
        (await wait(t, roomId, tokens[seat])).status,
      ]) {
        expect(asMatchOver(status)).toMatchObject({
          result: 'void',
          room_status: 'void',
          to_act_seat: null,
          ratings: null,
          final_stacks: expected,
          match_id: roomId,
        });
      }
    }
  });

  it("the opponent's pending wait answers match_over void at once when the room is aborted", async () => {
    const t = makeEnv({ waitMs: 3_000 });
    const { roomId, tokens } = await seededRoom(t, {
      hands: 2,
      turn_seconds: 60,
    });
    const pending = wait(t, roomId, tokens[1]);
    await sleep(50);
    await abort(t, roomId);
    const { status, elapsedMs } = await pending;
    expect(asMatchOver(status)).toMatchObject({
      result: 'void',
      room_status: 'void',
    });
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it('a waiting room (no opponent yet) is voided too: final_stacks [start, start], view null; joining afterwards answers 409 match_over', async () => {
    const t = makeEnv();
    const room = await openRoom(t, { starting_stack: 100 });
    await abort(t, room.room_id);
    const over = asMatchOver(await state(t, room.room_id, room.token));
    expect(over).toMatchObject({
      result: 'void',
      room_status: 'void',
      view: null,
      hand_number: null,
      final_stacks: [100, 100],
      ratings: null,
    });
    await expectError(await joinPost(t, room), 'match_over');
    expect(t.storage(room.room_id).alarm).toBeNull();
  });

  it('after abort: actions answer 409 match_over with the void state, leave answers 409 match_over, the alarm is deleted and no timeout is ever played', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await seededRoom(t, {
      hands: 2,
      turn_seconds: 10,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    expect(t.storage(roomId).alarm).not.toBeNull();
    await abort(t, roomId);
    expect(t.storage(roomId).alarm).toBeNull();
    const acted = await expectError(
      await actPost(t, roomId, tokens[0], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'match_over',
    );
    expect(asMatchOver(errorState(acted)).result).toBe('void');
    for (const token of tokens) {
      const left = await expectError(
        await leavePost(t, roomId, token),
        'match_over',
      );
      expect(asMatchOver(errorState(left)).result).toBe('void');
    }
    t.clock.ms += 60_000;
    await t.referee(roomId).alarm();
    expect(asMatchOver(await state(t, roomId, tokens[1]))).toMatchObject({
      result: 'void',
      final_stacks: [STACK, STACK],
    });
  });

  const endings = [
    {
      case: 'a complete match',
      end: async (t: TestEnv) => {
        const { roomId, tokens } = await seededRoom(t, { hands: 1 });
        const alice = await yourTurn(t, roomId, tokens[0]);
        await act(t, roomId, tokens[0], {
          turn_id: alice.turn_id,
          type: 'fold',
        });
        return roomId;
      },
    },
    {
      case: 'a leave while playing',
      end: async (t: TestEnv) => {
        const { roomId, tokens } = await seededRoom(t, { hands: 2 });
        await readStatus(await leavePost(t, roomId, tokens[1]));
        return roomId;
      },
    },
    {
      case: 'a cancelled waiting room (seat 0 left)',
      end: async (t: TestEnv) => {
        const room = await openRoom(t);
        await readStatus(await leavePost(t, room.room_id, room.token));
        return room.room_id;
      },
    },
    {
      case: 'a dissolved waiting room (5 minutes)',
      end: async (t: TestEnv) => {
        const room = await openRoom(t);
        t.clock.ms = room.createdAt + WAIT_LIMIT_MS;
        await t.referee(room.room_id).alarm();
        return room.room_id;
      },
    },
    {
      case: 'an aborted room',
      end: async (t: TestEnv) => {
        const { roomId } = await seededRoom(t, { hands: 2 });
        await abort(t, roomId);
        return roomId;
      },
    },
  ];

  it.each(endings)(
    'aborting a room that already ended ($case) answers 409 match_over in the error format, and the result is unchanged',
    async ({ end }) => {
      const t = makeEnv();
      const roomId = await end(t);
      const before = await t.storage(roomId).get('room');
      await expectError(await abortPost(t, roomId), 'match_over');
      expect(await t.storage(roomId).get('room')).toEqual(before);
    },
  );

  it('aborting an already-ended room gives the seatless admin an ended-room hint without referring to state', async () => {
    const t = makeEnv();
    const roomId = await endings[0].end(t);
    const body = await expectError(await abortPost(t, roomId), 'match_over');
    expect(body).not.toHaveProperty('state');
    expect(body.hint).not.toMatch(/state/i);
    expect(body.hint).toMatch(/already.*ended/i);
  });

  it.each(['r_zzzzz99999', 'nope', 'r_ABC'])(
    'an unknown or malformed room id (%s) answers 404 room_not_found',
    async roomId => {
      const t = makeEnv();
      await expectError(await abortPost(t, roomId), 'room_not_found');
    },
  );

  it('a wrong admin key answers 401 invalid_token and the room keeps playing', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await seededRoom(t, { hands: 2 });
    await expectError(await abortPost(t, roomId, 'wrong-key'), 'invalid_token');
    expect((await yourTurn(t, roomId, tokens[0])).room_status).toBe('playing');
  });

  it('A8: a room aborted over an hour ago answers abort with 409 match_over (not invalid_token), while its room endpoints answer 401 invalid_token', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await seededRoom(t, { hands: 2 });
    await abort(t, roomId);
    t.clock.ms += HOUR_MS;
    expect(asMatchOver(await state(t, roomId, tokens[0])).result).toBe('void');
    t.clock.ms += 1;
    await expectError(
      await get(t.env, `/v1/rooms/${roomId}/state`, tokens[0]),
      'invalid_token',
    );
    await expectError(await abortPost(t, roomId), 'match_over');
  });
});
