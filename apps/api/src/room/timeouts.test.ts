// T11 slice 1: timeouts (casino-api skill: 狀況處理 (超時, 連續 3 次超時, 太晚或
// 還沒輪到, 斷線), A3, A9, A15; holdem-rules: 超時動作). Everything goes over
// HTTP through handle(); the Room DO namespace is faked with one RoomReferee
// per room id, each with a memory storage that records its one alarm. The
// clock is injected; nothing really sleeps for a timeout. The pure engine is
// the oracle for every position.
//
// Timing rules these tests pin down: a timeout is played AT its deadline, so
// the next turn's deadline is the previous deadline + turn_seconds, however
// late the alarm or request ran. "Due" is now >= deadline. Any request first
// plays everything already due. An absent seat (3 consecutive timeouts) is
// played for the instant its turn starts.
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
  type HandRecord,
  legalActions,
  type MatchState,
  type Seat,
  startMatch,
} from '../holdem/match';
import { viewFor } from '../holdem/view';
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
    ADMIN_KEY: 'test-admin-key',
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
    settings: { blind_every: 50, ...settings },
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
  startMatch({
    seed: SEED,
    maxHands: hands,
    blindEvery: 50,
    startingStack: STACK,
  });

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

// holdem-rules 超時動作: check when check is legal, else fold.
const timeoutActionFor = (match: MatchState): Action =>
  legalActions(match).some(action => action.type === 'check')
    ? { type: 'check' }
    : { type: 'fold' };

// The engine after the seat to act times out.
const timedOut = (match: MatchState): MatchState => {
  const seat = match.toAct;
  if (seat === null) throw new Error('nobody to act');
  return applyOk(match, seat, timeoutActionFor(match), { timeout: true });
};

// A passive player: check when it can, else call.
const passive = (legal: YourTurn['legal_actions']): Action =>
  legal.some(action => action.type === 'check')
    ? { type: 'check' }
    : { type: 'call' };

// `status` shows the engine's position to `seat`.
const expectPosition = (status: Status, match: MatchState, seat: Seat) => {
  const seen = viewFor(match, seat);
  expect(status.hand_number).toBe(seen.hand_number);
  expect(status.to_act_seat).toBe(seen.to_act_seat);
  expect(status.view).toEqual(
    seen.view === null ? null : { ...seen.view, pots: [seen.view.pot] },
  );
};

const iso = (ms: number) => new Date(ms).toISOString();

// --- 超時: the timeout action -------------------------------------------------

describe('狀況處理 超時: at the deadline the server plays the timeout action', () => {
  it('超時動作 check: the big blind with check legal is checked for at the deadline by alarm(), history timeout:true', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    let match = engineStart(2);
    t.clock.ms = joinedAt + 1_000;
    const alice = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    match = applyOk(match, 0, { type: 'call' });
    // The engine confirms check is legal for seat 1 here.
    expect(match.toAct).toBe(1);
    expect(legalActions(match).map(a => a.type)).toContain('check');
    const bob = await yourTurn(t, roomId, tokens[1]);
    const deadline = joinedAt + 1_000 + 20_000;
    expect(bob.deadline).toBe(iso(deadline));

    t.clock.ms = deadline;
    await t.referee(roomId).alarm();
    match = timedOut(match);

    const after = await state(t, roomId, tokens[1]);
    expectPosition(after, match, 1);
    expect(after.view?.history.at(-1)).toEqual({
      seat: 1,
      street: 'preflop',
      type: 'check',
      timeout: true,
    });
    // Only the server's step is marked.
    expect(
      after.view?.history.filter(event => event.timeout === true),
    ).toHaveLength(1);
  });

  it('超時動作 fold: preflop the small blind facing the big blind (no check) is folded at the deadline; the hand record has timeout:true', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    let match = engineStart(2);
    expect(match.toAct).toBe(0);
    expect(legalActions(match).map(a => a.type)).not.toContain('check');

    t.clock.ms = joinedAt + 20_000;
    await t.referee(roomId).alarm();
    match = timedOut(match);

    const bob = await state(t, roomId, tokens[1]);
    expectPosition(bob, match, 1);
    expect(bob.status).toBe('your_turn');
    expect(bob.hand_number).toBe(2);
    expect(bob.status === 'your_turn' && bob.last_hand).toMatchObject({
      hand_number: 1,
      blinds: [1, 2],
      winner_seat: 1,
      ended_by: 'fold',
    });
    const hand1 = await t.storage(roomId).get<HandRecord>('hand:1');
    expect(hand1?.events.at(-1)).toEqual({
      seat: 0,
      street: 'preflop',
      type: 'fold',
      timeout: true,
    });
    const alice = await state(t, roomId, tokens[0]);
    expectPosition(alice, match, 0);
    expect(alice.status).toBe('waiting');
  });

  it('超時 (alarm): after the join the alarm is scheduled at the first deadline; after an action, at the next deadline', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    expect(t.storage(roomId).alarm).toBe(joinedAt + 20_000);
    t.clock.ms = joinedAt + 3_000;
    const alice = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    expect(t.storage(roomId).alarm).toBe(joinedAt + 3_000 + 20_000);
    const bob = await yourTurn(t, roomId, tokens[1]);
    expect(bob.deadline).toBe(iso(t.storage(roomId).alarm ?? 0));
  });

  it('超時 (alarm): while the room waits for an opponent the only alarm is the 5-minute dissolution, not a turn deadline', async () => {
    const t = makeEnv();
    const createdAt = t.clock.ms;
    const created = await post(t.env, '/v1/rooms', {
      game: 'holdem',
      name: 'alice',
      settings: { turn_seconds: 10 },
    });
    const room = decodeCreate(await created.json());
    // spec requires 等人超過 5 分鐘 (slice 2): a waiting room is due to dissolve
    // at created_at + 5 min, so that alarm is scheduled from the start.
    expect(t.storage(room.room_id).alarm).toBe(createdAt + 300_000);
  });

  it('超時 (alarm): alarm() 1 ms before the deadline plays nothing; the turn and the alarm stay', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const before = await yourTurn(t, roomId, tokens[0]);
    expect(before.seconds_remaining).toBe(20);
    t.clock.ms = joinedAt + 20_000 - 1;
    await t.referee(roomId).alarm();
    const after = await yourTurn(t, roomId, tokens[0]);
    // The remaining 1 ms rounds down to zero; every other field stays equal.
    expect(after.seconds_remaining).toBe(0);
    expect(after).toEqual({ ...before, seconds_remaining: 0 });
    expect(t.storage(roomId).alarm).toBe(joinedAt + 20_000);
  });

  it('超時 (alarm): after a timeout the alarm moves to the next seat’s first deadline = previous deadline + 2 × turn_seconds, even when alarm() runs late', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    // The alarm fires 4 s late.
    t.clock.ms = joinedAt + 20_000 + 4_000;
    await t.referee(roomId).alarm();
    const bob = await yourTurn(t, roomId, tokens[1]);
    expect(bob.deadline).toBe(iso(joinedAt + 40_000));
    expect(t.storage(roomId).alarm).toBe(joinedAt + 40_000);
  });

  it("超時 + 斷線: the opponent's pending wait answers your_turn as soon as alarm() plays the timeout", async () => {
    const t = makeEnv({ waitMs: 3_000 });
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const pending = wait(t, roomId, tokens[1]);
    await sleep(50);
    t.clock.ms = joinedAt + 20_000;
    await t.referee(roomId).alarm();
    const { status, elapsedMs } = await pending;
    expect(status.status).toBe('your_turn');
    expect(status.hand_number).toBe(2);
    expect(elapsedMs).toBeLessThan(1_500);
    expectPosition(status, timedOut(engineStart(2)), 1);
  });
});

// --- Lazy catch-up --------------------------------------------------------------

describe('狀況處理 超時 (catch-up): any request first plays what is already due', () => {
  it('state after the deadline (no alarm call) shows the timed-out position with the deterministic next deadline', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    t.clock.ms = joinedAt + 20_000 + 3_000;
    const match = timedOut(engineStart(2));
    const bob = await yourTurn(t, roomId, tokens[1]);
    expectPosition(bob, match, 1);
    expect(bob.deadline).toBe(iso(joinedAt + 40_000));
    const alice = await state(t, roomId, tokens[0]);
    expect(alice.status).toBe('waiting');
    expectPosition(alice, match, 0);
  });

  it('wait after the deadline answers your_turn to the opponent at once', async () => {
    const t = makeEnv({ waitMs: 3_000 });
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    t.clock.ms = joinedAt + 20_000;
    const { status, elapsedMs } = await wait(t, roomId, tokens[1]);
    expect(status.status).toBe('your_turn');
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it('an action after the deadline is judged against the caught-up position (the opponent now to act gets stale_turn for an unknown turn_id, not not_your_turn)', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    t.clock.ms = joinedAt + 20_000;
    const error = await expectError(
      await actPost(t, roomId, tokens[1], { turn_id: 't_999', type: 'call' }),
      'stale_turn',
    );
    const current = errorState(error);
    expect(current.status).toBe('your_turn');
    expectPosition(current, timedOut(engineStart(2)), 1);
  });

  it('leave after the deadline first plays the timeout: final_stacks include the timed-out hand', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    t.clock.ms = joinedAt + 20_000;
    const over = await readStatus(await leavePost(t, roomId, tokens[1]));
    const match = timedOut(engineStart(2));
    expect(over).toMatchObject({
      status: 'match_over',
      result: 'loss',
      // Hand 2 is called off: its blinds go back.
      final_stacks: [
        match.stacks[0] + match.contributed[0],
        match.stacks[1] + match.contributed[1],
      ],
    });
    expect(over.status === 'match_over' && over.final_stacks).toEqual([
      STACK - 1,
      STACK + 1,
    ]);
  });

  it('several overdue turns are all played in one catch-up, each at its own deadline (3 turns at +50 s, 2 turns at +45 s)', async () => {
    for (const [advance, turns] of [
      [50_000, 3],
      [45_000, 2],
    ] as const) {
      const t = makeEnv();
      const { roomId, tokens, joinedAt } = await seededRoom(t, {
        max_hands: 10,
        turn_seconds: 10,
      });
      let match = engineStart(10);
      for (let i = 0; i < turns; i++) match = timedOut(match);
      t.clock.ms = joinedAt + advance;
      const toAct = match.toAct as Seat;
      const status = await yourTurn(t, roomId, tokens[toAct]);
      expectPosition(status, match, toAct);
      expect(status.hand_number).toBe(turns + 1);
      const nextDeadline = joinedAt + (turns + 3) * 10_000;
      expect(status.deadline).toBe(iso(nextDeadline));
      expect(t.storage(roomId).alarm).toBe(nextDeadline);
    }
  });
});

// --- A3 / 太晚 ---------------------------------------------------------------------

describe('A3 + 狀況處理 太晚: a timeout uses up the turn_id', () => {
  it('A3: after a timeout the old turn_id answers 409 stale_turn with the state of the new position (opponent to act)', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    t.clock.ms = joinedAt + 20_000;
    await t.referee(roomId).alarm();
    const error = await expectError(
      await actPost(t, roomId, tokens[0], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'stale_turn',
    );
    const current = errorState(error);
    expect(current.status).toBe('waiting');
    expectPosition(current, timedOut(engineStart(2)), 0);
  });

  it('A3: after a timeout the old turn_id answers 409 stale_turn even when the same seat is to act again (flop after a timed-out check)', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    const bob = await yourTurn(t, roomId, tokens[1]);
    t.clock.ms = joinedAt + 20_000;
    await t.referee(roomId).alarm();
    const match = timedOut(applyOk(engineStart(2), 0, { type: 'call' }));
    expect(match.toAct).toBe(1);
    const error = await expectError(
      await actPost(t, roomId, tokens[1], {
        turn_id: bob.turn_id,
        type: 'check',
      }),
      'stale_turn',
    );
    const current = errorState(error);
    expect(current.status).toBe('your_turn');
    expectPosition(current, match, 1);
    expect(current.status === 'your_turn' && current.turn_id).not.toBe(
      bob.turn_id,
    );
    // The stale action changed nothing.
    expectPosition(await state(t, roomId, tokens[1]), match, 1);
  });

  it('太晚: an action arriving exactly at the deadline is late: 409 stale_turn, and the turn was played by timeout', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    t.clock.ms = joinedAt + 20_000;
    const error = await expectError(
      await actPost(t, roomId, tokens[0], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'stale_turn',
    );
    const match = timedOut(engineStart(2));
    expectPosition(errorState(error), match, 0);
    const hand1 = await t.storage(roomId).get<HandRecord>('hand:1');
    expect(hand1?.events.at(-1)).toMatchObject({ type: 'fold', timeout: true });
  });

  it('太晚 (boundary): an action 1 ms before the deadline is accepted', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    t.clock.ms = joinedAt + 20_000 - 1;
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    const bob = await yourTurn(t, roomId, tokens[1]);
    expect(bob.view?.history.some(event => event.timeout)).toBe(false);
  });
});

// --- 連續 3 次超時 / A9 ----------------------------------------------------------

describe('狀況處理 連續 3 次超時 / A9: a seat with 3 consecutive timeouts is absent', () => {
  it('after its 3rd consecutive timeout, every later turn of that seat is played at once (no wait for the deadline) until match_over; it never gets your_turn again', async () => {
    const t = makeEnv();
    const HANDS = 10;
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: HANDS,
      turn_seconds: 10,
    });
    let match = engineStart(HANDS);

    // Timeout 1: seat 0 (small blind) is folded at +20 s.
    t.clock.ms = joinedAt + 20_000;
    match = timedOut(match);
    // Hand 2: seat 1 (button) calls at +21 s.
    t.clock.ms = joinedAt + 21_000;
    const bob1 = await yourTurn(t, roomId, tokens[1]);
    expectPosition(bob1, match, 1);
    await act(t, roomId, tokens[1], { turn_id: bob1.turn_id, type: 'call' });
    match = applyOk(match, 1, { type: 'call' });
    // Timeout 2: seat 0 (big blind) is checked for at +31 s.
    t.clock.ms = joinedAt + 31_000;
    match = timedOut(match);
    expect(match.toAct).toBe(0);
    // Timeout 3: seat 0 acts first on the flop and is checked for at +41 s.
    t.clock.ms = joinedAt + 41_000;
    match = timedOut(match);
    expect(match.toAct).toBe(1);
    const bob2 = await yourTurn(t, roomId, tokens[1]);
    expectPosition(bob2, match, 1);
    expect(bob2.deadline).toBe(iso(joinedAt + 51_000));

    // From here the clock never moves: seat 0 is absent.
    let steps = 0;
    for (;;) {
      const bob = await state(t, roomId, tokens[1]);
      if (bob.status === 'match_over') break;
      expect(bob.status).toBe('your_turn');
      if (bob.status !== 'your_turn') throw new Error('expected your_turn');
      expectPosition(bob, match, 1);
      expect(bob.deadline).toBe(iso(t.clock.ms + 10_000));
      const alice = await state(t, roomId, tokens[0]);
      expect(alice.status).toBe('waiting');
      const action = passive(bob.legal_actions);
      await act(t, roomId, tokens[1], { turn_id: bob.turn_id, ...action });
      match = applyOk(match, 1, action);
      while (!match.over && match.toAct === 0) match = timedOut(match);
      if (++steps > 500) throw new Error('match did not end');
    }
    expect(match.over).toBe(true);
    for (const seat of [0, 1] as const) {
      const over = await state(t, roomId, tokens[seat]);
      expect(over.status).toBe('match_over');
      expect(over.status === 'match_over' && over.final_stacks).toEqual(
        match.stacks,
      );
    }
    expect(t.clock.ms).toBe(joinedAt + 41_000);
    expect(t.storage(roomId).alarm).toBeNull();
  });

  it('an absent seat cannot recover: its later state/wait never show your_turn and its actions are refused (not_your_turn or stale_turn)', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 10,
      turn_seconds: 10,
    });
    // Same opening as above: seat 0 times out 3 times in a row.
    t.clock.ms = joinedAt + 21_000;
    const bob1 = await yourTurn(t, roomId, tokens[1]);
    await act(t, roomId, tokens[1], { turn_id: bob1.turn_id, type: 'call' });
    t.clock.ms = joinedAt + 41_000;
    const bob2 = await yourTurn(t, roomId, tokens[1]);
    // Seat 0 comes back and asks for the state, then waits.
    const alice = await state(t, roomId, tokens[0]);
    expect(alice.status).toBe('waiting');
    // Seat 1 checks; the turn street goes to seat 0, played at once.
    await act(t, roomId, tokens[1], { turn_id: bob2.turn_id, type: 'check' });
    const bob3 = await yourTurn(t, roomId, tokens[1]);
    expect(bob3.view?.street).toBe('turn');
    expect(bob3.view?.history.at(-1)).toEqual({
      seat: 0,
      street: 'turn',
      type: 'check',
      timeout: true,
    });
    const aliceWait = await wait(t, roomId, tokens[0]);
    expect(aliceWait.status.status).toBe('waiting');
    for (const turnId of ['t_1', 't_3', 't_4', bob3.turn_id, 't_999']) {
      const response = await actPost(t, roomId, tokens[0], {
        turn_id: turnId,
        type: 'check',
      });
      expect(response.status).toBe(409);
      const body = (await response.json()) as ErrorBody;
      expect(['not_your_turn', 'stale_turn']).toContain(body.code);
    }
    // Seat 1 checks again: the river goes to seat 0, again played at once.
    await act(t, roomId, tokens[1], { turn_id: bob3.turn_id, type: 'check' });
    const bob4 = await yourTurn(t, roomId, tokens[1]);
    expect(bob4.view?.street).toBe('river');
    expect(bob4.view?.history.at(-1)).toMatchObject({
      seat: 0,
      timeout: true,
    });
    expect((await state(t, roomId, tokens[0])).status).toBe('waiting');
  });

  it('only consecutive timeouts count: timed out twice, then acts, then times out once more is NOT absent (still gets your_turn with a full deadline)', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 10,
      turn_seconds: 10,
    });
    let match = engineStart(10);
    // Timeout 1 at +20 s (seat 0 folds hand 1).
    t.clock.ms = joinedAt + 20_000;
    match = timedOut(match);
    t.clock.ms = joinedAt + 21_000;
    const bob1 = await yourTurn(t, roomId, tokens[1]);
    await act(t, roomId, tokens[1], { turn_id: bob1.turn_id, type: 'call' });
    match = applyOk(match, 1, { type: 'call' });
    // Timeout 2 at +31 s (seat 0 checked for preflop).
    t.clock.ms = joinedAt + 31_000;
    match = timedOut(match);
    // Seat 0 acts itself on the flop at +32 s: the count resets.
    t.clock.ms = joinedAt + 32_000;
    const alice1 = await yourTurn(t, roomId, tokens[0]);
    expectPosition(alice1, match, 0);
    await act(t, roomId, tokens[0], { turn_id: alice1.turn_id, type: 'check' });
    match = applyOk(match, 0, { type: 'check' });
    t.clock.ms = joinedAt + 33_000;
    const bob2 = await yourTurn(t, roomId, tokens[1]);
    await act(t, roomId, tokens[1], { turn_id: bob2.turn_id, type: 'check' });
    match = applyOk(match, 1, { type: 'check' });
    // Timeout 3 overall, but only 1 in a row: seat 0 on the turn at +43 s.
    t.clock.ms = joinedAt + 43_000;
    match = timedOut(match);
    const bob3 = await yourTurn(t, roomId, tokens[1]);
    expectPosition(bob3, match, 1);
    await act(t, roomId, tokens[1], { turn_id: bob3.turn_id, type: 'check' });
    match = applyOk(match, 1, { type: 'check' });
    // The river: seat 0 is not absent, so it is its turn, with a full deadline.
    const alice2 = await yourTurn(t, roomId, tokens[0]);
    expectPosition(alice2, match, 0);
    expect(alice2.view?.street).toBe('river');
    expect(alice2.deadline).toBe(iso(joinedAt + 53_000));
    expect(t.storage(roomId).alarm).toBe(joinedAt + 53_000);
    expect((await state(t, roomId, tokens[1])).status).toBe('waiting');
  });

  it('when both seats never act, both become absent and the match plays through to match_over at a deterministic instant (not 1 ms earlier)', async () => {
    const HANDS = 10;
    // The oracle: each timeout at its deadline; an absent seat at its turn's start.
    let match = engineStart(HANDS);
    const counts = [0, 0];
    let at = 0;
    const deadlines: number[] = [];
    while (!match.over) {
      const seat = match.toAct as Seat;
      at =
        (counts[seat] ?? 0) >= 3
          ? at
          : at + ((counts[seat] ?? 0) === 0 ? 20_000 : 10_000);
      deadlines.push(at);
      match = timedOut(match);
      counts[seat] = (counts[seat] ?? 0) + 1;
    }
    const endsAt = at;
    // Sanity: the last turns took no time at all.
    expect(deadlines.at(-1)).toBe(deadlines.at(-2));

    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: HANDS,
      turn_seconds: 10,
    });
    t.clock.ms = joinedAt + endsAt - 1;
    const before = await state(t, roomId, tokens[0]);
    expect(before.status).not.toBe('match_over');
    expect(t.storage(roomId).alarm).toBe(joinedAt + endsAt);

    t.clock.ms = joinedAt + endsAt;
    await t.referee(roomId).alarm();
    expect(t.storage(roomId).alarm).toBeNull();
    for (const seat of [0, 1] as const) {
      const over = await state(t, roomId, tokens[seat]);
      expect(over.status).toBe('match_over');
      expect(over.status === 'match_over' && over.final_stacks).toEqual(
        match.stacks,
      );
    }
    for (let hand = 1; hand <= HANDS; hand++) {
      const record = await t.storage(roomId).get<HandRecord>(`hand:${hand}`);
      const played = record?.events.filter(e => e.type !== 'post_blind');
      expect(played?.length).toBeGreaterThan(0);
      expect(played?.every(e => e.timeout === true)).toBe(true);
    }
  });
});

// --- Match end and the alarm ----------------------------------------------------

describe('超時 (alarm): nothing is due after the match ends, so the alarm is deleted', () => {
  it('a 1-hand match ended by a timeout fold: alarm set before, null after', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 1,
      turn_seconds: 10,
    });
    expect(t.storage(roomId).alarm).toBe(joinedAt + 20_000);
    t.clock.ms = joinedAt + 20_000;
    await t.referee(roomId).alarm();
    expect(t.storage(roomId).alarm).toBeNull();
    const over = await state(t, roomId, tokens[0]);
    expect(over).toMatchObject({ status: 'match_over', result: 'loss' });
  });

  it('a match ended by an accepted fold: alarm set before, null after', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 1,
      turn_seconds: 10,
    });
    expect(t.storage(roomId).alarm).toBe(joinedAt + 20_000);
    const alice = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'fold' });
    expect(t.storage(roomId).alarm).toBeNull();
  });

  it('a match ended by leave: alarm set before, null after; a later alarm() changes nothing', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    expect(t.storage(roomId).alarm).toBe(joinedAt + 20_000);
    const left = await readStatus(await leavePost(t, roomId, tokens[0]));
    expect(t.storage(roomId).alarm).toBeNull();
    t.clock.ms = joinedAt + 60_000;
    await t.referee(roomId).alarm();
    expect(await state(t, roomId, tokens[0])).toEqual(left);
    expect(t.storage(roomId).alarm).toBeNull();
  });
});

// --- 斷線 --------------------------------------------------------------------------

describe('狀況處理 斷線: the match goes on; state or wait picks it up', () => {
  it('a seat that went silent through a timeout comes back with state and wait, sees the current position and acts with the new turn_id', async () => {
    const t = makeEnv({ waitMs: 3_000 });
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    let match = engineStart(2);
    const alice = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    match = applyOk(match, 0, { type: 'call' });
    // Bob is gone past his deadline; his preflop check is played for him.
    t.clock.ms = joinedAt + 22_000;
    match = timedOut(match);
    const back = await yourTurn(t, roomId, tokens[1]);
    expectPosition(back, match, 1);
    expect(back.view?.street).toBe('flop');
    expect(back.deadline).toBe(iso(joinedAt + 30_000));
    const { status, elapsedMs } = await wait(t, roomId, tokens[1]);
    expect(elapsedMs).toBeLessThan(1_500);
    expect(status).toEqual(back);
    await act(t, roomId, tokens[1], { turn_id: back.turn_id, type: 'check' });
    match = applyOk(match, 1, { type: 'check' });
    expectPosition(await yourTurn(t, roomId, tokens[0]), match, 0);
  });
});

// --- 收到什麼就做什麼: late or not your turn → don't resend, go back to wait ----

describe('收到什麼就做什麼 (error 且太晚或沒輪到 → 不重交，回去 wait): stale_turn and not_your_turn hints', () => {
  // The hint sends the agent back to wait and never asks for a resend.
  const expectBackToWait = (body: ErrorBody, roomId: string) => {
    expect(body.hint).toContain(`GET /v1/rooms/${roomId}/wait`);
    expect(body.hint).not.toContain('turn_id');
    expect(body.hint.toLowerCase()).not.toContain('send it with');
    expect(body.hint).toMatch(/(do not|don't|never) resend/i);
  };

  it('stale_turn for an unknown turn_id while it IS the seat’s turn', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    await yourTurn(t, roomId, tokens[0]);
    const body = await expectError(
      await actPost(t, roomId, tokens[0], { turn_id: 't_999', type: 'call' }),
      'stale_turn',
    );
    expectBackToWait(body, roomId);
  });

  it('stale_turn for a timed-out turn_id when the same seat is to act again (A3)', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    const bob = await yourTurn(t, roomId, tokens[1]);
    t.clock.ms = joinedAt + 20_000;
    const body = await expectError(
      await actPost(t, roomId, tokens[1], {
        turn_id: bob.turn_id,
        type: 'check',
      }),
      'stale_turn',
    );
    expect(errorState(body).status).toBe('your_turn');
    expectBackToWait(body, roomId);
  });

  it('stale_turn for a timed-out turn_id when the opponent is to act (A3)', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    t.clock.ms = joinedAt + 20_000;
    const body = await expectError(
      await actPost(t, roomId, tokens[0], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'stale_turn',
    );
    expect(errorState(body).status).toBe('waiting');
    expectBackToWait(body, roomId);
  });

  it("stale_turn for the other seat's accepted turn_id", async () => {
    const t = makeEnv();
    const { roomId, tokens } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    await yourTurn(t, roomId, tokens[1]);
    const body = await expectError(
      await actPost(t, roomId, tokens[1], {
        turn_id: alice.turn_id,
        type: 'check',
      }),
      'stale_turn',
    );
    expectBackToWait(body, roomId);
  });

  it('not_your_turn for the seat not to act, and for seat 0 before anyone joined', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await seededRoom(t, {
      max_hands: 2,
      turn_seconds: 10,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    const body = await expectError(
      await actPost(t, roomId, tokens[1], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'not_your_turn',
    );
    expectBackToWait(body, roomId);

    const created = await post(t.env, '/v1/rooms', {
      game: 'holdem',
      name: 'carol',
    });
    const waiting = decodeCreate(await created.json());
    const early = await expectError(
      await actPost(t, waiting.room_id, waiting.token, {
        turn_id: 't_1',
        type: 'check',
      }),
      'not_your_turn',
    );
    expectBackToWait(early, waiting.room_id);
  });
});
