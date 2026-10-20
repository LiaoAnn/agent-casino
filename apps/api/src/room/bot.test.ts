// T13 S2: casino-api A1/A3/A9/A15 and holdem-rules timeout actions.
// Only public referee methods and the pure holdem engine are exercised.
import { describe, expect, it, vi } from 'vitest';
import type { RoomStatus } from '../contract/schemas';
import { randomAction } from '../holdem/bot';
import {
  type Action,
  applyTableAction,
  startTable,
  type TableHandRecord,
  tableLegalActions,
} from '../holdem/table';
import type { RecordedMatch, TableRecordInput } from './referee';
import { RoomReferee, type RoomStorage } from './referee';
import { seatView } from './view';

const SETTINGS = {
  max_hands: 4,
  turn_seconds: 5,
  blind_every: 50,
  starting_stack: 40,
};
const INPUT = {
  room_id: 'r_bottest001',
  invite_code: 'ABC234',
  name: 'Alice',
  settings: SETTINGS,
  seed: '0'.repeat(64),
  test: null,
  visibility: null,
};

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

const sequence = (values: readonly number[]) => {
  let index = 0;
  return vi.fn(() => values[index++ % values.length] ?? 0.6);
};

function fixture(values: readonly number[] = [0.6], settings = SETTINGS) {
  const storage = new MemoryStorage();
  const clock = { ms: Date.parse('2026-10-18T00:00:00Z') };
  const random = sequence(values);
  const recorded: RecordedMatch = { rated: false, ratings: null };
  const record = vi.fn(async (_input: TableRecordInput) => recorded);
  // Variables permit testing the proposed optional interface before S2 exists.
  const options = { now: () => clock.ms, waitMs: 1, random, record };
  const referee = new RoomReferee(storage, options);
  const create = async (bot = true) => {
    const input = {
      ...INPUT,
      settings,
      ...(bot ? { opponent: 'bot' as const } : {}),
    };
    expect(await referee.create(input)).toEqual({
      ok: true,
      value: createdSeat(input),
    });
  };
  const status = async (wait = false): Promise<typeof RoomStatus.Type> => {
    const response = await referee.status(INPUT.name, { wait });
    if (!response.ok) throw new Error(JSON.stringify(response.error));
    return response.value;
  };
  const turn = async () => {
    const current = await status();
    expect(current.status).toBe('your_turn');
    if (current.status !== 'your_turn') throw new Error('Expected human turn');
    return current;
  };
  const act = async (action: Action) => {
    const current = await turn();
    expect(
      await referee.act(INPUT.name, { turn_id: current.turn_id, ...action }),
    ).toMatchObject({
      ok: true,
      value: { status: 'accepted' },
    });
  };
  return {
    referee,
    storage,
    clock,
    random,
    record,
    recorded,
    create,
    status,
    turn,
    act,
  };
}

describe('T13 S2: house-bot in RoomReferee', () => {
  it('starts immediately with seat 1 occupied and rejects an invite-code join as room_full', async () => {
    const t = fixture();
    await t.create();
    expect(await t.status()).toMatchObject({
      status: 'your_turn',
      room_status: 'playing',
      to_act_seat: 0,
      view: { my_seat: 0, opponent_stack: 38 },
    });
    expect(
      await t.referee.join({ name: 'Bob', invite_code: INPUT.invite_code }),
    ).toMatchObject({
      ok: false,
      error: { code: 'room_full' },
    });
  });

  it('acts before the human action returns, including when the bot opens the next hand', async () => {
    const t = fixture();
    await t.create();
    const now = t.clock.ms;
    await t.act({ type: 'call' });
    // Big blind checks preflop, then acts first on the flop.
    expect(t.random).toHaveBeenCalledTimes(2);
    const afterCall = await t.status(true);
    expect(afterCall).toMatchObject({ status: 'your_turn', to_act_seat: 0 });
    expect(
      afterCall.view?.history.filter(
        event => event.seat === 1 && event.type !== 'post_blind',
      ),
    ).toEqual([
      { seat: 1, street: 'preflop', type: 'check' },
      { seat: 1, street: 'flop', type: 'check' },
    ]);
    await t.act({ type: 'fold' });
    // Seat 1 is the small blind in hand 2 and must call before act returns.
    expect(t.random).toHaveBeenCalledTimes(3);
    expect(await t.status(true)).toMatchObject({
      status: 'your_turn',
      hand_number: 2,
      to_act_seat: 0,
      view: {
        history: [
          { seat: 1, street: 'preflop', type: 'post_blind', amount: 1 },
          { seat: 0, street: 'preflop', type: 'post_blind', amount: 2 },
          { seat: 1, street: 'preflop', type: 'call', amount: 1 },
        ],
      },
    });
    expect(t.clock.ms).toBe(now);
  });

  it.each([
    { label: 'check/call', values: [0.6] },
    { label: 'minimum raises and folds', values: [0.1, 0.2, 0.9, 0.6] },
    {
      label: 'all-in and intermediate raises',
      values: [0.1, 0.4, 0.1, 0.7, 0.5, 0.9, 0.6],
    },
  ])(
    'matches randomAction for $label, persists legal non-timeout bot events and records house-bot',
    async ({ values }) => {
      // Running twice also pins down the same-stream/same-actions guarantee.
      const runs: TableHandRecord[][] = [];
      for (let run = 0; run < 2; run++) {
        const t = fixture(values);
        const oracleRandom = sequence(values);
        let engine = startTable({
          players: 2,
          seed: INPUT.seed,
          maxHands: SETTINGS.max_hands,
          blindEvery: 50,
          startingStack: SETTINGS.starting_stack,
        });
        const hands: TableHandRecord[] = [];
        const step = (action: Action) => {
          if (engine.toAct === null) throw new Error('Expected engine turn');
          const applied = applyTableAction(engine, engine.toAct, action);
          if (!applied.ok) throw new Error(applied.message);
          engine = applied.state;
          hands.push(...applied.finishedHands);
        };
        await t.create();
        for (let n = 0; !engine.over; n++) {
          expect(n).toBeLessThan(500);
          const turn = await t.turn();
          expect(turn).toMatchObject({
            hand_number: engine.handNumber,
            to_act_seat: engine.toAct,
            view: seatView(engine, 0),
            last_hand:
              engine.lastHand === null
                ? null
                : {
                    ...engine.lastHand,
                    pots: engine.lastHand.pots.map(({ amount, winners }) => ({
                      amount,
                      winner_seats: winners,
                    })),
                  },
          });
          expect(turn.legal_actions).toEqual(tableLegalActions(engine));
          const action: Action = tableLegalActions(engine).some(
            a => a.type === 'check',
          )
            ? { type: 'check' }
            : { type: 'call' };
          step(action);
          while (!engine.over && engine.toAct === 1) {
            step(randomAction(tableLegalActions(engine), oracleRandom));
          }
          expect(
            await t.referee.act(INPUT.name, {
              turn_id: turn.turn_id,
              ...action,
            }),
          ).toMatchObject({
            ok: true,
            value: { status: 'accepted' },
          });
          // Check before status()/wait() can trigger any deferred bot action.
          expect(t.random.mock.calls.length).toBe(
            oracleRandom.mock.calls.length,
          );
          const actual = await t.status(true);
          expect(actual).toMatchObject({
            hand_number: engine.handNumber,
            to_act_seat: engine.toAct,
            view: seatView(engine, 0),
            last_hand:
              engine.lastHand === null
                ? null
                : {
                    ...engine.lastHand,
                    pots: engine.lastHand.pots.map(({ amount, winners }) => ({
                      amount,
                      winner_seats: winners,
                    })),
                  },
          });
          expect(actual.status).toBe(engine.over ? 'match_over' : 'your_turn');
        }
        expect(t.record).toHaveBeenCalledTimes(1);
        expect(t.record.mock.calls[0][0]).toMatchObject({
          match_id: INPUT.room_id,
          players: [INPUT.name, 'house-bot'],
          hands,
          final_stacks: engine.stacks,
        });
        const botEvents = hands
          .flatMap(hand => hand.events)
          .filter(event => event.seat === 1 && event.type !== 'post_blind');
        expect(botEvents.length).toBeGreaterThan(0);
        expect(botEvents.every(event => event.timeout !== true)).toBe(true);
        expect(await t.status()).toMatchObject({
          status: 'match_over',
          room_status: 'finished',
          ratings: t.recorded.ratings,
        });
        expect(t.storage.alarm).toBeNull();
        runs.push(hands);
      }
      expect(runs[0]).toEqual(runs[1]);
    },
  );

  it('times out only the human, checks when possible, and ends as bots_only after three consecutive timeouts', async () => {
    const t = fixture([0.6], { ...SETTINGS, max_hands: 10 });
    await t.create();
    let thirdDeadline = 0;
    let secondTimeout: Awaited<ReturnType<typeof t.status>> | undefined;
    for (let n = 0; n < 3; n++) {
      const turn = await t.turn();
      expect(t.storage.alarm).toBe(Date.parse(turn.deadline));
      t.clock.ms = Date.parse(turn.deadline);
      thirdDeadline = t.clock.ms;
      await t.referee.alarm();
      if (n < 2) expect((await t.status()).room_status).toBe('playing');
      if (n === 1) secondTimeout = await t.status();
    }
    // The second timeout checked for the human (nothing to call) and the bot never timed out.
    expect(secondTimeout?.status).toBe('your_turn');
    if (secondTimeout?.status !== 'your_turn') throw new Error('Expected turn');
    expect(secondTimeout.view?.history.filter(step => step.timeout)).toEqual([
      expect.objectContaining({ seat: 0, type: 'check', timeout: true }),
    ]);
    // The third timeout marks the human absent; only house-bot is left, so the match ends at once.
    expect(await t.status(true)).toMatchObject({
      status: 'match_over',
      room_status: 'finished',
      result: 'loss',
      place: 2,
      ratings: null,
    });
    expect(t.clock.ms).toBe(thirdDeadline);
    expect(t.record).toHaveBeenCalledTimes(1);
    const input = t.record.mock.calls[0][0];
    expect(input.players).toEqual([INPUT.name, 'house-bot']);
    expect(input.end_reason).toBe('bots_only');
    expect(input.places).toEqual([2, 1]);
    // The unfinished hand is called off and not recorded: only hand 1 (the first timeout, a fold).
    expect(input.hands).toHaveLength(1);
    expect(input.final_stacks.reduce((sum, stack) => sum + stack, 0)).toBe(80);
    const timeouts = input.hands
      .flatMap(hand => hand.events)
      .filter(event => event.timeout);
    expect(timeouts).toEqual([
      expect.objectContaining({ seat: 0, type: 'fold', timeout: true }),
    ]);
    expect(t.storage.alarm).toBeNull();
  });

  it('without opponent keeps waiting for a human join and never draws bot randomness', async () => {
    const t = fixture();
    await t.create(false);
    expect(await t.status()).toMatchObject({
      status: 'waiting',
      room_status: 'waiting',
      view: null,
    });
    expect(
      await t.referee.join({ name: 'Bob', invite_code: INPUT.invite_code }),
    ).toMatchObject({ ok: true, value: { seat: 1 } });
    await t.act({ type: 'call' });
    expect(await t.status()).toMatchObject({
      status: 'waiting',
      room_status: 'playing',
      to_act_seat: 1,
    });
    expect(t.random).not.toHaveBeenCalled();
    expect(t.record).not.toHaveBeenCalled();
  });
});

describe('T34 freezeout against house-bot', () => {
  it('ends on a bust before max_hands, with upgraded blinds in last_hand and the record', async () => {
    const settings = {
      starting_stack: 10,
      blind_every: 1,
      max_hands: 50,
      turn_seconds: 5,
    };
    // The bot checks/calls. Folding every human turn eventually loses to the blinds.
    const t = fixture([0.6], settings);
    await t.create();
    let over = await t.status();
    for (let step = 0; step < 100 && over.status !== 'match_over'; step++) {
      if (over.status !== 'your_turn') throw new Error('Expected human turn');
      await t.act({ type: 'fold' });
      over = await t.status();
    }
    expect(over.status).toBe('match_over');
    if (over.status !== 'match_over') throw new Error('Expected a bust');
    expect(over.final_stacks).toContain(0);
    expect(over.final_stacks[0] + over.final_stacks[1]).toBe(20);
    expect(over.hand_number).toBeLessThan(settings.max_hands);
    expect(over.result).toBe(
      over.final_stacks[0] > over.final_stacks[1] ? 'win' : 'loss',
    );
    expect(over.ratings).toBeNull();
    const recorded = t.record.mock.calls[0]?.[0];
    expect(recorded).toBeDefined();
    const last = recorded?.hands.at(-1);
    expect(last?.blinds[0]).toBeGreaterThan(1);
    expect(over.last_hand).toMatchObject({
      hand_number: last?.hand_number,
      blinds: last?.blinds,
    });
    for (const hand of recorded?.hands ?? []) {
      const small = 2 ** (hand.hand_number - 1);
      expect(hand.blinds).toEqual([small, small * 2]);
    }
  });
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
