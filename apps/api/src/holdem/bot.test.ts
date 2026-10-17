import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomAction } from './bot';
import {
  type Action,
  applyAction,
  type LegalAction,
  legalActions,
  type MatchConfig,
  type MatchState,
  type Seat,
  startMatch,
} from './match';
import { mulberry32 } from './shuffle';

type Step = [Seat, Action];

const CHECK: Action = { type: 'check' };
const CALL: Action = { type: 'call' };
const raise = (amount: number): Action => ({ type: 'raise', amount });

const config = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
  seed: 1,
  hands: 10,
  startingStack: 40,
  ...overrides,
});

function playFrom(overrides: Partial<MatchConfig>, steps: Step[]): MatchState {
  let state = startMatch(config(overrides));
  for (const [seat, action] of steps) {
    const result = applyAction(state, seat, action);
    if (!result.ok) {
      throw new Error(`${JSON.stringify(action)} rejected: ${result.message}`);
    }
    state = result.state;
  }
  return state;
}

// Real decision points and the legal lists the engine offers there.
const SITUATIONS: [string, () => MatchState][] = [
  // fold, call 1, raise 4..40
  ['button at the start', () => startMatch(config())],
  // fold, check, raise 4..40
  ['big blind option after a limp', () => playFrom({}, [[0, CALL]])],
  // fold, check, raise 2..38
  [
    'first to act on the flop',
    () =>
      playFrom({}, [
        [0, CALL],
        [1, CHECK],
      ]),
  ],
  // fold, call 4, raise 10..40
  ['facing a raise', () => playFrom({}, [[0, raise(6)]])],
  // fold, call 38
  ['facing an all-in shove', () => playFrom({}, [[0, raise(40)]])],
  // fold, call 4, raise 10..10 (short all-in)
  [
    'short stack: raise min = max = all-in',
    () =>
      playFrom({ startingStack: 10 }, [
        [0, raise(4)],
        [1, raise(8)],
      ]),
  ],
  // fold, call 4, raise 10..1000 (big stacks)
  ['deep stacks', () => playFrom({ startingStack: 1000 }, [[0, raise(6)]])],
];

const counts = (actions: Action[]) => {
  const seen = { fold: 0, check: 0, call: 0, raise: 0 };
  for (const action of actions) seen[action.type]++;
  return seen;
};

function drawMany(legal: LegalAction[], n: number, seed = 7): Action[] {
  const random = mulberry32(seed);
  return Array.from({ length: n }, () => randomAction(legal, random));
}

/** The reasons `action` would be wrong for `legal`; [] when fine. */
function problems(action: Action, legal: LegalAction[]): string[] {
  const found: string[] = [];
  const offered = legal.find(option => option.type === action.type);
  if (!offered) found.push(`${action.type} is not offered`);
  if (action.type === 'raise') {
    if (offered?.type === 'raise') {
      if (!Number.isInteger(action.amount)) found.push('non-integer raise');
      if (action.amount < offered.min) found.push('raise below min');
      if (action.amount > offered.max) found.push('raise above max');
    }
    if (Object.keys(action).sort().join() !== 'amount,type') {
      found.push(`raise has extra keys: ${Object.keys(action).join()}`);
    }
  } else if (Object.keys(action).join() !== 'type') {
    found.push(`${action.type} carries extra keys: ${Object.keys(action)}`);
  }
  if (action.type === 'fold' && legal.some(option => option.type === 'check')) {
    found.push('folded when check was offered');
  }
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('randomAction', () => {
  it('throws RangeError when no action is legal', () => {
    expect(() => randomAction([], mulberry32(1))).toThrow(RangeError);
  });

  it.each(SITUATIONS)(
    '%s: always picks an action the engine accepts',
    (_name, makeState) => {
      const state = makeState();
      const legal = legalActions(state);
      const seat = state.toAct as Seat;
      for (const action of drawMany(legal, 2000)) {
        expect(problems(action, legal)).toEqual([]);
        const result = applyAction(state, seat, action);
        expect(result.ok).toBe(true);
      }
    },
  );

  it('handles hand-made lists (call only, check only, min = max raise)', () => {
    const lists: LegalAction[][] = [
      [{ type: 'fold' }, { type: 'call', amount: 3 }],
      [{ type: 'fold' }, { type: 'check' }],
      [{ type: 'fold' }, { type: 'check' }, { type: 'raise', min: 7, max: 7 }],
      [
        { type: 'fold' },
        { type: 'call', amount: 1 },
        { type: 'raise', min: 3, max: 4 },
      ],
    ];
    for (const legal of lists) {
      for (const action of drawMany(legal, 500)) {
        expect(problems(action, legal)).toEqual([]);
      }
    }
  });

  it('stays legal at the edges of the random stream (0 and just below 1)', () => {
    for (const [, makeState] of SITUATIONS) {
      const legal = legalActions(makeState());
      for (const value of [0, 0.5, 1 - Number.EPSILON]) {
        const action = randomAction(legal, () => value);
        expect(problems(action, legal)).toEqual([]);
      }
    }
  });

  it('never folds when check is offered', () => {
    const legal = legalActions(playFrom({}, [[0, CALL]]));
    expect(legal.some(option => option.type === 'check')).toBe(true);
    const seen = counts(drawMany(legal, 3000));
    expect(seen.fold).toBe(0);
    expect(seen.check).toBeGreaterThan(0);
    expect(seen.raise).toBeGreaterThan(0);
  });

  it('facing a bet it sometimes folds, calls and raises', () => {
    const legal = legalActions(startMatch(config()));
    const seen = counts(drawMany(legal, 3000));
    expect(seen.fold).toBeGreaterThan(0);
    expect(seen.call).toBeGreaterThan(0);
    expect(seen.raise).toBeGreaterThan(0);
    expect(seen.check).toBe(0);
  });

  it('facing an all-in it sometimes folds and sometimes calls', () => {
    const legal = legalActions(playFrom({}, [[0, raise(40)]]));
    const seen = counts(drawMany(legal, 3000));
    expect(seen.fold).toBeGreaterThan(0);
    expect(seen.call).toBeGreaterThan(0);
    expect(seen.raise).toBe(0);
  });

  it('raises exactly min, exactly max (all-in) and strictly in between', () => {
    for (const legal of [
      legalActions(startMatch(config())), // 4..40
      legalActions(playFrom({ startingStack: 1000 }, [[0, raise(6)]])), // 10..1000
      [
        { type: 'fold' },
        { type: 'check' },
        { type: 'raise', min: 2, max: 4 },
      ] satisfies LegalAction[],
    ]) {
      const range = legal.find(option => option.type === 'raise');
      if (range?.type !== 'raise') throw new Error('no raise offered');
      const amounts = new Set(
        drawMany(legal, 5000).flatMap(action =>
          action.type === 'raise' ? [action.amount] : [],
        ),
      );
      expect(amounts.has(range.min)).toBe(true);
      expect(amounts.has(range.max)).toBe(true);
      expect(
        [...amounts].some(amount => amount > range.min && amount < range.max),
      ).toBe(true);
    }
  });

  it('is deterministic: the same stream gives the same actions', () => {
    const lists = SITUATIONS.map(([, makeState]) => legalActions(makeState()));
    const run = () => {
      const random = mulberry32(12345);
      return Array.from({ length: 300 }, (_, i) =>
        randomAction(lists[i % lists.length], random),
      );
    };
    expect(run()).toEqual(run());
  });

  it('does not use Math.random', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random was called');
    });
    const random = mulberry32(3);
    for (const [, makeState] of SITUATIONS) {
      const legal = legalActions(makeState());
      for (let i = 0; i < 50; i++) randomAction(legal, random);
    }
    expect(Math.random).not.toHaveBeenCalled();
  });

  it('does not change the legal list', () => {
    const legal = legalActions(startMatch(config()));
    const copy = structuredClone(legal);
    drawMany(legal, 200);
    expect(legal).toEqual(copy);
  });

  it('plays whole matches against itself without an illegal action', () => {
    const random = mulberry32(99);
    for (const overrides of [
      { seed: 5, hands: 50, startingStack: 10 },
      { seed: 6, hands: 30, startingStack: 40 },
      { seed: 0xffffffff, hands: 20, startingStack: 2000 },
    ]) {
      let state = startMatch(config(overrides));
      let steps = 0;
      while (!state.over) {
        const seat = state.toAct as Seat;
        const result = applyAction(
          state,
          seat,
          randomAction(legalActions(state), random),
        );
        if (!result.ok) throw new Error(result.message);
        state = result.state;
        steps++;
        expect(steps).toBeLessThan(100_000);
      }
      expect(state.over).toBe(true);
    }
  });
});
