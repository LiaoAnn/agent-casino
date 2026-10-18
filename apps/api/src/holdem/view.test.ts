import { describe, expect, it } from 'vitest';
import type { Card } from './cards';
import {
  type Action,
  applyAction,
  type HistoryEvent,
  type LastHand,
  type MatchConfig,
  type MatchState,
  type Seat,
  startMatch,
} from './match';
import { dealHand } from './shuffle';
import { type SeatView, viewFor } from './view';

// Independent reference deals, same fixture as match.test.ts:
// ...0005 hand 1: 9c Ks | Jh 9d | Jc Qh 3d 7c 3c (seat 1 wins)
// ...0005 hand 2: Qc Th | Qs Ac | 7d 9d Jc 8d 5h

type Step = [Seat, Action];

const FOLD: Action = { type: 'fold' };
const CHECK: Action = { type: 'check' };
const CALL: Action = { type: 'call' };
const raise = (amount: number): Action => ({ type: 'raise', amount });

const config = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
  seed: '0000000000000000000000000000000000000000000000000000000000000005',
  hands: 10,
  startingStack: 40,
  ...overrides,
});

function play(state: MatchState, steps: Step[]): MatchState {
  let current = state;
  for (const [seat, action] of steps) {
    const result = applyAction(current, seat, action);
    if (!result.ok) {
      throw new Error(
        `seat ${seat} ${JSON.stringify(action)} rejected: ${result.code}: ${result.message}`,
      );
    }
    current = result.state;
  }
  return current;
}

const playFrom = (overrides: Partial<MatchConfig>, steps: Step[]) =>
  play(startMatch(config(overrides)), steps);

/** Checks every postflop street; `first` is the non-button seat. */
const checkPostflop = (first: Seat): Step[] => {
  const second: Seat = first === 0 ? 1 : 0;
  return [
    [first, CHECK],
    [second, CHECK],
    [first, CHECK],
    [second, CHECK],
    [first, CHECK],
    [second, CHECK],
  ];
};

/** Hand 1 (button = seat 0): limp, check, then check it down. */
const CHECK_DOWN_HAND_1: Step[] = [[0, CALL], [1, CHECK], ...checkPostflop(1)];

const blind = (seat: Seat, amount: number): HistoryEvent => ({
  seat,
  street: 'preflop',
  type: 'post_blind',
  amount,
});

const checks = (street: 'flop' | 'turn' | 'river'): HistoryEvent[] => [
  { seat: 1, street, type: 'check' },
  { seat: 0, street, type: 'check' },
];

const HAND_1_CHECK_DOWN_HISTORY: HistoryEvent[] = [
  blind(0, 1),
  blind(1, 2),
  { seat: 0, street: 'preflop', type: 'call', amount: 1 },
  { seat: 1, street: 'preflop', type: 'check' },
  ...checks('flop'),
  ...checks('turn'),
  ...checks('river'),
];

const HAND_1_SHOWDOWN: LastHand = {
  hand_number: 1,
  winner_seat: 1,
  pot: 4,
  ended_by: 'showdown',
  board: ['Jc', 'Qh', '3d', '7c', '3c'],
  hole_cards: [
    ['9c', 'Ks'],
    ['Jh', '9d'],
  ],
  stacks: [38, 42],
};

const VIEW_KEYS = [
  'board',
  'button_seat',
  'history',
  'my_bet_this_street',
  'my_cards',
  'my_seat',
  'my_stack',
  'opponent_bet_this_street',
  'opponent_stack',
  'pot',
  'street',
];
const SEAT_VIEW_KEYS = ['hand_number', 'last_hand', 'to_act_seat', 'view'];
const LAST_HAND_KEYS = [
  'board',
  'ended_by',
  'hand_number',
  'hole_cards',
  'pot',
  'stacks',
  'winner_seat',
];

/** Every quoted card string anywhere in the JSON. */
const cardsIn = (value: unknown): string[] =>
  [...JSON.stringify(value).matchAll(/"([2-9TJQKA][shdc])"/g)].map(m => m[1]);

/**
 * The only cards a seat may see: its own hole cards, the board revealed so
 * far, and last_hand's board plus both hole cards only after a showdown.
 */
function expectNoLeak(state: MatchState, seat: Seat, seen: SeatView): void {
  const deal = dealHand(state.config.seed, state.handNumber);
  expect(seen.view.my_cards).toEqual(deal.holeCards[seat]);
  expect(seen.view.board).toEqual(state.board);
  expect(seen.view.board).toEqual(deal.board.slice(0, seen.view.board.length));
  expect(seen.last_hand).toEqual(state.lastHand);

  const allowed = new Set<Card>([...seen.view.my_cards, ...seen.view.board]);
  const last = seen.last_hand;
  if (last) {
    const lastDeal = dealHand(state.config.seed, last.hand_number);
    expect(last.board).toEqual(lastDeal.board.slice(0, last.board.length));
    for (const card of last.board) allowed.add(card);
    if (last.ended_by === 'showdown') {
      expect(last.hole_cards).toEqual(lastDeal.holeCards);
      for (const card of last.hole_cards?.flat() ?? []) allowed.add(card);
    } else {
      expect(last.hole_cards).toBeNull();
    }
  }
  for (const card of cardsIn(seen)) {
    expect(allowed, `seat ${seat} sees ${card}`).toContain(card);
  }
  // The opponent's current cards are never in the view object itself.
  const opponent: Seat = seat === 0 ? 1 : 0;
  const viewCards = cardsIn(seen.view);
  for (const card of deal.holeCards[opponent]) {
    expect(viewCards).not.toContain(card);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('viewFor', () => {
  it('start of hand 1 from seat 0 (button, small blind)', () => {
    expect(viewFor(startMatch(config()), 0)).toEqual({
      hand_number: 1,
      to_act_seat: 0,
      view: {
        street: 'preflop',
        my_seat: 0,
        button_seat: 0,
        my_cards: ['9c', 'Ks'],
        board: [],
        pot: 3,
        my_stack: 39,
        opponent_stack: 38,
        my_bet_this_street: 1,
        opponent_bet_this_street: 2,
        history: [blind(0, 1), blind(1, 2)],
      },
      last_hand: null,
    });
  });

  it('start of hand 1 from seat 1 (big blind)', () => {
    expect(viewFor(startMatch(config()), 1)).toEqual({
      hand_number: 1,
      to_act_seat: 0,
      view: {
        street: 'preflop',
        my_seat: 1,
        button_seat: 0,
        my_cards: ['Jh', '9d'],
        board: [],
        pot: 3,
        my_stack: 38,
        opponent_stack: 39,
        my_bet_this_street: 2,
        opponent_bet_this_street: 1,
        history: [blind(0, 1), blind(1, 2)],
      },
      last_hand: null,
    });
  });

  it('mid-flop facing a bet: pot includes this street, both seats see the same public facts', () => {
    const state = playFrom({}, [
      [0, CALL],
      [1, CHECK],
      [1, raise(4)],
    ]);
    const history: HistoryEvent[] = [
      blind(0, 1),
      blind(1, 2),
      { seat: 0, street: 'preflop', type: 'call', amount: 1 },
      { seat: 1, street: 'preflop', type: 'check' },
      { seat: 1, street: 'flop', type: 'raise', amount: 4 },
    ];
    expect(viewFor(state, 0)).toEqual({
      hand_number: 1,
      to_act_seat: 0,
      view: {
        street: 'flop',
        my_seat: 0,
        button_seat: 0,
        my_cards: ['9c', 'Ks'],
        board: ['Jc', 'Qh', '3d'],
        pot: 8,
        my_stack: 38,
        opponent_stack: 34,
        my_bet_this_street: 0,
        opponent_bet_this_street: 4,
        history,
      },
      last_hand: null,
    });
    expect(viewFor(state, 1)).toEqual({
      hand_number: 1,
      to_act_seat: 0,
      view: {
        street: 'flop',
        my_seat: 1,
        button_seat: 0,
        my_cards: ['Jh', '9d'],
        board: ['Jc', 'Qh', '3d'],
        pot: 8,
        my_stack: 34,
        opponent_stack: 38,
        my_bet_this_street: 4,
        opponent_bet_this_street: 0,
        history,
      },
      last_hand: null,
    });
  });

  it('hand 2 after a preflop fold: seat 1 has the button, history is this hand only', () => {
    const state = playFrom({}, [[0, FOLD]]);
    const lastHand: LastHand = {
      hand_number: 1,
      winner_seat: 1,
      pot: 2,
      ended_by: 'fold',
      board: [],
      hole_cards: null,
      stacks: [39, 41],
    };
    expect(viewFor(state, 1)).toEqual({
      hand_number: 2,
      to_act_seat: 1,
      view: {
        street: 'preflop',
        my_seat: 1,
        button_seat: 1,
        my_cards: ['Qs', 'Ac'],
        board: [],
        pot: 3,
        my_stack: 40,
        opponent_stack: 37,
        my_bet_this_street: 1,
        opponent_bet_this_street: 2,
        history: [blind(1, 1), blind(0, 2)],
      },
      last_hand: lastHand,
    });
    expect(viewFor(state, 0)).toMatchObject({
      hand_number: 2,
      to_act_seat: 1,
      view: {
        my_seat: 0,
        button_seat: 1,
        my_cards: ['Qc', 'Th'],
        my_stack: 37,
        opponent_stack: 40,
        my_bet_this_street: 2,
        opponent_bet_this_street: 1,
      },
      last_hand: lastHand,
    });
  });

  it('last_hand after a flop fold: pot excludes the returned bet, flop shown, no hole cards', () => {
    const state = playFrom({}, [
      [0, CALL],
      [1, CHECK],
      [1, raise(6)],
      [0, FOLD],
    ]);
    for (const seat of [0, 1] as const) {
      const seen = viewFor(state, seat);
      expect(seen.last_hand).toEqual({
        hand_number: 1,
        winner_seat: 1,
        pot: 4,
        ended_by: 'fold',
        board: ['Jc', 'Qh', '3d'],
        hole_cards: null,
        stacks: [38, 42],
      });
      expect(seen.view).toMatchObject({ pot: 3, board: [] });
    }
    // Hand 1 hole cards stay hidden from the other seat after the fold.
    expect(cardsIn(viewFor(state, 0))).not.toContain('Jh');
    expect(cardsIn(viewFor(state, 0))).not.toContain('9d');
    expect(cardsIn(viewFor(state, 1))).not.toContain('9c');
    expect(cardsIn(viewFor(state, 1))).not.toContain('Ks');
    expect(viewFor(state, 0).view).toMatchObject({
      my_stack: 36,
      opponent_stack: 41,
    });
  });

  it('after a showdown: last_hand shows both hole cards, my_cards is the new deal', () => {
    const state = playFrom({}, CHECK_DOWN_HAND_1);
    const seat0 = viewFor(state, 0);
    const seat1 = viewFor(state, 1);
    expect(seat0.last_hand).toEqual(HAND_1_SHOWDOWN);
    expect(seat1.last_hand).toEqual(HAND_1_SHOWDOWN);
    expect(seat0).toMatchObject({
      hand_number: 2,
      to_act_seat: 1,
      view: {
        street: 'preflop',
        button_seat: 1,
        my_cards: ['Qc', 'Th'],
        board: [],
        pot: 3,
        my_stack: 36,
        opponent_stack: 41,
        history: [blind(1, 1), blind(0, 2)],
      },
    });
    expect(seat1.view.my_cards).toEqual(['Qs', 'Ac']);
    expect(cardsIn(seat0.view)).not.toContain('Qs');
    expect(cardsIn(seat1.view)).not.toContain('Qc');
  });

  it('match over after a showdown: to_act_seat null, pot 0, final stacks, last_hand = final hand', () => {
    const state = playFrom({ hands: 1 }, CHECK_DOWN_HAND_1);
    expect(viewFor(state, 0)).toEqual({
      hand_number: 1,
      to_act_seat: null,
      view: {
        street: 'river',
        my_seat: 0,
        button_seat: 0,
        my_cards: ['9c', 'Ks'],
        board: ['Jc', 'Qh', '3d', '7c', '3c'],
        pot: 0,
        my_stack: 38,
        opponent_stack: 42,
        my_bet_this_street: 0,
        opponent_bet_this_street: 0,
        history: HAND_1_CHECK_DOWN_HISTORY,
      },
      last_hand: HAND_1_SHOWDOWN,
    });
    expect(viewFor(state, 1)).toMatchObject({
      to_act_seat: null,
      view: { my_seat: 1, my_cards: ['Jh', '9d'], pot: 0, my_stack: 42 },
      last_hand: HAND_1_SHOWDOWN,
    });
  });

  it('match over after a fold: the final opponent cards stay hidden', () => {
    const state = playFrom({ hands: 2 }, [
      [0, FOLD],
      [1, FOLD],
    ]);
    const seen = viewFor(state, 0);
    expect(seen).toEqual({
      hand_number: 2,
      to_act_seat: null,
      view: {
        street: 'preflop',
        my_seat: 0,
        button_seat: 1,
        my_cards: ['Qc', 'Th'],
        board: [],
        pot: 0,
        my_stack: 40,
        opponent_stack: 40,
        my_bet_this_street: 0,
        opponent_bet_this_street: 0,
        history: [
          blind(1, 1),
          blind(0, 2),
          { seat: 1, street: 'preflop', type: 'fold' },
        ],
      },
      last_hand: {
        hand_number: 2,
        winner_seat: 0,
        pot: 2,
        ended_by: 'fold',
        board: [],
        hole_cards: null,
        stacks: [40, 40],
      },
    });
    expect(cardsIn(seen)).toEqual(['Qc', 'Th']);
    expect(cardsIn(viewFor(state, 1))).toEqual(['Qs', 'Ac']);
  });

  it('passes the timeout flag through history unchanged', () => {
    const limped = playFrom({}, [[0, CALL]]);
    const result = applyAction(limped, 1, CHECK, { timeout: true });
    if (!result.ok) throw new Error(result.message);
    for (const seat of [0, 1] as const) {
      const { history } = viewFor(result.state, seat).view;
      expect(history).toEqual(result.state.history);
      expect(history.slice(2)).toEqual([
        { seat: 0, street: 'preflop', type: 'call', amount: 1 },
        { seat: 1, street: 'preflop', type: 'check', timeout: true },
      ]);
      expect(JSON.stringify(history[2])).not.toContain('timeout');
    }
  });

  it('never leaks the opponent cards and has exact keys at every step of a 6-hand match', () => {
    // seed ...0005, 6 hands: preflop fold, flop fold, showdown, preflop fold,
    // raised showdown, flop fold; then the match is over.
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
    let state = startMatch(config({ hands: 6 }));
    const endings = new Set<string>();
    const inspect = () => {
      for (const seat of [0, 1] as const) {
        const seen = viewFor(state, seat);
        expect(Object.keys(seen).sort()).toEqual(SEAT_VIEW_KEYS);
        expect(Object.keys(seen.view).sort()).toEqual(VIEW_KEYS);
        if (seen.last_hand) {
          expect(Object.keys(seen.last_hand).sort()).toEqual(LAST_HAND_KEYS);
          endings.add(seen.last_hand.ended_by);
        }
        const opponent: Seat = seat === 0 ? 1 : 0;
        expect(seen).toMatchObject({
          hand_number: state.handNumber,
          to_act_seat: state.toAct,
          view: {
            street: state.street,
            my_seat: seat,
            button_seat: state.button,
            pot: state.contributed[0] + state.contributed[1],
            my_stack: state.stacks[seat],
            opponent_stack: state.stacks[opponent],
            my_bet_this_street: state.bets[seat],
            opponent_bet_this_street: state.bets[opponent],
            history: state.history,
          },
        });
        expectNoLeak(state, seat, seen);
      }
    };
    inspect();
    for (const step of script) {
      state = play(state, [step]);
      inspect();
    }
    expect(state.over).toBe(true);
    expect(state.handNumber).toBe(6);
    expect(endings).toEqual(new Set(['fold', 'showdown']));
  });

  it('does not mutate the state and shares no mutable arrays with it', () => {
    const state = playFrom({}, [...CHECK_DOWN_HAND_1, [1, raise(6)]]);
    const frozen = deepFreeze(structuredClone(state));
    expect(() => viewFor(frozen, 0)).not.toThrow();
    expect(frozen).toEqual(state);

    const copy = structuredClone(state);
    const seen = viewFor(state, 1);
    seen.view.my_cards[0] = 'Ac';
    seen.view.board.push('Ac');
    seen.view.history.push({ seat: 0, street: 'preflop', type: 'fold' });
    seen.view.history[0].amount = 99;
    if (!seen.last_hand?.hole_cards) throw new Error('expected showdown');
    seen.last_hand.board.pop();
    seen.last_hand.stacks[0] = 0;
    seen.last_hand.hole_cards[0][0] = 'Ac';
    seen.last_hand.hole_cards[1].reverse();
    expect(state).toEqual(copy);
    expect(viewFor(state, 1).last_hand).toEqual(HAND_1_SHOWDOWN);
  });
});
