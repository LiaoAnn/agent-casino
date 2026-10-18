// T11 slice 3: test rooms and chaos (casino-api skill: 測試房與狀況演練, A11;
// 狀況處理 超時 still holds in chaos rooms). Same harness as
// timeouts.test.ts: HTTP through handle(), one RoomReferee per room id over a
// memory storage with its one alarm, an injected clock. Every env var
// (ALLOW_TEST_ROOMS, DEFAULT_SETTINGS_JSON, DEFAULT_TEST_JSON) is set per test.
//
// Chaos only where ALLOW_TEST_ROOMS is exactly 'true':
// - reject_first_action: each seat's first judged action (its turn, current
//   turn_id) answers 400 invalid_action with the normal state; the turn_id
//   stays usable.
// - extra_waiting N: per turn, the first N waits of the seat to act answer
//   waiting at once; state is not affected; the deadline still counts.
// - fail_request_every N: per seat, every Nth token request (wait, state,
//   actions, leave) answers 503 unavailable and does nothing.
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
import { legalActions, type Seat, startMatch } from '../holdem/match';
import { dealHand } from '../holdem/shuffle';
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

// `vars` are the env vars on top of ALLOW_TEST_ROOMS='true'; a var set to
// undefined is left out of the env.
const makeEnv = (
  options: { waitMs?: number; vars?: Record<string, string | undefined> } = {},
): TestEnv => {
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
  } as Record<string, unknown>;
  const vars = { ALLOW_TEST_ROOMS: 'true', ...options.vars };
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) env[key] = value;
  }
  return {
    env: env as unknown as Bindings,
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

// Seat 0 alice opens a room with `body` (settings, test); seat 1 bob joins.
const startRoom = async (t: TestEnv, body: Record<string, unknown> = {}) => {
  const created = await post(t.env, '/v1/rooms', {
    game: 'holdem',
    name: 'alice',
    ...body,
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

// A seeded chaos room.
const chaosRoom = (
  t: TestEnv,
  chaos: Record<string, unknown>,
  settings: Record<string, unknown> = { hands: 2, turn_seconds: 10 },
) => startRoom(t, { settings, test: { seed: SEED, chaos } });

// --- More helpers -----------------------------------------------------------

const PRODUCTION_LIKE = [
  { case: 'ALLOW_TEST_ROOMS unset', allow: undefined },
  { case: "ALLOW_TEST_ROOMS='TRUE'", allow: 'TRUE' },
  { case: "ALLOW_TEST_ROOMS='1'", allow: '1' },
];

const retryableOf = (body: ErrorBody) =>
  (body as ErrorBody & { retryable?: boolean }).retryable;

// 503 unavailable, retryable, in the standard error format.
const expectUnavailable = async (response: Response) => {
  const body = await expectError(response, 'unavailable');
  expect(body.status).toBe('error');
  expect(retryableOf(body)).toBe(true);
};

const iso = (ms: number) => new Date(ms).toISOString();

const statePath = (roomId: string) => `/v1/rooms/${roomId}/state`;
const waitPath = (roomId: string) => `/v1/rooms/${roomId}/wait`;

// Hand 1 position right after the join.
const opening = () =>
  startMatch({ seed: SEED, hands: 2, startingStack: STACK });

// --- reject_first_action --------------------------------------------------------

describe('A11 chaos reject_first_action: each seat’s first judged action answers invalid_action', () => {
  it('seat 0’s first (legal) action answers 400 invalid_action, retryable, with the normal your_turn; nothing applied; the same action with the same turn_id is then accepted', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await chaosRoom(t, {
      reject_first_action: true,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    expect(alice.legal_actions).toEqual(legalActions(opening()));
    const body = await expectError(
      await actPost(t, roomId, tokens[0], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'invalid_action',
    );
    expect(retryableOf(body)).toBe(true);
    expect(errorState(body)).toEqual(alice);
    // Not applied, turn_id and deadline unchanged.
    expect(await yourTurn(t, roomId, tokens[0])).toEqual(alice);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    const bob = await yourTurn(t, roomId, tokens[1]);
    expect(bob.view?.history.at(-1)).toMatchObject({ seat: 0, type: 'call' });
  });

  it('happens once per seat: seat 1’s first action is rejected too after seat 0’s; later actions of either seat are judged normally', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await chaosRoom(t, {
      reject_first_action: true,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    await expectError(
      await actPost(t, roomId, tokens[0], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'invalid_action',
    );
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    const bob = await yourTurn(t, roomId, tokens[1]);
    const rejected = await expectError(
      await actPost(t, roomId, tokens[1], {
        turn_id: bob.turn_id,
        type: 'check',
      }),
      'invalid_action',
    );
    expect(errorState(rejected)).toEqual(bob);
    await act(t, roomId, tokens[1], { turn_id: bob.turn_id, type: 'check' });
    // Flop: seat 1 acts first, accepted at once.
    const bobFlop = await yourTurn(t, roomId, tokens[1]);
    await act(t, roomId, tokens[1], {
      turn_id: bobFlop.turn_id,
      type: 'check',
    });
    const aliceFlop = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], {
      turn_id: aliceFlop.turn_id,
      type: 'check',
    });
  });

  it('not_your_turn and stale_turn answer as usual and do not count as the first action', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await chaosRoom(t, {
      reject_first_action: true,
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    await expectError(
      await actPost(t, roomId, tokens[1], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'not_your_turn',
    );
    await expectError(
      await actPost(t, roomId, tokens[0], { turn_id: 't_999', type: 'call' }),
      'stale_turn',
    );
    await expectError(
      await actPost(t, roomId, tokens[0], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'invalid_action',
    );
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    // A duplicate answers accepted + duplicate as usual.
    const again = await act(t, roomId, tokens[0], {
      turn_id: alice.turn_id,
      type: 'call',
    });
    expect(again.duplicate).toBe(true);
    // Seat 1's not_your_turn above did not use up its rejection.
    const bob = await yourTurn(t, roomId, tokens[1]);
    await expectError(
      await actPost(t, roomId, tokens[1], {
        turn_id: bob.turn_id,
        type: 'check',
      }),
      'invalid_action',
    );
  });

  it.each(PRODUCTION_LIKE)(
    'is ignored with $case: the first action is accepted',
    async ({ allow }) => {
      const t = makeEnv({ vars: { ALLOW_TEST_ROOMS: allow } });
      const { roomId, tokens } = await chaosRoom(t, {
        reject_first_action: true,
      });
      const alice = await yourTurn(t, roomId, tokens[0]);
      await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    },
  );
});

// --- extra_waiting ---------------------------------------------------------------

describe('A11 chaos extra_waiting: the first N waits of the seat to act answer waiting', () => {
  it('N=2: two waits answer waiting at once (room_status playing), the third answers your_turn with the deadline from the turn start; state is not affected and does not count', async () => {
    const t = makeEnv({ waitMs: 2_000 });
    const { roomId, tokens, joinedAt } = await chaosRoom(t, {
      extra_waiting: 2,
    });
    const fromState = await yourTurn(t, roomId, tokens[0]);
    expect(fromState.seconds_remaining).toBe(10);
    for (let i = 0; i < 2; i++) {
      t.clock.ms += 1_000;
      const { status, elapsedMs } = await wait(t, roomId, tokens[0]);
      expect(status).toMatchObject({
        status: 'waiting',
        room_status: 'playing',
        to_act_seat: 0,
      });
      expect(elapsedMs).toBeLessThan(1_000);
      const current = await yourTurn(t, roomId, tokens[0]);
      expect(current.seconds_remaining).toBe(9 - i);
      expect(current).toEqual({ ...fromState, seconds_remaining: 9 - i });
    }
    const { status } = await wait(t, roomId, tokens[0]);
    expect(status.status === 'your_turn' && status.seconds_remaining).toBe(8);
    expect(status).toEqual({ ...fromState, seconds_remaining: 8 });
    expect(status.status === 'your_turn' && status.deadline).toBe(
      iso(joinedAt + 10_000),
    );
  });

  it('every new turn of the seat gets N fake waitings again; the opponent’s waits are unaffected (they hold as usual)', async () => {
    const t = makeEnv({ waitMs: 300 });
    const { roomId, tokens } = await chaosRoom(t, { extra_waiting: 1 });
    // Seat 1 is not to act: its wait holds for the window, as usual.
    const held = await wait(t, roomId, tokens[1]);
    expect(held.status.status).toBe('waiting');
    expect(held.elapsedMs).toBeGreaterThanOrEqual(250);
    // Seat 0: one fake waiting, then your_turn.
    expect((await wait(t, roomId, tokens[0])).status.status).toBe('waiting');
    const alice = await wait(t, roomId, tokens[0]);
    expect(alice.status.status).toBe('your_turn');
    if (alice.status.status !== 'your_turn') throw new Error('your_turn');
    await act(t, roomId, tokens[0], {
      turn_id: alice.status.turn_id,
      type: 'call',
    });
    // Seat 1's turn: one fake waiting.
    const bobFake = await wait(t, roomId, tokens[1]);
    expect(bobFake.status.status).toBe('waiting');
    expect(bobFake.elapsedMs).toBeLessThan(250);
    const bob = await wait(t, roomId, tokens[1]);
    expect(bob.status.status).toBe('your_turn');
    if (bob.status.status !== 'your_turn') throw new Error('your_turn');
    await act(t, roomId, tokens[1], {
      turn_id: bob.status.turn_id,
      type: 'check',
    });
    // Flop: seat 1 again, a new turn: one fake waiting again.
    expect((await wait(t, roomId, tokens[1])).status.status).toBe('waiting');
    expect((await wait(t, roomId, tokens[1])).status.status).toBe('your_turn');
  });

  it('a wait already pending when the turn arrives counts as one of the N: it answers waiting', async () => {
    const t = makeEnv({ waitMs: 3_000 });
    const { roomId, tokens } = await chaosRoom(t, { extra_waiting: 2 });
    const pending = wait(t, roomId, tokens[1]);
    await sleep(50);
    const alice = await yourTurn(t, roomId, tokens[0]);
    await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });
    const first = await pending;
    expect(first.status).toMatchObject({ status: 'waiting', to_act_seat: 1 });
    expect(first.elapsedMs).toBeLessThan(1_500);
    expect((await wait(t, roomId, tokens[1])).status.status).toBe('waiting');
    expect((await wait(t, roomId, tokens[1])).status.status).toBe('your_turn');
  });

  it('超時 still holds: fake waitings do not move the deadline; at the deadline the turn is timed out', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await chaosRoom(t, {
      extra_waiting: 5,
    });
    for (let i = 0; i < 3; i++) {
      expect((await wait(t, roomId, tokens[0])).status.status).toBe('waiting');
    }
    t.clock.ms = joinedAt + 10_000;
    await t.referee(roomId).alarm();
    const bob = await yourTurn(t, roomId, tokens[1]);
    expect(bob.hand_number).toBe(2);
    expect(bob.last_hand).toMatchObject({ winner_seat: 1, ended_by: 'fold' });
  });

  it.each(PRODUCTION_LIKE)(
    'is ignored with $case: the first wait answers your_turn',
    async ({ allow }) => {
      const t = makeEnv({ vars: { ALLOW_TEST_ROOMS: allow } });
      const { roomId, tokens } = await chaosRoom(t, { extra_waiting: 2 });
      expect((await wait(t, roomId, tokens[0])).status.status).toBe(
        'your_turn',
      );
    },
  );
});

// --- fail_request_every ------------------------------------------------------------

describe('A11 chaos fail_request_every: every Nth token request of a seat answers 503 and does nothing', () => {
  it('the 503 message distinguishes an intentional chaos drop from a genuine DO outage', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await chaosRoom(t, { fail_request_every: 2 });
    await readStatus(await get(t.env, statePath(roomId), tokens[0]));
    const body = await expectError(
      await get(t.env, statePath(roomId), tokens[0]),
      'unavailable',
    );
    expect(retryableOf(body)).toBe(true);
    expect(body.message).not.toBe('The room could not be reached');
    expect(body.message).toMatch(/dropped.*on purpose|chaos/i);
  });

  it('N=3, counted per seat: each seat’s 3rd and 6th request answer 503 unavailable, retryable; the others answer normally; create and join do not count', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await chaosRoom(t, { fail_request_every: 3 });
    for (let n = 1; n <= 6; n++) {
      for (const seat of [0, 1] as const) {
        const response = await get(t.env, statePath(roomId), tokens[seat]);
        if (n % 3 === 0) await expectUnavailable(response);
        else await readStatus(response);
      }
    }
  });

  it('the counts are separate: seat 1’s requests do not move seat 0’s count', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await chaosRoom(t, { fail_request_every: 2 });
    await readStatus(await get(t.env, statePath(roomId), tokens[0]));
    for (let i = 0; i < 3; i++) {
      // Seat 1: 1 ok, 2 fails, 3 ok.
      const response = await get(t.env, statePath(roomId), tokens[1]);
      if (i === 1) await expectUnavailable(response);
      else await readStatus(response);
    }
    await expectUnavailable(await get(t.env, statePath(roomId), tokens[0]));
  });

  it('an action sent as the Nth request is not applied; resent afterwards it is accepted normally', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await chaosRoom(t, { fail_request_every: 3 });
    // Requests 1 and 2.
    const alice = await yourTurn(t, roomId, tokens[0]);
    await readStatus(await get(t.env, statePath(roomId), tokens[0]));
    // Request 3: dropped.
    await expectUnavailable(
      await actPost(t, roomId, tokens[0], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
    );
    // Request 4: nothing changed.
    expect(await yourTurn(t, roomId, tokens[0])).toEqual(alice);
    // Request 5: accepted, not a duplicate.
    const accepted = await act(t, roomId, tokens[0], {
      turn_id: alice.turn_id,
      type: 'call',
    });
    expect(accepted.duplicate).toBeUndefined();
  });

  it('a leave sent as the Nth request does not leave', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await chaosRoom(t, { fail_request_every: 2 });
    await readStatus(await get(t.env, statePath(roomId), tokens[1]));
    await expectUnavailable(await leavePost(t, roomId, tokens[1]));
    const alice = await yourTurn(t, roomId, tokens[0]);
    expect(alice.room_status).toBe('playing');
  });

  it('a wait sent as the Nth request answers 503 at once', async () => {
    const t = makeEnv({ waitMs: 3_000 });
    const { roomId, tokens } = await chaosRoom(t, { fail_request_every: 2 });
    await readStatus(await get(t.env, statePath(roomId), tokens[1]));
    const started = performance.now();
    await expectUnavailable(await get(t.env, waitPath(roomId), tokens[1]));
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('超時 still holds: the turn times out at the deadline whatever the dropped requests', async () => {
    const t = makeEnv();
    const { roomId, tokens, joinedAt } = await chaosRoom(t, {
      fail_request_every: 2,
    });
    t.clock.ms = joinedAt + 10_000;
    await t.referee(roomId).alarm();
    const bob = await yourTurn(t, roomId, tokens[1]);
    expect(bob.hand_number).toBe(2);
    await expectUnavailable(await get(t.env, statePath(roomId), tokens[1]));
  });

  it('with reject_first_action too, a dropped (503) action does not count as the first action', async () => {
    const t = makeEnv();
    const { roomId, tokens } = await chaosRoom(t, {
      fail_request_every: 2,
      reject_first_action: true,
    });
    // 1: state.
    const alice = await yourTurn(t, roomId, tokens[0]);
    const call = { turn_id: alice.turn_id, type: 'call' };
    // 2: dropped.
    await expectUnavailable(await actPost(t, roomId, tokens[0], call));
    // 3: the first judged action: rejected.
    await expectError(
      await actPost(t, roomId, tokens[0], call),
      'invalid_action',
    );
    // 4: dropped.
    await expectUnavailable(await actPost(t, roomId, tokens[0], call));
    // 5: accepted.
    await act(t, roomId, tokens[0], call);
  });

  it.each(PRODUCTION_LIKE)(
    'is ignored with $case: every request answers normally',
    async ({ allow }) => {
      const t = makeEnv({ vars: { ALLOW_TEST_ROOMS: allow } });
      const { roomId, tokens } = await chaosRoom(t, { fail_request_every: 2 });
      for (let i = 0; i < 6; i++) {
        await readStatus(await get(t.env, statePath(roomId), tokens[0]));
      }
    },
  );
});

// --- DEFAULT_SETTINGS_JSON / DEFAULT_TEST_JSON (A11) ------------------------------

describe('A11 DEFAULT_SETTINGS_JSON: the default settings of every room on the deployment', () => {
  it.each([
    { case: 'with ALLOW_TEST_ROOMS=true', allow: 'true' },
    ...PRODUCTION_LIKE,
  ])(
    '$case, a room without settings uses them (turn_seconds 5, starting_stack 100, hands 3)',
    async ({ allow }) => {
      const t = makeEnv({
        vars: {
          ALLOW_TEST_ROOMS: allow,
          DEFAULT_SETTINGS_JSON:
            '{"turn_seconds":5,"hands":3,"starting_stack":100}',
        },
      });
      const { roomId, tokens, joinedAt } = await startRoom(t);
      let turn = await yourTurn(t, roomId, tokens[0]);
      expect(turn.deadline).toBe(iso(joinedAt + 5_000));
      expect(turn.view).toMatchObject({ my_stack: 99, opponent_stack: 98 });
      // 3 hands: the small blind folds each one; then the match is over.
      for (let hand = 1; hand <= 3; hand++) {
        const seat = turn.to_act_seat as Seat;
        await act(t, roomId, tokens[seat], {
          turn_id: turn.turn_id,
          type: 'fold',
        });
        if (hand === 3) break;
        turn = await yourTurn(t, roomId, tokens[seat === 0 ? 1 : 0]);
        expect(turn.hand_number).toBe(hand + 1);
      }
      expect((await state(t, roomId, tokens[0])).status).toBe('match_over');
    },
  );

  it('per key: request settings win over DEFAULT_SETTINGS_JSON, which wins over the built-in defaults', async () => {
    const t = makeEnv({
      vars: {
        DEFAULT_SETTINGS_JSON: '{"turn_seconds":5,"starting_stack":100}',
      },
    });
    const { roomId, tokens, joinedAt } = await startRoom(t, {
      settings: { turn_seconds: 30 },
    });
    const turn = await yourTurn(t, roomId, tokens[0]);
    expect(turn.deadline).toBe(iso(joinedAt + 30_000));
    expect(turn.view).toMatchObject({ my_stack: 99, opponent_stack: 98 });

    const u = makeEnv({
      vars: { DEFAULT_SETTINGS_JSON: '{"turn_seconds":5}' },
    });
    const other = await startRoom(u);
    const otherTurn = await yourTurn(u, other.roomId, other.tokens[0]);
    expect(otherTurn.deadline).toBe(iso(other.joinedAt + 5_000));
    // Built-in starting_stack 40.
    expect(otherTurn.view).toMatchObject({ my_stack: 39, opponent_stack: 38 });
  });
});

describe('A11 DEFAULT_TEST_JSON: default test settings, only where ALLOW_TEST_ROOMS=true', () => {
  it('{"seed"} deals dealHand(seed, 1) to a room without test', async () => {
    const t = makeEnv({ vars: { DEFAULT_TEST_JSON: `{"seed":"${SEED}"}` } });
    const { roomId, tokens } = await startRoom(t);
    const deal = dealHand(SEED, 1);
    const alice = await state(t, roomId, tokens[0]);
    const bob = await state(t, roomId, tokens[1]);
    expect(alice.view?.my_cards).toEqual(deal.holeCards[0]);
    expect(bob.view?.my_cards).toEqual(deal.holeCards[1]);
  });

  it('{"chaos":{"extra_waiting":1}} makes every room a chaos room', async () => {
    const t = makeEnv({
      vars: { DEFAULT_TEST_JSON: '{"chaos":{"extra_waiting":1}}' },
    });
    const { roomId, tokens } = await startRoom(t);
    expect((await wait(t, roomId, tokens[0])).status.status).toBe('waiting');
    expect((await wait(t, roomId, tokens[0])).status.status).toBe('your_turn');
  });

  it('merged shallowly with the request test: request {seed} + default {chaos} gives both', async () => {
    const OTHER_SEED = 'a'.repeat(64);
    const t = makeEnv({
      vars: { DEFAULT_TEST_JSON: '{"chaos":{"reject_first_action":true}}' },
    });
    const { roomId, tokens } = await startRoom(t, {
      test: { seed: OTHER_SEED },
    });
    const alice = await yourTurn(t, roomId, tokens[0]);
    expect(alice.view?.my_cards).toEqual(dealHand(OTHER_SEED, 1).holeCards[0]);
    await expectError(
      await actPost(t, roomId, tokens[0], {
        turn_id: alice.turn_id,
        type: 'call',
      }),
      'invalid_action',
    );
  });

  it('request test keys win: request hex seed overrides the default hex seed', async () => {
    const OTHER_SEED = 'a'.repeat(64);
    const t = makeEnv({ vars: { DEFAULT_TEST_JSON: `{"seed":"${SEED}"}` } });
    const { roomId, tokens } = await startRoom(t, {
      test: { seed: OTHER_SEED },
    });
    const alice = await state(t, roomId, tokens[0]);
    expect(alice.view?.my_cards).toEqual(dealHand(OTHER_SEED, 1).holeCards[0]);
  });

  it.each(PRODUCTION_LIKE)(
    'is never read with $case: no seed, no chaos, and even invalid JSON is not an error',
    async ({ allow }) => {
      const t = makeEnv({
        vars: {
          ALLOW_TEST_ROOMS: allow,
          DEFAULT_TEST_JSON: `{"seed":"${SEED}","chaos":{"reject_first_action":true}}`,
        },
      });
      const { roomId, tokens } = await startRoom(t);
      const alice = await yourTurn(t, roomId, tokens[0]);
      const bob = await state(t, roomId, tokens[1]);
      const deal = dealHand(SEED, 1);
      expect([alice.view?.my_cards, bob.view?.my_cards]).not.toEqual([
        deal.holeCards[0],
        deal.holeCards[1],
      ]);
      await act(t, roomId, tokens[0], { turn_id: alice.turn_id, type: 'call' });

      const u = makeEnv({
        vars: { ALLOW_TEST_ROOMS: allow, DEFAULT_TEST_JSON: '{not json' },
      });
      const other = await startRoom(u);
      expect((await state(u, other.roomId, other.tokens[0])).status).toBe(
        'your_turn',
      );
    },
  );
});

describe('A11 misconfigured defaults are loud: POST /v1/rooms answers 500 internal', () => {
  it.each([
    { var: 'DEFAULT_SETTINGS_JSON', value: '{not json', allow: undefined },
    {
      var: 'DEFAULT_SETTINGS_JSON',
      value: '{"turn_seconds":1}',
      allow: undefined,
    },
    { var: 'DEFAULT_SETTINGS_JSON', value: '{"hands":"many"}', allow: 'true' },
    { var: 'DEFAULT_SETTINGS_JSON', value: '[]', allow: 'true' },
    { var: 'DEFAULT_TEST_JSON', value: '{not json', allow: 'true' },
    {
      var: 'DEFAULT_TEST_JSON',
      value: `{"seed":"${'A'.repeat(64)}"}`,
      allow: 'true',
    },
    {
      var: 'DEFAULT_TEST_JSON',
      value: '{"chaos":{"fail_request_every":1}}',
      allow: 'true',
    },
  ])(
    '$var=$value (ALLOW_TEST_ROOMS=$allow)',
    async ({ var: name, value, allow }) => {
      const t = makeEnv({ vars: { ALLOW_TEST_ROOMS: allow, [name]: value } });
      const response = await post(t.env, '/v1/rooms', {
        game: 'holdem',
        name: 'alice',
      });
      await expectError(response, 'internal');
    },
  );
});
