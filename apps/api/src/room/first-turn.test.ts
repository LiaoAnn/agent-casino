// T48 / A22: exercise the public HTTP and referee interfaces, with an injected clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import type {
  CreateRoomResponse,
  JoinResponse,
  RoomStatus,
} from '../contract/schemas';
import { startTestD1, type TestD1 } from '../db/test-d1';
import type { Bindings } from '../routes/env';
import { RoomReferee, type RoomStorage } from './referee';

class MemoryStorage implements RoomStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

let d1: TestD1;
beforeAll(async () => {
  d1 = await startTestD1();
}, 30_000);
beforeEach(async () => {
  await d1.reset();
});
afterAll(async () => {
  await d1?.dispose();
});

const fixture = async (
  options: { turnSeconds?: number; maxHands?: number; bot?: boolean } = {},
) => {
  const clock = { ms: Date.parse('2026-10-19T00:00:00Z') };
  const storage = new MemoryStorage();
  const referee = new RoomReferee(storage, {
    now: () => clock.ms,
    waitMs: 1,
    webUrl: 'https://web.test',
    random: () => 0.6,
  });
  const env = {
    TOKEN_SECRET: 'first-turn-test-secret',
    WEB_URL: 'https://web.test',
    DB: d1.d1,
    ALLOW_TEST_ROOMS: 'true',
    ROOM: { idFromName: (name: string) => name, get: () => referee },
    MATCHMAKER: {},
  } as unknown as Bindings;
  const request = (path: string, token?: string, body?: unknown) =>
    handle(
      new Request(`https://api.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const created = await request('/v1/rooms', undefined, {
    game: 'holdem',
    name: 'alice',
    display_name: '小愛 🃏',
    settings: {
      starting_stack: 40,
      blind_every: 50,
      max_hands: options.maxHands ?? 5,
      ...(options.turnSeconds === undefined
        ? {}
        : { turn_seconds: options.turnSeconds }),
    },
    test: { seed: '0'.repeat(64) },
    ...(options.bot ? { opponent: 'bot' } : {}),
  });
  expect(created.status).toBe(200);
  const creator = (await created.json()) as typeof CreateRoomResponse.Type;
  const path = `/v1/rooms/${creator.room_id}`;
  let joined: typeof JoinResponse.Type | undefined;
  if (!options.bot) {
    const response = await request(`${path}/join`, undefined, {
      name: 'bob',
      display_name: '鮑伯',
      invite_code: creator.invite_code,
    });
    expect(response.status).toBe(200);
    joined = (await response.json()) as typeof JoinResponse.Type;
  }
  const players = [creator, joined] as const;
  const read = async (seat: 0 | 1, endpoint: 'state' | 'wait' = 'state') => {
    const player = players[seat];
    if (!player) throw new Error('No player');
    const response = await request(`${path}/${endpoint}`, player.token);
    expect(response.status).toBe(200);
    // Do not decode here: the separate contract tests check field preservation.
    return (await response.json()) as typeof RoomStatus.Type;
  };
  const turn = async (seat: 0 | 1, endpoint: 'state' | 'wait' = 'state') => {
    const status = await read(seat, endpoint);
    if (status.status !== 'your_turn')
      throw new Error(`Expected your_turn: ${JSON.stringify(status)}`);
    return status;
  };
  const act = async (
    seat: 0 | 1,
    type: 'call' | 'check' | 'fold',
    wait = false,
  ) => {
    const current = await turn(seat);
    const player = players[seat];
    if (!player) throw new Error('No player');
    return request(`${path}/actions${wait ? '?wait=1' : ''}`, player.token, {
      turn_id: current.turn_id,
      type,
    });
  };
  return {
    clock,
    storage,
    referee,
    creator,
    joined,
    request,
    path,
    players,
    read,
    turn,
    act,
  };
};

const reminder = (hint: string, url: string) => {
  expect(hint).toContain(
    `If you have not given your owner the watch link yet, give it now: ${url}`,
  );
};

describe('T48 tell_owner until this seat accepts its own action', () => {
  it('repeats each seat-specific message on every state/wait before acting, then omits the key after acting', async () => {
    const t = await fixture();
    if (!t.joined) throw new Error('Expected opponent');
    for (const seat of [0, 1] as const) {
      const player = t.players[seat];
      if (!player) throw new Error('Expected player');
      const opponent = seat === 0 ? '鮑伯' : '小愛 🃏';
      for (const endpoint of ['state', 'wait', 'state', 'wait'] as const) {
        const current = await t.turn(seat, endpoint);
        expect
          .soft(current)
          .toHaveProperty(
            'tell_owner',
            `Playing against ${opponent}. Watch: ${player.watch_url}`,
          );
        reminder(current.hint, player.watch_url);
      }
      if (seat === 1)
        expect
          .soft(await t.turn(1))
          .toHaveProperty('tell_owner', t.joined.tell_owner);
      expect((await t.act(seat, seat === 0 ? 'call' : 'check')).status).toBe(
        200,
      );
    }
    // The big blind starts the flop; both seats have now acted once.
    for (const seat of [1, 0] as const) {
      for (const endpoint of ['state', 'wait'] as const) {
        const current = await t.turn(seat, endpoint);
        expect(current).not.toHaveProperty('tell_owner');
        expect(current.hint).not.toMatch(/watch link/i);
      }
      expect((await t.act(seat, 'check')).status).toBe(200);
    }
  });

  it('invalid_action preserves the message, turn_id and deadline until the retry is accepted', async () => {
    const t = await fixture();
    const first = await t.turn(0);
    const rejected = await t.request(
      `${t.path}/actions?wait=1`,
      t.creator.token,
      { turn_id: first.turn_id, type: 'check' },
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'invalid_action' });
    for (const endpoint of ['state', 'wait'] as const) {
      const current = await t.turn(0, endpoint);
      expect(current).toMatchObject({
        turn_id: first.turn_id,
        deadline: first.deadline,
      });
      expect
        .soft(current)
        .toHaveProperty(
          'tell_owner',
          `Playing against 鮑伯. Watch: ${t.creator.watch_url}`,
        );
    }
    expect((await t.act(0, 'call')).status).toBe(200);
    expect((await t.act(1, 'check')).status).toBe(200);
    expect((await t.act(1, 'check')).status).toBe(200);
    expect(await t.turn(0)).not.toHaveProperty('tell_owner');
  });

  it.each([0, 1] as const)(
    'a timeout does not consume seat %s message, but does consume its double-time turn',
    async seat => {
      const t = await fixture({ turnSeconds: 10 });
      if (seat === 1) expect((await t.act(0, 'call')).status).toBe(200);
      const first = await t.turn(seat);
      t.clock.ms = Date.parse(first.deadline);
      await t.referee.alarm();
      if (seat === 0) expect((await t.act(1, 'call')).status).toBe(200);
      const player = t.players[seat];
      if (!player) throw new Error('Expected player');
      for (const endpoint of ['state', 'wait'] as const) {
        const current = await t.turn(seat, endpoint);
        expect(current.turn_id).not.toBe(first.turn_id);
        expect
          .soft(current)
          .toHaveProperty(
            'tell_owner',
            `Playing against ${seat === 0 ? '鮑伯' : '小愛 🃏'}. Watch: ${player.watch_url}`,
          );
        expect.soft(Date.parse(current.deadline)).toBe(t.clock.ms + 10_000);
        expect.soft(current.seconds_remaining).toBe(10);
        reminder(current.hint, player.watch_url);
      }
    },
  );

  it('actions?wait=1 returns your_turn without tell_owner after the accepted action', async () => {
    const t = await fixture();
    expect((await t.act(0, 'call')).status).toBe(200);
    // Seat 1 checks preflop and is immediately to act again on the flop.
    const response = await t.act(1, 'check', true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'your_turn',
      view: { street: 'flop' },
    });
    expect(body).not.toHaveProperty('tell_owner');
    expect(body).toEqual(await t.read(1, 'wait'));
  });

  it('waiting never carries tell_owner, including actions?wait=1', async () => {
    const t = await fixture();
    for (const endpoint of ['state', 'wait'] as const) {
      const current = await t.read(1, endpoint);
      expect(current.status).toBe('waiting');
      expect(current).not.toHaveProperty('tell_owner');
    }
    const response = await t.act(0, 'call', true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'waiting' });
    expect(body).not.toHaveProperty('tell_owner');
  });

  it('legacy rooms without stored watch_urls omit tell_owner and the watch reminder', async () => {
    const room = new RoomReferee(new MemoryStorage(), {
      waitMs: 1,
      webUrl: 'https://web.test',
    });
    expect(
      await room.create({
        room_id: 'r_legacy0001',
        invite_code: 'ABCDEF',
        name: 'alice',
        settings: {
          starting_stack: 40,
          blind_every: 50,
          max_hands: 5,
          turn_seconds: 30,
        },
        seed: '0'.repeat(64),
        test: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await room.join({ name: 'bob', invite_code: 'ABCDEF' }),
    ).toMatchObject({ ok: true });
    for (const wait of [false, true]) {
      const current = await room.status(0, { wait });
      expect(current).toMatchObject({
        ok: true,
        value: { status: 'your_turn' },
      });
      if (!current.ok) throw new Error('Expected status');
      expect(current.value).not.toHaveProperty('tell_owner');
      expect(current.value.hint).not.toMatch(/watch link/i);
    }
  });
});

describe('T48 first assigned turn gets twice settings.turn_seconds', () => {
  it.each([undefined, 10])(
    'both seats get their own double-time turn, then normal turns (setting %s)',
    async turnSeconds => {
      const t = await fixture({ turnSeconds });
      const seconds = turnSeconds ?? 30;
      const start = t.clock.ms;
      const alice = await t.turn(0);
      expect.soft(Date.parse(alice.deadline)).toBe(start + 2 * seconds * 1000);
      expect.soft(alice.seconds_remaining).toBe(2 * seconds);
      expect.soft(t.storage.alarm).toBe(start + 2 * seconds * 1000);
      t.clock.ms += 3_000;
      expect
        .soft((await t.turn(0, 'wait')).seconds_remaining)
        .toBe(2 * seconds - 3);
      expect((await t.act(0, 'call')).status).toBe(200);
      const bob = await t.turn(1);
      expect
        .soft(Date.parse(bob.deadline))
        .toBe(t.clock.ms + 2 * seconds * 1000);
      expect.soft(bob.seconds_remaining).toBe(2 * seconds);
      expect.soft(t.storage.alarm).toBe(t.clock.ms + 2 * seconds * 1000);
      t.clock.ms += 1_000;
      expect((await t.act(1, 'check')).status).toBe(200);
      const bobAgain = await t.turn(1);
      expect
        .soft(Date.parse(bobAgain.deadline))
        .toBe(t.clock.ms + seconds * 1000);
      expect.soft(bobAgain.seconds_remaining).toBe(seconds);
      expect((await t.act(1, 'check')).status).toBe(200);
      const aliceAgain = await t.turn(0);
      expect
        .soft(Date.parse(aliceAgain.deadline))
        .toBe(t.clock.ms + seconds * 1000);
      expect.soft(aliceAgain.seconds_remaining).toBe(seconds);
    },
  );

  it.each([0, 1] as const)(
    'seat %s is not timed out at 1x or 2x minus 1 ms, but is timed out at 2x',
    async seat => {
      const t = await fixture({ turnSeconds: 10 });
      if (seat === 1) expect((await t.act(0, 'call')).status).toBe(200);
      const first = await t.turn(seat);
      const start = t.clock.ms;
      for (const elapsed of [10_000, 19_999]) {
        t.clock.ms = start + elapsed;
        await t.referee.alarm();
        const response = await t.read(seat);
        expect.soft(response).toMatchObject({
          status: 'your_turn',
          turn_id: first.turn_id,
          deadline: new Date(start + 20_000).toISOString(),
          seconds_remaining: Math.floor((20_000 - elapsed) / 1000),
        });
      }
      t.clock.ms = start + 20_000;
      await t.referee.alarm();
      const response = await t.read(seat);
      if (seat === 0)
        expect(response).toMatchObject({ status: 'waiting', hand_number: 2 });
      else
        expect(response).toMatchObject({
          status: 'your_turn',
          view: { street: 'flop' },
          seconds_remaining: 10,
        });
      if (response.status === 'your_turn')
        expect(response.turn_id).not.toBe(first.turn_id);
      const watched = await t.referee.watch(seat);
      if (!watched.ok) throw new Error('Expected watch');
      const events =
        seat === 0
          ? watched.value.hands[0]?.events
          : watched.value.view?.history;
      expect(events?.at(-1)).toMatchObject({
        seat,
        type: seat === 0 ? 'fold' : 'check',
        timeout: true,
      });
    },
  );

  it('house-bot acts immediately without advancing the clock', async () => {
    const t = await fixture({ bot: true });
    const start = t.clock.ms;
    const first = await t.turn(0);
    expect.soft(first).toHaveProperty('tell_owner', t.creator.tell_owner);
    expect((await t.act(0, 'fold')).status).toBe(200);
    const next = await t.turn(0);
    expect(next.hand_number).toBeGreaterThan(1);
    expect(
      next.view?.history.some(
        event => event.seat === 1 && event.type !== 'post_blind',
      ),
    ).toBe(true);
    expect(t.clock.ms).toBe(start);
    expect(next.seconds_remaining).toBe(30);
  });
});

describe('T48 owner language and script reminders', () => {
  it('your_turn explicitly distinguishes Traditional and Simplified Chinese', async () => {
    const t = await fixture();
    expect((await t.turn(0)).hint).toContain(
      'Traditional and Simplified Chinese are different scripts',
    );
  });

  it.each(['win/loss', 'draw', 'left'] as const)(
    'match_over %s asks for the owner language and script',
    async ending => {
      const t = await fixture({ maxHands: ending === 'draw' ? 2 : 1 });
      if (ending === 'left')
        expect(await t.referee.leave(0)).toMatchObject({ ok: true });
      else {
        expect((await t.act(0, 'fold')).status).toBe(200);
        if (ending === 'draw')
          expect((await t.act(1, 'fold')).status).toBe(200);
      }
      for (const seat of [0, 1] as const) {
        const over = await t.read(seat);
        expect(over).toMatchObject({
          status: 'match_over',
          result: ending === 'draw' ? 'draw' : seat === 0 ? 'loss' : 'win',
        });
        expect
          .soft(over.hint)
          .toContain(
            'Report the result to your owner in their language and script (Traditional and Simplified Chinese are different scripts)',
          );
      }
    },
  );
});
