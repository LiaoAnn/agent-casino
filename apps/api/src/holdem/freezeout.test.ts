import { describe, expect, it } from 'vitest';
import { seatView } from '../room/view';
import {
  type Action,
  applyTableAction,
  blindsAt,
  replayTable,
  startTable,
  type TableConfig,
  type TableHandRecord,
  type TableSeat,
  type TableState,
  tableLegalActions,
} from './table';

// The heads-up config: a 2-seat table without `players`.
type HeadsUpConfig = Omit<TableConfig, 'players'>;

const config = (overrides: Partial<HeadsUpConfig> = {}): HeadsUpConfig => ({
  seed: '0000000000000000000000000000000000000000000000000000000000000005',
  startingStack: 40,
  blindEvery: 5,
  maxHands: 20,
  ...overrides,
});

function act(state: TableState, seat: TableSeat, action: Action) {
  const result = applyTableAction(state, seat, action);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

function folds(matchConfig: HeadsUpConfig, count: number) {
  let state = startTable({ ...matchConfig, players: 2 });
  const hands: TableHandRecord[] = [];
  for (let n = 0; n < count; n++) {
    const result = act(state, (n % 2) as TableSeat, { type: 'fold' });
    hands.push(...result.finishedHands);
    state = result.state;
  }
  return { state, hands };
}

describe('freezeout blind schedule', () => {
  it.each<[number, number, [number, number]]>([
    [1, 5, [1, 2]],
    [5, 5, [1, 2]],
    [6, 5, [2, 4]],
    [10, 5, [2, 4]],
    [11, 5, [4, 8]],
    [1, 1, [1, 2]],
    [2, 1, [2, 4]],
    [3, 1, [4, 8]],
    [50, 50, [1, 2]],
    [51, 50, [2, 4]],
    [200, 1, [2 ** 199, 2 ** 200]],
  ])('blindsAt(%i, %i) = %j', (hand, every, expected) => {
    expect(blindsAt(hand, every)).toEqual(expected);
  });

  it.each<[number, number, [number, number]]>([
    [5, 1, [1, 2]],
    [5, 5, [1, 2]],
    [5, 6, [2, 4]],
    [1, 1, [1, 2]],
    [1, 2, [2, 4]],
    [1, 3, [4, 8]],
  ])(
    'posts the level for blindEvery %i, hand %i',
    (blindEvery, hand, expected) => {
      const { state, hands } = folds(config({ blindEvery }), hand - 1);
      expect(state.handNumber).toBe(hand);
      const button = ((hand - 1) % 2) as TableSeat;
      expect(state.history).toEqual([
        {
          seat: button,
          street: 'preflop',
          type: 'post_blind',
          amount: expected[0],
        },
        {
          seat: button === 0 ? 1 : 0,
          street: 'preflop',
          type: 'post_blind',
          amount: expected[1],
        },
      ]);
      const result = act(state, button, { type: 'fold' });
      expect(result.finishedHands[0].blinds).toEqual(expected);
      expect(result.state.lastHand?.blinds).toEqual(expected);
      expect(hands).toHaveLength(hand - 1);
    },
  );

  it('caps a higher-level big blind at the short stack and ends on its bust', () => {
    // Seed ...0005: folds leave [7, 13] before hand 4. Seat 0 can post
    // only 7 of the scheduled 16. Seat 1 already posted 8: refund 1,
    // run out the board without another action; seat 1 wins hand 4.
    const { state, hands } = folds(
      config({ startingStack: 10, blindEvery: 1 }),
      3,
    );
    expect(hands.map(hand => hand.stacks)).toEqual([
      [9, 11],
      [11, 9],
      [7, 13],
      [0, 20],
    ]);
    expect(hands[3]).toMatchObject({
      hand_number: 4,
      blinds: [8, 16],
      button_seat: 1,
      winner_seat: 1,
      pot: 14,
      ended_by: 'showdown',
      events: [
        { seat: 1, street: 'preflop', type: 'post_blind', amount: 8 },
        { seat: 0, street: 'preflop', type: 'post_blind', amount: 7 },
      ],
    });
    expect(state.over).toBe(true);
    expect(state.handNumber).toBe(4);
    expect(state.handNumber).toBeLessThan(state.config.maxHands);
    expect(state.stacks).toEqual([0, 20]);
    expect(tableLegalActions(state)).toEqual([]);
  });

  it('uses the current big blind for the initial raise and resets it on every street', () => {
    let { state } = folds(config({ blindEvery: 1 }), 1);
    expect(state.handNumber).toBe(2);
    expect(tableLegalActions(state)).toContainEqual({
      type: 'raise',
      min: 8,
      max: 41,
    });
    const rejected = applyTableAction(state, 1, { type: 'raise', amount: 6 });
    expect(rejected.ok).toBe(false);
    state = act(state, 1, { type: 'call' }).state;
    expect(tableLegalActions(state)).toContainEqual({
      type: 'raise',
      min: 8,
      max: 39,
    });
    state = act(state, 0, { type: 'check' }).state;
    for (const street of ['flop', 'turn', 'river']) {
      expect(state.street).toBe(street);
      expect(tableLegalActions(state)).toContainEqual({
        type: 'raise',
        min: 4,
        max: 35,
      });
      expect(applyTableAction(state, 0, { type: 'raise', amount: 2 }).ok).toBe(
        false,
      );
      // A raise of one big blind, followed by a fold, is accepted on each street.
      const raised = act(state, 0, { type: 'raise', amount: 4 });
      expect(tableLegalActions(raised.state)).toContainEqual({
        type: 'raise',
        min: 8,
        max: 37,
      });
      expect(
        act(raised.state, 1, { type: 'fold' }).finishedHands[0].blinds,
      ).toEqual([2, 4]);
      state = act(state, 0, { type: 'check' }).state;
      state = act(state, 1, { type: 'check' }).state;
    }
    expect(state.lastHand?.blinds).toEqual([2, 4]);
  });

  it.each<[number, [number, number]]>([
    [1, [39, 41]],
    [2, [40, 40]],
  ])(
    'stops at maxHands %i with final stacks %j, including an exact draw',
    (maxHands, stacks) => {
      const { state, hands } = folds(config({ maxHands }), maxHands);
      expect(state.over).toBe(true);
      expect(state.toAct).toBeNull();
      expect(state.handNumber).toBe(maxHands);
      expect(state.stacks).toEqual(stacks);
      expect(hands).toHaveLength(maxHands);
      expect(state.lastHand?.stacks).toEqual(stacks);
      expect(tableLegalActions(state)).toEqual([]);
    },
  );
});

describe('freezeout seat view', () => {
  it.each<[number, [number, number], number]>([
    [1, [1, 2], 6],
    [5, [1, 2], 6],
    [6, [2, 4], 11],
  ])(
    'hand %i exposes blinds %j and next level %i to both seats',
    (hand, blinds, next) => {
      const { state } = folds(config(), hand - 1);
      for (const seat of [0, 1] as const) {
        expect(seatView(state, seat)).toMatchObject({
          blinds,
          next_blinds_at_hand: next,
        });
      }
    },
  );

  it('reports every hand as a new level with blindEvery 1', () => {
    const { state } = folds(config({ blindEvery: 1 }), 1);
    expect(seatView(state, 0)).toMatchObject({
      blinds: [2, 4],
      next_blinds_at_hand: 3,
    });
  });

  it('includes a next level exactly at maxHands, and null beyond it while still playing', () => {
    expect(
      seatView(startTable({ ...config({ maxHands: 6 }), players: 2 }), 0)
        ?.next_blinds_at_hand,
    ).toBe(6);
    const { state } = folds(config({ maxHands: 10 }), 5);
    expect(state.over).toBe(false);
    expect(seatView(state, 0)).toMatchObject({
      blinds: [2, 4],
      next_blinds_at_hand: null,
    });
  });

  it('keeps the last level and clears next level after a bust or safety cap', () => {
    const bust = folds(config({ startingStack: 10, blindEvery: 1 }), 3).state;
    const capped = folds(config({ maxHands: 6 }), 6).state;
    for (const [state, blinds] of [
      [bust, [8, 16]],
      [capped, [2, 4]],
    ] as const) {
      expect(state.over).toBe(true);
      for (const seat of [0, 1] as const) {
        expect(seatView(state, seat)).toMatchObject({
          blinds,
          next_blinds_at_hand: null,
        });
      }
    }
  });
});

describe('freezeout replay', () => {
  it.each([
    [config({ maxHands: 6 }), 6],
    [config({ startingStack: 10, blindEvery: 1 }), 3],
  ] as const)(
    'seed plus actions reproduces upgraded and automatic hands: %j',
    (matchConfig, count) => {
      const { state, hands } = folds(matchConfig, count);
      const events = hands.flatMap(hand => hand.events);
      const actions = events.filter(event => event.type !== 'post_blind');
      for (const input of [events, actions]) {
        const result = replayTable({ ...matchConfig, players: 2 }, input);
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        expect(result.hands).toEqual(hands);
        expect(result.state).toEqual(state);
      }
    },
  );
});
