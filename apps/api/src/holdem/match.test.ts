import { describe, expect, it } from 'vitest';
import {
  type Action,
  type ApplyResult,
  applyAction,
  type HandRecord,
  type HistoryEvent,
  legalActions,
  type MatchConfig,
  type MatchState,
  type Seat,
  startMatch,
} from './match';
import { dealHand } from './shuffle';

// Independent node:crypto reference deals, cross-checked with evaluateHand.
// Seeds are 64 lowercase hex chars; abbreviated below by their final 4 chars.
// ...0005 replaces old seed 1, preserving winners 1, 0, 0, 1 in hands 1–4:
// hand 1: 9c Ks | Jh 9d | Jc Qh 3d 7c 3c (J+3 two pair beats a pair of 3s)
// hand 2: Qc Th | Qs Ac | 7d 9d Jc 8d 5h (Q-high straight beats ace high)
// hand 3: 6d 7h | Td 2d | 9c Ks Ts 8c 7s (T-high straight beats a pair of Ts)
// hand 4: 6c Jh | 9c 9s | 4c Kh Td Ac 9h (three 9s beat ace high)
// ...0000 replaces old seed 3: Tc Jd | 6h Js | 2c Ac Qs Jh 4h
//   seat 0 wins: both pair Js with A/Q, T kicker beats 6.
// ...0016 replaces old seed 6: 7s 3d | 3s 4d | 3c 2s Qd 5s 2h
//   tie: both play 3 3 2 2 Q.

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

const chipsInPlay = (state: MatchState): number =>
  state.stacks[0] +
  state.stacks[1] +
  state.contributed[0] +
  state.contributed[1];

function expectOk(result: ApplyResult): Extract<ApplyResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`rejected: ${result.code}: ${result.message}`);
  }
  return result;
}

function expectRejected(
  result: ApplyResult,
): Extract<ApplyResult, { ok: false }> {
  if (result.ok) throw new Error('expected the action to be rejected');
  expect(typeof result.message).toBe('string');
  expect(result.message.length).toBeGreaterThan(0);
  return result;
}

/** Applies a script of actions, asserting each is accepted and chips are kept. */
function play(
  state: MatchState,
  steps: Step[],
): { state: MatchState; finished: HandRecord[] } {
  let current = state;
  const finished: HandRecord[] = [];
  for (const [seat, action] of steps) {
    const result = applyAction(current, seat, action);
    if (!result.ok) {
      throw new Error(
        `seat ${seat} ${JSON.stringify(action)} rejected: ${result.code}: ${result.message}`,
      );
    }
    expect(chipsInPlay(result.state)).toBe(2 * current.config.startingStack);
    expect(result.state.stacks[0]).toBeGreaterThanOrEqual(0);
    expect(result.state.stacks[1]).toBeGreaterThanOrEqual(0);
    finished.push(...result.finishedHands);
    current = result.state;
  }
  return { state: current, finished };
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

describe('startMatch', () => {
  it('posts the blinds for hand 1 and lets the button (seat 0) act first', () => {
    const state = startMatch(config());
    expect(state).toMatchObject({
      config: config(),
      handNumber: 1,
      button: 0,
      street: 'preflop',
      holeCards: dealHand(
        '0000000000000000000000000000000000000000000000000000000000000005',
        1,
      ).holeCards,
      board: [],
      stacks: [39, 38],
      bets: [1, 2],
      contributed: [1, 2],
      toAct: 0,
      over: false,
      history: [blind(0, 1), blind(1, 2)],
      lastHand: null,
    });
  });

  it.each([
    ['uppercase seed', { seed: 'A'.repeat(64) }],
    ['63-character seed', { seed: '0'.repeat(63) }],
    ['non-hex seed', { seed: 'g'.repeat(64) }],
    ['empty seed', { seed: '' }],
    ['65-character seed', { seed: '0'.repeat(65) }],
    ['hands 0', { hands: 0 }],
    ['hands 201', { hands: 201 }],
    ['hands 2.5', { hands: 2.5 }],
    ['startingStack 9', { startingStack: 9 }],
    ['startingStack 2001', { startingStack: 2001 }],
    ['startingStack 40.5', { startingStack: 40.5 }],
  ])('throws RangeError for %s', (_name, overrides) => {
    expect(() => startMatch(config(overrides))).toThrow(RangeError);
  });

  it('accepts the boundary values', () => {
    for (const overrides of [
      { seed: '0'.repeat(64), hands: 1, startingStack: 10 },
      { seed: 'f'.repeat(64), hands: 200, startingStack: 2000 },
    ]) {
      expect(startMatch(config(overrides)).handNumber).toBe(1);
    }
  });
});

describe('preflop', () => {
  it('offers the button fold, call 1, raise 4..all-in at the start', () => {
    expect(legalActions(startMatch(config()))).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 1 },
      { type: 'raise', min: 4, max: 40 },
    ]);
  });

  it('gives the big blind the option (check or raise) after a limp', () => {
    const { state } = playFrom({}, [[0, CALL]]);
    expect(state.history.at(-1)).toEqual({
      seat: 0,
      street: 'preflop',
      type: 'call',
      amount: 1,
    });
    expect(state.toAct).toBe(1);
    expect(state.street).toBe('preflop');
    expect(state.bets).toEqual([2, 2]);
    expect(state.stacks).toEqual([38, 38]);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'check' },
      { type: 'raise', min: 4, max: 40 },
    ]);
  });

  it('records call as chips added and raise as the street total (the trap)', () => {
    const { state } = playFrom({}, [
      [0, raise(6)],
      [1, CALL],
    ]);
    expect(state.history).toEqual([
      blind(0, 1),
      blind(1, 2),
      { seat: 0, street: 'preflop', type: 'raise', amount: 6 },
      { seat: 1, street: 'preflop', type: 'call', amount: 4 },
    ]);
    expect(state.street).toBe('flop');
    expect(state.contributed).toEqual([6, 6]);
    expect(state.stacks).toEqual([34, 34]);
  });

  it('after a raise to 6 the caller adds 4 and the minimum re-raise is to 10', () => {
    const { state } = playFrom({}, [[0, raise(6)]]);
    expect(state.bets).toEqual([6, 2]);
    expect(state.stacks).toEqual([34, 38]);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 4 },
      { type: 'raise', min: 10, max: 40 },
    ]);
  });

  it('carries the last raise size: 6 -> 10 makes 14 the minimum, 6 -> 15 makes 24', () => {
    const minReraise = playFrom({}, [
      [0, raise(6)],
      [1, raise(10)],
    ]).state;
    expect(legalActions(minReraise)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 4 },
      { type: 'raise', min: 14, max: 40 },
    ]);
    const bigReraise = playFrom({}, [
      [0, raise(6)],
      [1, raise(15)],
    ]).state;
    expect(legalActions(bigReraise)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 9 },
      { type: 'raise', min: 24, max: 40 },
    ]);
  });

  it('reopens action to the small blind when the big blind raises its option', () => {
    const { state } = playFrom({}, [
      [0, CALL],
      [1, raise(6)],
    ]);
    expect(state.toAct).toBe(0);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 4 },
      { type: 'raise', min: 10, max: 40 },
    ]);
    const called = play(state, [[0, CALL]]).state;
    expect(called.street).toBe('flop');
    expect(called.contributed).toEqual([6, 6]);
  });
});

describe('streets', () => {
  it('reveals 3, 4, 5 board cards and the non-button acts first postflop', () => {
    const deal = dealHand(
      '0000000000000000000000000000000000000000000000000000000000000005',
      1,
    );
    let { state } = playFrom({}, [
      [0, CALL],
      [1, CHECK],
    ]);
    expect(state.street).toBe('flop');
    expect(state.board).toEqual(deal.board.slice(0, 3));
    expect(state.bets).toEqual([0, 0]);
    expect(state.contributed).toEqual([2, 2]);
    expect(state.toAct).toBe(1);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'check' },
      { type: 'raise', min: 2, max: 38 },
    ]);

    state = play(state, [[1, CHECK]]).state;
    expect(state.toAct).toBe(0);
    expect(state.street).toBe('flop');

    state = play(state, [[0, CHECK]]).state;
    expect(state.street).toBe('turn');
    expect(state.board).toEqual(deal.board.slice(0, 4));
    expect(state.toAct).toBe(1);

    state = play(state, [
      [1, CHECK],
      [0, CHECK],
    ]).state;
    expect(state.street).toBe('river');
    expect(state.board).toEqual(deal.board);
    expect(state.toAct).toBe(1);
  });

  it('postflop: first bet min 2, raise min doubles the bet, size resets next street', () => {
    let { state } = playFrom({}, [
      [0, CALL],
      [1, CHECK],
      [1, raise(5)],
    ]);
    expect(state.bets).toEqual([0, 5]);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 5 },
      { type: 'raise', min: 10, max: 38 },
    ]);
    state = play(state, [[0, CALL]]).state;
    expect(state.street).toBe('turn');
    expect(state.contributed).toEqual([7, 7]);
    expect(state.stacks).toEqual([33, 33]);
    expect(state.toAct).toBe(1);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'check' },
      { type: 'raise', min: 2, max: 33 },
    ]);
  });

  it('uses seat 0 as the postflop first actor when seat 1 has the button', () => {
    const { state } = playFrom({}, [
      [0, FOLD],
      [1, CALL],
      [0, CHECK],
    ]);
    expect(state.handNumber).toBe(2);
    expect(state.button).toBe(1);
    expect(state.street).toBe('flop');
    expect(state.board).toEqual(
      dealHand(
        '0000000000000000000000000000000000000000000000000000000000000005',
        2,
      ).board.slice(0, 3),
    );
    expect(state.toAct).toBe(0);
  });
});

describe('hand endings', () => {
  it('fold preflop: returns the uncalled big blind chip, pot 2, next hand starts', () => {
    const { state, finished } = playFrom({}, [[0, FOLD]]);
    expect(finished).toEqual([
      {
        hand_number: 1,
        button_seat: 0,
        winner_seat: 1,
        pot: 2,
        ended_by: 'fold',
        board: [],
        hole_cards: null,
        stacks: [39, 41],
        events: [
          blind(0, 1),
          blind(1, 2),
          { seat: 0, street: 'preflop', type: 'fold' },
        ],
      },
    ]);
    const { button_seat: _b, events: _e, ...lastHand } = finished[0];
    expect(state.lastHand).toEqual(lastHand);
    expect(state).toMatchObject({
      handNumber: 2,
      button: 1,
      street: 'preflop',
      holeCards: dealHand(
        '0000000000000000000000000000000000000000000000000000000000000005',
        2,
      ).holeCards,
      board: [],
      stacks: [37, 40],
      bets: [2, 1],
      contributed: [2, 1],
      toAct: 1,
      over: false,
      history: [blind(1, 1), blind(0, 2)],
    });
  });

  it('fold to an all-in shove returns the uncalled 38: pot 4', () => {
    const { finished } = playFrom({}, [
      [0, raise(40)],
      [1, FOLD],
    ]);
    expect(finished[0]).toMatchObject({
      winner_seat: 0,
      pot: 4,
      ended_by: 'fold',
      stacks: [42, 38],
    });
  });

  it('the big blind may fold even when it could check', () => {
    const { finished } = playFrom({}, [
      [0, CALL],
      [1, FOLD],
    ]);
    expect(finished[0]).toMatchObject({
      winner_seat: 0,
      pot: 4,
      stacks: [42, 38],
    });
  });

  it('fold on the flop shows the 3 flop cards and returns the uncalled bet', () => {
    const { finished } = playFrom({}, [
      [0, CALL],
      [1, CHECK],
      [1, raise(6)],
      [0, FOLD],
    ]);
    expect(finished[0]).toMatchObject({
      winner_seat: 1,
      pot: 4,
      ended_by: 'fold',
      board: dealHand(
        '0000000000000000000000000000000000000000000000000000000000000005',
        1,
      ).board.slice(0, 3),
      hole_cards: null,
      stacks: [38, 42],
    });
  });

  it('check-down seed ...0005 hand 1: seat 1 wins at showdown, full hand record', () => {
    const deal = dealHand(
      '0000000000000000000000000000000000000000000000000000000000000005',
      1,
    );
    const { state, finished } = playFrom({}, CHECK_DOWN_HAND_1);
    const street = (s: 'flop' | 'turn' | 'river'): HistoryEvent[] => [
      { seat: 1, street: s, type: 'check' },
      { seat: 0, street: s, type: 'check' },
    ];
    expect(finished).toEqual([
      {
        hand_number: 1,
        button_seat: 0,
        winner_seat: 1,
        pot: 4,
        ended_by: 'showdown',
        board: deal.board,
        hole_cards: deal.holeCards,
        stacks: [38, 42],
        events: [
          blind(0, 1),
          blind(1, 2),
          { seat: 0, street: 'preflop', type: 'call', amount: 1 },
          { seat: 1, street: 'preflop', type: 'check' },
          ...street('flop'),
          ...street('turn'),
          ...street('river'),
        ],
      },
    ]);
    expect(state.handNumber).toBe(2);
    expect(state.lastHand).toMatchObject({ hand_number: 1, winner_seat: 1 });
    expect(state.stacks).toEqual([36, 41]);
  });

  it('check-down seed ...0000 hand 1: seat 0 wins at showdown', () => {
    const { finished } = playFrom(
      {
        seed: '0000000000000000000000000000000000000000000000000000000000000000',
      },
      CHECK_DOWN_HAND_1,
    );
    expect(finished[0]).toMatchObject({
      winner_seat: 0,
      pot: 4,
      ended_by: 'showdown',
      hole_cards: dealHand(
        '0000000000000000000000000000000000000000000000000000000000000000',
        1,
      ).holeCards,
      stacks: [42, 38],
    });
  });

  it('bets on every street go into the pot: seed ...0005 hand 1, seat 1 wins 32', () => {
    const { finished } = playFrom({}, [
      [0, CALL],
      [1, CHECK],
      [1, raise(4)],
      [0, CALL],
      [1, CHECK],
      [0, CHECK],
      [1, raise(10)],
      [0, CALL],
    ]);
    expect(finished[0]).toMatchObject({
      winner_seat: 1,
      pot: 32,
      ended_by: 'showdown',
      stacks: [24, 56],
    });
    expect(finished[0].events.slice(-2)).toEqual([
      { seat: 1, street: 'river', type: 'raise', amount: 10 },
      { seat: 0, street: 'river', type: 'call', amount: 10 },
    ]);
  });

  it('split pot seed ...0016 hand 1: winner_seat null and half each', () => {
    const { finished } = playFrom(
      {
        seed: '0000000000000000000000000000000000000000000000000000000000000016',
      },
      [[0, raise(6)], [1, CALL], ...checkPostflop(1)],
    );
    expect(finished[0]).toMatchObject({
      winner_seat: null,
      pot: 12,
      ended_by: 'showdown',
      board: dealHand(
        '0000000000000000000000000000000000000000000000000000000000000016',
        1,
      ).board,
      hole_cards: dealHand(
        '0000000000000000000000000000000000000000000000000000000000000016',
        1,
      ).holeCards,
      stacks: [40, 40],
    });
  });
});

describe('all-in', () => {
  it('all-in and call preflop runs the board out; the loser at 0 ends the match', () => {
    const deal = dealHand(
      '0000000000000000000000000000000000000000000000000000000000000005',
      1,
    );
    const { state, finished } = playFrom({}, [[0, raise(40)]]);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 38 },
    ]);
    const result = expectOk(applyAction(state, 1, CALL));
    expect(finished).toEqual([]);
    expect(result.finishedHands).toEqual([
      {
        hand_number: 1,
        button_seat: 0,
        winner_seat: 1,
        pot: 80,
        ended_by: 'showdown',
        board: deal.board,
        hole_cards: deal.holeCards,
        stacks: [0, 80],
        events: [
          blind(0, 1),
          blind(1, 2),
          { seat: 0, street: 'preflop', type: 'raise', amount: 40 },
          { seat: 1, street: 'preflop', type: 'call', amount: 38 },
        ],
      },
    ]);
    expect(result.state).toMatchObject({
      handNumber: 1,
      button: 0,
      street: 'river',
      board: deal.board,
      stacks: [0, 80],
      bets: [0, 0],
      contributed: [0, 0],
      toAct: null,
      over: true,
    });
    expect(result.state.history).toEqual(result.finishedHands[0].events);
    expect(legalActions(result.state)).toEqual([]);
  });

  it('all-in on the flop and call deals turn and river with no more actions', () => {
    const { state, finished } = playFrom(
      {
        seed: '0000000000000000000000000000000000000000000000000000000000000000',
      },
      [
        [0, CALL],
        [1, CHECK],
        [1, raise(38)],
        [0, CALL],
      ],
    );
    expect(finished[0]).toMatchObject({
      hand_number: 1,
      winner_seat: 0,
      pot: 80,
      ended_by: 'showdown',
      board: dealHand(
        '0000000000000000000000000000000000000000000000000000000000000000',
        1,
      ).board,
      stacks: [80, 0],
    });
    expect(state.over).toBe(true);
  });

  // Seed ...0005, 40 chips. Hand 1 checked down: [38, 42]. Hand 2 (seat 1 button,
  // 41 behind + 1 posted) shoves 42; seat 0 has only 36 behind.
  const shoveHand2 = (): MatchState =>
    playFrom({}, [...CHECK_DOWN_HAND_1, [1, raise(42)]]).state;

  it('raise max is your own all-in total even with more chips than the opponent', () => {
    const { state } = playFrom({}, CHECK_DOWN_HAND_1);
    expect(state.toAct).toBe(1);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 1 },
      { type: 'raise', min: 4, max: 42 },
    ]);
  });

  it('a call bigger than the stack is capped (all-in) and no raise is offered', () => {
    const state = shoveHand2();
    expect(state.stacks).toEqual([36, 0]);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 36 },
    ]);
    const rejected = expectRejected(applyAction(state, 0, raise(42)));
    expect(rejected.code).toBe('invalid_action');
  });

  it('short all-in call: excess 4 goes back to the bigger stack, pot 76', () => {
    const { state, finished } = play(shoveHand2(), [[0, CALL]]);
    expect(finished).toEqual([
      {
        hand_number: 2,
        button_seat: 1,
        winner_seat: 0,
        pot: 76,
        ended_by: 'showdown',
        board: dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          2,
        ).board,
        hole_cards: dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          2,
        ).holeCards,
        stacks: [76, 4],
        events: [
          blind(1, 1),
          blind(0, 2),
          { seat: 1, street: 'preflop', type: 'raise', amount: 42 },
          { seat: 0, street: 'preflop', type: 'call', amount: 36 },
        ],
      },
    ]);
    expect(state).toMatchObject({
      handNumber: 3,
      button: 0,
      stacks: [75, 2],
      bets: [1, 2],
      toAct: 0,
      over: false,
    });
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 1 },
      { type: 'raise', min: 4, max: 76 },
    ]);
  });

  it('match ends when a stack hits 0, before the configured 10 hands', () => {
    const { state, finished } = play(shoveHand2(), [
      [0, CALL],
      [0, raise(4)],
    ]);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 2 },
    ]);
    const end = play(state, [[1, CALL]]);
    expect(finished.map(hand => hand.hand_number)).toEqual([2]);
    expect(end.finished).toEqual([
      expect.objectContaining({
        hand_number: 3,
        button_seat: 0,
        winner_seat: 0,
        pot: 8,
        ended_by: 'showdown',
        stacks: [80, 0],
      }),
    ]);
    expect(end.state).toMatchObject({
      handNumber: 3,
      over: true,
      toAct: null,
      stacks: [80, 0],
      bets: [0, 0],
      contributed: [0, 0],
    });
    expect(end.state.lastHand).toMatchObject({ hand_number: 3, pot: 8 });
  });

  it('short all-in raise: min = max = all-in total, then the opponent may only call or fold', () => {
    const { state } = playFrom({ startingStack: 10 }, [
      [0, raise(4)],
      [1, raise(8)],
    ]);
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 4 },
      { type: 'raise', min: 10, max: 10 },
    ]);
    const tooSmall = expectRejected(applyAction(state, 0, raise(9)));
    expect(tooSmall.code).toBe('invalid_action');
    expect(tooSmall.message).toContain('10');

    const shoved = play(state, [[0, raise(10)]]).state;
    expect(shoved.stacks).toEqual([0, 2]);
    expect(legalActions(shoved)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 2 },
    ]);
    expect(expectRejected(applyAction(shoved, 1, raise(10))).code).toBe(
      'invalid_action',
    );

    const end = play(shoved, [[1, CALL]]);
    expect(end.finished[0]).toMatchObject({
      winner_seat: 1,
      pot: 20,
      ended_by: 'showdown',
      stacks: [0, 20],
    });
    expect(end.state.over).toBe(true);
  });
});

describe('blind all-ins (seed ...0005, 10 chips)', () => {
  // Hand 1: seat 0 raises to 4, seat 1 to 8, seat 0 folds -> [6, 14].
  // Hand 2 (seat 1 button): seat 1 raises to 5, seat 0 calls 3 (1 left),
  //   flop: seat 0 checks, seat 1 bets 2, seat 0 folds -> [1, 19].
  // Hand 3 (seat 0 button): seat 0 posts its last chip as small blind, so
  //   nobody acts; the uncalled 1 goes back, board runs out, seat 0 wins 2
  //   -> [2, 18].
  // Hand 4 (seat 1 button): seat 0 posts its last 2 as big blind (all-in).
  const SCRIPT: Step[] = [
    [0, raise(4)],
    [1, raise(8)],
    [0, FOLD],
    [1, raise(5)],
    [0, CALL],
    [0, CHECK],
    [1, raise(2)],
  ];
  const setup = () => playFrom({ startingStack: 10 }, SCRIPT);

  it('small blind all-in by posting: big blind does not act, refund, runout, next hand starts', () => {
    const before = setup();
    expect(before.finished.map(hand => hand.stacks)).toEqual([[6, 14]]);
    const result = expectOk(applyAction(before.state, 0, FOLD));
    expect(result.finishedHands).toEqual([
      expect.objectContaining({
        hand_number: 2,
        button_seat: 1,
        winner_seat: 1,
        pot: 10,
        ended_by: 'fold',
        board: dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          2,
        ).board.slice(0, 3),
        stacks: [1, 19],
      }),
      {
        hand_number: 3,
        button_seat: 0,
        winner_seat: 0,
        pot: 2,
        ended_by: 'showdown',
        board: dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          3,
        ).board,
        hole_cards: dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          3,
        ).holeCards,
        stacks: [2, 18],
        events: [blind(0, 1), blind(1, 2)],
      },
    ]);
    expect(result.state.lastHand).toMatchObject({
      hand_number: 3,
      stacks: [2, 18],
    });
  });

  it('big blind all-in by posting: small blind may only call or fold', () => {
    const { state } = play(setup().state, [[0, FOLD]]);
    expect(state).toMatchObject({
      handNumber: 4,
      button: 1,
      street: 'preflop',
      stacks: [0, 17],
      bets: [2, 1],
      contributed: [2, 1],
      toAct: 1,
      over: false,
      history: [blind(1, 1), blind(0, 2)],
    });
    expect(legalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 1 },
    ]);
    expect(expectRejected(applyAction(state, 1, raise(4))).code).toBe(
      'invalid_action',
    );

    const end = play(state, [[1, CALL]]);
    expect(end.finished).toEqual([
      expect.objectContaining({
        hand_number: 4,
        winner_seat: 1,
        pot: 4,
        ended_by: 'showdown',
        board: dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          4,
        ).board,
        stacks: [0, 20],
      }),
    ]);
    expect(end.state).toMatchObject({
      handNumber: 4,
      street: 'river',
      over: true,
      toAct: null,
      stacks: [0, 20],
    });
  });

  // Hand 1: seat 0 raises to 9, seat 1 shoves 10 (short all-in raise),
  //   seat 0 folds: uncalled 1 back, pot 18 -> [1, 19].
  // Hand 2 (seat 1 button): seat 1 posts 1, seat 0 posts its last chip as
  //   big blind. Both have 1 in, so nobody has to act: board runs out and
  //   seat 0 wins (seed ...0005 hand 2: Q-high straight) a pot of 2 -> [2, 18].
  // Hand 3 (seat 0 button): blinds 1 and 2 posted, seat 0 to act.
  it('big blind shorter than the blind posts what it has; nobody acts, runout', () => {
    const before = playFrom({ startingStack: 10 }, [
      [0, raise(9)],
      [1, raise(10)],
    ]).state;
    const result = expectOk(applyAction(before, 0, FOLD));
    expect(result.finishedHands).toEqual([
      expect.objectContaining({
        hand_number: 1,
        button_seat: 0,
        winner_seat: 1,
        pot: 18,
        ended_by: 'fold',
        stacks: [1, 19],
      }),
      {
        hand_number: 2,
        button_seat: 1,
        winner_seat: 0,
        pot: 2,
        ended_by: 'showdown',
        board: dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          2,
        ).board,
        hole_cards: dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          2,
        ).holeCards,
        stacks: [2, 18],
        events: [blind(1, 1), blind(0, 1)],
      },
    ]);
    expect(chipsInPlay(result.state)).toBe(20);
    expect(result.state).toMatchObject({
      handNumber: 3,
      button: 0,
      street: 'preflop',
      holeCards: dealHand(
        '0000000000000000000000000000000000000000000000000000000000000005',
        3,
      ).holeCards,
      board: [],
      stacks: [1, 16],
      bets: [1, 2],
      contributed: [1, 2],
      toAct: 0,
      over: false,
      history: [blind(0, 1), blind(1, 2)],
    });
    expect(result.state.lastHand).toMatchObject({
      hand_number: 2,
      stacks: [2, 18],
    });
    expect(legalActions(result.state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 1 },
    ]);
  });
});

describe('match flow', () => {
  it('rotates the button and deals each hand from dealHand(seed, n)', () => {
    let state = startMatch(
      config({
        seed: '0000000000000000000000000000000000000000000000000000000000000007',
      }),
    );
    for (let n = 1; n <= 4; n++) {
      const button: Seat = (n - 1) % 2 === 0 ? 0 : 1;
      expect(state.handNumber).toBe(n);
      expect(state.button).toBe(button);
      expect(state.toAct).toBe(button);
      expect(state.holeCards).toEqual(
        dealHand(
          '0000000000000000000000000000000000000000000000000000000000000007',
          n,
        ).holeCards,
      );
      expect(state.history).toEqual([
        blind(button, 1),
        blind(button === 0 ? 1 : 0, 2),
      ]);
      state = play(state, [[button, FOLD]]).state;
    }
  });

  it('ends after the configured number of hands (hands: 1)', () => {
    const deal = dealHand(
      '0000000000000000000000000000000000000000000000000000000000000005',
      1,
    );
    const { state, finished } = playFrom({ hands: 1 }, CHECK_DOWN_HAND_1);
    expect(finished).toHaveLength(1);
    expect(state).toMatchObject({
      handNumber: 1,
      button: 0,
      street: 'river',
      board: deal.board,
      stacks: [38, 42],
      bets: [0, 0],
      contributed: [0, 0],
      toAct: null,
      over: true,
    });
    expect(state.history).toEqual(finished[0].events);
    expect(state.lastHand).toMatchObject({ hand_number: 1, stacks: [38, 42] });
    expect(legalActions(state)).toEqual([]);
  });

  it('ends after 2 folded hands with stacks back to [40, 40]', () => {
    const { state, finished } = playFrom({ hands: 2 }, [
      [0, FOLD],
      [1, FOLD],
    ]);
    expect(finished.map(hand => hand.stacks)).toEqual([
      [39, 41],
      [40, 40],
    ]);
    expect(state).toMatchObject({
      handNumber: 2,
      button: 1,
      street: 'preflop',
      board: [],
      stacks: [40, 40],
      over: true,
      toAct: null,
    });
    expect(state.history).toEqual([
      blind(1, 1),
      blind(0, 2),
      { seat: 1, street: 'preflop', type: 'fold' },
    ]);
  });

  it('replays: the same seed and actions give the same states and records', () => {
    const script: Step[] = [
      [0, raise(6)],
      [1, CALL],
      [1, raise(2)],
      [0, raise(8)],
      [1, CALL],
      ...checkPostflop(1).slice(2),
      [1, FOLD],
    ];
    const a = playFrom(
      {
        seed: '000000000000000000000000000000000000000000000000000000000000001a',
      },
      script,
    );
    const b = playFrom(
      {
        seed: '000000000000000000000000000000000000000000000000000000000000001a',
      },
      script,
    );
    expect(a).toEqual(b);

    // Flop: seat 1 bets 2, seat 0 raises to 8 -> seat 1 calls 6, may
    // re-raise to 14 (8 + raise size 6).
    const flopRaised = playFrom(
      {
        seed: '000000000000000000000000000000000000000000000000000000000000001a',
      },
      script.slice(0, 4),
    ).state;
    expect(flopRaised).toMatchObject({
      street: 'flop',
      bets: [8, 2],
      contributed: [14, 8],
      stacks: [26, 32],
      toAct: 1,
    });
    expect(legalActions(flopRaised)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 6 },
      { type: 'raise', min: 14, max: 34 },
    ]);
    const turn = playFrom(
      {
        seed: '000000000000000000000000000000000000000000000000000000000000001a',
      },
      script.slice(0, 5),
    ).state;
    expect(turn).toMatchObject({
      street: 'turn',
      bets: [0, 0],
      contributed: [14, 14],
      stacks: [26, 26],
      toAct: 1,
    });

    // Seed ...001a hand 1: 7h Jd | Js 2s | Ks Ad 3h 8d 9h, both play A K J 9 8:
    // split 28. Hand 2: seat 1 folds its small blind -> [41, 39].
    const deal = dealHand(
      '000000000000000000000000000000000000000000000000000000000000001a',
      1,
    );
    expect(a.finished).toEqual([
      {
        hand_number: 1,
        button_seat: 0,
        winner_seat: null,
        pot: 28,
        ended_by: 'showdown',
        board: deal.board,
        hole_cards: deal.holeCards,
        stacks: [40, 40],
        events: [
          blind(0, 1),
          blind(1, 2),
          { seat: 0, street: 'preflop', type: 'raise', amount: 6 },
          { seat: 1, street: 'preflop', type: 'call', amount: 4 },
          { seat: 1, street: 'flop', type: 'raise', amount: 2 },
          { seat: 0, street: 'flop', type: 'raise', amount: 8 },
          { seat: 1, street: 'flop', type: 'call', amount: 6 },
          { seat: 1, street: 'turn', type: 'check' },
          { seat: 0, street: 'turn', type: 'check' },
          { seat: 1, street: 'river', type: 'check' },
          { seat: 0, street: 'river', type: 'check' },
        ],
      },
      expect.objectContaining({
        hand_number: 2,
        button_seat: 1,
        winner_seat: 0,
        pot: 2,
        ended_by: 'fold',
        stacks: [41, 39],
      }),
    ]);
    expect(a.state).toMatchObject({
      handNumber: 3,
      stacks: [40, 37],
      contributed: [1, 2],
    });
  });
});

describe('timeout flag', () => {
  it('marks only actions applied with { timeout: true }', () => {
    const limped = play(startMatch(config()), [[0, CALL]]).state;
    const checked = expectOk(
      applyAction(limped, 1, CHECK, { timeout: true }),
    ).state;
    expect(checked.history.slice(2)).toEqual([
      { seat: 0, street: 'preflop', type: 'call', amount: 1 },
      { seat: 1, street: 'preflop', type: 'check', timeout: true },
    ]);
    expect(JSON.stringify(checked.history[2])).not.toContain('timeout');

    const folded = expectOk(applyAction(checked, 1, FOLD, { timeout: true }));
    expect(folded.finishedHands[0].events.at(-1)).toEqual({
      seat: 1,
      street: 'flop',
      type: 'fold',
      timeout: true,
    });
  });
});

describe('errors', () => {
  it('not_your_turn when the other seat acts', () => {
    const result = expectRejected(applyAction(startMatch(config()), 1, CALL));
    expect(result.code).toBe('not_your_turn');
  });

  it('match_over takes precedence once the match has ended', () => {
    const { state } = playFrom({ hands: 1 }, [[0, FOLD]]);
    expect(state.over).toBe(true);
    for (const seat of [0, 1] as const) {
      for (const action of [FOLD, CHECK, CALL, raise(4)]) {
        expect(expectRejected(applyAction(state, seat, action)).code).toBe(
          'match_over',
        );
      }
    }
  });

  const start = () => startMatch(config());
  const limped = () => play(startMatch(config()), [[0, CALL]]).state;
  it.each<[string, () => MatchState, Seat, Action]>([
    ['check when facing a bet', start, 0, CHECK],
    ['call with nothing to call', limped, 1, CALL],
    ['raise below the minimum', start, 0, raise(3)],
    ['raise above the all-in total', start, 0, raise(41)],
    ['raise to a non-integer', start, 0, raise(4.5)],
    ['raise without an amount', start, 0, { type: 'raise' } as Action],
    [
      'an unknown action type',
      start,
      0,
      { type: 'allin' } as unknown as Action,
    ],
  ])('invalid_action for %s', (_name, makeState, seat, action) => {
    const result = expectRejected(applyAction(makeState(), seat, action));
    expect(result.code).toBe('invalid_action');
  });

  it('a bad raise message names the allowed range', () => {
    const result = expectRejected(
      applyAction(startMatch(config()), 0, raise(41)),
    );
    expect(result.message).toContain('4');
    expect(result.message).toContain('40');
  });
});

describe('purity', () => {
  it('never mutates the input state, accepted or rejected', () => {
    const state = play(startMatch(config()), [[0, raise(6)]]).state;
    const copy = structuredClone(state);
    deepFreeze(state);
    expectOk(applyAction(state, 1, CALL));
    expectOk(applyAction(state, 1, FOLD));
    expectRejected(applyAction(state, 1, CHECK));
    expectRejected(applyAction(state, 0, CALL));
    legalActions(state);
    expect(state).toEqual(copy);
  });

  it('works the same on JSON round-tripped states', () => {
    const script: Step[] = [
      ...CHECK_DOWN_HAND_1,
      [1, raise(42)],
      [0, CALL],
      [0, raise(4)],
      [1, CALL],
    ];
    const direct = playFrom({}, script);
    let state = JSON.parse(JSON.stringify(startMatch(config()))) as MatchState;
    const finished: HandRecord[] = [];
    for (const [seat, action] of script) {
      const result = expectOk(applyAction(state, seat, action));
      finished.push(...result.finishedHands);
      state = JSON.parse(JSON.stringify(result.state)) as MatchState;
    }
    expect(state).toEqual(direct.state);
    expect(finished).toEqual(direct.finished);
    expect(direct.state.over).toBe(true);
  });
});
