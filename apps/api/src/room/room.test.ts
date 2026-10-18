import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchRecordInput, RecordedMatch } from '../db/records';
import { type CreateInput, RoomReferee, type RoomStorage } from './referee';
import { Room } from './room';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: Env,
    ) {}
  },
}));

class MemoryStorage implements RoomStorage {
  readonly #data = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.#data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.#data.set(key, structuredClone(value));
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

const INPUT: CreateInput = {
  room_id: 'r_abcde12345',
  invite_code: 'ABCDEF',
  name: 'alice',
  settings: {
    max_hands: 1,
    turn_seconds: 5,
    blind_every: 50,
    starting_stack: 40,
  },
  seed: '0'.repeat(64),
  test: null,
};

const joinedRoom = async (webUrl?: string) => {
  const storage = new MemoryStorage();
  const recorded: RecordedMatch = {
    rated: true,
    ratings: [
      { name: 'alice', rating: 1484, change: -16 },
      { name: 'bob', rating: 1516, change: 16 },
    ],
  };
  const recordMatch = vi.fn(async (_input: MatchRecordInput) => recorded);
  const stub = { recordMatch };
  const id = { name: 'global' };
  const matchmaker = {
    idFromName: vi.fn((_name: string) => id),
    get: vi.fn((_id: unknown) => stub),
  };
  const room = new Room(
    { storage } as unknown as DurableObjectState,
    { MATCHMAKER: matchmaker, WEB_URL: webUrl } as unknown as Env,
  );
  expect(await room.create(INPUT)).toEqual({ ok: true, value: null });
  expect(
    await room.join({ name: 'bob', invite_code: INPUT.invite_code }),
  ).toEqual({
    ok: true,
    value: {
      seat: 1,
      opponent_name: 'alice',
      display_name: 'bob',
      opponent_display_name: 'alice',
      settings: INPUT.settings,
    },
  });
  return { room, storage, matchmaker, id, recordMatch, recorded };
};

describe('Room Durable Object wrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a finished room through the global Matchmaker and returns its ratings', async () => {
    const { room, matchmaker, id, recordMatch, recorded } = await joinedRoom();
    expect(matchmaker.get).not.toHaveBeenCalled();
    const turn = await room.status(0, { wait: false });
    if (!turn.ok || turn.value.status !== 'your_turn') {
      throw new Error('Expected the first turn');
    }
    expect(
      await room.act(0, { turn_id: turn.value.turn_id, type: 'fold' }),
    ).toMatchObject({ ok: true, value: { status: 'accepted' } });
    expect(matchmaker.idFromName).toHaveBeenCalledWith('global');
    expect(matchmaker.get).toHaveBeenCalledWith(id);
    expect(recordMatch).toHaveBeenCalledTimes(1);
    expect(recordMatch.mock.calls[0][0]).toMatchObject({
      match_id: INPUT.room_id,
      players: ['alice', 'bob'],
    });
    for (const wait of [false, true]) {
      expect(await room.status(0, { wait })).toMatchObject({
        ok: true,
        value: { status: 'match_over', ratings: recorded.ratings },
      });
    }
  });

  it('create and join schedule the first deadline; alarm persists the timeout before any status or act call', async () => {
    const joinedAt = Date.now();
    const { room, storage } = await joinedRoom();
    expect(storage.alarm).toBe(joinedAt + 5_000);
    const before = await storage.get('room');

    vi.setSystemTime(joinedAt + 5_001);
    await room.alarm();

    // Inspect persistence first: status() can itself catch up expired turns.
    expect(await storage.get('room')).not.toEqual(before);
    expect(storage.alarm).toBeNull();
    const status = await room.status(0, { wait: false });
    expect(status).toMatchObject({
      ok: true,
      value: {
        status: 'match_over',
        room_status: 'finished',
        result: 'loss',
        last_hand: { ended_by: 'fold', winner_seat: 1 },
      },
    });
  });

  it('abort through Room voids the room and deletes the alarm', async () => {
    const { room, storage } = await joinedRoom();
    expect(await room.abort()).toEqual({ ok: true, value: null });
    expect(storage.alarm).toBeNull();
    for (const seat of [0, 1] as const) {
      expect(await room.status(seat, { wait: false })).toMatchObject({
        ok: true,
        value: { status: 'match_over', room_status: 'void', result: 'void' },
      });
    }
  });

  it('passes WEB_URL to the referee for match_over hints', async () => {
    const { room } = await joinedRoom('https://web.test');
    const response = await room.leave(0);
    expect(response).toMatchObject({
      ok: true,
      value: { status: 'match_over', result: 'loss' },
    });
    if (!response.ok) throw new Error('Expected leave to succeed');
    expect(response.value.hint).toContain(
      `https://web.test/matches/${INPUT.room_id}`,
    );
  });
});

describe('match_over record links (T32, A15)', () => {
  const endings = [
    { ending: 'fold', joined: true, results: ['loss', 'win'], hasRecord: true },
    {
      ending: 'draw',
      joined: true,
      results: ['draw', 'draw'],
      hasRecord: true,
    },
    {
      ending: 'leave',
      joined: true,
      results: ['loss', 'win'],
      hasRecord: true,
    },
    {
      ending: 'abort',
      joined: true,
      results: ['void', 'void'],
      hasRecord: true,
    },
    {
      ending: 'timeout',
      joined: false,
      results: ['cancelled'],
      hasRecord: false,
    },
    {
      ending: 'leave',
      joined: false,
      results: ['cancelled'],
      hasRecord: false,
    },
    { ending: 'abort', joined: false, results: ['void'], hasRecord: false },
  ] as const;

  for (const webUrl of ['https://web.test', undefined]) {
    describe(`webUrl=${webUrl ?? 'unset'}`, () => {
      it.each(endings)(
        '$ending with joined=$joined gives links only for a started match',
        async ({ ending, joined, results, hasRecord }) => {
          const clock = { ms: Date.parse('2026-10-18T00:00:00Z') };
          // Keep options assignable before the new optional webUrl is declared.
          const options = { webUrl, now: () => clock.ms, waitMs: 1 };
          const referee = new RoomReferee(new MemoryStorage(), options);
          expect(
            await referee.create({
              ...INPUT,
              settings: {
                ...INPUT.settings,
                max_hands: ending === 'draw' ? 2 : 1,
              },
            }),
          ).toMatchObject({ ok: true });
          if (joined) {
            expect(
              await referee.join({
                name: 'bob',
                invite_code: INPUT.invite_code,
              }),
            ).toMatchObject({ ok: true });
          }

          const expectLink = (hint: string) => {
            if (webUrl && hasRecord) {
              expect.soft(hint).toContain(`${webUrl}/matches/${INPUT.room_id}`);
            } else {
              expect.soft(hint).not.toContain('/matches/');
            }
          };

          if (ending === 'leave') {
            const left = await referee.leave(0);
            expect(left).toMatchObject({
              ok: true,
              value: { status: 'match_over', result: results[0] },
            });
            if (!left.ok) throw new Error('Expected leave to succeed');
            expectLink(left.value.hint);
          } else if (ending === 'abort') {
            expect(await referee.abort()).toMatchObject({ ok: true });
          } else if (ending === 'timeout') {
            clock.ms += 5 * 60 * 1000;
            await referee.alarm();
          } else {
            for (let hand = 0; hand < (ending === 'draw' ? 2 : 1); hand++) {
              const seat = hand === 0 ? 0 : 1;
              const turn = await referee.status(seat, { wait: false });
              if (!turn.ok || turn.value.status !== 'your_turn') {
                throw new Error('Expected a turn to finish by folding');
              }
              expect(
                await referee.act(seat, {
                  turn_id: turn.value.turn_id,
                  type: 'fold',
                }),
              ).toMatchObject({ ok: true, value: { status: 'accepted' } });
            }
          }

          for (const seat of joined ? ([0, 1] as const) : ([0] as const)) {
            for (const wait of [false, true]) {
              const response = await referee.status(seat, { wait });
              expect(response).toMatchObject({
                ok: true,
                value: { status: 'match_over', result: results[seat] },
              });
              if (!response.ok) throw new Error('Expected finished status');
              expectLink(response.value.hint);
            }

            const errors = [
              await referee.act(seat, { turn_id: 't_999', type: 'check' }),
              await referee.leave(seat),
            ];
            for (const response of errors) {
              expect(response).toMatchObject({
                ok: false,
                error: {
                  code: 'match_over',
                  state: { status: 'match_over', result: results[seat] },
                },
              });
              if (response.ok || !response.error.state) {
                throw new Error('Expected match_over error with state');
              }
              expectLink(response.error.state.hint);
            }
          }
        },
      );
    });
  }
});

describe('T35 persisted room display names', () => {
  it('persists both display names across a RoomReferee recreation and passes them to the match recorder', async () => {
    const storage = new MemoryStorage();
    const record = vi.fn(
      async (_input: MatchRecordInput): Promise<RecordedMatch> => ({
        rated: false,
        ratings: null,
      }),
    );
    const options = { waitMs: 1, record };
    const referee = new RoomReferee(storage, options);
    expect(
      await referee.create({ ...INPUT, display_name: '小愛 🃏' }),
    ).toMatchObject({ ok: true });
    expect(
      await referee.join({
        name: 'bob',
        display_name: '小包 🎲',
        invite_code: INPUT.invite_code,
      }),
    ).toMatchObject({
      ok: true,
      value: { display_name: '小包 🎲', opponent_display_name: '小愛 🃏' },
    });
    const restored = new RoomReferee(storage, options);
    for (const wait of [false, true]) {
      for (const seat of [0, 1] as const) {
        expect(await restored.status(seat, { wait })).toMatchObject({
          ok: true,
          value: {
            display_name: seat === 0 ? '小愛 🃏' : '小包 🎲',
            opponent_display_name: seat === 0 ? '小包 🎲' : '小愛 🃏',
          },
        });
      }
    }
    expect(await restored.leave(0)).toMatchObject({ ok: true });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        players: ['alice', 'bob'],
        display_names: ['小愛 🃏', '小包 🎲'],
      }),
    );
  });

  it.each(['waiting', 'human', 'bot'] as const)(
    'reads a pre-T35 %s room without display_names',
    async kind => {
      const storage = new MemoryStorage();
      const options = { waitMs: 1 };
      const original = new RoomReferee(storage, options);
      expect(
        await original.create({
          ...INPUT,
          display_name: '新名字',
          ...(kind === 'bot' ? { opponent: 'bot' as const } : {}),
        }),
      ).toMatchObject({ ok: true });
      if (kind === 'human') {
        expect(
          await original.join({
            name: 'bOB',
            display_name: '另一個名字',
            invite_code: INPUT.invite_code,
          }),
        ).toMatchObject({ ok: true });
      }
      const stored = await storage.get<Record<string, unknown>>('room');
      if (!stored) throw new Error('Expected a persisted room');
      delete stored.display_names;
      await storage.put('room', stored);
      const restored = new RoomReferee(storage, options);
      const opponent =
        kind === 'waiting' ? null : kind === 'bot' ? 'House Bot' : 'bOB';
      for (const wait of [false, true]) {
        expect(await restored.status(0, { wait })).toMatchObject({
          ok: true,
          value: { display_name: 'alice', opponent_display_name: opponent },
        });
        if (kind === 'human') {
          expect(await restored.status(1, { wait })).toMatchObject({
            ok: true,
            value: { display_name: 'bOB', opponent_display_name: 'alice' },
          });
        }
      }
      expect(await restored.watch(0)).toMatchObject({
        ok: true,
        value: { display_names: ['alice', opponent] },
      });
      if (kind === 'human') {
        expect(await restored.watch(1)).toMatchObject({
          ok: true,
          value: { display_names: ['alice', 'bOB'] },
        });
      }
    },
  );
});
