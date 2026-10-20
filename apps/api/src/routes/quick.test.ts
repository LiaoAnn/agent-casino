// T39 S3: lobby and automatic seating through the real HTTP app (A2, A4, A25).
import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { Lobby, SeatResponse } from '../contract/schemas';
import { banName } from '../db/bans';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { lobbyIn } from '../matchmaker/lobby';
import { RoomReferee, type RoomStorage } from '../room/referee';
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

const WEB_URL = 'https://web.test';

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
  const clock = { ms: Date.now() };
  const env = {
    TOKEN_SECRET: 't39-test-secret',
    WEB_URL,
    ADMIN_KEY: 't39-test-admin',
    ALLOW_TEST_ROOMS: 'true',
    DB: db.d1,
    ROOM: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        let room = rooms.get(id);
        if (!room) {
          room = new RoomReferee(new MemoryStorage(), {
            waitMs: 1,
            now: () => clock.ms,
            listRoom: update => lobby.update(update),
          });
          rooms.set(id, room);
        }
        return room;
      },
    },
    MATCHMAKER: {},
  } as unknown as Bindings;
  const lobby = lobbyIn(env, {
    storage: new MemoryStorage(),
    now: () => clock.ms,
  });
  env.MATCHMAKER = {
    idFromName: (name: string) => name,
    get: () => ({
      quick: lobby.quick,
      rooms: lobby.list,
      listRoom: lobby.update,
    }),
  } as unknown as Bindings['MATCHMAKER'];

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
  const seat = async (response: Response) => {
    const raw = await response.json();
    expect(response.status, JSON.stringify(raw)).toBe(200);
    return Schema.decodeUnknownSync(SeatResponse)(raw);
  };
  const open = (options: Record<string, unknown> = {}) =>
    request('POST', '/v1/rooms', {
      game: 'holdem',
      name: 'host',
      visibility: 'public',
      ...options,
    }).then(seat);
  const quick = (name: string, options: Record<string, unknown> = {}) =>
    request('POST', '/v1/rooms/quick', {
      game: 'holdem',
      name,
      ...options,
    }).then(seat);
  const list = async () => {
    const response = await request('GET', '/v1/lobby');
    const raw = await response.json();
    expect(response.status, JSON.stringify(raw)).toBe(200);
    const decoded = Schema.decodeUnknownSync(Lobby)(raw);
    return { raw, decoded };
  };
  return { env, clock, request, open, quick, list, seat };
}

async function expectError(response: Response, status: number, code: string) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(body).toMatchObject({
    status: 'error',
    code,
    retryable: false,
    message: expect.any(String),
    hint: expect.any(String),
  });
  return body as { message: string; hint: string };
}

describe('T39 S3 POST /v1/rooms/quick', () => {
  it('seats six concurrent names at one public table, then makes the seventh a new host', async () => {
    const f = fixture();
    const seated = await Promise.all(
      Array.from({ length: 6 }, (_, i) => f.quick(`player-${i}`)),
    );
    const roomId = seated[0]?.room_id;
    expect(new Set(seated.map(s => s.room_id)).size).toBe(1);
    expect(seated.map(s => s.seat).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seated.filter(s => s.is_host)).toHaveLength(1);
    expect(seated.find(s => s.is_host)?.seat).toBe(0);
    for (const s of seated) {
      expect(s).toMatchObject({ visibility: 'public', invite_code: null });
    }
    const seventh = await f.quick('player-6');
    expect(seventh.room_id).not.toBe(roomId);
    expect(seventh).toMatchObject({
      seat: 0,
      is_host: true,
      visibility: 'public',
      invite_code: null,
    });
  });

  it.each([
    ['private', { visibility: 'private' }],
    [
      'custom public',
      { visibility: 'public', settings: { starting_stack: 80 } },
    ],
    ['legacy heads-up', { visibility: undefined }],
  ])('does not auto-seat at a %s room', async (_kind, options) => {
    const f = fixture();
    const excluded = await f.open(options);
    const seated = await f.quick('guest');
    expect(seated.room_id).not.toBe(excluded.room_id);
    expect(seated).toMatchObject({ seat: 0, is_host: true });
  });

  it('joins an existing default public table with tell_owner and a wait hint', async () => {
    const f = fixture();
    const host = await f.open({ display_name: 'Host Shark' });
    const joined = await f.quick('guest', { display_name: 'Guest Shark' });
    expect(joined).toMatchObject({
      room_id: host.room_id,
      seat: 1,
      is_host: false,
      display_name: 'Guest Shark',
    });
    expect(joined.tell_owner).toContain('Joined the table of Host Shark');
    expect(joined.tell_owner).toContain('Guest Shark');
    expect(joined.tell_owner).toContain(joined.watch_url);
    expect(joined.hint).toContain(`/v1/rooms/${host.room_id}/wait`);
  });

  it('opens a new public table without tell_owner when none can be joined', async () => {
    const f = fixture();
    const host = await f.quick('host');
    expect(host).toMatchObject({
      seat: 0,
      is_host: true,
      visibility: 'public',
    });
    expect(host).not.toHaveProperty('tell_owner');
    expect(host.hint).toContain(`/v1/rooms/${host.room_id}/wait`);
  });

  it('returns contract seats with WEB_URL watch links and tokens accepted by state', async () => {
    const f = fixture();
    const host = await f.quick('host');
    const guest = await f.quick('guest');
    for (const s of [host, guest]) {
      expect(
        s.watch_url.startsWith(`${WEB_URL}/watch/${s.room_id}?token=`),
      ).toBe(true);
      const state = await f.request(
        'GET',
        `/v1/rooms/${s.room_id}/state`,
        undefined,
        s.token,
      );
      expect(state.status).toBe(200);
    }
  });

  it('skips a table already containing the name without changing its seats', async () => {
    const f = fixture();
    const host = await f.open();
    const before = await f.request(
      'GET',
      `/v1/rooms/${host.room_id}/state`,
      undefined,
      host.token,
    );
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as { seats: unknown };
    const other = await f.quick('host');
    expect(other.room_id).not.toBe(host.room_id);
    expect(other).toMatchObject({ seat: 0, is_host: true });
    const after = await f.request(
      'GET',
      `/v1/rooms/${host.room_id}/state`,
      undefined,
      host.token,
    );
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ seats: beforeBody.seats });
  });

  it('does not auto-seat at a table after its host starts it', async () => {
    const f = fixture();
    const host = await f.open();
    const started = await f.request(
      'POST',
      `/v1/rooms/${host.room_id}/start`,
      { bots: 1 },
      host.token,
    );
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ room_status: 'playing' });
    const seated = await f.quick('guest');
    expect(seated.room_id).not.toBe(host.room_id);
    expect(seated).toMatchObject({ seat: 0, is_host: true });
  });

  it.each([
    { settings: { starting_stack: 80 } },
    { test: { seed: '0'.repeat(64) } },
  ])('rejects quick options %j as invalid_request', async options => {
    const f = fixture();
    await expectError(
      await f.request('POST', '/v1/rooms/quick', {
        game: 'holdem',
        name: 'guest',
        ...options,
      }),
      400,
      'invalid_request',
    );
  });

  it.each(['', 'bad name', 'a'.repeat(33), 'house-bot', 'House-Bot'])(
    'rejects name %j as name_invalid',
    async name => {
      const f = fixture();
      await expectError(
        await f.request('POST', '/v1/rooms/quick', { game: 'holdem', name }),
        400,
        'name_invalid',
      );
    },
  );

  it.each(['alice', 'ALICE'])('rejects banned name %s', async name => {
    const f = fixture();
    await banName(db.db, 'Alice');
    await expectError(
      await f.request('POST', '/v1/rooms/quick', { game: 'holdem', name }),
      403,
      'name_banned',
    );
  });
});

describe('T39 S3 GET /v1/lobby', () => {
  it('initially returns an empty contract lobby', async () => {
    expect((await fixture().list()).raw).toEqual({ rooms: [] });
  });

  it('lists public and private waiting rooms oldest first without leaking the invite code', async () => {
    const f = fixture();
    const publicRoom = await f.open({ display_name: 'Public Host' });
    f.clock.ms += 1_000;
    const privateRoom = await f.open({
      visibility: 'private',
      name: 'private-host',
      display_name: 'Private Host',
    });
    const { raw, decoded } = await f.list();
    expect(decoded.rooms.map(r => r.room_id)).toEqual([
      publicRoom.room_id,
      privateRoom.room_id,
    ]);
    for (const [index, room] of [publicRoom, privateRoom].entries()) {
      expect(decoded.rooms[index]).toMatchObject({
        room_id: room.room_id,
        visibility: room.visibility,
        seats: [
          {
            seat: 0,
            name: index === 0 ? 'host' : 'private-host',
            display_name: room.display_name,
          },
        ],
        seats_open: 5,
        settings: room.settings,
        created_at: expect.any(String),
      });
    }
    expect(privateRoom.invite_code).toEqual(expect.any(String));
    expect(JSON.stringify(raw)).not.toContain(privateRoom.invite_code);
  });

  it('removes a room from the lobby when the host starts it', async () => {
    const f = fixture();
    const host = await f.open();
    const response = await f.request(
      'POST',
      `/v1/rooms/${host.room_id}/start`,
      { bots: 1 },
      host.token,
    );
    expect(response.status).toBe(200);
    expect((await f.list()).raw).toEqual({ rooms: [] });
  });
});

describe('T39 S3 retired POST /v1/queue', () => {
  it.each([
    [
      'legacy body with queue_key',
      JSON.stringify({
        game: 'holdem',
        name: 'alice',
        queue_key: 'a'.repeat(16),
      }),
      true,
    ],
    [
      'body without queue_key',
      JSON.stringify({ game: 'holdem', name: 'alice' }),
      true,
    ],
    ['malformed JSON', '{broken', true],
    ['malformed JSON without content-type', '{broken', false],
  ])('always returns 410 gone for %s', async (_label, body, contentType) => {
    const f = fixture();
    const response = await handle(
      new Request('http://api.test/v1/queue', {
        method: 'POST',
        ...(contentType
          ? { headers: { 'content-type': 'application/json' } }
          : {}),
        body: new TextEncoder().encode(body),
      }),
      f.env,
    );
    const error = await expectError(response, 410, 'gone');
    expect(error.hint).toContain('POST /v1/rooms/quick');
    expect(error.hint).toContain('/skill.md');
  });
});
