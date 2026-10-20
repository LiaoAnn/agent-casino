import { describe, expect, it } from 'vitest';
import type { RoomStatus } from '../contract/schemas';
import { dealHand } from '../holdem/shuffle';
import {
  type Action,
  applyTableAction,
  leaveTable,
  startTable,
  type TableConfig,
  type TableEvent,
  type TableState,
} from '../holdem/table';
import { seatView } from './view';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
type View = NonNullable<(typeof RoomStatus.Type)['view']>;
type Step = [number, Action];
const FOLD: Action = { type: 'fold' };
const CHECK: Action = { type: 'check' };
const CALL: Action = { type: 'call' };
const raise = (amount: number): Action => ({ type: 'raise', amount });
const config = (overrides: Partial<TableConfig> = {}): TableConfig => ({
  players: 2,
  seed: '5'.padStart(64, '0'),
  maxHands: 10,
  blindEvery: 50,
  startingStack: 40,
  ...overrides,
});
const blind = (
  seat: 0 | 1,
  amount: number,
): Mutable<View['history'][number]> => ({
  seat,
  street: 'preflop',
  type: 'post_blind',
  amount,
});
const checkPostflop = (first: number): Step[] => {
  const second = first === 0 ? 1 : 0;
  return [
    [first, CHECK],
    [second, CHECK],
    [first, CHECK],
    [second, CHECK],
    [first, CHECK],
    [second, CHECK],
  ];
};
const CHECK_DOWN_HAND_1: Step[] = [[0, CALL], [1, CHECK], ...checkPostflop(1)];
const HAND_1_HISTORY: TableEvent[] = [
  blind(0, 1),
  blind(1, 2),
  { seat: 0, street: 'preflop', type: 'call', amount: 1 },
  { seat: 1, street: 'preflop', type: 'check' },
  ...(['flop', 'turn', 'river'] as const).flatMap(street => [
    { seat: 1, street, type: 'check' as const },
    { seat: 0, street, type: 'check' as const },
  ]),
];
function play(table: TableState, steps: Step[]): TableState {
  for (const [seat, action] of steps) {
    const result = applyTableAction(table, seat, action);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    table = result.state;
  }
  return table;
}
const playFrom = (overrides: Partial<TableConfig>, steps: Step[]) =>
  play(startTable(config(overrides)), steps);
// Contract types are readonly; mutation is deliberate in the isolation test.
function seen(table: TableState, seat: number): Mutable<View> {
  const view: View | null = seatView(table, seat);
  if (view === null) throw new Error('Expected dealt seat');
  return view as Mutable<View>;
}
const cardsIn = (value: unknown): string[] =>
  [...JSON.stringify(value).matchAll(/"([2-9TJQKA][shdc])"/g)].map(m => m[1]);
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
const VIEW_KEYS = [
  'blinds',
  'board',
  'button_seat',
  'history',
  'my_bet_this_street',
  'my_cards',
  'my_seat',
  'my_stack',
  'next_blinds_at_hand',
  'opponent_bet_this_street',
  'opponent_stack',
  'pot',
  'pots',
  'street',
];
// Independent reference deal ...0005: 9c/Ks, Jh/9d; Jc Qh 3d 7c 3c.
const initial = (seat: 0 | 1): Mutable<View> => ({
  blinds: [1, 2],
  next_blinds_at_hand: null,
  street: 'preflop',
  my_seat: seat,
  button_seat: 0,
  my_cards: seat === 0 ? ['9c', 'Ks'] : ['Jh', '9d'],
  board: [],
  pot: 3,
  pots: [3],
  my_stack: seat === 0 ? 39 : 38,
  opponent_stack: seat === 0 ? 38 : 39,
  my_bet_this_street: seat === 0 ? 1 : 2,
  opponent_bet_this_street: seat === 0 ? 2 : 1,
  history: [blind(0, 1), blind(1, 2)],
});

describe('seatView (heads-up cases)', () => {
  it('start of hand 1 from seat 0 (button, small blind)', () => {
    expect(seatView(startTable(config()), 0)).toEqual(initial(0));
  });
  it('start of hand 1 from seat 1 (big blind)', () => {
    expect(seatView(startTable(config()), 1)).toEqual(initial(1));
  });
  it('mid-flop facing a bet: pot includes this street, both seats see the same public facts', () => {
    const table = playFrom({}, [
      [0, CALL],
      [1, CHECK],
      [1, raise(4)],
    ]);
    const history: TableEvent[] = [
      blind(0, 1),
      blind(1, 2),
      { seat: 0, street: 'preflop', type: 'call', amount: 1 },
      { seat: 1, street: 'preflop', type: 'check' },
      { seat: 1, street: 'flop', type: 'raise', amount: 4 },
    ];
    expect(seatView(table, 0)).toEqual({
      ...initial(0),
      street: 'flop',
      board: ['Jc', 'Qh', '3d'],
      pot: 8,
      pots: [8],
      my_stack: 38,
      opponent_stack: 34,
      my_bet_this_street: 0,
      opponent_bet_this_street: 4,
      history,
    });
    expect(seatView(table, 1)).toEqual({
      ...initial(1),
      street: 'flop',
      board: ['Jc', 'Qh', '3d'],
      pot: 8,
      pots: [8],
      my_stack: 34,
      opponent_stack: 38,
      my_bet_this_street: 4,
      opponent_bet_this_street: 0,
      history,
    });
  });
  it('hand 2 after a preflop fold: seat 1 has the button, history is this hand only', () => {
    const table = playFrom({}, [[0, FOLD]]);
    expect(seatView(table, 1)).toEqual({
      ...initial(1),
      button_seat: 1,
      my_cards: ['Qs', 'Ac'],
      my_stack: 40,
      opponent_stack: 37,
      my_bet_this_street: 1,
      opponent_bet_this_street: 2,
      history: [blind(1, 1), blind(0, 2)],
    });
    expect(seatView(table, 0)).toEqual({
      ...initial(0),
      button_seat: 1,
      my_cards: ['Qc', 'Th'],
      my_stack: 37,
      opponent_stack: 40,
      my_bet_this_street: 2,
      opponent_bet_this_street: 1,
      history: [blind(1, 1), blind(0, 2)],
    });
  });
  it('after a flop fold: the new pot and stacks exclude the returned bet; old opponent cards stay hidden', () => {
    const table = playFrom({}, [
      [0, CALL],
      [1, CHECK],
      [1, raise(6)],
      [0, FOLD],
    ]);
    expect(table.lastHand).toEqual({
      blinds: [1, 2],
      hand_number: 1,
      winner_seat: 1,
      pot: 4,
      pots: [{ amount: 4, winners: [1] }],
      ended_by: 'fold',
      board: ['Jc', 'Qh', '3d'],
      hole_cards: null,
      stacks: [38, 42],
    });
    for (const seat of [0, 1])
      expect(seen(table, seat)).toMatchObject({ pot: 3, pots: [3], board: [] });
    expect(cardsIn(seen(table, 0))).not.toContain('Jh');
    expect(cardsIn(seen(table, 0))).not.toContain('9d');
    expect(cardsIn(seen(table, 1))).not.toContain('9c');
    expect(cardsIn(seen(table, 1))).not.toContain('Ks');
    expect(seen(table, 0)).toMatchObject({ my_stack: 36, opponent_stack: 41 });
  });
  it('after a showdown: my_cards is the new deal', () => {
    const table = playFrom({}, CHECK_DOWN_HAND_1);
    expect(table.lastHand).toEqual({
      blinds: [1, 2],
      hand_number: 1,
      winner_seat: 1,
      pot: 4,
      pots: [{ amount: 4, winners: [1] }],
      ended_by: 'showdown',
      board: ['Jc', 'Qh', '3d', '7c', '3c'],
      hole_cards: [
        ['9c', 'Ks'],
        ['Jh', '9d'],
      ],
      stacks: [38, 42],
    });
    const seat0 = seen(table, 0),
      seat1 = seen(table, 1);
    expect(seat0).toEqual({
      ...initial(0),
      button_seat: 1,
      my_cards: ['Qc', 'Th'],
      my_stack: 36,
      opponent_stack: 41,
      my_bet_this_street: 2,
      opponent_bet_this_street: 1,
      history: [blind(1, 1), blind(0, 2)],
    });
    expect(seat1.my_cards).toEqual(['Qs', 'Ac']);
    expect(cardsIn(seat0)).not.toContain('Qs');
    expect(cardsIn(seat1)).not.toContain('Qc');
  });
  it('match over after a showdown: pot 0, final stacks, final board and history', () => {
    const table = playFrom({ maxHands: 1 }, CHECK_DOWN_HAND_1);
    expect(table.toAct).toBeNull();
    expect(seatView(table, 0)).toEqual({
      ...initial(0),
      street: 'river',
      board: ['Jc', 'Qh', '3d', '7c', '3c'],
      pot: 0,
      pots: [0],
      my_stack: 38,
      opponent_stack: 42,
      my_bet_this_street: 0,
      opponent_bet_this_street: 0,
      history: HAND_1_HISTORY,
    });
    expect(seatView(table, 1)).toMatchObject({
      my_seat: 1,
      my_cards: ['Jh', '9d'],
      pot: 0,
      pots: [0],
      my_stack: 42,
    });
  });
  it('match over after a fold: the final opponent cards stay hidden', () => {
    const table = playFrom({ maxHands: 2 }, [
      [0, FOLD],
      [1, FOLD],
    ]);
    expect(table.toAct).toBeNull();
    const seat0 = seen(table, 0);
    expect(seat0).toEqual({
      ...initial(0),
      button_seat: 1,
      my_cards: ['Qc', 'Th'],
      pot: 0,
      pots: [0],
      my_stack: 40,
      opponent_stack: 40,
      my_bet_this_street: 0,
      opponent_bet_this_street: 0,
      history: [
        blind(1, 1),
        blind(0, 2),
        { seat: 1, street: 'preflop', type: 'fold' },
      ],
    });
    expect(cardsIn(seat0)).toEqual(['Qc', 'Th']);
    expect(cardsIn(seen(table, 1))).toEqual(['Qs', 'Ac']);
  });
  it('passes the timeout flag through history unchanged', () => {
    const table = playFrom({}, [[0, CALL]]);
    const result = applyTableAction(table, 1, CHECK, { timeout: true });
    if (!result.ok) throw new Error(result.message);
    for (const seat of [0, 1]) {
      const { history } = seen(result.state, seat);
      expect(history).toEqual(result.state.history);
      expect(history.slice(2)).toEqual([
        { seat: 0, street: 'preflop', type: 'call', amount: 1 },
        { seat: 1, street: 'preflop', type: 'check', timeout: true },
      ]);
      expect(JSON.stringify(history[2])).not.toContain('timeout');
    }
  });
  it('never leaks opponent cards and has exact View keys at every step of a 6-hand match', () => {
    const script: Step[] = [
      [0, FOLD],
      [1, CALL],
      [0, CHECK],
      [0, raise(2)],
      [1, FOLD],
      [0, CALL],
      [1, CHECK],
      ...checkPostflop(1),
      [1, FOLD],
      [0, raise(6)],
      [1, CALL],
      ...checkPostflop(1),
      [1, CALL],
      [0, CHECK],
      [0, CHECK],
      [1, raise(2)],
      [0, FOLD],
    ];
    let table = startTable(config({ maxHands: 6 }));
    const endings = new Set<string>();
    const inspect = () => {
      for (const seat of [0, 1] as const) {
        const view = seen(table, seat),
          deal = dealHand(table.config.seed, table.handNumber);
        expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
        expect(view).toMatchObject({
          street: table.street,
          my_seat: seat,
          button_seat: table.button,
          pot: table.contributed[0] + table.contributed[1],
          my_stack: table.stacks[seat],
          opponent_stack: table.stacks[1 - seat],
          my_bet_this_street: table.bets[seat],
          opponent_bet_this_street: table.bets[1 - seat],
          history: table.history,
        });
        expect(view.my_cards).toEqual(deal.holeCards[seat]);
        expect(view.board).toEqual(table.board);
        expect(view.board).toEqual(deal.board.slice(0, view.board.length));
        const allowed = new Set([...view.my_cards, ...view.board]);
        for (const card of cardsIn(view))
          expect(allowed, `seat ${seat} sees ${card}`).toContain(card);
        for (const card of deal.holeCards[1 - seat])
          expect(cardsIn(view)).not.toContain(card);
        if (table.lastHand) endings.add(table.lastHand.ended_by);
      }
    };
    inspect();
    for (const step of script) {
      table = play(table, [step]);
      inspect();
    }
    expect(table.over).toBe(true);
    expect(table.handNumber).toBe(6);
    expect(endings).toEqual(new Set(['fold', 'showdown']));
  });
  it('does not mutate the table and shares no mutable View arrays with it', () => {
    const table = playFrom({}, [...CHECK_DOWN_HAND_1, [1, raise(6)]]);
    const frozen = deepFreeze(structuredClone(table));
    expect(() => seatView(frozen, 0)).not.toThrow();
    expect(frozen).toEqual(table);
    const copy = structuredClone(table),
      before = structuredClone(seen(table, 1));
    const view = seen(table, 1);
    view.my_cards[0] = 'Ac';
    view.board.push('Ac');
    view.pots.push(99);
    view.history.push({ seat: 0, street: 'preflop', type: 'fold' });
    view.history[0].amount = 99;
    expect(table).toEqual(copy);
    expect(seatView(table, 1)).toEqual(before);
  });
});

describe('seatView table fields (A25)', () => {
  it('does not split unequal contributions without a live all-in', () => {
    const table = startTable(config({ players: 3 }));
    expect(seatView(table, 0)).toMatchObject({
      pot: 3,
      pots: [3],
      opponent_stack: null,
      opponent_bet_this_street: null,
    });
    expect(seatView(play(table, [[0, raise(6)]]), 1)).toMatchObject({
      pot: 9,
      pots: [9],
    });
  });
  it('splits only at live all-ins, puts other chips in the top pot and ignores a departed all-in', () => {
    // Legal first-hand setup from table.test.ts: stacks before hand 2 blinds
    // become [40, 18, 22, 40, 106, 14]. No edited engine state.
    const setup: Step[] = [
      [3, FOLD],
      [4, CALL],
      [5, CALL],
      [0, FOLD],
      [1, CALL],
      [2, CHECK],
      [1, raise(16)],
      [2, CALL],
      [4, CALL],
      [5, CALL],
      [1, raise(4)],
      [2, FOLD],
      [4, CALL],
      [5, CALL],
      [1, CHECK],
      [4, raise(2)],
      [5, raise(4)],
      [1, FOLD],
      [4, raise(6)],
      [5, FOLD],
    ];
    let table = play(startTable(config({ players: 6 })), setup);
    expect(table.stacks).toEqual([40, 18, 21, 38, 106, 14]);
    table = play(table, [
      [4, raise(106)],
      [5, CALL],
      [0, CALL],
    ]);
    expect(table.contributed).toEqual([40, 0, 1, 2, 106, 14]);
    expect(seatView(table, 1)).toMatchObject({ pot: 163, pots: [45, 52, 66] });
    const left = leaveTable(table, 5);
    if (!left.ok) throw new Error(left.message);
    expect(seatView(left.state, 1)).toMatchObject({ pot: 163, pots: [97, 66] });
  });
  it('returns null for an undealt seat and keeps opponent fields null at a three-seat table with two survivors', () => {
    const table = playFrom({ players: 3, startingStack: 10 }, [
      [0, raise(10)],
      [1, CALL],
      [2, FOLD],
    ]);
    expect(table.over).toBe(false);
    const out = table.holeCards.indexOf(null);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(seatView(table, out)).toBeNull();
    const live = table.holeCards.findIndex(cards => cards !== null);
    expect(seatView(table, live)).toMatchObject({
      opponent_stack: null,
      opponent_bet_this_street: null,
    });
  });
});
