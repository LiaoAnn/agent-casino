// T09 slice 1: open a room, join with an invite code, `state` and `wait`
// (casino-api skill: 名字規則, 房間 token, 端點, A4, A6, A8, A14, A15;
// holdem-rules: 房間預設設定, 一手牌的流程, 種子與洗牌). Everything goes over
// HTTP through handle(); the Room DO namespace is faked with one RoomReferee
// per room id.
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { handle } from '../app';
import { ERROR_STATUS, type ErrorCode } from '../contract/errors';
import {
  ActionAccepted,
  CreateRoomResponse,
  JoinResponse,
  RoomStatus,
} from '../contract/schemas';
import {
  type Action,
  applyAction,
  legalActions,
  type MatchState,
  type Seat,
  startMatch,
} from '../holdem/match';
import { dealHand } from '../holdem/shuffle';
import { viewFor } from '../holdem/view';
import { RoomReferee, type RoomStorage } from '../room/referee';
import { signRoomToken, verifyRoomToken } from '../token/token';
import type { Bindings } from './env';

const BASE = 'http://api.test';
const TOKEN_SECRET = 'test-token-secret';
const ADMIN_KEY = 'test-admin-key';
const NEVER_CREATED = 'r_zzzzz99999';
const SEED = 12345;

// --- Fakes ------------------------------------------------------------------

class MemoryStorage implements RoomStorage {
  readonly #data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#data.set(key, structuredClone(value));
  }
}

interface Clock {
  ms: number;
}

interface TestEnv {
  env: Bindings;
  clock: Clock;
}

// Whole seconds, so a deadline without milliseconds still compares equal.
const startOfSecond = () => Math.floor(Date.now() / 1000) * 1000;

const makeEnv = (
  options: { waitMs?: number; allowTestRooms?: boolean } = {},
): TestEnv => {
  const clock: Clock = { ms: startOfSecond() };
  const referees = new Map<string, RoomReferee>();
  const ROOM = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let referee = referees.get(id);
      if (referee === undefined) {
        referee = new RoomReferee(new MemoryStorage(), {
          waitMs: options.waitMs ?? 300,
          now: () => clock.ms,
        });
        referees.set(id, referee);
      }
      return referee;
    },
  };
  const env = {
    TOKEN_SECRET,
    ADMIN_KEY,
    DB: {},
    ROOM,
    MATCHMAKER: {},
    ...(options.allowTestRooms ? { ALLOW_TEST_ROOMS: 'true' } : {}),
  } as unknown as Bindings;
  return { env, clock };
};

// --- HTTP helpers -----------------------------------------------------------

const post = (env: Bindings, path: string, body: unknown) =>
  handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

interface ErrorBody {
  status: 'error';
  code: string;
  message: string;
  hint: string;
  retryable: boolean;
  state?: unknown;
}

const expectError = async (
  response: Response,
  code: ErrorCode,
  retryable = false,
): Promise<ErrorBody> => {
  expect(response.headers.get('content-type') ?? '').toContain(
    'application/json',
  );
  const body = (await response.json()) as ErrorBody;
  expect({ status: response.status, code: body.code }).toEqual({
    status: ERROR_STATUS[code],
    code,
  });
  expect(body).toMatchObject({
    status: 'error',
    message: expect.any(String),
    hint: expect.any(String),
    retryable,
  });
  expect(body.message.length).toBeGreaterThan(0);
  expect(body.hint.length).toBeGreaterThan(0);
  return body;
};

const decodeCreate = Schema.decodeUnknownSync(CreateRoomResponse);
const decodeJoin = Schema.decodeUnknownSync(JoinResponse);
const decodeStatus = Schema.decodeUnknownSync(RoomStatus);

type Created = typeof CreateRoomResponse.Type;
type Joined = typeof JoinResponse.Type;
type Status = typeof RoomStatus.Type;

const createRoom = async (
  env: Bindings,
  body: Record<string, unknown> = {},
): Promise<Created> => {
  const response = await post(env, '/v1/rooms', {
    game: 'holdem',
    name: 'alice',
    ...body,
  });
  expect(response.status).toBe(200);
  return decodeCreate(await response.json());
};

const joinRoom = async (
  env: Bindings,
  room: Created,
  body: Record<string, unknown> = {},
): Promise<Joined> => {
  const response = await post(env, `/v1/rooms/${room.room_id}/join`, {
    name: 'bob',
    invite_code: room.invite_code,
    ...body,
  });
  expect(response.status).toBe(200);
  return decodeJoin(await response.json());
};

interface StatusResult {
  status: Status;
  raw: string;
}

const readStatus = async (response: Response): Promise<StatusResult> => {
  expect(response.status).toBe(200);
  const raw = await response.text();
  return { status: decodeStatus(JSON.parse(raw)), raw };
};

const state = async (
  env: Bindings,
  roomId: string,
  token: string,
): Promise<StatusResult> =>
  readStatus(await get(env, `/v1/rooms/${roomId}/state`, token));

const wait = async (
  env: Bindings,
  roomId: string,
  token: string,
): Promise<StatusResult & { elapsedMs: number }> => {
  const started = performance.now();
  const result = await readStatus(
    await get(env, `/v1/rooms/${roomId}/wait`, token),
  );
  return { ...result, elapsedMs: performance.now() - started };
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// A room where alice (seat 0) and bob (seat 1) both sat down.
const startedRoom = async (
  t: TestEnv,
  body: Record<string, unknown> = {},
): Promise<{ room: Created; joined: Joined }> => {
  const room = await createRoom(t.env, body);
  const joined = await joinRoom(t.env, room);
  return { room, joined };
};

// --- POST /v1/rooms ---------------------------------------------------------

describe('POST /v1/rooms', () => {
  it('answers 200 with room_id, invite_code, seat 0, token and hint', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    expect(room.room_id).toMatch(/^r_[a-z0-9]{10}$/);
    expect(room.invite_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(room.seat).toBe(0);
    expect(room.token.length).toBeGreaterThan(0);
  });

  it('hint names GET /v1/rooms/<room_id>/wait and says to share room_id and invite_code', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    expect(room.hint).toContain(`GET /v1/rooms/${room.room_id}/wait`);
    expect(room.hint).toContain('room_id');
    expect(room.hint).toContain('invite_code');
    expect(room.hint.toLowerCase()).toContain('opponent');
  });

  it('two creates give different room_ids', async () => {
    const { env } = makeEnv();
    const a = await createRoom(env);
    const b = await createRoom(env);
    expect(a.room_id).not.toBe(b.room_id);
  });

  it('the token is a room token for that room, seat 0 and the name', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    const check = await verifyRoomToken(
      room.token,
      TOKEN_SECRET,
      room.room_id,
      Date.now(),
    );
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.claims).toMatchObject({
        room_id: room.room_id,
        seat: 0,
        name: 'alice',
      });
    }
  });

  it('out-of-range settings answer 400 invalid_request', async () => {
    const { env } = makeEnv();
    await expectError(
      await post(env, '/v1/rooms', {
        game: 'holdem',
        name: 'alice',
        settings: { hands: 0 },
      }),
      'invalid_request',
    );
  });

  it.each([
    { case: 'bad characters', name: 'bad name!' },
    { case: 'too long', name: 'a'.repeat(33) },
    { case: 'empty', name: '' },
  ])('a name with $case answers 400 name_invalid', async ({ name }) => {
    const { env } = makeEnv();
    await expectError(
      await post(env, '/v1/rooms', { game: 'holdem', name }),
      'name_invalid',
    );
  });

  it.each(['house-bot', 'House-Bot'])(
    'the reserved name %s answers 400 name_invalid asking for another name',
    async name => {
      const { env } = makeEnv();
      const body = await expectError(
        await post(env, '/v1/rooms', { game: 'holdem', name }),
        'name_invalid',
      );
      expect(body.message.toLowerCase()).toMatch(/another|different/);
    },
  );
});

// --- Settings and test seed -------------------------------------------------

describe('room settings', () => {
  it('omitted settings use starting_stack 40 (stacks after blinds 39 / 38)', async () => {
    const t = makeEnv();
    const { room, joined } = await startedRoom(t);
    const alice = await state(t.env, room.room_id, room.token);
    expect(alice.status.view).toMatchObject({
      my_stack: 39,
      opponent_stack: 38,
    });
    const bob = await state(t.env, room.room_id, joined.token);
    expect(bob.status.view).toMatchObject({ my_stack: 38, opponent_stack: 39 });
  });

  it('omitted settings use turn_seconds 60 for the deadline', async () => {
    const t = makeEnv();
    const room = await createRoom(t.env);
    const joinedAt = t.clock.ms;
    await joinRoom(t.env, room);
    const { status } = await state(t.env, room.room_id, room.token);
    expect(status.status).toBe('your_turn');
    if (status.status === 'your_turn') {
      expect(Date.parse(status.deadline)).toBe(joinedAt + 60_000);
    }
  });

  it('given settings are used (starting_stack 100, turn_seconds 30)', async () => {
    const t = makeEnv();
    const room = await createRoom(t.env, {
      settings: { hands: 3, turn_seconds: 30, starting_stack: 100 },
    });
    const joinedAt = t.clock.ms;
    await joinRoom(t.env, room);
    const { status } = await state(t.env, room.room_id, room.token);
    expect(status.view).toMatchObject({ my_stack: 99, opponent_stack: 98 });
    expect(status.status).toBe('your_turn');
    if (status.status === 'your_turn') {
      expect(Date.parse(status.deadline)).toBe(joinedAt + 30_000);
    }
  });

  it('with ALLOW_TEST_ROOMS=true, test.seed deals dealHand(seed, 1) to each seat', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { room, joined } = await startedRoom(t, { test: { seed: SEED } });
    const deal = dealHand(SEED, 1);
    const alice = await state(t.env, room.room_id, room.token);
    const bob = await state(t.env, room.room_id, joined.token);
    expect(alice.status.view?.my_cards).toEqual(deal.holeCards[0]);
    expect(bob.status.view?.my_cards).toEqual(deal.holeCards[1]);
  });

  it('without ALLOW_TEST_ROOMS, a room with test.seed still works', async () => {
    const t = makeEnv();
    const { room } = await startedRoom(t, { test: { seed: SEED } });
    const { status } = await state(t.env, room.room_id, room.token);
    expect(status.status).toBe('your_turn');
  });
});

// --- POST /v1/rooms/{room_id}/join -------------------------------------------

describe('POST /v1/rooms/{room_id}/join', () => {
  it('answers 200 with room_id, seat 1, token and a hint naming wait', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    const joined = await joinRoom(env, room);
    expect(joined.room_id).toBe(room.room_id);
    expect(joined.seat).toBe(1);
    expect(joined.hint).toContain(`GET /v1/rooms/${room.room_id}/wait`);
  });

  it('the token is a room token for that room, seat 1 and the name', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    const joined = await joinRoom(env, room);
    const check = await verifyRoomToken(
      joined.token,
      TOKEN_SECRET,
      room.room_id,
      Date.now(),
    );
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.claims).toMatchObject({
        room_id: room.room_id,
        seat: 1,
        name: 'bob',
      });
    }
  });

  it('compares the invite code case-insensitively', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    const joined = await joinRoom(env, room, {
      invite_code: room.invite_code.toLowerCase(),
    });
    expect(joined.seat).toBe(1);
  });

  it('a wrong invite code answers 403 wrong_invite_code', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    const wrong = room.invite_code === 'AAAAAA' ? 'BBBBBB' : 'AAAAAA';
    await expectError(
      await post(env, `/v1/rooms/${room.room_id}/join`, {
        name: 'bob',
        invite_code: wrong,
      }),
      'wrong_invite_code',
    );
  });

  it.each([NEVER_CREATED, 'nope', 'r_ABC'])(
    'room %s answers 404 room_not_found',
    async roomId => {
      const { env } = makeEnv();
      await expectError(
        await post(env, `/v1/rooms/${roomId}/join`, {
          name: 'bob',
          invite_code: 'ABC234',
        }),
        'room_not_found',
      );
    },
  );

  it('a third player answers 409 room_full', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    await joinRoom(env, room);
    await expectError(
      await post(env, `/v1/rooms/${room.room_id}/join`, {
        name: 'carol',
        invite_code: room.invite_code,
      }),
      'room_full',
    );
  });

  it.each([
    { case: 'the name of seat 0 in another case', name: 'ALICE' },
    { case: 'the reserved name house-bot', name: 'house-bot' },
    { case: 'a malformed name', name: 'bad name!' },
  ])('$case answers 400 name_invalid', async ({ name }) => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    await expectError(
      await post(env, `/v1/rooms/${room.room_id}/join`, {
        name,
        invite_code: room.invite_code,
      }),
      'name_invalid',
    );
  });

  it('after a refused join the seat is still free', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    await expectError(
      await post(env, `/v1/rooms/${room.room_id}/join`, {
        name: 'alice',
        invite_code: room.invite_code,
      }),
      'name_invalid',
    );
    const joined = await joinRoom(env, room);
    expect(joined.seat).toBe(1);
  });
});

// --- GET state / wait --------------------------------------------------------

describe('GET /v1/rooms/{room_id}/state before the opponent joins', () => {
  it('answers waiting with room_status waiting and no view', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    const { status } = await state(env, room.room_id, room.token);
    expect(status).toMatchObject({
      status: 'waiting',
      room_status: 'waiting',
      to_act_seat: null,
      hand_number: null,
      view: null,
    });
    expect(status.hint.toLowerCase()).toContain('wait');
  });
});

describe('hand 1 after the join', () => {
  it('seat 0 (button, small blind) has your_turn with the full preflop view', async () => {
    const t = makeEnv();
    const { room } = await startedRoom(t);
    const { status } = await state(t.env, room.room_id, room.token);
    expect(status).toMatchObject({
      status: 'your_turn',
      room_status: 'playing',
      to_act_seat: 0,
      hand_number: 1,
      last_hand: null,
      view: {
        street: 'preflop',
        my_seat: 0,
        button_seat: 0,
        board: [],
        pot: 3,
        my_stack: 39,
        opponent_stack: 38,
        my_bet_this_street: 1,
        opponent_bet_this_street: 2,
        history: [
          { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
          { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
        ],
      },
    });
    if (status.status !== 'your_turn') return;
    expect(typeof status.turn_id).toBe('string');
    expect(status.turn_id.length).toBeGreaterThan(0);
    expect(status.legal_actions).toEqual(
      expect.arrayContaining([
        { type: 'fold' },
        { type: 'call', amount: 1 },
        { type: 'raise', min: 4, max: 40 },
      ]),
    );
  });

  it('the deadline is the turn start + turn_seconds, not moved by later calls', async () => {
    const t = makeEnv();
    const room = await createRoom(t.env, { settings: { turn_seconds: 45 } });
    const joinedAt = t.clock.ms;
    await joinRoom(t.env, room);
    t.clock.ms += 5_000;
    const { status } = await state(t.env, room.room_id, room.token);
    expect(status.status).toBe('your_turn');
    if (status.status !== 'your_turn') return;
    expect(status.deadline).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
    );
    expect(Date.parse(status.deadline)).toBe(joinedAt + 45_000);
  });

  it('your_turn hint names POST /v1/rooms/<room_id>/actions and turn_id', async () => {
    const t = makeEnv();
    const { room } = await startedRoom(t);
    const { status } = await state(t.env, room.room_id, room.token);
    expect(status.hint).toContain(`POST /v1/rooms/${room.room_id}/actions`);
    expect(status.hint).toContain('turn_id');
  });

  it('seat 1 gets waiting with room_status playing, to_act_seat 0 and its view', async () => {
    const t = makeEnv();
    const { room, joined } = await startedRoom(t);
    const { status } = await state(t.env, room.room_id, joined.token);
    expect(status).toMatchObject({
      status: 'waiting',
      room_status: 'playing',
      to_act_seat: 0,
      hand_number: 1,
      view: {
        street: 'preflop',
        my_seat: 1,
        button_seat: 0,
        board: [],
        pot: 3,
        my_stack: 38,
        opponent_stack: 39,
        my_bet_this_street: 2,
        opponent_bet_this_street: 1,
      },
    });
  });

  it("never sends a seat the opponent's hole cards", async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { room, joined } = await startedRoom(t, { test: { seed: SEED } });
    const [seat0Cards, seat1Cards] = dealHand(SEED, 1).holeCards;

    const bobState = await state(t.env, room.room_id, joined.token);
    const bobWait = await wait(t.env, room.room_id, joined.token);
    for (const { raw } of [bobState, bobWait]) {
      for (const card of seat0Cards) expect(raw).not.toContain(card);
    }

    const aliceState = await state(t.env, room.room_id, room.token);
    const aliceWait = await wait(t.env, room.room_id, room.token);
    for (const { raw } of [aliceState, aliceWait]) {
      for (const card of seat1Cards) expect(raw).not.toContain(card);
    }
  });

  it('turn_id stays the same across state and wait calls for the same turn', async () => {
    const t = makeEnv();
    const { room } = await startedRoom(t);
    const first = await state(t.env, room.room_id, room.token);
    const second = await state(t.env, room.room_id, room.token);
    const third = await wait(t.env, room.room_id, room.token);
    const ids = [first, second, third].map(({ status }) =>
      status.status === 'your_turn' ? status.turn_id : undefined,
    );
    expect(ids[0]).toEqual(expect.any(String));
    expect(ids).toEqual([ids[0], ids[0], ids[0]]);
  });
});

describe('GET /v1/rooms/{room_id}/wait', () => {
  it('answers your_turn at once when it is already your turn', async () => {
    const t = makeEnv({ waitMs: 2000 });
    const { room } = await startedRoom(t);
    const result = await wait(t.env, room.room_id, room.token);
    expect(result.status.status).toBe('your_turn');
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  it('holds seat 1 for the wait window, then answers waiting', async () => {
    const t = makeEnv({ waitMs: 300 });
    const { room, joined } = await startedRoom(t);
    const result = await wait(t.env, room.room_id, joined.token);
    expect(result.status).toMatchObject({
      status: 'waiting',
      room_status: 'playing',
      to_act_seat: 0,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(280);
  });

  it('holds seat 0 of a waiting room, then answers waiting', async () => {
    const t = makeEnv({ waitMs: 300 });
    const room = await createRoom(t.env);
    const result = await wait(t.env, room.room_id, room.token);
    expect(result.status).toMatchObject({
      status: 'waiting',
      room_status: 'waiting',
      to_act_seat: null,
      hand_number: null,
      view: null,
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(280);
  });

  it('a pending wait of seat 0 answers your_turn as soon as the opponent joins', async () => {
    const t = makeEnv({ waitMs: 2000 });
    const room = await createRoom(t.env);
    const pending = wait(t.env, room.room_id, room.token);
    await sleep(50);
    await joinRoom(t.env, room);
    const result = await pending;
    expect(result.status).toMatchObject({
      status: 'your_turn',
      room_status: 'playing',
      to_act_seat: 0,
      hand_number: 1,
    });
    expect(result.elapsedMs).toBeLessThan(1000);
  });
});

describe('state and wait for a room that was never created', () => {
  const tokenFor = () =>
    signRoomToken(
      { room_id: NEVER_CREATED, seat: 0, name: 'alice' },
      TOKEN_SECRET,
      Date.now(),
    );

  it('state answers 404 room_not_found', async () => {
    const { env } = makeEnv();
    await expectError(
      await get(env, `/v1/rooms/${NEVER_CREATED}/state`, await tokenFor()),
      'room_not_found',
    );
  });

  it('wait answers 404 room_not_found', async () => {
    const { env } = makeEnv();
    await expectError(
      await get(env, `/v1/rooms/${NEVER_CREATED}/wait`, await tokenFor()),
      'room_not_found',
    );
  });
});

// --- T09 slice 2: POST /v1/rooms/{room_id}/actions ----------------------------
// (casino-api skill: POST actions, 錯誤格式, 狀況處理, A3, A4, A6, A15;
// holdem-rules: 一手牌的流程, 整場結束, 引擎的細節定案). The pure engine is the
// oracle for stacks, last_hand and hole cards.

const actPost = (
  env: Bindings,
  roomId: string,
  token: string,
  body: Record<string, unknown>,
) =>
  handle(
    new Request(`${BASE}/v1/rooms/${roomId}/actions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    env,
  );

const decodeAccepted = Schema.decodeUnknownSync(ActionAccepted);
type Accepted = typeof ActionAccepted.Type;

const expectAccepted = async (response: Response): Promise<Accepted> => {
  expect(response.status).toBe(200);
  return decodeAccepted(await response.json());
};

const act = async (
  env: Bindings,
  roomId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Accepted> => expectAccepted(await actPost(env, roomId, token, body));

type YourTurn = Extract<Status, { status: 'your_turn' }>;
type MatchOverStatus = Extract<Status, { status: 'match_over' }>;

const yourTurn = async (
  env: Bindings,
  roomId: string,
  token: string,
): Promise<YourTurn> => {
  const { status } = await state(env, roomId, token);
  expect(status.status).toBe('your_turn');
  if (status.status !== 'your_turn') throw new Error('expected your_turn');
  return status;
};

const asMatchOver = (status: Status): MatchOverStatus => {
  expect(status.status).toBe('match_over');
  if (status.status !== 'match_over') throw new Error('expected match_over');
  return status;
};

// The `state` field an error must carry (A4), checked against RoomStatus.
const errorState = (body: ErrorBody): Status => {
  expect(body.state).toBeDefined();
  return decodeStatus(body.state);
};

// Replays `actions` (seat, action) in the engine from hand 1.
const engineAfter = (
  config: { seed: number; hands: number; startingStack?: number },
  actions: ReadonlyArray<readonly [Seat, Action]>,
): MatchState => {
  let match = startMatch({
    seed: config.seed,
    hands: config.hands,
    startingStack: config.startingStack ?? 40,
  });
  for (const [seat, action] of actions) {
    const result = applyAction(match, seat, action);
    if (!result.ok) throw new Error(result.message);
    match = result.state;
  }
  return match;
};

// A seeded room (seat 0 alice, seat 1 bob) with the given settings.
const seededRoom = async (
  t: TestEnv,
  settings: Record<string, unknown> = {},
) => {
  const { room, joined } = await startedRoom(t, {
    settings,
    test: { seed: SEED },
  });
  return { roomId: room.room_id, tokens: [room.token, joined.token] as const };
};

describe('POST /v1/rooms/{room_id}/actions: accepted', () => {
  it('a legal action with the current turn_id answers 200 accepted with a hint naming wait', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t);
    const turn = await yourTurn(t.env, roomId, tokens[0]);
    const response = await actPost(t.env, roomId, tokens[0], {
      turn_id: turn.turn_id,
      type: 'call',
    });
    expect(response.headers.get('content-type') ?? '').toContain(
      'application/json',
    );
    const body = await expectAccepted(response);
    expect(body.status).toBe('accepted');
    expect(body.duplicate).toBeUndefined();
    expect(body.hint).toContain(`GET /v1/rooms/${roomId}/wait`);
  });

  it('after the action the opponent has your_turn with a new turn_id and the actor is waiting', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t);
    const first = await yourTurn(t.env, roomId, tokens[0]);
    await act(t.env, roomId, tokens[0], {
      turn_id: first.turn_id,
      type: 'call',
    });

    const bob = await yourTurn(t.env, roomId, tokens[1]);
    expect(bob.turn_id).not.toBe(first.turn_id);
    expect(bob.to_act_seat).toBe(1);
    const expected = viewFor(
      engineAfter({ seed: SEED, hands: 10 }, [[0, { type: 'call' }]]),
      1,
    );
    expect(bob.view).toEqual(expected.view);
    expect(bob.legal_actions).toEqual(
      expect.arrayContaining([{ type: 'check' }]),
    );

    const alice = await state(t.env, roomId, tokens[0]);
    expect(alice.status).toMatchObject({
      status: 'waiting',
      room_status: 'playing',
      to_act_seat: 1,
      hand_number: 1,
    });
  });

  it("the opponent's deadline is the time of the action + turn_seconds", async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t, { turn_seconds: 20 });
    const first = await yourTurn(t.env, roomId, tokens[0]);
    t.clock.ms += 7_000;
    const actedAt = t.clock.ms;
    await act(t.env, roomId, tokens[0], {
      turn_id: first.turn_id,
      type: 'call',
    });
    t.clock.ms += 3_000;
    const bob = await yourTurn(t.env, roomId, tokens[1]);
    expect(Date.parse(bob.deadline)).toBe(actedAt + 20_000);
  });

  it('a raise uses amount as the street total and shows in history', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t);
    const first = await yourTurn(t.env, roomId, tokens[0]);
    await act(t.env, roomId, tokens[0], {
      turn_id: first.turn_id,
      type: 'raise',
      amount: 6,
    });
    const bob = await yourTurn(t.env, roomId, tokens[1]);
    const expected = viewFor(
      engineAfter({ seed: SEED, hands: 10 }, [
        [0, { type: 'raise', amount: 6 }],
      ]),
      1,
    );
    expect(bob.view).toEqual(expected.view);
    expect(bob.view?.history.at(-1)).toEqual({
      seat: 0,
      street: 'preflop',
      type: 'raise',
      amount: 6,
    });
  });
});

describe('POST /v1/rooms/{room_id}/actions: the same turn_id twice (A3)', () => {
  it.each([
    { case: 'the same body', resend: { type: 'call' } },
    { case: 'a different action', resend: { type: 'fold' } },
    { case: 'a different raise', resend: { type: 'raise', amount: 999 } },
  ])(
    'resending with $case answers the first accepted body plus duplicate:true',
    async ({ resend }) => {
      const t = makeEnv({ allowTestRooms: true });
      const { roomId, tokens } = await seededRoom(t);
      const first = await yourTurn(t.env, roomId, tokens[0]);
      const accepted = await act(t.env, roomId, tokens[0], {
        turn_id: first.turn_id,
        type: 'call',
      });
      const again = await act(t.env, roomId, tokens[0], {
        turn_id: first.turn_id,
        ...resend,
      });
      expect(again).toEqual({ ...accepted, duplicate: true });
    },
  );

  it('a duplicate changes nothing: same opponent turn_id, history not doubled', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t);
    const first = await yourTurn(t.env, roomId, tokens[0]);
    await act(t.env, roomId, tokens[0], {
      turn_id: first.turn_id,
      type: 'call',
    });
    const before = await yourTurn(t.env, roomId, tokens[1]);
    await act(t.env, roomId, tokens[0], {
      turn_id: first.turn_id,
      type: 'call',
    });
    await act(t.env, roomId, tokens[0], {
      turn_id: first.turn_id,
      type: 'fold',
    });
    const after = await yourTurn(t.env, roomId, tokens[1]);
    expect(after).toEqual(before);
    expect(after.view?.history).toHaveLength(3);
    const alice = await state(t.env, roomId, tokens[0]);
    expect(alice.status).toMatchObject({ status: 'waiting', to_act_seat: 1 });
  });

  it('after the match ended, the last accepted turn_id still answers accepted + duplicate:true', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t, { hands: 1 });
    const first = await yourTurn(t.env, roomId, tokens[0]);
    const accepted = await act(t.env, roomId, tokens[0], {
      turn_id: first.turn_id,
      type: 'fold',
    });
    const again = await act(t.env, roomId, tokens[0], {
      turn_id: first.turn_id,
      type: 'fold',
    });
    expect(again).toEqual({ ...accepted, duplicate: true });
    const { status } = await state(t.env, roomId, tokens[0]);
    expect(status.status).toBe('match_over');
  });
});

describe('POST /v1/rooms/{room_id}/actions: invalid_action (A3)', () => {
  // Seat 0 preflop may fold, call 1, or raise to 4..40.
  it.each([
    {
      case: 'a raise below the minimum',
      body: { type: 'raise', amount: 3 },
      mentions: '4',
    },
    {
      case: 'a raise above the maximum',
      body: { type: 'raise', amount: 41 },
      mentions: '40',
    },
    { case: 'a raise without amount', body: { type: 'raise' }, mentions: '4' },
    {
      case: 'a check when facing a bet',
      body: { type: 'check' },
      mentions: 'check',
    },
  ])(
    '$case answers 400 invalid_action, retryable, saying what was wrong',
    async ({ body, mentions }) => {
      const t = makeEnv({ allowTestRooms: true });
      const { roomId, tokens } = await seededRoom(t);
      const turn = await yourTurn(t.env, roomId, tokens[0]);
      const error = await expectError(
        await actPost(t.env, roomId, tokens[0], {
          turn_id: turn.turn_id,
          ...body,
        }),
        'invalid_action',
        true,
      );
      expect(error.message.toLowerCase()).toContain(mentions);
      expect(error.hint).toContain('legal_actions');
    },
  );

  it('does not use up the turn_id: the same seat then sends a legal action with it', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t);
    const turn = await yourTurn(t.env, roomId, tokens[0]);
    await expectError(
      await actPost(t.env, roomId, tokens[0], {
        turn_id: turn.turn_id,
        type: 'raise',
        amount: 3,
      }),
      'invalid_action',
      true,
    );

    const still = await yourTurn(t.env, roomId, tokens[0]);
    expect(still.turn_id).toBe(turn.turn_id);
    expect(still.view?.history).toHaveLength(2);

    const accepted = await act(t.env, roomId, tokens[0], {
      turn_id: turn.turn_id,
      type: 'raise',
      amount: 4,
    });
    expect(accepted.duplicate).toBeUndefined();
    const bob = await yourTurn(t.env, roomId, tokens[1]);
    expect(bob.view?.opponent_bet_this_street).toBe(4);
  });
});

describe('POST /v1/rooms/{room_id}/actions: not_your_turn', () => {
  it('the seat not to act answers 409 not_your_turn with its waiting state', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t);
    const aliceTurn = await yourTurn(t.env, roomId, tokens[0]);
    const error = await expectError(
      await actPost(t.env, roomId, tokens[1], {
        turn_id: aliceTurn.turn_id,
        type: 'call',
      }),
      'not_your_turn',
    );
    expect(errorState(error)).toMatchObject({
      status: 'waiting',
      room_status: 'playing',
      to_act_seat: 0,
      hand_number: 1,
      view: { my_seat: 1 },
    });
    // Nothing changed for seat 0.
    const after = await yourTurn(t.env, roomId, tokens[0]);
    expect(after.turn_id).toBe(aliceTurn.turn_id);
    expect(after.view?.history).toHaveLength(2);
  });

  it('seat 0 acting before anyone joined answers 409 not_your_turn with the waiting room state', async () => {
    const t = makeEnv();
    const room = await createRoom(t.env);
    const error = await expectError(
      await actPost(t.env, room.room_id, room.token, {
        turn_id: 't_1',
        type: 'check',
      }),
      'not_your_turn',
    );
    expect(errorState(error)).toMatchObject({
      status: 'waiting',
      room_status: 'waiting',
      to_act_seat: null,
      view: null,
    });
  });
});

describe('POST /v1/rooms/{room_id}/actions: stale_turn', () => {
  it('an unknown turn_id from the seat to act answers 409 stale_turn with its current your_turn', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t);
    const turn = await yourTurn(t.env, roomId, tokens[0]);
    const stale = turn.turn_id === 't_999' ? 't_998' : 't_999';
    const error = await expectError(
      await actPost(t.env, roomId, tokens[0], { turn_id: stale, type: 'call' }),
      'stale_turn',
    );
    const current = errorState(error);
    expect(current).toMatchObject({
      status: 'your_turn',
      turn_id: turn.turn_id,
      to_act_seat: 0,
    });
    const after = await yourTurn(t.env, roomId, tokens[0]);
    expect(after.view?.history).toHaveLength(2);
  });

  it("the other seat's accepted turn_id answers 409 stale_turn", async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t);
    const aliceTurn = await yourTurn(t.env, roomId, tokens[0]);
    await act(t.env, roomId, tokens[0], {
      turn_id: aliceTurn.turn_id,
      type: 'call',
    });
    const bobTurn = await yourTurn(t.env, roomId, tokens[1]);
    const error = await expectError(
      await actPost(t.env, roomId, tokens[1], {
        turn_id: aliceTurn.turn_id,
        type: 'check',
      }),
      'stale_turn',
    );
    expect(errorState(error)).toMatchObject({
      status: 'your_turn',
      turn_id: bobTurn.turn_id,
      to_act_seat: 1,
    });
    const after = await yourTurn(t.env, roomId, tokens[1]);
    expect(after).toEqual(bobTurn);
  });
});

describe('POST /v1/rooms/{room_id}/actions: finishing a 1-hand match by a fold', () => {
  const foldedMatch = async (waitMs = 300) => {
    const t = makeEnv({ allowTestRooms: true, waitMs });
    const { roomId, tokens } = await seededRoom(t, { hands: 1 });
    const turn = await yourTurn(t.env, roomId, tokens[0]);
    return { t, roomId, tokens, turn };
  };
  const expectedEnd = engineAfter({ seed: SEED, hands: 1 }, [
    [0, { type: 'fold' }],
  ]);

  it('both seats get match_over from state and wait at once', async () => {
    const { t, roomId, tokens, turn } = await foldedMatch(2000);
    await act(t.env, roomId, tokens[0], {
      turn_id: turn.turn_id,
      type: 'fold',
    });
    for (const token of tokens) {
      const fromState = await state(t.env, roomId, token);
      expect(fromState.status.status).toBe('match_over');
      const fromWait = await wait(t.env, roomId, token);
      expect(fromWait.status.status).toBe('match_over');
      expect(fromWait.elapsedMs).toBeLessThan(1000);
    }
  });

  it('a pending wait answers match_over as soon as the match ends', async () => {
    const { t, roomId, tokens, turn } = await foldedMatch(2000);
    const pending = wait(t.env, roomId, tokens[1]);
    await sleep(50);
    await act(t.env, roomId, tokens[0], {
      turn_id: turn.turn_id,
      type: 'fold',
    });
    const result = await pending;
    expect(result.status.status).toBe('match_over');
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  it('match_over carries match_id, result from the caller, engine stacks, ratings null and last_hand', async () => {
    const { t, roomId, tokens, turn } = await foldedMatch();
    await act(t.env, roomId, tokens[0], {
      turn_id: turn.turn_id,
      type: 'fold',
    });
    const results = ['loss', 'win'] as const;
    for (const seat of [0, 1] as const) {
      const over = asMatchOver(
        (await state(t.env, roomId, tokens[seat])).status,
      );
      expect(over).toMatchObject({
        status: 'match_over',
        room_status: 'finished',
        match_id: roomId,
        result: results[seat],
        final_stacks: expectedEnd.stacks,
        ratings: null,
        to_act_seat: null,
        last_hand: {
          hand_number: 1,
          ended_by: 'fold',
          winner_seat: 1,
          hole_cards: null,
          board: [],
        },
      });
      expect(over.last_hand).toEqual(expectedEnd.lastHand);
      expect(over.hint.length).toBeGreaterThan(0);
      expect(over.view?.pot).toBe(0);
    }
  });

  it('last_hand.pot is what the winner won, without the returned uncalled big blind', async () => {
    const { t, roomId, tokens, turn } = await foldedMatch();
    await act(t.env, roomId, tokens[0], {
      turn_id: turn.turn_id,
      type: 'fold',
    });
    const over = asMatchOver((await state(t.env, roomId, tokens[1])).status);
    // Seat 0 put in 1, seat 1's extra 1 is returned: the pot won is 2.
    expect(over.last_hand?.pot).toBe(2);
    expect(over.final_stacks).toEqual([39, 41]);
    expect(over.last_hand?.stacks).toEqual([39, 41]);
  });

  it('a new action after the match answers 409 match_over with the match_over state', async () => {
    const { t, roomId, tokens, turn } = await foldedMatch();
    await act(t.env, roomId, tokens[0], {
      turn_id: turn.turn_id,
      type: 'fold',
    });
    for (const seat of [0, 1] as const) {
      const error = await expectError(
        await actPost(t.env, roomId, tokens[seat], {
          turn_id: 't_999',
          type: 'check',
        }),
        'match_over',
      );
      expect(errorState(error)).toMatchObject({
        status: 'match_over',
        room_status: 'finished',
        match_id: roomId,
      });
    }
  });
});

describe('POST /v1/rooms/{room_id}/actions: a 1-hand match to showdown', () => {
  // Plays check-or-call for whichever seat has your_turn until match_over,
  // and records the same actions for the engine.
  const playPassive = async (
    t: TestEnv,
    roomId: string,
    tokens: readonly [string, string],
  ) => {
    const actions: Array<readonly [Seat, Action]> = [];
    for (let step = 0; step < 20; step++) {
      const statuses = await Promise.all(
        tokens.map(async token => (await state(t.env, roomId, token)).status),
      );
      if (statuses.every(status => status.status === 'match_over')) {
        return { actions, statuses };
      }
      const seat = statuses.findIndex(
        status => status.status === 'your_turn',
      ) as Seat | -1;
      expect(seat).not.toBe(-1);
      if (seat === -1) break;
      const turn = statuses[seat];
      if (turn.status !== 'your_turn') break;
      const canCheck = turn.legal_actions.some(a => a.type === 'check');
      const action: Action = canCheck ? { type: 'check' } : { type: 'call' };
      await act(t.env, roomId, tokens[seat], {
        turn_id: turn.turn_id,
        type: action.type,
      });
      actions.push([seat, action]);
    }
    throw new Error('the match did not end');
  };

  it('ends by showdown with both hole cards, engine stacks and the matching result', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t, { hands: 1 });
    const { actions, statuses } = await playPassive(t, roomId, tokens);

    // call, check, then check-check on flop, turn and river.
    expect(actions).toHaveLength(8);
    const expected = engineAfter({ seed: SEED, hands: 1 }, actions);
    expect(expected.over).toBe(true);
    const deal = dealHand(SEED, 1);
    const [s0, s1] = expected.stacks;

    for (const seat of [0, 1] as const) {
      const over = asMatchOver(statuses[seat]);
      const mine = expected.stacks[seat];
      const theirs = expected.stacks[seat === 0 ? 1 : 0];
      expect(over).toMatchObject({
        room_status: 'finished',
        match_id: roomId,
        final_stacks: [s0, s1],
        ratings: null,
        result: mine > theirs ? 'win' : mine < theirs ? 'loss' : 'draw',
        last_hand: {
          ended_by: 'showdown',
          hole_cards: deal.holeCards,
          board: deal.board,
        },
      });
      expect(over.last_hand).toEqual(expected.lastHand);
      expect(over.view?.pot).toBe(0);
    }
  });
});

describe('POST /v1/rooms/{room_id}/actions: the next hand', () => {
  it('after seat 0 folds hand 1 of 2, seat 1 (button) acts first in hand 2', async () => {
    const t = makeEnv({ allowTestRooms: true });
    const { roomId, tokens } = await seededRoom(t, { hands: 2 });
    const turn = await yourTurn(t.env, roomId, tokens[0]);
    await act(t.env, roomId, tokens[0], {
      turn_id: turn.turn_id,
      type: 'fold',
    });
    const expected = engineAfter({ seed: SEED, hands: 2 }, [
      [0, { type: 'fold' }],
    ]);

    const bob = await yourTurn(t.env, roomId, tokens[1]);
    expect(bob).toMatchObject({
      room_status: 'playing',
      hand_number: 2,
      to_act_seat: 1,
      view: { button_seat: 1, street: 'preflop' },
    });
    expect(bob.view).toEqual(viewFor(expected, 1).view);
    expect(bob.last_hand).toEqual(expected.lastHand);
    expect(bob.last_hand).toMatchObject({
      hand_number: 1,
      ended_by: 'fold',
      winner_seat: 1,
    });
    expect(bob.legal_actions).toEqual(legalActions(expected));

    const alice = await state(t.env, roomId, tokens[0]);
    expect(alice.status).toMatchObject({
      status: 'waiting',
      room_status: 'playing',
      hand_number: 2,
      to_act_seat: 1,
    });
    expect(alice.status.view?.my_cards).toEqual(dealHand(SEED, 2).holeCards[0]);
  });

  it("a pending wait of seat 1 answers your_turn for hand 2 right after seat 0's fold", async () => {
    const t = makeEnv({ allowTestRooms: true, waitMs: 2000 });
    const { roomId, tokens } = await seededRoom(t, { hands: 2 });
    const turn = await yourTurn(t.env, roomId, tokens[0]);
    const pending = wait(t.env, roomId, tokens[1]);
    await sleep(50);
    await act(t.env, roomId, tokens[0], {
      turn_id: turn.turn_id,
      type: 'fold',
    });
    const result = await pending;
    expect(result.status).toMatchObject({
      status: 'your_turn',
      hand_number: 2,
      to_act_seat: 1,
    });
    expect(result.elapsedMs).toBeLessThan(1000);
  });
});
