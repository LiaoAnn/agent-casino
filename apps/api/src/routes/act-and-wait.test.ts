import { Schema } from 'effect';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { handle } from '../app';
import {
  ActionAccepted,
  CreateRoomResponse,
  JoinResponse,
  RoomStatus,
} from '../contract/schemas';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { RoomReferee, type RoomStorage } from '../room/referee';
import type { Bindings } from './env';

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

const SECRET = 'test-act-wait-secret';
let db: TestD1;
beforeAll(async () => {
  db = await startTestD1();
}, 30_000);
beforeEach(async () => {
  await db.reset();
});
afterAll(async () => {
  await db?.dispose();
});

const fixture = async (max_hands = 3) => {
  // Freeze the game clock while keeping real timers for D1 and HTTP effects.
  const now = Date.now();
  const room = new RoomReferee(new MemoryStorage(), {
    waitMs: 20,
    now: () => now,
    webUrl: 'https://web.test',
  });
  const actSpy = vi.spyOn(room, 'act');
  const env = {
    TOKEN_SECRET: SECRET,
    WEB_URL: 'https://web.test',
    DB: db.d1,
    ROOM: { idFromName: (name: string) => name, get: () => room },
    MATCHMAKER: {},
    ALLOW_TEST_ROOMS: 'true',
  } as unknown as Bindings;
  const post = (path: string, body: unknown) =>
    handle(
      new Request(`http://api.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
  const created = await post('/v1/rooms', {
    game: 'holdem',
    name: 'alice',
    settings: {
      starting_stack: 40,
      blind_every: 50,
      max_hands,
      turn_seconds: 5,
    },
    test: { seed: '0'.repeat(64) },
  });
  expect(created.status).toBe(200);
  const host = Schema.decodeUnknownSync(CreateRoomResponse)(
    await created.json(),
  );
  const joined = await post(`/v1/rooms/${host.room_id}/join`, {
    name: 'bob',
    invite_code: host.invite_code,
  });
  expect(joined.status).toBe(200);
  const guest = Schema.decodeUnknownSync(JoinResponse)(await joined.json());
  const tokens = [host.token, guest.token];
  const request = (seat: 0 | 1, path: string, body?: unknown) =>
    handle(
      new Request(`http://api.test/v1/rooms/${host.room_id}/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${tokens[seat]}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const status = async (seat: 0 | 1, path = 'state') => {
    const response = await request(seat, path);
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(RoomStatus)(await response.json());
  };
  const turn = async (seat: 0 | 1) => {
    const current = await status(seat);
    if (current.status !== 'your_turn') throw new Error('Expected your_turn');
    return current;
  };
  return {
    room,
    request,
    status,
    turn,
    actSpy,
    roomId: host.room_id,
    watchUrl: host.watch_url,
  };
};

describe('T47 actions?wait=1 HTTP contract', () => {
  it.each(['true', '0', 'false', '2', ''])(
    'rejects wait=%j before executing the action; the same turn remains usable',
    async wait => {
      const t = await fixture(1);
      const first = await t.turn(0);
      const action = { turn_id: first.turn_id, type: 'fold' };
      const response = await t.request(0, `actions?wait=${wait}`, action);
      expect.soft(response.status).toBe(400);
      expect
        .soft(await response.json())
        .toMatchObject({ status: 'error', code: 'invalid_request' });
      expect.soft(t.actSpy).not.toHaveBeenCalled();
      expect.soft((await t.status(0)).status).toBe('your_turn');
      const retry = await t.request(0, 'actions', action);
      expect(retry.status).toBe(200);
      const accepted = Schema.decodeUnknownSync(ActionAccepted)(
        await retry.json(),
      );
      expect(accepted.status).toBe('accepted');
      expect(accepted).not.toHaveProperty('duplicate');
    },
  );

  it('decodes wait=1, forwards it to the referee and serializes match_over as RoomStatus', async () => {
    const t = await fixture(1);
    const first = await t.turn(0);
    const action = { turn_id: first.turn_id, type: 'fold' };
    const response = await t.request(0, 'actions?wait=1', action);
    expect(response.status).toBe(200);
    expect(t.actSpy).toHaveBeenCalledWith(0, action, { wait: true });
    const raw = await response.json();
    expect(raw).toEqual(await t.status(0, 'wait'));
    expect(Schema.decodeUnknownSync(RoomStatus)(raw)).toMatchObject({
      status: 'match_over',
      tell_owner: expect.any(String),
      hands_since_your_turn: [expect.objectContaining({ hand_number: 1 })],
    });
    const duplicate = await t.request(0, 'actions?wait=1', action);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(raw);
  });

  it('serializes a wait timeout with the same waiting schema and body as GET wait', async () => {
    const t = await fixture();
    const first = await t.turn(0);
    const response = await t.request(0, 'actions?wait=1', {
      turn_id: first.turn_id,
      type: 'call',
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(await t.status(0, 'wait'));
    expect(Schema.decodeUnknownSync(RoomStatus)(body)).toMatchObject({
      status: 'waiting',
      to_act_seat: 1,
    });
  });

  it('serializes your_turn with the new action URL and preserves note and first-turn watch reminders', async () => {
    const t = await fixture();
    const first = await t.turn(0);
    expect
      .soft(first.hint)
      .toContain(`POST /v1/rooms/${t.roomId}/actions?wait=1`);
    expect.soft(first.hint).toMatch(/watch link/i);
    expect.soft(first.hint).toContain(t.watchUrl);
    expect.soft(first.hint).toMatch(/note/i);
    expect.soft(first.hint).toMatch(/language/i);
    expect.soft(first.hint).toBe((await t.status(0, 'wait')).hint);
    const action = { turn_id: first.turn_id, type: 'fold' };
    const old = await t.request(0, 'actions', action);
    expect(old.status).toBe(200);
    expect(
      Schema.decodeUnknownSync(ActionAccepted)(await old.json()).status,
    ).toBe('accepted');
    const bob = await t.turn(1);
    await t.request(1, 'actions', { turn_id: bob.turn_id, type: 'fold' });
    // A resend on a newer turn marks the duplicate, even with a different payload.
    const response = await t.request(0, 'actions?wait=1', {
      ...action,
      type: 'check',
    });
    expect(response.status).toBe(200);
    const raw = await response.json();
    const current = await t.status(0, 'wait');
    if (current.status !== 'your_turn') throw new Error('Expected your_turn');
    expect(raw).toEqual({
      ...current,
      duplicate: true,
      hint: `turn_id ${first.turn_id} was already used, so nothing was sent; act again with turn_id ${current.turn_id} from this response. ${current.hint}`,
    });
    const body = Schema.decodeUnknownSync(RoomStatus)(raw);
    expect(body).toMatchObject({ status: 'your_turn', hand_number: 3 });
    expect(body.hint).toContain(`POST /v1/rooms/${t.roomId}/actions?wait=1`);
    expect(body.hint).not.toMatch(/watch link/i);
  });

  it('preserves the original invalid_action error and allows correction with the same turn', async () => {
    const t = await fixture();
    const first = await t.turn(0);
    const invalid = { turn_id: first.turn_id, type: 'check' };
    const original = await t.request(0, 'actions', invalid);
    const combined = await t.request(0, 'actions?wait=1', invalid);
    expect(combined.status).toBe(400);
    expect(await combined.json()).toEqual(await original.json());
    const accepted = await t.request(0, 'actions', {
      ...invalid,
      type: 'call',
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: 'accepted' });
  });

  it('preserves legacy accepted and duplicate responses without the query', async () => {
    const t = await fixture();
    const first = await t.turn(0);
    const action = { turn_id: first.turn_id, type: 'call' };
    const response = await t.request(0, 'actions', action);
    expect(response.status).toBe(200);
    const body = Schema.decodeUnknownSync(ActionAccepted)(
      await response.json(),
    );
    expect(body.status).toBe('accepted');
    const duplicate = await t.request(0, 'actions', action);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ ...body, duplicate: true });
  });
});
