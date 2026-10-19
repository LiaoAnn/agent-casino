import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import {
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

const fixture = async () => {
  const now = Date.now();
  const room = new RoomReferee(new MemoryStorage(), {
    now: () => now,
    waitMs: 20,
    webUrl: 'https://web.test',
  });
  const env = {
    TOKEN_SECRET: 'duplicate-turn-test-secret',
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
      max_hands: 4,
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
  const request = async (seat: 0 | 1, path: string, body?: unknown) => {
    const response = await handle(
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
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };
  const turn = async (seat: 0 | 1) => {
    const current = Schema.decodeUnknownSync(RoomStatus)(
      await request(seat, 'wait'),
    );
    if (current.status !== 'your_turn') throw new Error('Expected your_turn');
    return current;
  };
  const first = await turn(0);
  const action = { turn_id: first.turn_id, type: 'fold' };
  const accepted = await request(0, 'actions', action);
  expect(accepted).toMatchObject({ status: 'accepted' });
  return { request, turn, action };
};

describe('T50 duplicate turn HTTP responses', () => {
  it('marks a resend with wait=1 on a newer own turn and preserves the GET wait payload', async () => {
    const t = await fixture();
    const bob = await t.turn(1);
    await t.request(1, 'actions', { turn_id: bob.turn_id, type: 'fold' });
    const current = await t.request(0, 'wait');
    expect(current).toMatchObject({ status: 'your_turn', hand_number: 3 });
    expect(current.turn_id).not.toBe(t.action.turn_id);
    // Even a changed payload for the used turn must have no effect.
    const duplicate = await t.request(0, 'actions?wait=1', {
      ...t.action,
      type: 'call',
    });
    const prefix = `turn_id ${t.action.turn_id} was already used, so nothing was sent; act again with turn_id ${current.turn_id} from this response.`;
    expect.soft(duplicate).toMatchObject({ duplicate: true });
    expect.soft((duplicate.hint as string).startsWith(prefix)).toBe(true);
    expect.soft(duplicate).toEqual({
      ...current,
      duplicate: true,
      hint: duplicate.hint,
    });
    expect(await t.request(0, 'wait')).toEqual(current);
  });

  it('names the used and current turns in the first hint sentence without wait', async () => {
    const t = await fixture();
    const bob = await t.turn(1);
    await t.request(1, 'actions', { turn_id: bob.turn_id, type: 'fold' });
    const current = await t.request(0, 'wait');
    expect(current).toMatchObject({ status: 'your_turn', hand_number: 3 });
    expect(current.turn_id).not.toBe(t.action.turn_id);
    const duplicate = await t.request(0, 'actions', t.action);
    expect(duplicate).toMatchObject({ status: 'accepted', duplicate: true });
    const firstSentence = (duplicate.hint as string).split('.')[0];
    expect
      .soft(firstSentence)
      .toContain(
        `turn_id ${t.action.turn_id} was already used, so nothing was sent`,
      );
    expect.soft(firstSentence).toContain(current.turn_id);
    expect(await t.request(0, 'wait')).toEqual(current);
  });

  it('returns waiting without duplicate when wait=1 times out on the opponent turn', async () => {
    const t = await fixture();
    const duplicate = await t.request(0, 'actions?wait=1', t.action);
    expect(duplicate).toMatchObject({ status: 'waiting', to_act_seat: 1 });
    expect(duplicate).not.toHaveProperty('duplicate');
    expect(duplicate).toEqual(await t.request(0, 'wait'));
    expect(await t.turn(1)).toMatchObject({ hand_number: 2 });
  });

  it('preserves accepted plus duplicate without wait on the opponent turn', async () => {
    const t = await fixture();
    const bob = await t.turn(1);
    const duplicate = await t.request(0, 'actions', t.action);
    expect(duplicate).toMatchObject({ status: 'accepted', duplicate: true });
    expect(await t.turn(1)).toEqual(bob);
  });
});
