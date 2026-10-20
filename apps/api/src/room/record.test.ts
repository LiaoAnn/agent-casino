// T13 S1: casino-api A9/A10/A15 and holdem-rules replay requirements.
// Exercise only the referee's public API and persisted HandRecords.
import { describe, expect, it, vi } from 'vitest';
import {
  type Action,
  applyTableAction,
  startTable,
  type TableHandRecord,
  type TableState,
  tableLegalActions,
} from '../holdem/table';
import type { RecordedMatch, TableRecordInput } from './referee';
import { RoomReferee, type RoomStorage } from './referee';

type Seat = 0 | 1;

const ROOM_ID = 'r_record0001';
const SEED = '0'.repeat(64);
const PLAYERS: [string, string] = ['ALice', 'bOB'];
const SETTINGS = {
  max_hands: 2,
  turn_seconds: 10,
  blind_every: 50,
  starting_stack: 40,
};
const RECORDED: RecordedMatch = {
  rated: true,
  ratings: [
    { name: 'Alice', rating: 1516, change: 16 },
    { name: 'Bob', rating: 1484, change: -16 },
  ],
};
type Recorder = (input: TableRecordInput) => Promise<RecordedMatch>;

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

function fixture(record: Recorder = async () => RECORDED, settings = SETTINGS) {
  const storage = new MemoryStorage();
  const clock = { ms: Date.parse('2026-10-18T00:00:00.000Z') };
  const spy = vi.fn(record);
  // A variable allows the new optional callback before RefereeOptions gains it.
  const options = { now: () => clock.ms, waitMs: 1, record: spy };
  const referee = new RoomReferee(storage, options);
  let engine = startTable({
    players: 2,
    seed: SEED,
    maxHands: settings.max_hands,
    blindEvery: 50,
    startingStack: settings.starting_stack,
  });
  const hands: TableHandRecord[] = [];

  const open = async (join = true) => {
    expect(
      await referee.create({
        room_id: ROOM_ID,
        invite_code: 'ABC234',
        name: PLAYERS[0],
        settings,
        seed: SEED,
        test: null,
        visibility: null,
      }),
    ).toEqual({
      ok: true,
      value: createdSeat({
        room_id: ROOM_ID,
        invite_code: 'ABC234',
        name: PLAYERS[0],
        settings,
      }),
    });
    if (join) {
      expect(
        await referee.join({ name: PLAYERS[1], invite_code: 'ABC234' }),
      ).toMatchObject({ ok: true });
    }
  };

  const turn = async () => {
    if (engine.toAct === null) throw new Error('Expected an active engine');
    const result = await referee.status(PLAYERS[engine.toAct], { wait: false });
    if (!result.ok || result.value.status !== 'your_turn') {
      throw new Error(`Expected your_turn: ${JSON.stringify(result)}`);
    }
    return { seat: engine.toAct, ...result.value };
  };

  const step = async (action: Action) => {
    const current = await turn();
    const applied = applyTableAction(engine, current.seat, action);
    if (!applied.ok) throw new Error(applied.message);
    engine = applied.state;
    hands.push(...applied.finishedHands);
    return referee.act(PLAYERS[current.seat], {
      turn_id: current.turn_id,
      ...action,
    });
  };

  const finish = async (
    pick: (state: TableState) => Action = () => ({ type: 'fold' }),
  ) => {
    for (let i = 0; !engine.over && i < 2_000; i++) {
      expect(await step(pick(engine))).toMatchObject({
        ok: true,
        value: { status: 'accepted' },
      });
    }
    expect(engine.over).toBe(true);
    return engine;
  };

  return { referee, storage, clock, spy, open, turn, step, finish, hands };
}

type Fixture = ReturnType<typeof fixture>;

async function over(t: Fixture, seat: Seat = 0, wait = false) {
  const response = await t.referee.status([PLAYERS[0], PLAYERS[1]][seat], {
    wait,
  });
  if (!response.ok || response.value.status !== 'match_over') {
    throw new Error(`Expected match_over: ${JSON.stringify(response)}`);
  }
  return response.value;
}

async function expectRecord(
  t: Fixture,
  result: TableRecordInput['result'],
  settings = SETTINGS,
  hands = t.hands,
  endReason = 'max_hands',
) {
  expect(t.spy).toHaveBeenCalledTimes(1);
  const response = await over(t);
  expect(t.spy.mock.calls[0][0]).toEqual({
    match_id: ROOM_ID,
    players: PLAYERS,
    display_names: PLAYERS,
    settings,
    seed: SEED,
    result,
    end_reason: endReason,
    places:
      endReason === 'void' || endReason === 'cancelled'
        ? null
        : result === 'seat0_win'
          ? [1, 2]
          : result === 'seat1_win'
            ? [2, 1]
            : [1, 1],
    ended_at: new Date(t.clock.ms).toISOString(),
    final_stacks: response.final_stacks,
    hands,
  });
  for (const hand of hands) {
    expect(await t.storage.get(`hand:${hand.hand_number}`)).toEqual(hand);
  }
}

describe('T13 S1: replay, record, then match_over', () => {
  it.each([
    { max_hands: 1, result: 'seat1_win' as const, firstCall: false },
    { max_hands: 1, result: 'seat0_win' as const, firstCall: true },
    { max_hands: 2, result: 'draw' as const, firstCall: false },
  ])(
    'records $result after all $max_hands hands, preserving metadata and ordered engine hands',
    async scenario => {
      const settings = { ...SETTINGS, max_hands: scenario.max_hands };
      const t = fixture(undefined, settings);
      await t.open();
      if (scenario.firstCall) {
        await t.step({ type: 'call' });
        // Big blind folds despite having the option to check.
      }
      t.clock.ms += 1_234;
      const final = await t.finish();
      const [a, b] = final.stacks;
      expect(a > b ? 'seat0_win' : a < b ? 'seat1_win' : 'draw').toBe(
        scenario.result,
      );
      await expectRecord(t, scenario.result, settings);
      expect((await over(t)).final_stacks).toEqual(final.stacks);
      expect((await over(t)).room_status).toBe('finished');
    },
  );

  it('records an early bust from all-in showdowns before the configured hand limit', async () => {
    const settings = {
      ...SETTINGS,
      max_hands: 100,
      blind_every: 50,
      starting_stack: 10,
    };
    const t = fixture(undefined, settings);
    await t.open();
    const final = await t.finish(state => {
      const actions = tableLegalActions(state);
      const raise = actions.find(action => action.type === 'raise');
      if (raise?.type === 'raise') return { type: 'raise', amount: raise.max };
      return actions.some(action => action.type === 'call')
        ? { type: 'call' }
        : { type: 'check' };
    });
    expect(final.stacks).toContain(0);
    expect(t.hands.length).toBeLessThan(settings.max_hands);
    await expectRecord(
      t,
      final.stacks[0] === 0 ? 'seat1_win' : 'seat0_win',
      settings,
      t.hands,
      'bust',
    );
  });

  it.each([0, 1] as const)(
    'records the opponent as winner when seat %i leaves during play',
    async seat => {
      const t = fixture();
      await t.open();
      await t.step({ type: 'fold' });
      await t.step({ type: 'raise', amount: 6 });
      t.clock.ms += 2_000;
      const response = await t.referee.leave([PLAYERS[0], PLAYERS[1]][seat]);
      expect(response).toMatchObject({
        ok: true,
        value: {
          result: 'loss',
          final_stacks: [39, 41],
          ratings: RECORDED.ratings,
        },
      });
      await expectRecord(
        t,
        seat === 0 ? 'seat1_win' : 'seat0_win',
        SETTINGS,
        t.hands,
        'leave',
      );
    },
  );

  it('records an admin abort as void with completed hands and refunded unfinished bets', async () => {
    const t = fixture(async () => ({ rated: false, ratings: null }));
    await t.open();
    await t.step({ type: 'fold' });
    await t.step({ type: 'raise', amount: 6 });
    t.clock.ms += 2_000;
    expect(await t.referee.abort()).toEqual({ ok: true, value: null });
    await expectRecord(t, 'void', SETTINGS, t.hands, 'void');
    expect(await over(t)).toMatchObject({
      result: 'void',
      room_status: 'void',
      final_stacks: [39, 41],
      ratings: null,
    });
  });

  it.each(['act', 'leave', 'abort'] as const)(
    '%s waits for record to complete before responding, then all ended responses carry its ratings',
    async ending => {
      let release: (value: RecordedMatch) => void = () => {};
      const blocked = new Promise<RecordedMatch>(resolve => {
        release = resolve;
      });
      let entered: () => void = () => {};
      const called = new Promise<'called'>(resolve => {
        entered = () => resolve('called');
      });
      const recorded =
        ending === 'abort' ? { rated: false, ratings: null } : RECORDED;
      const t = fixture(
        async () => {
          entered();
          return blocked;
        },
        { ...SETTINGS, max_hands: 1 },
      );
      await t.open();
      const current = await t.turn();
      let settled = false;
      const pending = (
        ending === 'act'
          ? t.referee.act(PLAYERS[current.seat], {
              turn_id: current.turn_id,
              type: 'fold',
            })
          : ending === 'leave'
            ? t.referee.leave(PLAYERS[0])
            : t.referee.abort()
      ).finally(() => {
        settled = true;
      });
      try {
        expect(
          await Promise.race([called, pending.then(() => 'responded')]),
        ).toBe('called');
        // Let an incorrectly un-awaited write return to its caller, if it can.
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).toBe(false);
      } finally {
        release(recorded);
        await pending;
      }
      expect(t.spy).toHaveBeenCalledTimes(1);
      if (ending === 'leave') {
        expect(await pending).toMatchObject({
          ok: true,
          value: { ratings: recorded.ratings },
        });
      }
      for (const seat of [0, 1] as const) {
        for (const wait of [false, true]) {
          expect((await over(t, seat, wait)).ratings).toEqual(recorded.ratings);
        }
        // A repeated leave is an ended-room error with the same match_over state.
        expect(
          await t.referee.leave([PLAYERS[0], PLAYERS[1]][seat]),
        ).toMatchObject({
          ok: false,
          error: { code: 'match_over', state: { ratings: recorded.ratings } },
        });
      }
      await t.referee.alarm();
      expect(t.spy).toHaveBeenCalledTimes(1);
    },
  );

  it('voids a match when a previously completed stored hand disagrees with replay', async () => {
    const t = fixture(async () => ({ rated: false, ratings: null }));
    await t.open();
    await t.step({ type: 'fold' });
    const hand = await t.storage.get<TableHandRecord>('hand:1');
    if (hand === undefined) throw new Error('Expected completed hand:1');
    hand.stacks = [1, 79];
    await t.storage.put('hand:1', hand);
    await t.finish();
    expect(t.spy).toHaveBeenCalledTimes(1);
    expect(t.spy.mock.calls[0][0].result).toBe('void');
    expect(t.spy.mock.calls[0][0]).toHaveProperty('end_reason', 'void');
    for (const seat of [0, 1] as const) {
      expect(await over(t, seat)).toMatchObject({
        result: 'void',
        room_status: 'void',
        ratings: null,
      });
    }
  });

  it('replays timeout substitutions without voiding an otherwise valid match', async () => {
    const t = fixture();
    await t.open();
    for (let n = 0; n < SETTINGS.max_hands; n++) {
      const deadline = t.storage.alarm;
      if (deadline === null) throw new Error('Expected turn alarm');
      t.clock.ms = deadline;
      await t.referee.alarm();
    }
    expect(t.spy).toHaveBeenCalledTimes(1);
    const input = t.spy.mock.calls[0][0];
    expect(input.result).toBe('draw');
    expect(input).toHaveProperty('end_reason', 'max_hands');
    expect(input.hands).toHaveLength(2);
    for (const hand of input.hands) {
      expect(hand.events.some(event => event.timeout === true)).toBe(true);
      expect(await t.storage.get(`hand:${hand.hand_number}`)).toEqual(hand);
    }
    expect(await over(t)).toMatchObject({
      result: 'draw',
      room_status: 'finished',
      ratings: RECORDED.ratings,
    });
  });

  it.each(['leave', 'two-minute absence alarm'] as const)(
    'does not record a never-started room dissolved by %s',
    async ending => {
      const t = fixture();
      await t.open(false);
      if (ending === 'leave') await t.referee.leave(PLAYERS[0]);
      else {
        t.clock.ms += 2 * 60 * 1_000;
        await t.referee.alarm();
      }
      expect(await over(t)).toMatchObject({
        result: 'cancelled',
        ratings: null,
      });
      await over(t, 0, true);
      await t.referee.alarm();
      expect(t.spy).not.toHaveBeenCalled();
    },
  );

  it('returns the original accepted result for a duplicate final action while recording keeps failing', async () => {
    let failing = true;
    const t = fixture(
      async () => {
        if (failing) throw new Error('D1 temporarily unavailable');
        return RECORDED;
      },
      { ...SETTINGS, max_hands: 1 },
    );
    await t.open();
    const current = await t.turn();
    const action = { turn_id: current.turn_id, type: 'fold' as const };
    const accepted = await t.referee.act(PLAYERS[current.seat], action);
    expect(accepted).toMatchObject({
      ok: true,
      value: { status: 'accepted' },
    });
    if (!accepted.ok) throw new Error('Expected accepted final action');
    expect(t.spy).toHaveBeenCalledTimes(1);
    for (let retry = 0; retry < 2; retry++) {
      expect(await t.referee.act(PLAYERS[current.seat], action)).toEqual({
        ok: true,
        value: { ...accepted.value, duplicate: true },
      });
    }

    failing = false;
    for (const seat of [0, 1] as const) {
      expect(await over(t, seat)).toMatchObject({
        room_status: 'finished',
        ratings: RECORDED.ratings,
      });
    }
  });

  it('schedules future alarms after failed recording, retries when due, and clears the alarm after success', async () => {
    let failing = true;
    const t = fixture(
      async () => {
        if (failing) throw new Error('D1 temporarily unavailable');
        return RECORDED;
      },
      { ...SETTINGS, max_hands: 1 },
    );
    await t.open();
    expect(await t.step({ type: 'fold' })).toMatchObject({
      ok: true,
      value: { status: 'accepted' },
    });
    expect(t.spy).toHaveBeenCalledTimes(1);
    const original = structuredClone(t.spy.mock.calls[0][0]);
    const firstAlarm = t.storage.alarm;
    if (firstAlarm === null) throw new Error('Expected recording retry alarm');
    expect(firstAlarm).toBeGreaterThan(t.clock.ms);

    t.clock.ms = firstAlarm;
    await t.referee.alarm();
    expect(t.spy).toHaveBeenCalledTimes(2);
    const secondAlarm = t.storage.alarm;
    if (secondAlarm === null) throw new Error('Expected another retry alarm');
    expect(secondAlarm).toBeGreaterThan(t.clock.ms);

    failing = false;
    t.clock.ms = secondAlarm;
    await t.referee.alarm();
    expect(t.spy).toHaveBeenCalledTimes(3);
    expect(t.storage.alarm).toBeNull();
    for (const [input] of t.spy.mock.calls) expect(input).toEqual(original);
    expect(await over(t)).toMatchObject({ ratings: RECORDED.ratings });
    expect(t.spy).toHaveBeenCalledTimes(3);
    expect(t.storage.alarm).toBeNull();
  });

  it.each(['state', 'wait', 'alarm'] as const)(
    'keeps the final action accepted and retries failed recording on every %s until success',
    async trigger => {
      let failing = true;
      const t = fixture(
        async () => {
          if (failing) throw new Error('D1 temporarily unavailable');
          return RECORDED;
        },
        { ...SETTINGS, max_hands: 1 },
      );
      await t.open();
      expect(await t.step({ type: 'fold' })).toMatchObject({
        ok: true,
        value: { status: 'accepted' },
      });
      expect(t.spy).toHaveBeenCalledTimes(1);
      const original = structuredClone(t.spy.mock.calls[0][0]);
      for (const wait of [false, true]) {
        expect(await t.referee.status(PLAYERS[0], { wait })).toMatchObject({
          ok: false,
          error: { code: 'unavailable', retryable: true },
        });
      }
      expect(t.spy).toHaveBeenCalledTimes(3);
      const retry = () =>
        trigger === 'alarm'
          ? t.referee.alarm()
          : t.referee.status(PLAYERS[0], { wait: trigger === 'wait' });
      await retry();
      expect(t.spy).toHaveBeenCalledTimes(4);
      failing = false;
      t.clock.ms += 1_000;
      await retry();
      expect(t.spy).toHaveBeenCalledTimes(5);
      for (const [input] of t.spy.mock.calls) expect(input).toEqual(original);
      for (const seat of [0, 1] as const) {
        for (const wait of [false, true]) {
          expect((await over(t, seat, wait)).ratings).toEqual(RECORDED.ratings);
        }
      }
      await t.referee.alarm();
      expect(t.spy).toHaveBeenCalledTimes(5);
    },
  );
});

describe('T23: notes go to record (A16)', () => {
  type Noted = { hand_number: number; seq: number; note: string };

  // Plays by hand: hand 1 checks and calls to the flop, then folds; hand 2
  // folds at once. Every action carries a note naming its place; returns them.
  const playWithNotes = async (t: Fixture, seats: readonly Seat[] = [0, 1]) => {
    const expected: Noted[] = [];
    for (let i = 0; i < 50; i++) {
      let moved = false;
      for (const seat of seats) {
        const response = await t.referee.status(
          [PLAYERS[0], PLAYERS[1]][seat],
          { wait: false },
        );
        if (!response.ok) throw new Error(JSON.stringify(response));
        const status = response.value;
        if (status.status === 'match_over') return expected;
        if (status.status !== 'your_turn' || status.view === null) continue;
        const hand_number = status.hand_number as number;
        const seq = status.view.history.length;
        const note = `note h${hand_number} q${seq}`;
        const fold = status.view.street === 'flop' || hand_number === 2;
        const type = fold
          ? 'fold'
          : status.legal_actions.some(action => action.type === 'check')
            ? 'check'
            : 'call';
        const accepted = await t.referee.act([PLAYERS[0], PLAYERS[1]][seat], {
          turn_id: status.turn_id,
          type,
          note,
        });
        expect(accepted).toMatchObject({ ok: true });
        expected.push({ hand_number, seq, note });
        moved = true;
      }
      if (!moved) break;
    }
    return expected;
  };

  it('hands the notes of both seats over, by hand and position in the hand (blinds count)', async () => {
    const t = fixture(undefined, { ...SETTINGS, max_hands: 2 });
    await t.open();
    const expected = await playWithNotes(t);
    // preflop call + check, a flop fold, then hand 2's opening fold.
    expect(expected.length).toBeGreaterThanOrEqual(4);
    expect(t.spy).toHaveBeenCalledTimes(1);
    const { notes } = t.spy.mock.calls[0][0];
    const sort = (list: Noted[]) =>
      [...list].sort((a, b) => a.hand_number - b.hand_number || a.seq - b.seq);
    expect(sort(notes ?? [])).toEqual(sort(expected));
    // The first action of hand 1 is the third step, after the two blinds.
    expect(notes).toContainEqual({
      hand_number: 1,
      seq: 2,
      note: 'note h1 q2',
    });
  });

  it('leaves out the note of a refused action and of a step sent without one', async () => {
    const t = fixture(undefined, { ...SETTINGS, max_hands: 1 });
    await t.open();
    const current = await t.turn();
    expect(
      await t.referee.act(PLAYERS[current.seat], {
        turn_id: current.turn_id,
        type: 'raise',
        amount: 3,
        note: 'refused note',
      }),
    ).toMatchObject({ ok: false });
    await t.step({ type: 'call' });
    await t.step({ type: 'fold' });
    expect(t.spy).toHaveBeenCalledTimes(1);
    const { notes } = t.spy.mock.calls[0][0];
    expect(notes ?? []).toEqual([]);
  });
});

// T28 A6/A15: results survive the immediate transition to the next hand.
describe('T28 S2 last_hand.stack_changes', () => {
  it.each([
    { ending: 'fold', max_hands: 1 },
    { ending: 'fold', max_hands: 3 },
    { ending: 'showdown', max_hands: 1 },
    { ending: 'showdown', max_hands: 3 },
  ] as const)(
    '$ending across $max_hands hands in wait and state',
    async ({ ending, max_hands: hands }) => {
      const t = fixture(undefined, { ...SETTINGS, max_hands: hands });
      await t.open();
      let before: readonly number[] = [40, 40];
      for (let handNumber = 1; handNumber <= hands; handNumber++) {
        // Keep checking/calling to reach showdown without risking an early bust.
        for (let step = 0; t.hands.length < handNumber && step < 20; step++) {
          const turn = await t.turn();
          const type =
            ending === 'fold'
              ? 'fold'
              : turn.legal_actions.some(action => action.type === 'call')
                ? 'call'
                : 'check';
          expect(await t.step({ type })).toMatchObject({
            ok: true,
            value: { status: 'accepted' },
          });
        }
        const hand = t.hands[handNumber - 1];
        if (!hand) throw new Error('Expected a completed hand');
        expect(hand.ended_by).toBe(ending);
        if (handNumber === 2) expect(before).not.toEqual([40, 40]);
        const changes: [number, number] = [
          hand.stacks[0] - before[0],
          hand.stacks[1] - before[1],
        ];
        expect(changes[0] + changes[1]).toBe(0);
        const seat = handNumber === hands ? 0 : (await t.turn()).seat;
        for (const wait of [false, true]) {
          const result = await t.referee.status(
            [PLAYERS[0], PLAYERS[1]][seat],
            { wait },
          );
          expect(result).toMatchObject({
            ok: true,
            value: {
              status: handNumber === hands ? 'match_over' : 'your_turn',
              last_hand: {
                hand_number: handNumber,
                ended_by: ending,
                stacks: hand.stacks,
                hole_cards: ending === 'showdown' ? hand.hole_cards : null,
              },
            },
          });
          // Soft assertions let later hands prove their own per-hand baseline.
          expect.soft(result).toMatchObject({
            ok: true,
            value: {
              last_hand: { stack_changes: changes },
            },
          });
        }
        before = hand.stacks;
      }
    },
  );
});

describe('T28 S3 seconds_remaining', () => {
  it.each([false, true])(
    'uses the injected clock for wait=%s and floors partial seconds',
    async wait => {
      const t = fixture(undefined, { ...SETTINGS, turn_seconds: 30 });
      await t.open();
      const first = await t.turn();
      const deadline = Date.parse(first.deadline);
      for (const elapsed of [0, 600, 1_001, 29_999]) {
        t.clock.ms = deadline - 30_000 + elapsed;
        const seconds = Math.max(0, Math.floor((deadline - t.clock.ms) / 1000));
        const result = await t.referee.status(PLAYERS[first.seat], { wait });
        expect.soft(result).toMatchObject({
          ok: true,
          value: {
            status: 'your_turn',
            turn_id: first.turn_id,
            deadline: first.deadline,
            seconds_remaining: seconds,
          },
        });
      }
    },
  );

  it('includes the same countdown in an invalid_action your_turn state', async () => {
    const t = fixture(undefined, { ...SETTINGS, turn_seconds: 30 });
    await t.open();
    const first = await t.turn();
    t.clock.ms += 600;
    const result = await t.referee.act(PLAYERS[first.seat], {
      turn_id: first.turn_id,
      type: 'check',
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_action' },
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        state: {
          status: 'your_turn',
          deadline: first.deadline,
          seconds_remaining: 59,
        },
      },
    });
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
