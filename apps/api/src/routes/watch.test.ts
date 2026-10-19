// T23: the owner's watch link (casino-api skill A16; also A3, A4, A8, A13,
// A15). Everything goes over HTTP through handle(); the Room DO namespace is
// faked with one RoomReferee per room id and finished matches are written to a
// real local D1, like the other route tests. The pure engine's deal
// (dealHand) is the oracle for hole cards.

import { eq } from 'drizzle-orm';
import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { ERROR_STATUS, type ErrorCode } from '../contract/errors';
import {
  ActionAccepted,
  CreateRoomResponse,
  JoinResponse,
  RoomStatus,
  SETTINGS_DEFAULTS,
  WatchResponse,
} from '../contract/schemas';
import { matchEvents } from '../db/schema';
import { startTestD1, type TestD1 } from '../db/test-d1';
import type { Seat } from '../holdem/match';
import { dealHand } from '../holdem/shuffle';
import { RatingWriter } from '../matchmaker/ratings';
import { RoomReferee, type RoomStorage } from '../room/referee';
import { signWatchToken, verifyWatchToken } from '../token/token';
import type { Bindings } from './env';

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
const WEB_URL = 'https://web.test';
const TOKEN_SECRET = 'test-token-secret';
const ADMIN_KEY = 'test-admin-key';
const NEVER_CREATED = 'r_zzzzz99999';
const SEED = '0000000000000000000000000000000000000000000000000000000000003039';
const FORBIDDEN_KEYS = ['seed', 'turn_id', 'legal_actions'];

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

  async setAlarm(_scheduledTime: number): Promise<void> {}

  async deleteAlarm(): Promise<void> {}
}

interface TestEnv {
  env: Bindings;
  clock: { ms: number };
}

const makeEnv = (options: { waitMs?: number } = {}): TestEnv => {
  const clock = { ms: Math.floor(Date.now() / 1000) * 1000 };
  const ratings = new RatingWriter(testD1.db);
  const referees = new Map<string, RoomReferee>();
  const ROOM = {
    idFromName: (name: string) => name,
    get: (id: string) => {
      let referee = referees.get(id);
      if (referee === undefined) {
        referee = new RoomReferee(new MemoryStorage(), {
          waitMs: options.waitMs ?? 5,
          now: () => clock.ms,
          record: input => ratings.record(input),
        });
        referees.set(id, referee);
      }
      return referee;
    },
  };
  const env = {
    TOKEN_SECRET,
    WEB_URL,
    ADMIN_KEY,
    DB: testD1.d1,
    ROOM,
    MATCHMAKER: {},
    ALLOW_TEST_ROOMS: 'true',
  } as unknown as Bindings;
  return { env, clock };
};

// --- HTTP helpers -----------------------------------------------------------

const post = (env: Bindings, path: string, body: unknown, token?: string) =>
  handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
    env,
  );

const get = (env: Bindings, path: string, token?: string) =>
  handle(
    new Request(`${BASE}${path}`, {
      method: 'GET',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
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
): Promise<ErrorBody> => {
  const body = (await response.json()) as ErrorBody;
  expect({ status: response.status, code: body.code }).toEqual({
    status: ERROR_STATUS[code],
    code,
  });
  expect(body).toMatchObject({
    status: 'error',
    message: expect.any(String),
    hint: expect.any(String),
  });
  return body;
};

const decodeCreate = Schema.decodeUnknownSync(CreateRoomResponse);
const decodeJoin = Schema.decodeUnknownSync(JoinResponse);
const decodeStatus = Schema.decodeUnknownSync(RoomStatus);
const decodeWatch = (value: unknown) =>
  Schema.decodeUnknownSync(WatchResponse)(value);
const decodeAccepted = Schema.decodeUnknownSync(ActionAccepted);

type Status = typeof RoomStatus.Type;
type YourTurn = Extract<Status, { status: 'your_turn' }>;
type MatchOver = Extract<Status, { status: 'match_over' }>;
type Watch = typeof WatchResponse.Type;

// --- JSON helpers -------------------------------------------------------------

const allKeys = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(allKeys)
    : value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, inner]) => [
          key,
          ...allKeys(inner),
        ])
      : [];

const allStrings = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(allStrings)
      : value !== null && typeof value === 'object'
        ? Object.values(value).flatMap(allStrings)
        : [];

// Every value stored under a `note` key, anywhere in the JSON.
const allNotes = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(allNotes)
    : value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, inner]) =>
          key === 'note' && typeof inner === 'string'
            ? [inner]
            : allNotes(inner),
        )
      : [];

// A card is never any string of the body, nor a standalone token in the raw
// text. The random room_id is removed first (`r_ab9sxxxxxx` contains `9s`).
const expectNoCards = (
  raw: string,
  roomId: string,
  cards: readonly string[],
) => {
  const strings = allStrings(JSON.parse(raw));
  const text = raw.split(roomId).join('');
  for (const card of cards) {
    expect(strings).not.toContain(card);
    expect(text).not.toMatch(
      new RegExp(`(?<![A-Za-z0-9])${card}(?![A-Za-z0-9])`),
    );
  }
};

// --- Room helpers -----------------------------------------------------------

const createRoom = async (
  env: Bindings,
  body: Record<string, unknown> = {},
) => {
  const response = await post(env, '/v1/rooms', {
    game: 'holdem',
    name: 'alice',
    test: { seed: SEED },
    ...body,
  });
  expect(response.status).toBe(200);
  return decodeCreate(await response.json());
};

const joinRoom = async (
  env: Bindings,
  room: { room_id: string; invite_code: string },
  name = 'bob',
) => {
  const response = await post(env, `/v1/rooms/${room.room_id}/join`, {
    name,
    invite_code: room.invite_code,
  });
  expect(response.status).toBe(200);
  return decodeJoin(await response.json());
};

const tokenOf = (watchUrl: string): string => {
  const token = new URL(watchUrl).searchParams.get('token');
  if (token === null || token === '') throw new Error('no token in watch_url');
  return token;
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

const state = (env: Bindings, roomId: string, token: string) =>
  get(env, `/v1/rooms/${roomId}/state`, token).then(readStatus);

const wait = (env: Bindings, roomId: string, token: string) =>
  get(env, `/v1/rooms/${roomId}/wait`, token).then(readStatus);

interface WatchResult {
  watch: Watch;
  json: unknown;
  raw: string;
}

const watchOf = async (
  env: Bindings,
  roomId: string,
  token: string,
): Promise<WatchResult> => {
  const response = await get(env, `/v1/rooms/${roomId}/watch`, token);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type') ?? '').toContain(
    'application/json',
  );
  const raw = await response.text();
  const json = JSON.parse(raw);
  const keys = allKeys(json);
  for (const key of FORBIDDEN_KEYS) expect(keys).not.toContain(key);
  return { watch: decodeWatch(json), json, raw };
};

const actPost = (
  env: Bindings,
  roomId: string,
  token: string,
  body: Record<string, unknown>,
) => post(env, `/v1/rooms/${roomId}/actions`, body, token);

const yourTurn = async (
  env: Bindings,
  roomId: string,
  token: string,
): Promise<YourTurn> => {
  const { status } = await state(env, roomId, token);
  if (status.status !== 'your_turn') throw new Error('expected your_turn');
  return status;
};

// The same seat's result in the seat-angle vocabulary of /v1/matches.
const seatResult = (over: MatchOver, seat: Seat): string =>
  over.result === 'win'
    ? `seat${seat}_win`
    : over.result === 'loss'
      ? `seat${seat === 0 ? 1 : 0}_win`
      : over.result;

const stripNote = <T extends { note?: string }>(event: T): Omit<T, 'note'> => {
  const { note: _note, ...rest } = event;
  return rest;
};

// --- A rig that plays a scripted match and keeps what each seat has seen -------

interface LastHandSeen {
  hand_number: number;
  blinds: readonly [number, number];
  winner_seat: Seat | null;
  pot: number;
  ended_by: 'fold' | 'showdown';
  board: readonly string[];
  hole_cards: readonly (readonly string[])[] | null;
  stacks: readonly number[];
}

interface Seen {
  // The history and my_cards of the latest view the seat got for each hand.
  histories: Map<number, readonly unknown[]>;
  cards: Map<number, readonly string[]>;
  lastHands: Map<number, LastHandSeen>;
}

interface LoggedNote {
  seat: Seat;
  hand_number: number;
  seq: number;
  note: string;
}

interface RoomSettings {
  max_hands: number;
  turn_seconds: number;
  blind_every: number;
  starting_stack: number;
}

interface Rig {
  t: TestEnv;
  roomId: string;
  settings: RoomSettings;
  tokens: readonly [string, string];
  watchTokens: readonly [string, string];
  seen: readonly [Seen, Seen];
  notes: LoggedNote[];
}

const openRig = async (
  overrides: Partial<RoomSettings> = {},
  options: { waitMs?: number } = {},
): Promise<Rig> => {
  const settings: RoomSettings = {
    ...SETTINGS_DEFAULTS,
    max_hands: 3,
    blind_every: 50,
    ...overrides,
  };
  const t = makeEnv(options);
  const room = await createRoom(t.env, { settings });
  const joined = await joinRoom(t.env, room);
  return {
    t,
    roomId: room.room_id,
    settings,
    tokens: [room.token, joined.token],
    watchTokens: [tokenOf(room.watch_url), tokenOf(joined.watch_url)],
    seen: [
      { histories: new Map(), cards: new Map(), lastHands: new Map() },
      { histories: new Map(), cards: new Map(), lastHands: new Map() },
    ],
    notes: [],
  };
};

const observe = (rig: Rig, seat: Seat, status: Status) => {
  const seen = rig.seen[seat];
  if (status.view !== null && status.hand_number !== null) {
    seen.histories.set(
      status.hand_number,
      structuredClone(status.view.history),
    );
    seen.cards.set(status.hand_number, status.view.my_cards);
  }
  if ('last_hand' in status && status.last_hand) {
    seen.lastHands.set(status.last_hand.hand_number, status.last_hand);
  }
};

const observeBoth = async (rig: Rig) => {
  const statuses: Status[] = [];
  for (const seat of [0, 1] as const) {
    const { status } = await state(rig.t.env, rig.roomId, rig.tokens[seat]);
    observe(rig, seat, status);
    statuses.push(status);
  }
  return statuses;
};

const noteText = (seat: Seat, hand: number, seq: number) =>
  `NOTE-${seat === 0 ? 'A' : 'B'}-h${hand}-q${seq}`;

type Move =
  | { type: 'fold' | 'check' | 'call' }
  | { type: 'raise'; amount: number };
type Choose = (turn: YourTurn, seat: Seat) => Move;

// Hands 1 and 3: the first to act folds. Everything else: check or call, so
// hand 2 (and any later hand) goes to showdown.
const foldFirst: Choose = turn => {
  const first = turn.view?.history.length === 2;
  if (turn.hand_number !== 2 && first) return { type: 'fold' };
  return turn.legal_actions.some(action => action.type === 'check')
    ? { type: 'check' }
    : { type: 'call' };
};

// Plays one action by whoever has the turn, with a note naming its place.
// Returns false when the match is over.
const step = async (
  rig: Rig,
  choose: Choose = foldFirst,
  options: { note?: boolean } = {},
): Promise<boolean> => {
  const statuses = await observeBoth(rig);
  const seat = statuses.findIndex(status => status.status === 'your_turn');
  if (seat === -1) return false;
  const turn = statuses[seat];
  if (turn?.status !== 'your_turn' || turn.view === null)
    throw new Error('expected your_turn');
  const hand = turn.hand_number as number;
  const seq = turn.view.history.length;
  const move = choose(turn, seat as Seat);
  const note = noteText(seat as Seat, hand, seq);
  const response = await actPost(
    rig.t.env,
    rig.roomId,
    rig.tokens[seat as Seat],
    {
      turn_id: turn.turn_id,
      ...move,
      ...(options.note === false ? {} : { note }),
    },
  );
  expect(response.status).toBe(200);
  expect(decodeAccepted(await response.json()).status).toBe('accepted');
  if (options.note !== false) {
    rig.notes.push({ seat: seat as Seat, hand_number: hand, seq, note });
  }
  await observeBoth(rig);
  return true;
};

// What the seat's agent could know now, against what its watch says.
const checkParity = async (rig: Rig) => {
  for (const seat of [0, 1] as const) {
    const { status } = await state(rig.t.env, rig.roomId, rig.tokens[seat]);
    observe(rig, seat, status);
    const { watch, json } = await watchOf(
      rig.t.env,
      rig.roomId,
      rig.watchTokens[seat],
    );
    expect(watch).toMatchObject({
      room_id: rig.roomId,
      seat,
      players: ['alice', 'bob'],
      settings: rig.settings,
      room_status: status.room_status,
      hand_number: status.hand_number,
      to_act_seat: status.to_act_seat,
    });
    // Only the seat's own turn has a deadline.
    if (status.status === 'your_turn') {
      expect(Date.parse(watch.deadline as string)).toBe(
        Date.parse(status.deadline),
      );
    } else {
      expect(watch.deadline).toBeNull();
    }
    // The current view is the seat's own state view, plus its own notes.
    if (status.view === null) {
      expect(watch.view).toBeNull();
    } else {
      expect(watch.view).not.toBeNull();
      expect({
        ...watch.view,
        history: watch.view?.history.map(stripNote),
      }).toEqual(status.view);
    }
    // Finished hands, as far as the seat has been told.
    const seen = rig.seen[seat];
    for (const hand of watch.hands) {
      const deal = dealHand(SEED, hand.hand_number);
      expect(hand.hole_cards[seat]).toEqual(deal.holeCards[seat]);
      const mine = seen.cards.get(hand.hand_number);
      if (mine !== undefined) expect(hand.hole_cards[seat]).toEqual(mine);
      const opponent = seat === 0 ? 1 : 0;
      // In play only a showdown shows the opponent's cards; afterwards all do.
      if (watch.room_status === 'playing') {
        expect(hand.hole_cards[opponent]).toEqual(
          hand.ended_by === 'showdown' ? deal.holeCards[opponent] : null,
        );
      } else {
        expect(hand.hole_cards).toEqual(deal.holeCards);
      }
      const last = seen.lastHands.get(hand.hand_number);
      if (last !== undefined) {
        expect(hand).toMatchObject({
          blinds: [1, 2],
          winner_seat: last.winner_seat,
          pot: last.pot,
          ended_by: last.ended_by,
          board: last.board,
          stacks: last.stacks,
        });
        if (last.hole_cards !== null) {
          expect(hand.hole_cards).toEqual(last.hole_cards);
        }
      }
      const history = seen.histories.get(hand.hand_number);
      if (history !== undefined) {
        const events = hand.events.map(stripNote);
        expect(events.slice(0, history.length)).toEqual(history);
        // Only the action that ended the hand can be missing from the last view.
        expect(events.length - history.length).toBeLessThanOrEqual(1);
      }
    }
    // The result, once there is one.
    if (status.status === 'match_over') {
      expect(watch.room_status).toBe(status.room_status);
      if (watch.room_status === 'finished' || watch.room_status === 'void') {
        expect(watch.match_id).toBe(status.match_id);
        expect(watch.result).toBe(seatResult(status, seat));
        expect(watch.final_stacks).toEqual(status.final_stacks);
        expect(watch.ratings).toEqual(status.ratings);
      } else {
        throw new Error('match_over without a finished watch');
      }
    } else {
      expect(json).not.toHaveProperty('result');
      expect(json).not.toHaveProperty('final_stacks');
      expect(json).not.toHaveProperty('match_id');
      expect(json).not.toHaveProperty('ratings');
    }
  }
};

const playOut = async (rig: Rig, choose: Choose = foldFirst) => {
  for (let i = 0; i < 100; i++) {
    if (!(await step(rig, choose))) return;
  }
  throw new Error('the match did not end');
};

// --- Tokens -------------------------------------------------------------------

describe('watch_url on room creation and join (A16)', () => {
  it('is WEB_URL/watch/<room_id>?token=<watch token> for the seat and name', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env);
    expect(
      room.watch_url.startsWith(`${WEB_URL}/watch/${room.room_id}?token=`),
    ).toBe(true);
    const token = tokenOf(room.watch_url);
    expect(token).not.toBe(room.token);
    expect(await verifyWatchToken(token, TOKEN_SECRET, room.room_id)).toEqual({
      ok: true,
      claims: { room_id: room.room_id, seat: 0, name: 'alice' },
    });

    const joined = await joinRoom(env, room);
    expect(
      joined.watch_url.startsWith(`${WEB_URL}/watch/${room.room_id}?token=`),
    ).toBe(true);
    expect(
      await verifyWatchToken(
        tokenOf(joined.watch_url),
        TOKEN_SECRET,
        room.room_id,
      ),
    ).toEqual({
      ok: true,
      claims: { room_id: room.room_id, seat: 1, name: 'bob' },
    });
  });

  it('carries the deterministic watch token for the room, seat and name', async () => {
    const { env } = makeEnv();
    const a = await createRoom(env);
    const b = await createRoom(env);
    expect(tokenOf(a.watch_url)).not.toBe(tokenOf(b.watch_url));
    expect(a.watch_url).toBe(
      `${WEB_URL}/watch/${a.room_id}?token=${await signWatchToken(
        { room_id: a.room_id, seat: 0, name: 'alice' },
        TOKEN_SECRET,
      )}`,
    );
  });
});

describe('watch tokens and seat tokens are not interchangeable (A16)', () => {
  const setup = async () => {
    const rig = await openRig();
    const turn = await yourTurn(rig.t.env, rig.roomId, rig.tokens[0]);
    return { rig, turn };
  };

  it.each([
    { call: 'wait', method: 'GET' as const, path: 'wait' },
    { call: 'state', method: 'GET' as const, path: 'state' },
    { call: 'actions', method: 'POST' as const, path: 'actions' },
    { call: 'leave', method: 'POST' as const, path: 'leave' },
  ])(
    'a watch token on $call answers 401 invalid_token and changes nothing',
    async ({ method, path }) => {
      const { rig, turn } = await setup();
      for (const seat of [0, 1] as const) {
        const url = `/v1/rooms/${rig.roomId}/${path}`;
        const response =
          method === 'GET'
            ? await get(rig.t.env, url, rig.watchTokens[seat])
            : await post(
                rig.t.env,
                url,
                path === 'actions'
                  ? { turn_id: turn.turn_id, type: 'fold' }
                  : {},
                rig.watchTokens[seat],
              );
        const body = await expectError(response, 'invalid_token');
        expect(body.retryable).toBe(false);
      }
      const after = await yourTurn(rig.t.env, rig.roomId, rig.tokens[0]);
      expect(after).toEqual(turn);
      const opponent = await state(rig.t.env, rig.roomId, rig.tokens[1]);
      expect(opponent.status.room_status).toBe('playing');
    },
  );

  it('a seat token on watch answers 401 invalid_token, for both seats', async () => {
    const { rig } = await setup();
    for (const seat of [0, 1] as const) {
      await expectError(
        await get(rig.t.env, `/v1/rooms/${rig.roomId}/watch`, rig.tokens[seat]),
        'invalid_token',
      );
    }
  });

  it("another room's watch token answers 401 invalid_token", async () => {
    const { rig } = await setup();
    const other = await createRoom(rig.t.env);
    await expectError(
      await get(
        rig.t.env,
        `/v1/rooms/${rig.roomId}/watch`,
        tokenOf(other.watch_url),
      ),
      'invalid_token',
    );
  });

  it('a watch token signed with another secret answers 401 invalid_token', async () => {
    const { rig } = await setup();
    const forged = await signWatchToken(
      { room_id: rig.roomId, seat: 0, name: 'alice' },
      'attacker-secret',
    );
    await expectError(
      await get(rig.t.env, `/v1/rooms/${rig.roomId}/watch`, forged),
      'invalid_token',
    );
  });

  it('a watch token with the seat edited answers 401 invalid_token', async () => {
    const { rig } = await setup();
    const [payload, sig] = rig.watchTokens[0].split('.');
    const edited = btoa(
      JSON.stringify({ room_id: rig.roomId, seat: 1, name: 'bob' }),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    expect(edited).not.toBe(payload);
    await expectError(
      await get(rig.t.env, `/v1/rooms/${rig.roomId}/watch`, `${edited}.${sig}`),
      'invalid_token',
    );
  });

  it.each(['garbage', 'a.b', ''])(
    'the token %j answers 401 invalid_token',
    async token => {
      const { rig } = await setup();
      await expectError(
        await get(rig.t.env, `/v1/rooms/${rig.roomId}/watch`, token),
        'invalid_token',
      );
    },
  );

  it('no Authorization header answers 401 invalid_token', async () => {
    const { rig } = await setup();
    await expectError(
      await get(rig.t.env, `/v1/rooms/${rig.roomId}/watch`),
      'invalid_token',
    );
  });

  it('a valid watch token for a room that was never created answers 404 room_not_found', async () => {
    const { env } = makeEnv();
    const token = await signWatchToken(
      { room_id: NEVER_CREATED, seat: 0, name: 'alice' },
      TOKEN_SECRET,
    );
    await expectError(
      await get(env, `/v1/rooms/${NEVER_CREATED}/watch`, token),
      'room_not_found',
    );
  });

  it('a watch link is read-only: POST on the watch path is not served', async () => {
    const { rig } = await setup();
    const response = await post(
      rig.t.env,
      `/v1/rooms/${rig.roomId}/watch`,
      {},
      rig.watchTokens[0],
    );
    expect(response.status).toBe(404);
  });
});

// --- Before and at the start --------------------------------------------------

describe('GET /v1/rooms/{room_id}/watch while waiting for an opponent', () => {
  it('answers at once with the room and no view, hands or deadline', async () => {
    const t = makeEnv({ waitMs: 2000 });
    const room = await createRoom(t.env, {
      settings: {
        max_hands: 5,
        turn_seconds: 20,
        blind_every: 50,
        starting_stack: 100,
      },
    });
    const started = performance.now();
    const { watch, json } = await watchOf(
      t.env,
      room.room_id,
      tokenOf(room.watch_url),
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(watch).toEqual({
      room_id: room.room_id,
      seat: 0,
      players: ['alice', null],
      display_names: ['alice', null],
      settings: {
        max_hands: 5,
        turn_seconds: 20,
        blind_every: 50,
        starting_stack: 100,
      },
      room_status: 'waiting',
      hand_number: null,
      to_act_seat: null,
      deadline: null,
      view: null,
      hands: [],
    });
    expect(json).not.toHaveProperty('result');
  });
});

describe('GET /v1/rooms/{room_id}/watch during play', () => {
  it('answers at once, even when the seat is waiting for its opponent', async () => {
    const rig = await openRig({}, { waitMs: 2000 });
    for (const seat of [0, 1] as const) {
      const started = performance.now();
      await watchOf(rig.t.env, rig.roomId, rig.watchTokens[seat]);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it("shows each seat's own cards and a deadline only on its own turn", async () => {
    const rig = await openRig();
    const deal = dealHand(SEED, 1);
    const started = rig.t.clock.ms;
    const first = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
    expect(first.watch).toMatchObject({
      seat: 0,
      players: ['alice', 'bob'],
      room_status: 'playing',
      hand_number: 1,
      to_act_seat: 0,
      view: { my_seat: 0, my_cards: deal.holeCards[0] },
      hands: [],
    });
    expect(Date.parse(first.watch.deadline as string)).toBe(
      started + 2 * SETTINGS_DEFAULTS.turn_seconds * 1000,
    );
    const second = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[1]);
    expect(second.watch).toMatchObject({
      seat: 1,
      to_act_seat: 0,
      view: { my_seat: 1, my_cards: deal.holeCards[1] },
      deadline: null,
    });
  });

  it("never sends the opponent's cards while hand 1 is on", async () => {
    const rig = await openRig();
    const deal = dealHand(SEED, 1);
    const check = async () => {
      const a = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
      const b = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[1]);
      expectNoCards(a.raw, rig.roomId, deal.holeCards[1]);
      expectNoCards(b.raw, rig.roomId, deal.holeCards[0]);
    };
    await check();
    await step(rig, () => ({ type: 'call' }));
    await check();
    await step(rig, () => ({ type: 'check' }));
    await check();
  });

  it("the deadline moves to the other seat's watch when the turn passes", async () => {
    const rig = await openRig();
    await step(rig, () => ({ type: 'call' }));
    const alice = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
    const bob = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[1]);
    const bobTurn = await yourTurn(rig.t.env, rig.roomId, rig.tokens[1]);
    expect(alice.watch.to_act_seat).toBe(1);
    expect(alice.watch.deadline).toBeNull();
    expect(Date.parse(bob.watch.deadline as string)).toBe(
      Date.parse(bobTurn.deadline),
    );
  });
});

// --- Information parity ---------------------------------------------------------

describe('a watch response holds nothing the same seat could not get from state (A16)', () => {
  it('matches the seat state at every step of a 3-hand match, to match_over', async () => {
    const rig = await openRig({ max_hands: 3 });
    await checkParity(rig);
    for (let i = 0; i < 100; i++) {
      if (!(await step(rig))) break;
      await checkParity(rig);
    }
    const final = await state(rig.t.env, rig.roomId, rig.tokens[0]);
    expect(final.status.status).toBe('match_over');
    expect(rig.notes.length).toBeGreaterThan(4);
  });
});

// --- Hole cards -----------------------------------------------------------------

describe('hole cards in watch hands (A16)', () => {
  it('shows the seat its own hole cards in a hand that ended by a fold, and not the opponent', async () => {
    const rig = await openRig({ max_hands: 3 });
    // Hand 1: seat 0 folds at once.
    await step(rig);
    const deal = dealHand(SEED, 1);
    const alice = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
    expect(alice.watch.room_status).toBe('playing');
    expect(alice.watch.hands).toHaveLength(1);
    expect(alice.watch.hands[0]).toMatchObject({
      hand_number: 1,
      ended_by: 'fold',
      hole_cards: [deal.holeCards[0], null],
    });
    const bob = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[1]);
    expect(bob.watch.hands[0]).toMatchObject({
      hand_number: 1,
      ended_by: 'fold',
      hole_cards: [null, deal.holeCards[1]],
    });
  });

  it('shows both hole cards for a hand that went to showdown, while the match goes on', async () => {
    const rig = await openRig({ max_hands: 3 });
    // Hand 1 by fold; hand 2 passive to showdown; stop before hand 3 is played.
    while (true) {
      const statuses = await observeBoth(rig);
      if (statuses[0]?.hand_number === 3) break;
      if (!(await step(rig))) break;
    }
    const deal = dealHand(SEED, 2);
    for (const seat of [0, 1] as const) {
      const { watch } = await watchOf(
        rig.t.env,
        rig.roomId,
        rig.watchTokens[seat],
      );
      expect(watch.room_status).toBe('playing');
      expect(watch.hand_number).toBe(3);
      expect(watch.hands.map(hand => hand.hand_number)).toEqual([1, 2]);
      expect(watch.hands[1]).toMatchObject({
        ended_by: 'showdown',
        hole_cards: deal.holeCards,
      });
      const opponent = seat === 0 ? 1 : 0;
      expect(watch.hands[0]?.hole_cards[opponent]).toBeNull();
    }
  });
});

// --- Notes ----------------------------------------------------------------------

describe('note on POST /actions (A16)', () => {
  it('shows in the own seat watch, in the current view and in the finished hand', async () => {
    const rig = await openRig({ max_hands: 2 });
    await step(rig, () => ({ type: 'call' }));
    const afterCall = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
    expect(afterCall.watch.view?.history.at(-1)).toMatchObject({
      seat: 0,
      type: 'call',
      note: noteText(0, 1, 2),
    });
    // The blinds have no note.
    expect(afterCall.watch.view?.history[0]?.note).toBeUndefined();
    expect(afterCall.watch.view?.history[1]?.note).toBeUndefined();
    await step(rig, () => ({ type: 'check' }));
    // Fold hand 1 away after the flop starts.
    for (let i = 0; i < 20; i++) {
      const { watch } = await watchOf(
        rig.t.env,
        rig.roomId,
        rig.watchTokens[0],
      );
      if (watch.hands.length === 1) break;
      await step(rig, turn =>
        turn.view?.board.length === 3
          ? { type: 'fold' }
          : turn.legal_actions.some(action => action.type === 'check')
            ? { type: 'check' }
            : { type: 'call' },
      );
    }
    for (const seat of [0, 1] as const) {
      const { watch } = await watchOf(
        rig.t.env,
        rig.roomId,
        rig.watchTokens[seat],
      );
      const hand = watch.hands[0];
      expect(hand?.hand_number).toBe(1);
      const own = rig.notes.filter(
        entry => entry.seat === seat && entry.hand_number === 1,
      );
      expect(own.length).toBeGreaterThan(0);
      for (const entry of own) {
        expect(hand?.events[entry.seq]).toMatchObject({
          seat,
          note: entry.note,
        });
      }
      const noted = hand?.events.filter(event => event.note !== undefined);
      expect(noted).toHaveLength(own.length);
    }
  });

  it("never appears in the opponent's wait, state or watch, nor in /v1/matches/{id}", async () => {
    const rig = await openRig({ max_hands: 3 });
    const check = async () => {
      for (const seat of [0, 1] as const) {
        const other = seat === 0 ? 1 : 0;
        const theirs = rig.notes.filter(entry => entry.seat === other);
        const mine = rig.notes.filter(entry => entry.seat === seat);
        const fromState = await state(rig.t.env, rig.roomId, rig.tokens[seat]);
        const fromWait = await wait(rig.t.env, rig.roomId, rig.tokens[seat]);
        const fromWatch = await watchOf(
          rig.t.env,
          rig.roomId,
          rig.watchTokens[seat],
        );
        for (const entry of theirs) {
          for (const raw of [fromState.raw, fromWait.raw, fromWatch.raw]) {
            expect(raw).not.toContain(entry.note);
          }
        }
        // The seat's watch holds exactly its own notes, nobody else's.
        expect(new Set(allNotes(fromWatch.json))).toEqual(
          new Set(mine.map(entry => entry.note)),
        );
        // The agent's own wait and state never carry notes at all.
        expect(allNotes(JSON.parse(fromState.raw))).toEqual([]);
        expect(allNotes(JSON.parse(fromWait.raw))).toEqual([]);
      }
    };
    await check();
    while (await step(rig)) await check();
    await check();
    expect(rig.notes.some(entry => entry.seat === 0)).toBe(true);
    expect(rig.notes.some(entry => entry.seat === 1)).toBe(true);

    const response = await get(rig.t.env, `/v1/matches/${rig.roomId}`);
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(allNotes(JSON.parse(raw))).toEqual([]);
    for (const entry of rig.notes) expect(raw).not.toContain(entry.note);
  });

  it('is stored in D1 match_events for both seats, and nowhere else', async () => {
    const rig = await openRig({ max_hands: 3 });
    await playOut(rig);
    const rows = await testD1.db
      .select()
      .from(matchEvents)
      .where(eq(matchEvents.matchId, rig.roomId));
    expect(rows.length).toBeGreaterThan(rig.notes.length);
    const sort = <T extends { hand_number: number; seq: number }>(list: T[]) =>
      [...list].sort((a, b) => a.hand_number - b.hand_number || a.seq - b.seq);
    expect(
      sort(
        rows
          .filter(row => row.note !== null)
          .map(row => ({
            seat: row.seat,
            hand_number: row.handNumber,
            seq: row.seq,
            note: row.note,
          })),
      ),
    ).toEqual(sort(rig.notes));
    // Blinds and steps sent without a note have a null note.
    expect(
      rows
        .filter(row => row.type === 'post_blind')
        .every(row => row.note === null),
    ).toBe(true);
  });

  it('may be 500 characters and not 501', async () => {
    const rig = await openRig();
    const turn = await yourTurn(rig.t.env, rig.roomId, rig.tokens[0]);
    const error = await expectError(
      await actPost(rig.t.env, rig.roomId, rig.tokens[0], {
        turn_id: turn.turn_id,
        type: 'call',
        note: 'x'.repeat(501),
      }),
      'invalid_request',
    );
    expect(error.hint.length).toBeGreaterThan(0);
    // Refused: the same turn is still open and nothing was recorded.
    expect(await yourTurn(rig.t.env, rig.roomId, rig.tokens[0])).toEqual(turn);
    const { watch } = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
    expect(watch.view?.history).toHaveLength(2);

    const accepted = await actPost(rig.t.env, rig.roomId, rig.tokens[0], {
      turn_id: turn.turn_id,
      type: 'call',
      note: 'y'.repeat(500),
    });
    expect(accepted.status).toBe(200);
    const after = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
    expect(after.watch.view?.history.at(-1)?.note).toBe('y'.repeat(500));
  });

  it('counts characters, not bytes: 500 multi-byte characters are accepted', async () => {
    const rig = await openRig();
    const turn = await yourTurn(rig.t.env, rig.roomId, rig.tokens[0]);
    const note = '牌'.repeat(500);
    const accepted = await actPost(rig.t.env, rig.roomId, rig.tokens[0], {
      turn_id: turn.turn_id,
      type: 'call',
      note,
    });
    expect(accepted.status).toBe(200);
    const { watch } = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
    expect(watch.view?.history.at(-1)?.note).toBe(note);
  });

  it.each([
    { case: 'a number', note: 42 },
    { case: 'null', note: null },
  ])('a note that is $case answers 400 invalid_request', async ({ note }) => {
    const rig = await openRig();
    const turn = await yourTurn(rig.t.env, rig.roomId, rig.tokens[0]);
    await expectError(
      await actPost(rig.t.env, rig.roomId, rig.tokens[0], {
        turn_id: turn.turn_id,
        type: 'call',
        note,
      }),
      'invalid_request',
    );
    expect(await yourTurn(rig.t.env, rig.roomId, rig.tokens[0])).toEqual(turn);
  });

  it('may be left out', async () => {
    const rig = await openRig();
    await step(rig, () => ({ type: 'call' }), { note: false });
    const { watch, json } = await watchOf(
      rig.t.env,
      rig.roomId,
      rig.watchTokens[0],
    );
    expect(watch.view?.history).toHaveLength(3);
    expect(allNotes(json)).toEqual([]);
  });

  it('of a refused action is dropped; the note of the action that is accepted is kept', async () => {
    const rig = await openRig();
    const turn = await yourTurn(rig.t.env, rig.roomId, rig.tokens[0]);
    await expectError(
      await actPost(rig.t.env, rig.roomId, rig.tokens[0], {
        turn_id: turn.turn_id,
        type: 'raise',
        amount: 3,
        note: 'REFUSED-NOTE',
      }),
      'invalid_action',
    );
    await actPost(rig.t.env, rig.roomId, rig.tokens[0], {
      turn_id: turn.turn_id,
      type: 'call',
      note: 'ACCEPTED-NOTE',
    });
    const { raw, watch } = await watchOf(
      rig.t.env,
      rig.roomId,
      rig.watchTokens[0],
    );
    expect(raw).not.toContain('REFUSED-NOTE');
    expect(watch.view?.history.at(-1)?.note).toBe('ACCEPTED-NOTE');
  });

  it('of a resent turn_id does not replace the first accepted note (A3)', async () => {
    const rig = await openRig();
    const turn = await yourTurn(rig.t.env, rig.roomId, rig.tokens[0]);
    await actPost(rig.t.env, rig.roomId, rig.tokens[0], {
      turn_id: turn.turn_id,
      type: 'call',
      note: 'FIRST-NOTE',
    });
    const again = await actPost(rig.t.env, rig.roomId, rig.tokens[0], {
      turn_id: turn.turn_id,
      type: 'fold',
      note: 'SECOND-NOTE',
    });
    expect(decodeAccepted(await again.json())).toMatchObject({
      status: 'accepted',
      duplicate: true,
    });
    const { raw, watch } = await watchOf(
      rig.t.env,
      rig.roomId,
      rig.watchTokens[0],
    );
    expect(raw).not.toContain('SECOND-NOTE');
    expect(watch.view?.history).toHaveLength(3);
    expect(watch.view?.history.at(-1)?.note).toBe('FIRST-NOTE');
  });

  it('is missing from a step played by the timeout', async () => {
    const rig = await openRig({ turn_seconds: 20 });
    rig.t.clock.ms += 41_000;
    // Any request plays the timeout that is due.
    await state(rig.t.env, rig.roomId, rig.tokens[1]);
    const { watch, json } = await watchOf(
      rig.t.env,
      rig.roomId,
      rig.watchTokens[0],
    );
    const events = [
      ...watch.hands.flatMap(hand => hand.events),
      ...(watch.view?.history ?? []),
    ];
    const timedOut = events.filter(event => event.timeout === true);
    expect(timedOut.length).toBeGreaterThan(0);
    for (const event of timedOut) {
      expect(event.seat).toBe(0);
      expect(event.note).toBeUndefined();
    }
    expect(allNotes(json)).toEqual([]);
  });
});

// --- After the match --------------------------------------------------------------

describe('GET /v1/rooms/{room_id}/watch after the match', () => {
  it('has the result and every hand with both hole cards and the own notes', async () => {
    const rig = await openRig({ max_hands: 3 });
    await playOut(rig);
    const over = await state(rig.t.env, rig.roomId, rig.tokens[0]);
    expect(over.status.status).toBe('match_over');
    if (over.status.status !== 'match_over') return;
    expect(over.status.ratings).not.toBeNull();

    for (const seat of [0, 1] as const) {
      const { watch, json } = await watchOf(
        rig.t.env,
        rig.roomId,
        rig.watchTokens[seat],
      );
      expect(watch).toMatchObject({
        room_id: rig.roomId,
        seat,
        players: ['alice', 'bob'],
        room_status: 'finished',
        to_act_seat: null,
        deadline: null,
        match_id: rig.roomId,
        final_stacks: over.status.final_stacks,
        ratings: over.status.ratings,
      });
      if (watch.room_status !== 'finished') throw new Error('not finished');
      expect(watch.result).toBe(seatResult(over.status, 0));
      expect(watch.hands.map(hand => hand.hand_number)).toEqual([1, 2, 3]);
      for (const hand of watch.hands) {
        expect(hand.hole_cards).toEqual(
          dealHand(SEED, hand.hand_number).holeCards,
        );
        expect(hand.events.length).toBeGreaterThanOrEqual(3);
      }
      const own = rig.notes.filter(entry => entry.seat === seat);
      expect(own.length).toBeGreaterThan(0);
      for (const entry of own) {
        expect(
          watch.hands[entry.hand_number - 1]?.events[entry.seq],
        ).toMatchObject({ seat, note: entry.note });
      }
      expect(new Set(allNotes(json))).toEqual(
        new Set(own.map(entry => entry.note)),
      );
    }
  });

  it('gives each hand as /v1/matches/{id} does, plus the own notes', async () => {
    const rig = await openRig({ max_hands: 3 });
    await playOut(rig);
    const detail = (await (
      await get(rig.t.env, `/v1/matches/${rig.roomId}`)
    ).json()) as {
      hands: Array<{ events: unknown[] } & Record<string, unknown>>;
      final_stacks: number[];
      result: string;
    };
    const { watch } = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[1]);
    if (watch.room_status !== 'finished') throw new Error('not finished');
    expect(watch.result).toBe(detail.result);
    expect(watch.final_stacks).toEqual(detail.final_stacks);
    expect(
      watch.hands.map(hand => ({
        ...hand,
        events: hand.events.map(stripNote),
      })),
    ).toEqual(detail.hands);
  });

  it('still answers more than an hour after the match ended, when seat tokens are refused (A8)', async () => {
    const rig = await openRig({ max_hands: 1 });
    await playOut(rig);
    rig.t.clock.ms += 2 * 60 * 60 * 1000;
    const { watch } = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
    expect(watch.room_status).toBe('finished');
    expect(watch.hands).toHaveLength(1);
  });

  it('has no ratings when the opponent is the house bot', async () => {
    const t = makeEnv({ waitMs: 1 });
    const room = await createRoom(t.env, {
      opponent: 'bot',
      settings: {
        max_hands: 2,
        turn_seconds: 5,
        blind_every: 50,
        starting_stack: 40,
      },
    });
    const token = tokenOf(room.watch_url);
    const start = await watchOf(t.env, room.room_id, token);
    expect(start.watch).toMatchObject({
      seat: 0,
      players: ['alice', 'house-bot'],
      room_status: 'playing',
    });
    for (let i = 0; i < 100; i++) {
      const { status } = await wait(t.env, room.room_id, room.token);
      if (status.status === 'match_over') break;
      if (status.status !== 'your_turn') throw new Error('bot kept us waiting');
      await actPost(t.env, room.room_id, room.token, {
        turn_id: status.turn_id,
        type: status.legal_actions.some(action => action.type === 'check')
          ? 'check'
          : 'call',
        note: `bot-game note ${i}`,
      });
    }
    const { watch, json } = await watchOf(t.env, room.room_id, token);
    expect(watch.room_status).toBe('finished');
    if (watch.room_status !== 'finished') return;
    expect(watch.ratings).toBeNull();
    // A bot all-in can end the match before the second hand.
    expect(watch.hands.length).toBeGreaterThanOrEqual(1);
    expect(watch.hands.length).toBeLessThanOrEqual(2);
    // Notes are only the owner's: the bot's steps have none.
    for (const hand of watch.hands) {
      for (const event of hand.events) {
        if (event.seat === 1) expect(event.note).toBeUndefined();
      }
    }
    expect(allNotes(json).length).toBeGreaterThan(0);
  });
});

describe('GET /v1/rooms/{room_id}/watch after the room is over without a full match', () => {
  it('shows a leave during play as a finished match won by the other seat, with no unplayed hand', async () => {
    const rig = await openRig({ max_hands: 3 });
    await step(rig, () => ({ type: 'call' }));
    const left = await post(
      rig.t.env,
      `/v1/rooms/${rig.roomId}/leave`,
      {},
      rig.tokens[0],
    );
    expect(left.status).toBe(200);
    const over = decodeStatus(await left.json());
    if (over.status !== 'match_over') throw new Error('expected match_over');
    for (const seat of [0, 1] as const) {
      const { watch } = await watchOf(
        rig.t.env,
        rig.roomId,
        rig.watchTokens[seat],
      );
      expect(watch).toMatchObject({
        room_status: 'finished',
        match_id: rig.roomId,
        result: 'seat1_win',
        final_stacks: over.final_stacks,
        hands: [],
        deadline: null,
        to_act_seat: null,
      });
    }
  });

  it('shows a room dissolved while waiting as cancelled', async () => {
    const t = makeEnv();
    const room = await createRoom(t.env);
    const left = await post(
      t.env,
      `/v1/rooms/${room.room_id}/leave`,
      {},
      room.token,
    );
    expect(left.status).toBe(200);
    const over = decodeStatus(await left.json());
    if (over.status !== 'match_over') throw new Error('expected match_over');
    const { watch } = await watchOf(
      t.env,
      room.room_id,
      tokenOf(room.watch_url),
    );
    expect(watch).toMatchObject({
      room_status: 'finished',
      match_id: room.room_id,
      result: 'cancelled',
      final_stacks: over.final_stacks,
      ratings: null,
      hands: [],
    });
  });

  it('shows an aborted match as void', async () => {
    const rig = await openRig({ max_hands: 3 });
    await step(rig);
    const aborted = await post(
      rig.t.env,
      `/v1/admin/rooms/${rig.roomId}/abort`,
      {},
      ADMIN_KEY,
    );
    expect(aborted.status).toBe(200);
    const over = (await state(rig.t.env, rig.roomId, rig.tokens[0])).status;
    if (over.status !== 'match_over') throw new Error('expected match_over');
    for (const seat of [0, 1] as const) {
      const { watch } = await watchOf(
        rig.t.env,
        rig.roomId,
        rig.watchTokens[seat],
      );
      expect(watch).toMatchObject({
        room_status: 'void',
        match_id: rig.roomId,
        result: 'void',
        final_stacks: over.final_stacks,
        ratings: null,
        deadline: null,
        to_act_seat: null,
      });
    }
  });
});

describe('T34 freezeout views and results', () => {
  it('reports the current blinds and next upgrade in wait, state and watch across the boundary', async () => {
    const rig = await openRig({ blind_every: 2, max_hands: 6 });
    for (const [hand, blinds, next] of [
      [1, [1, 2], 3],
      [2, [1, 2], 3],
      [3, [2, 4], 5],
    ] as const) {
      for (const seat of [0, 1] as const) {
        // wait is also checked for the non-acting seat (short local poll).
        for (const read of [state, wait]) {
          const { status } = await read(
            rig.t.env,
            rig.roomId,
            rig.tokens[seat],
          );
          expect(status.hand_number).toBe(hand);
          expect(status.settings).toEqual(rig.settings);
          expect(status.view).toMatchObject({
            blinds,
            next_blinds_at_hand: next,
          });
          if (hand > 1 && status.status === 'your_turn') {
            expect(status.last_hand).toMatchObject({
              hand_number: hand - 1,
              blinds: [1, 2],
            });
          }
        }
        const { watch } = await watchOf(
          rig.t.env,
          rig.roomId,
          rig.watchTokens[seat],
        );
        expect(watch.settings).toEqual(rig.settings);
        expect(watch.view).toMatchObject({ blinds, next_blinds_at_hand: next });
        expect(watch.hands.map(h => h.blinds)).toEqual(
          Array.from({ length: hand - 1 }, () => [1, 2]),
        );
      }
      const seat = hand % 2 === 1 ? 0 : 1;
      const turn = await yourTurn(rig.t.env, rig.roomId, rig.tokens[seat]);
      expect(
        (
          await actPost(rig.t.env, rig.roomId, rig.tokens[seat], {
            turn_id: turn.turn_id,
            type: 'fold',
          })
        ).status,
      ).toBe(200);
    }
    const { watch } = await watchOf(rig.t.env, rig.roomId, rig.watchTokens[0]);
    expect(watch.hands.map(h => h.blinds)).toEqual([
      [1, 2],
      [1, 2],
      [2, 4],
    ]);
  });

  it('ends at max_hands and reports a draw when alternating small-blind folds restore equal stacks', async () => {
    const rig = await openRig({ blind_every: 50, max_hands: 2 });
    for (const seat of [0, 1] as const) {
      const turn = await yourTurn(rig.t.env, rig.roomId, rig.tokens[seat]);
      expect(
        (
          await actPost(rig.t.env, rig.roomId, rig.tokens[seat], {
            turn_id: turn.turn_id,
            type: 'fold',
          })
        ).status,
      ).toBe(200);
    }
    for (const seat of [0, 1] as const) {
      for (const read of [state, wait]) {
        const { status } = await read(rig.t.env, rig.roomId, rig.tokens[seat]);
        expect(status).toMatchObject({
          status: 'match_over',
          result: 'draw',
          hand_number: 2,
          final_stacks: [40, 40],
          last_hand: { hand_number: 2, blinds: [1, 2] },
          view: { blinds: [1, 2], next_blinds_at_hand: null },
        });
      }
    }
  });
});

it('fills freezeout defaults in create, join, wait, state and watch responses', async () => {
  const t = makeEnv();
  const expected = {
    starting_stack: 40,
    blind_every: 5,
    max_hands: 50,
    turn_seconds: 30,
  };
  const room = await createRoom(t.env);
  expect(room.settings).toEqual(expected);
  const joined = await joinRoom(t.env, room);
  expect(joined.settings).toEqual(expected);
  for (const read of [state, wait]) {
    expect(
      (await read(t.env, room.room_id, room.token)).status.settings,
    ).toEqual(expected);
  }
  const { watch } = await watchOf(t.env, room.room_id, tokenOf(room.watch_url));
  expect(watch.settings).toEqual(expected);
  expect(watch.view).toMatchObject({ blinds: [1, 2], next_blinds_at_hand: 6 });
});

describe('T35 watch display names', () => {
  it('returns seat-ordered normalized names before joining, during play and after finishing', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env, {
      name: 'AlIce',
      display_name: '  小愛   🃏 ',
    });
    const watchToken = tokenOf(room.watch_url);
    expect(
      (await watchOf(env, room.room_id, watchToken)).watch.display_names,
    ).toEqual(['小愛 🃏', null]);
    const response = await post(env, `/v1/rooms/${room.room_id}/join`, {
      name: 'bOB',
      invite_code: room.invite_code,
      display_name: '  Cafe\u0301  🎲 ',
    });
    expect(response.status).toBe(200);
    const joined = decodeJoin(await response.json());
    for (const token of [watchToken, tokenOf(joined.watch_url)]) {
      expect(
        (await watchOf(env, room.room_id, token)).watch.display_names,
      ).toEqual(['小愛 🃏', 'Café 🎲']);
    }
    expect(
      (await post(env, `/v1/rooms/${room.room_id}/leave`, {}, room.token))
        .status,
    ).toBe(200);
    for (const token of [watchToken, tokenOf(joined.watch_url)]) {
      expect(
        (await watchOf(env, room.room_id, token)).watch.display_names,
      ).toEqual(['小愛 🃏', 'Café 🎲']);
    }
    const detail = await get(env, `/v1/matches/${room.room_id}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      players: ['AlIce', 'bOB'],
      display_names: ['小愛 🃏', 'Café 🎲'],
    });
    const list = await get(env, '/v1/matches');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      matches: [
        expect.objectContaining({
          match_id: room.room_id,
          display_names: ['小愛 🃏', 'Café 🎲'],
        }),
      ],
    });
    const board = await get(env, '/v1/leaderboard');
    expect(board.status).toBe(200);
    expect(await board.json()).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ name: 'AlIce', display_name: '小愛 🃏' }),
        expect.objectContaining({ name: 'bOB', display_name: 'Café 🎲' }),
      ]),
    });
  });

  it('defaults to the request spelling and House Bot', async () => {
    const { env } = makeEnv();
    const room = await createRoom(env, { name: 'AlIce', opponent: 'bot' });
    expect(
      (await watchOf(env, room.room_id, tokenOf(room.watch_url))).watch
        .display_names,
    ).toEqual(['AlIce', 'House Bot']);
  });
});
