import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchRecordInput, RecordedMatch } from '../db/records';
import { applyTableAction, startTable } from '../holdem/table';
import { legacyRoom } from './legacy-fixture';
import {
  type CreateInput,
  RoomReferee,
  type RoomStorage,
  type TableRecordInput,
} from './referee';
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
  visibility: null,
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
  // Rooms also tell the Matchmaker, the lobby, their lobby row (T39).
  const stub = { recordMatch, listRoom: vi.fn(async () => {}) };
  const id = { name: 'global' };
  const matchmaker = {
    idFromName: vi.fn((_name: string) => id),
    get: vi.fn((_id: unknown) => stub),
  };
  const room = new Room(
    { storage } as unknown as DurableObjectState,
    { MATCHMAKER: matchmaker, WEB_URL: webUrl } as unknown as Env,
  );
  expect(await room.create(INPUT)).toEqual({
    ok: true,
    value: createdSeat(INPUT),
  });
  expect(
    await room.join({ name: 'bob', invite_code: INPUT.invite_code }),
  ).toEqual({
    ok: true,
    value: {
      room_id: INPUT.room_id,
      visibility: 'private',
      invite_code: null,
      is_host: false,
      seats_open: 0,
      seats: [
        {
          seat: 0,
          name: 'alice',
          display_name: 'alice',
          stack: 39,
          bet_this_street: 1,
          status: 'playing',
          place: null,
        },
        {
          seat: 1,
          name: 'bob',
          display_name: 'bob',
          stack: 38,
          bet_this_street: 2,
          status: 'playing',
          place: null,
        },
      ],
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
  it('T43: match_over tells each owner their result, final stacks, both Elo changes and record URL', async () => {
    const { room } = await joinedRoom('https://web.test');
    const turn = await room.status('alice', { wait: false });
    if (!turn.ok || turn.value.status !== 'your_turn')
      throw new Error('Expected turn');
    const accepted = await room.act('alice', {
      turn_id: turn.value.turn_id,
      type: 'fold',
    });
    expect(accepted).toMatchObject({ ok: true, value: { status: 'accepted' } });
    if (!accepted.ok) throw new Error('Expected accepted');
    expect(accepted.value).not.toHaveProperty('tell_owner');
    expect(accepted.value).not.toHaveProperty('hands_since_your_turn');
    for (const seat of [0, 1] as const) {
      const response = await room.status(['alice', 'bob'][seat], {
        wait: false,
      });
      if (!response.ok || response.value.status !== 'match_over')
        throw new Error('Expected match_over');
      const body = response.value;
      expect.soft(body).toHaveProperty('tell_owner', expect.any(String));
      const message =
        (body as unknown as { tell_owner?: string }).tell_owner ?? '';
      expect
        .soft(message)
        .toMatch(
          seat === 0 ? /\b(loss|lost|defeat)\b/i : /\b(win|won|victory)\b/i,
        );
      for (const stack of body.final_stacks)
        expect.soft(message).toContain(String(stack));
      expect.soft(message).toMatch(/Elo/i);
      for (const rating of body.ratings ?? []) {
        expect.soft(message).toContain(rating.name);
        expect
          .soft(message)
          .toContain(
            rating.change > 0 ? `+${rating.change}` : String(rating.change),
          );
      }
      expect
        .soft(message)
        .toContain(`https://web.test/matches/${INPUT.room_id}`);
    }
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a finished room through the global Matchmaker and returns its ratings', async () => {
    const { room, matchmaker, id, recordMatch, recorded } = await joinedRoom();
    // Only the lobby has heard from the room so far (T39).
    expect(recordMatch).not.toHaveBeenCalled();
    const turn = await room.status('alice', { wait: false });
    if (!turn.ok || turn.value.status !== 'your_turn') {
      throw new Error('Expected the first turn');
    }
    expect(
      await room.act('alice', { turn_id: turn.value.turn_id, type: 'fold' }),
    ).toMatchObject({ ok: true, value: { status: 'accepted' } });
    expect(matchmaker.idFromName).toHaveBeenCalledWith('global');
    expect(matchmaker.get).toHaveBeenCalledWith(id);
    expect(recordMatch).toHaveBeenCalledTimes(1);
    expect(recordMatch.mock.calls[0][0]).toMatchObject({
      match_id: INPUT.room_id,
      players: ['alice', 'bob'],
    });
    for (const wait of [false, true]) {
      expect(await room.status('alice', { wait })).toMatchObject({
        ok: true,
        value: { status: 'match_over', ratings: recorded.ratings },
      });
    }
  });

  it('create and join schedule the first deadline; alarm persists the timeout before any status or act call', async () => {
    const joinedAt = Date.now();
    const { room, storage } = await joinedRoom();
    expect(storage.alarm).toBe(joinedAt + 10_000);
    const before = await storage.get('room');

    vi.setSystemTime(joinedAt + 10_001);
    await room.alarm();

    // Inspect persistence first: status() can itself catch up expired turns.
    expect(await storage.get('room')).not.toEqual(before);
    expect(storage.alarm).toBeNull();
    const status = await room.status('alice', { wait: false });
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
      expect(
        await room.status(['alice', 'bob'][seat], { wait: false }),
      ).toMatchObject({
        ok: true,
        value: { status: 'match_over', room_status: 'void', result: 'void' },
      });
    }
  });

  it('passes WEB_URL to the referee for match_over hints', async () => {
    const { room } = await joinedRoom('https://web.test');
    const response = await room.leave('alice');
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
            const left = await referee.leave('alice');
            expect(left).toMatchObject({
              ok: true,
              value: { status: 'match_over', result: results[0] },
            });
            if (!left.ok) throw new Error('Expected leave to succeed');
            expectLink(left.value.hint);
          } else if (ending === 'abort') {
            expect(await referee.abort()).toMatchObject({ ok: true });
          } else if (ending === 'timeout') {
            clock.ms += 2 * 60 * 1000;
            await referee.alarm();
          } else {
            for (let hand = 0; hand < (ending === 'draw' ? 2 : 1); hand++) {
              const seat = hand === 0 ? 0 : 1;
              const turn = await referee.status(['alice', 'bob'][seat], {
                wait: false,
              });
              if (!turn.ok || turn.value.status !== 'your_turn') {
                throw new Error('Expected a turn to finish by folding');
              }
              expect(
                await referee.act(['alice', 'bob'][seat], {
                  turn_id: turn.value.turn_id,
                  type: 'fold',
                }),
              ).toMatchObject({ ok: true, value: { status: 'accepted' } });
            }
          }

          for (const seat of joined ? ([0, 1] as const) : ([0] as const)) {
            for (const wait of [false, true]) {
              const response = await referee.status(['alice', 'bob'][seat], {
                wait,
              });
              expect(response).toMatchObject({
                ok: true,
                value: { status: 'match_over', result: results[seat] },
              });
              if (!response.ok) throw new Error('Expected finished status');
              expectLink(response.value.hint);
            }

            const errors = [
              await referee.act(['alice', 'bob'][seat], {
                turn_id: 't_999',
                type: 'check',
              }),
              await referee.leave(['alice', 'bob'][seat]),
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
  it.each([true, false])(
    'T51: match_over uses display names for chips and identity-qualified Elo (rated=%s)',
    async rated => {
      const room = new RoomReferee(new MemoryStorage(), {
        waitMs: 1,
        record: async () => ({
          rated,
          ratings: rated
            ? [
                { name: 'haiku-cf62', rating: 1516, change: 16 },
                { name: 'alice', rating: 1484, change: -16 },
              ]
            : null,
        }),
      });
      expect(
        await room.create({
          ...INPUT,
          name: 'haiku-cf62',
          display_name: '海庫',
        }),
      ).toMatchObject({ ok: true });
      expect(
        await room.join({
          name: 'alice',
          display_name: 'alice',
          invite_code: INPUT.invite_code,
        }),
      ).toMatchObject({ ok: true });
      expect(await room.leave('alice')).toMatchObject({ ok: true });
      for (const seat of [0, 1] as const) {
        const response = await room.status(['haiku-cf62', 'alice'][seat], {
          wait: false,
        });
        if (!response.ok || response.value.status !== 'match_over')
          throw new Error('Expected match_over');
        const message = response.value.tell_owner ?? '';
        const chips = message.split('Elo:')[0] ?? '';
        expect.soft(chips).toContain('海庫');
        expect.soft(chips).toContain('alice');
        expect.soft(chips).not.toContain('haiku-cf62');
        for (const stack of response.value.final_stacks)
          expect.soft(chips).toContain(String(stack));
        if (rated) {
          expect
            .soft(message)
            .toContain(
              seat === 0
                ? 'Elo: 海庫 (haiku-cf62): 1516 (+16), alice: 1484 (-16)'
                : 'Elo: alice: 1484 (-16), 海庫 (haiku-cf62): 1516 (+16)',
            );
          expect.soft(message).not.toContain('alice (alice)');
        } else {
          expect.soft(message).toContain('unrated (no change)');
        }
      }
    },
  );

  it('persists both display names across a RoomReferee recreation and passes them to the match recorder', async () => {
    const storage = new MemoryStorage();
    const record = vi.fn(
      async (_input: TableRecordInput): Promise<RecordedMatch> => ({
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
        expect(
          await restored.status(['alice', 'bob'][seat], { wait }),
        ).toMatchObject({
          ok: true,
          value: {
            display_name: seat === 0 ? '小愛 🃏' : '小包 🎲',
            opponent_display_name: seat === 0 ? '小包 🎲' : '小愛 🃏',
          },
        });
      }
    }
    expect(await restored.leave('alice')).toMatchObject({ ok: true });
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
      // The pre-T38 shape, saved before T35: no display_names key at all.
      const legacy = legacyRoom(false);
      const second =
        kind === 'waiting' ? null : kind === 'bot' ? 'house-bot' : 'bOB';
      const stored: Record<string, unknown> = {
        ...legacy.room,
        names: ['alice', second],
        ...(kind === 'waiting'
          ? {
              match: null,
              turn: null,
              turn_count: 0,
              used_turns: {},
              acted_after_hand: undefined,
            }
          : {}),
      };
      delete stored.display_names;
      expect(stored).not.toHaveProperty('display_names');
      const storage = new MemoryStorage();
      await storage.put('room', stored);
      if (kind !== 'waiting') await storage.put('hand:1', legacy.hand);
      const restored = new RoomReferee(storage, {
        now: () => legacy.at,
        waitMs: 1,
      });
      const opponent =
        kind === 'waiting' ? null : kind === 'bot' ? 'House Bot' : 'bOB';
      for (const wait of [false, true]) {
        expect(await restored.status('alice', { wait })).toMatchObject({
          ok: true,
          value: { display_name: 'alice', opponent_display_name: opponent },
        });
        if (kind === 'human') {
          expect(await restored.status('bOB', { wait })).toMatchObject({
            ok: true,
            value: { display_name: 'bOB', opponent_display_name: 'alice' },
          });
        }
      }
      expect(await restored.watch('alice')).toMatchObject({
        ok: true,
        value: {
          display_names: opponent === null ? ['alice'] : ['alice', opponent],
        },
      });
      if (kind === 'human') {
        expect(await restored.watch('bOB')).toMatchObject({
          ok: true,
          value: { display_names: ['alice', 'bOB'] },
        });
      }
    },
  );
});

// Transitional heads-up seat answer (A25); keep exact create assertions.
const createdSeat = (input: {
  room_id: string;
  invite_code: string;
  name: string;
  settings: {
    starting_stack: number;
    max_hands: number;
    turn_seconds: number;
    blind_every: number | null;
  };
  opponent?: 'bot';
}) => {
  const bot = input.opponent === 'bot';
  return {
    room_id: input.room_id,
    visibility: 'private',
    invite_code: input.invite_code,
    seat: 0,
    is_host: true,
    display_name: input.name,
    opponent_name: bot ? 'house-bot' : null,
    opponent_display_name: bot ? 'House Bot' : null,
    seats: [
      {
        seat: 0,
        name: input.name,
        display_name: input.name,
        stack: input.settings.starting_stack - (bot ? 1 : 0),
        bet_this_street: bot ? 1 : 0,
        status: bot ? 'playing' : 'waiting',
        place: null,
      },
      ...(bot
        ? [
            {
              seat: 1,
              name: 'house-bot',
              display_name: 'House Bot',
              stack: input.settings.starting_stack - 2,
              bet_this_street: 2,
              status: 'playing',
              place: null,
            },
          ]
        : []),
    ],
    seats_open: bot ? 0 : 1,
    settings: input.settings,
  };
};

describe('pre-T38 RoomData and HandRecord storage compatibility', () => {
  it('continues an active legacy room and records both old and new hands without voiding it', async () => {
    const storage = new MemoryStorage();
    const legacy = legacyRoom(false);
    await storage.put('room', legacy.room);
    await storage.put('hand:1', legacy.hand);
    const record = vi.fn(async (_input: TableRecordInput) => ({
      rated: false,
      ratings: null,
    }));
    const room = new RoomReferee(storage, {
      now: () => legacy.at,
      waitMs: 1,
      record,
    });
    expect(await room.status('BOB', { wait: false })).toMatchObject({
      ok: true,
      value: {
        status: 'your_turn',
        hand_number: 2,
        turn_id: 't_2',
        view: { my_seat: 1, my_cards: ['Qs', 'Ac'], pot: 3, pots: [3] },
      },
    });
    expect(
      await room.act('bob', { turn_id: 't_2', type: 'fold' }),
    ).toMatchObject({ ok: true, value: { status: 'accepted' } });
    expect(await room.status('ALICE', { wait: false })).toMatchObject({
      ok: true,
      value: {
        status: 'match_over',
        result: 'draw',
        final_stacks: [40, 40],
        place: 1,
      },
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      players: ['alice', 'bob'],
      display_names: ['小愛', '小包'],
      result: 'draw',
      places: [1, 1],
      hands: [
        { ...legacy.hand, pots: [{ amount: 2, winners: [1] }] },
        {
          hand_number: 2,
          pot: 2,
          pots: [{ amount: 2, winners: [0] }],
          stacks: [40, 40],
        },
      ],
    });
  });

  it('serves a finished legacy room watch, including the stored hand and public cards', async () => {
    const storage = new MemoryStorage();
    const legacy = legacyRoom(true);
    await storage.put('room', legacy.room);
    await storage.put('hand:1', legacy.hand);
    const room = new RoomReferee(storage, { now: () => legacy.at, waitMs: 1 });
    for (const name of ['ALICE', 'BOB']) {
      expect(await room.watch(name)).toMatchObject({
        ok: true,
        value: {
          room_id: INPUT.room_id,
          room_status: 'finished',
          players: ['alice', 'bob'],
          display_names: ['小愛', '小包'],
          final_stacks: [39, 41],
          places: [2, 1],
          hands: [
            {
              hand_number: 1,
              pot: 2,
              pots: [{ amount: 2, winner_seats: [1] }],
              hole_cards: [
                ['9c', 'Ks'],
                ['Jh', '9d'],
              ],
              stacks: [39, 41],
            },
          ],
        },
      });
    }
  });
});

describe('pre-T38 finished room that was never recorded', () => {
  // A heads-up room that ended by fold before T38 wrote it, so `recorded` is
  // still null when the new referee first reads it.
  const unrecorded = () => {
    const legacy = legacyRoom(true);
    return {
      legacy,
      room: { ...legacy.room, recorded: null },
    };
  };

  it('the fixture replays on the current engine to the same fold-ended result', () => {
    const { legacy } = unrecorded();
    const start = startTable({
      seed: legacy.room.seed,
      players: 2,
      startingStack: 40,
      blindEvery: 50,
      maxHands: 1,
    });
    const folded = applyTableAction(start, 0, { type: 'fold' });
    if (!folded.ok) throw new Error(folded.message);
    expect(folded.state.over).toBe(true);
    expect(folded.state.places).toEqual([2, 1]);
    expect(folded.state.stacks).toEqual([39, 41]);
    expect(folded.finishedHands).toHaveLength(1);
    expect(folded.finishedHands[0]).toMatchObject({
      ended_by: 'fold',
      winner_seat: 1,
      stacks: [39, 41],
    });
    expect(legacy.hand).toMatchObject({ ended_by: 'fold', winner_seat: 1 });
  });

  it.each(['alarm', 'status'] as const)(
    'records it on first %s as a real result, not a void, exactly once',
    async trigger => {
      const { legacy, room: stored } = unrecorded();
      const storage = new MemoryStorage();
      await storage.put('room', stored);
      await storage.put('hand:1', legacy.hand);
      const rated: RecordedMatch = {
        rated: true,
        ratings: [
          { name: 'alice', rating: 1484, change: -16 },
          { name: 'bob', rating: 1516, change: 16 },
        ],
      };
      const record = vi.fn(async (_input: TableRecordInput) => rated);
      const options = { now: () => legacy.at, waitMs: 1, record };
      const room = new RoomReferee(storage, options);
      if (trigger === 'alarm') await room.alarm();
      else await room.status('alice', { wait: false });

      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0][0]).toMatchObject({
        match_id: legacy.room.room_id,
        players: ['alice', 'bob'],
        display_names: ['小愛', '小包'],
        seed: legacy.room.seed,
        result: 'seat1_win',
        places: [2, 1],
        final_stacks: [39, 41],
        ended_at: new Date(legacy.at).toISOString(),
        hands: [
          {
            ended_by: 'fold',
            winner_seat: 1,
            stacks: [39, 41],
            pots: [{ amount: 2, winners: [1] }],
          },
        ],
      });
      for (const [name, result, place] of [
        ['alice', 'loss', 2],
        ['bob', 'win', 1],
      ] as const) {
        expect(await room.status(name, { wait: false })).toMatchObject({
          ok: true,
          value: {
            status: 'match_over',
            room_status: 'finished',
            result,
            place,
            final_stacks: [39, 41],
            ratings: rated.ratings,
          },
        });
      }
      // The write is remembered: a fresh referee over the same storage does not repeat it.
      const again = new RoomReferee(storage, options);
      await again.alarm();
      await again.status('bob', { wait: false });
      expect(record).toHaveBeenCalledTimes(1);
    },
  );
});

describe('Room DO hands an N-seat table to the Matchmaker (A10)', () => {
  const settings = {
    max_hands: 1,
    turn_seconds: 5,
    blind_every: 50,
    starting_stack: 40,
  };
  const NAMES = ['alice', 'bob', 'carol'];
  const recorded: RecordedMatch = {
    rated: true,
    ratings: [
      { name: 'alice', rating: 1510, change: 10 },
      { name: 'bob', rating: 1495, change: -5 },
      { name: 'carol', rating: 1495, change: -5 },
    ],
  };

  const seated = async () => {
    const recordMatch = vi.fn(async (_input: MatchRecordInput) => recorded);
    const id = { name: 'global' };
    const matchmaker = {
      idFromName: vi.fn((_name: string) => id),
      get: vi.fn((_id: unknown) => ({
        recordMatch,
        listRoom: async () => {},
      })),
    };
    const room = new Room(
      { storage: new MemoryStorage() } as unknown as DurableObjectState,
      { MATCHMAKER: matchmaker } as unknown as Env,
    );
    expect(
      await room.create({
        room_id: 'r_multi00002',
        invite_code: 'ABCDEF',
        name: 'alice',
        settings,
        seed: '0'.repeat(64),
        test: null,
        visibility: 'public',
      }),
    ).toMatchObject({ ok: true });
    for (const name of NAMES.slice(1))
      expect(await room.join({ name })).toMatchObject({ ok: true });
    expect(await room.start('alice', {})).toMatchObject({ ok: true });
    return { room, recordMatch, matchmaker, id };
  };

  const expectRatings = async (room: Room) => {
    for (const name of NAMES) {
      expect(await room.status(name, { wait: false })).toMatchObject({
        ok: true,
        value: { status: 'match_over', ratings: recorded.ratings },
      });
    }
  };

  it('a table played out sends 3 players, 3 places and TableHandRecords; match_over carries the 3 ratings', async () => {
    const { room, recordMatch, matchmaker, id } = await seated();
    for (
      let turn = 0;
      turn < 20 && recordMatch.mock.calls.length === 0;
      turn++
    ) {
      for (const name of NAMES) {
        const state = await room.status(name, { wait: false });
        if (state.ok && state.value.status === 'your_turn') {
          await room.act(name, { turn_id: state.value.turn_id, type: 'fold' });
          break;
        }
      }
    }
    expect(matchmaker.idFromName).toHaveBeenCalledWith('global');
    expect(matchmaker.get).toHaveBeenCalledWith(id);
    expect(recordMatch).toHaveBeenCalledTimes(1);
    const input = recordMatch.mock.calls[0][0];
    expect(input).toMatchObject({
      match_id: 'r_multi00002',
      players: NAMES,
      seed: '0'.repeat(64),
      end_reason: 'max_hands',
    });
    expect(input.display_names).toHaveLength(3);
    expect(input.final_stacks).toHaveLength(3);
    expect(input.places).toHaveLength(3);
    expect(input.places?.every(place => Number.isInteger(place))).toBe(true);
    expect(input.hands.length).toBeGreaterThan(0);
    for (const hand of input.hands) {
      expect(hand.pots).toEqual(expect.any(Array));
      expect(hand.pots?.length).toBeGreaterThan(0);
    }
    await expectRatings(room);
  });

  it('two seats leaving ends the match by leave and still records all 3 seats', async () => {
    const { room, recordMatch } = await seated();
    expect(await room.leave('bob')).toMatchObject({
      ok: true,
      value: { place: 3 },
    });
    expect(recordMatch).not.toHaveBeenCalled();
    expect(await room.leave('carol')).toMatchObject({
      ok: true,
      value: { place: 2 },
    });
    expect(recordMatch).toHaveBeenCalledTimes(1);
    expect(recordMatch.mock.calls[0][0]).toMatchObject({
      players: NAMES,
      places: [1, 3, 2],
      end_reason: 'leave',
    });
    expect(recordMatch.mock.calls[0][0].final_stacks).toHaveLength(3);
    await expectRatings(room);
  });
});
