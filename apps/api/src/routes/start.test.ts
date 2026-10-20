// T38 S4: visibility seats and start through the real HTTP app.
import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { RoomStatus, SeatResponse } from '../contract/schemas';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { RoomReferee, type RoomStorage } from '../room/referee';
import { signRoomToken, verifyRoomToken } from '../token/token';
import type { Bindings } from './env';

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

const SECRET = 't38-test-secret';
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

function fixture() {
  const rooms = new Map<string, RoomReferee>();
  const env = {
    TOKEN_SECRET: SECRET,
    WEB_URL: 'https://web.test',
    ADMIN_KEY: 't38-admin',
    ALLOW_TEST_ROOMS: 'true',
    DB: db.d1,
    ROOM: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        let room = rooms.get(id);
        if (!room) {
          room = new RoomReferee(new MemoryStorage(), { waitMs: 1 });
          rooms.set(id, room);
        }
        return room;
      },
    },
    MATCHMAKER: {},
  } as unknown as Bindings;
  const request = (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
  ) =>
    handle(
      new Request(`http://api.test${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const open = async (visibility: 'public' | 'private' = 'public') => {
    const response = await request('POST', '/v1/rooms', {
      game: 'holdem',
      name: 'alice',
      display_name: 'Alice Shark',
      visibility,
      test: { seed: '0'.repeat(64) },
    });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(SeatResponse)(await response.json());
  };
  const join = async (roomId: string, name: string, invite_code?: string) => {
    const response = await request('POST', `/v1/rooms/${roomId}/join`, {
      name,
      ...(invite_code ? { invite_code } : {}),
    });
    expect(response.status).toBe(200);
    return Schema.decodeUnknownSync(SeatResponse)(await response.json());
  };
  const start = (roomId: string, token: string, body: unknown = {}) =>
    request('POST', `/v1/rooms/${roomId}/start`, body, token);
  return { request, open, join, start };
}

async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { hint: string };
  expect(body).toMatchObject({
    status: 'error',
    code,
    message: expect.any(String),
    hint: expect.any(String),
  });
  return body;
}

describe('T38 S4 visibility seat responses', () => {
  it.each(['public', 'private'] as const)(
    'POST /v1/rooms %s returns the complete waiting seat',
    async visibility => {
      const f = fixture();
      const host = await f.open(visibility);
      expect(host).toMatchObject({
        visibility,
        seat: 0,
        is_host: true,
        seats_open: 5,
        invite_code: visibility === 'public' ? null : expect.any(String),
        settings: { blind_every: null },
        opponent_name: null,
        opponent_display_name: null,
        seats: [
          {
            seat: 0,
            name: 'alice',
            display_name: 'Alice Shark',
            status: 'waiting',
            place: null,
          },
        ],
      });
      const joined = await f.join(
        host.room_id,
        'bob',
        host.invite_code ?? undefined,
      );
      expect(joined).toMatchObject({
        visibility,
        seat: 1,
        is_host: false,
        invite_code: null,
        seats_open: 4,
        opponent_name: 'alice',
        settings: { blind_every: null },
      });
      expect(joined.tell_owner).toContain('Alice Shark');
      expect(joined.tell_owner).toContain('bob');
      expect(joined.tell_owner).toContain(joined.watch_url);
      expect(joined.seats).toHaveLength(2);
      const state = await f.request(
        'GET',
        `/v1/rooms/${host.room_id}/state`,
        undefined,
        host.token,
      );
      expect(await state.json()).toMatchObject({ room_status: 'waiting' });
    },
  );

  it('public join requires no invite_code; private join without a code returns wrong_invite_code', async () => {
    const f = fixture();
    const publicRoom = await f.open();
    expect((await f.join(publicRoom.room_id, 'bob')).seat).toBe(1);
    const privateRoom = await f.open('private');
    await error(
      await f.request('POST', `/v1/rooms/${privateRoom.room_id}/join`, {
        name: 'carol',
      }),
      403,
      'wrong_invite_code',
    );
  });
});

describe('T38 S4 POST /v1/rooms/{id}/start', () => {
  it('starts with bots and returns the host current RoomStatus; retry preserves it', async () => {
    const f = fixture();
    const host = await f.open();
    const response = await f.start(host.room_id, host.token, { bots: 2 });
    expect(response.status).toBe(200);
    const state = Schema.decodeUnknownSync(RoomStatus)(await response.json());
    if (state.status !== 'your_turn') throw new Error('Expected host turn');
    expect(state).toMatchObject({
      status: 'your_turn',
      room_status: 'playing',
      is_host: true,
      seats_open: 0,
      settings: { blind_every: 5 },
      view: { my_seat: 0 },
    });
    expect(state.seats).toHaveLength(3);
    const retry = await f.start(host.room_id, host.token, { bots: 2 });
    expect(retry.status).toBe(200);
    const current = await retry.json();
    expect(current).toMatchObject({
      turn_id: state.turn_id,
      hand_number: state.hand_number,
      seats: state.seats,
    });
  });

  it('not_host is 403; not_enough_players is 409; bots over vacant seats is 400', async () => {
    const f = fixture();
    const host = await f.open();
    await error(
      await f.start(host.room_id, host.token),
      409,
      'not_enough_players',
    );
    const guest = await f.join(host.room_id, 'bob');
    await error(await f.start(host.room_id, guest.token), 403, 'not_host');
    await f.join(host.room_id, 'carol');
    await error(
      await f.start(host.room_id, host.token, { bots: 4 }),
      400,
      'invalid_request',
    );
  });

  it('finished room returns 409 match_over', async () => {
    const f = fixture();
    const host = await f.open();
    await f.join(host.room_id, 'bob');
    const left = await f.request(
      'POST',
      `/v1/rooms/${host.room_id}/leave`,
      {},
      host.token,
    );
    expect(left.status).toBe(200);
    await error(await f.start(host.room_id, host.token), 409, 'match_over');
  });

  it('signed token for a name not seated at the table returns 401 invalid_token', async () => {
    const f = fixture();
    const host = await f.open();
    const stranger = await signRoomToken(
      { room_id: host.room_id, seat: 0, name: 'stranger' },
      SECRET,
      Date.now(),
    );
    await error(await f.start(host.room_id, stranger), 401, 'invalid_token');
    const guest = await f.join(host.room_id, 'bob');
    expect(
      (
        await f.request(
          'POST',
          `/v1/rooms/${host.room_id}/leave`,
          {},
          guest.token,
        )
      ).status,
    ).toBe(200);
    const removed = await error(
      await f.start(host.room_id, guest.token),
      401,
      'invalid_token',
    );
    expect(removed.hint).toMatch(/join|new room/i);
  });

  it('seat 2 token works and keeps working by name after seat 1 leaves', async () => {
    const f = fixture();
    const host = await f.open();
    const bob = await f.join(host.room_id, 'bob');
    const carol = await f.join(host.room_id, 'carol');
    expect(carol.seat).toBe(2);
    expect(
      await verifyRoomToken(carol.token, SECRET, host.room_id, Date.now()),
    ).toMatchObject({ ok: true, claims: { seat: 2, name: 'carol' } });
    const before = await f.request(
      'GET',
      `/v1/rooms/${host.room_id}/state`,
      undefined,
      carol.token,
    );
    expect(before.status).toBe(200);
    expect(
      (
        await f.request(
          'POST',
          `/v1/rooms/${host.room_id}/leave`,
          {},
          bob.token,
        )
      ).status,
    ).toBe(200);
    const after = await f.request(
      'GET',
      `/v1/rooms/${host.room_id}/wait`,
      undefined,
      carol.token,
    );
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      room_status: 'waiting',
      seats: [
        { seat: 0, name: 'alice' },
        { seat: 1, name: 'carol' },
      ],
    });
    await error(await f.start(host.room_id, carol.token), 403, 'not_host');
  });

  it('all token seats 0–5 can read their own state', async () => {
    const f = fixture();
    const host = await f.open();
    const seats = [host];
    for (const name of ['bob', 'carol', 'dave', 'eve', 'frank'])
      seats.push(await f.join(host.room_id, name));
    for (const [seat, answer] of seats.entries()) {
      expect(answer.seat).toBe(seat);
      const response = await f.request(
        'GET',
        `/v1/rooms/${host.room_id}/state`,
        undefined,
        answer.token,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        display_name: answer.display_name,
      });
    }
  });
});
