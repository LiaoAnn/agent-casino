import { describe, expect, it } from 'vitest';
import { checkHand, checkState } from './invariants';
import {
  type Action,
  applyAction,
  type HandRecord,
  type HistoryEvent,
  type LegalAction,
  legalActions,
  type MatchConfig,
  type MatchState,
  type Seat,
  startMatch,
} from './match';
import { dealHand, mulberry32 } from './shuffle';

// Independent reference fixtures (seat 0 | seat 1 | board), see match.test.ts:
// ...0005 hand 1: 9c Ks | Jh 9d | Jc Qh 3d 7c 3c   seat 1 wins
// ...0016 hand 1: 7s 3d | 3s 4d | 3c 2s Qd 5s 2h   tie
// ...001a hand 1: 7h Jd | Js 2s | Ks Ad 3h 8d 9h   tie

type Step = [Seat, Action, { timeout?: boolean }?];

const FOLD: Action = { type: 'fold' };
const CHECK: Action = { type: 'check' };
const CALL: Action = { type: 'call' };
const raise = (amount: number): Action => ({ type: 'raise', amount });

const config = (overrides: Partial<MatchConfig> = {}): MatchConfig => ({
  seed: '0000000000000000000000000000000000000000000000000000000000000005',
  maxHands: 10,
  blindEvery: 50,
  startingStack: 40,
  ...overrides,
});

/** Every state along a script (the start included) and the finished hands. */
function trace(
  overrides: Partial<MatchConfig>,
  steps: Step[],
): { states: MatchState[]; hands: HandRecord[] } {
  let state = startMatch(config(overrides));
  const states = [state];
  const hands: HandRecord[] = [];
  for (const [seat, action, options] of steps) {
    const result = applyAction(state, seat, action, options);
    if (!result.ok) {
      throw new Error(
        `seat ${seat} ${JSON.stringify(action)} rejected: ${result.message}`,
      );
    }
    hands.push(...result.finishedHands);
    state = result.state;
    states.push(state);
  }
  return { states, hands };
}

const last = <T>(items: T[]): T => items[items.length - 1];
const stateAfter = (overrides: Partial<MatchConfig>, steps: Step[]) =>
  last(trace(overrides, steps).states);

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

const CHECK_DOWN_HAND_1: Step[] = [[0, CALL], [1, CHECK], ...checkPostflop(1)];

// Seed ...0005, 10 chips (match.test.ts "blind all-ins"): hand 3 seat 0 is all-in
// by posting the small blind, hand 4 by posting the big blind.
const BLIND_ALL_IN_SCRIPT: Step[] = [
  [0, raise(4)],
  [1, raise(8)],
  [0, FOLD],
  [1, raise(5)],
  [0, CALL],
  [0, CHECK],
  [1, raise(2)],
  [0, FOLD],
  [1, CALL],
];

const SCENARIOS: [string, Partial<MatchConfig>, Step[]][] = [
  ['check-down, seat 1 wins', {}, CHECK_DOWN_HAND_1],
  [
    'raises on every street and a split pot (seed ...001a)',
    {
      seed: '000000000000000000000000000000000000000000000000000000000000001a',
    },
    [
      [0, raise(6)],
      [1, CALL],
      [1, raise(2)],
      [0, raise(8)],
      [1, CALL],
      ...checkPostflop(1).slice(2),
      [1, FOLD],
    ],
  ],
  [
    'split pot on the last hand (seed ...0016, hands 1)',
    {
      seed: '0000000000000000000000000000000000000000000000000000000000000016',
      maxHands: 1,
    },
    [[0, raise(6)], [1, CALL], ...checkPostflop(1)],
  ],
  [
    'short all-in call returns the excess, then a bust',
    {},
    [...CHECK_DOWN_HAND_1, [1, raise(42)], [0, CALL], [0, raise(4)], [1, CALL]],
  ],
  ['blind all-ins, then a bust', { startingStack: 10 }, BLIND_ALL_IN_SCRIPT],
  [
    'big blind shorter than the blind',
    { startingStack: 10 },
    [
      [0, raise(9)],
      [1, raise(10)],
      [0, FOLD],
    ],
  ],
  [
    'short all-in raise does not reopen, then a bust',
    { startingStack: 10 },
    [
      [0, raise(4)],
      [1, raise(8)],
      [0, raise(10)],
      [1, CALL],
    ],
  ],
  [
    'all-in on the flop',
    {
      seed: '0000000000000000000000000000000000000000000000000000000000000000',
    },
    [
      [0, CALL],
      [1, CHECK],
      [1, raise(38)],
      [0, CALL],
    ],
  ],
  [
    'match ends after the configured hands',
    { maxHands: 2 },
    [
      [0, FOLD],
      [1, FOLD],
    ],
  ],
  [
    'timeouts and a fold where check was allowed',
    {},
    [
      [0, CALL, { timeout: true }],
      [1, CHECK, { timeout: true }],
      [1, FOLD, { timeout: true }],
      [1, CALL],
      [0, raise(10)],
      [1, raise(18)],
      [0, CALL],
    ],
  ],
];

/** Random legal play, independent of bot.ts. */
function pick(legal: LegalAction[], random: () => number): Action {
  const option = legal[Math.floor(random() * legal.length)];
  if (option.type === 'raise') {
    const span = option.max - option.min + 1;
    return raise(option.min + Math.floor(random() * span));
  }
  return { type: option.type };
}

function randomMatch(overrides: Partial<MatchConfig>, botSeed: number) {
  const random = mulberry32(botSeed);
  let state = startMatch(config(overrides));
  const states = [state];
  const hands: HandRecord[] = [];
  while (!state.over) {
    const result = applyAction(
      state,
      state.toAct as Seat,
      pick(legalActions(state), random),
      { timeout: random() < 0.1 },
    );
    if (!result.ok) throw new Error(result.message);
    hands.push(...result.finishedHands);
    state = result.state;
    states.push(state);
  }
  return { states, hands };
}

const RANDOM_MATCHES: [Partial<MatchConfig>, number][] = [
  [{ seed: '0'.repeat(64), maxHands: 30, startingStack: 10 }, 1],
  [{ seed: 'f'.repeat(64), maxHands: 30, startingStack: 10 }, 2],
  [
    {
      seed: '000000000000000000000000000000000000000000000000000000000000000b',
      maxHands: 40,
      startingStack: 40,
    },
    3,
  ],
  [
    {
      seed: '000000000000000000000000000000000000000000000000000000000000000c',
      maxHands: 20,
      startingStack: 2000,
    },
    4,
  ],
  [
    {
      seed: '000000000000000000000000000000000000000000000000000000000000000d',
      maxHands: 100,
      startingStack: 15,
    },
    5,
  ],
];

function expectViolations(found: unknown): void {
  expect(Array.isArray(found)).toBe(true);
  const list = found as unknown[];
  expect(list.length).toBeGreaterThan(0);
  for (const message of list) {
    expect(typeof message).toBe('string');
    expect((message as string).length).toBeGreaterThan(0);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const blind = (seat: Seat, amount: number): HistoryEvent => ({
  seat,
  street: 'preflop',
  type: 'post_blind',
  amount,
});

describe('checkState on legal play', () => {
  it('the start of a match has no violations', () => {
    for (const overrides of [
      {},
      { seed: '0'.repeat(64), maxHands: 1, startingStack: 10 },
      { seed: 'f'.repeat(64), maxHands: 100, startingStack: 2000 },
    ]) {
      expect(checkState(startMatch(config(overrides)))).toEqual([]);
    }
  });

  it.each(SCENARIOS)('%s: every state has none', (_name, overrides, steps) => {
    for (const state of trace(overrides, steps).states) {
      expect(checkState(state)).toEqual([]);
    }
  });

  it('the scripted scenarios reach busts, last hands and blind all-ins', () => {
    const states = SCENARIOS.flatMap(
      ([, overrides, steps]) => trace(overrides, steps).states,
    );
    expect(states.some(s => s.over && s.stacks.includes(0))).toBe(true);
    expect(
      states.some(
        s =>
          s.over && s.handNumber === s.config.maxHands && !s.stacks.includes(0),
      ),
    ).toBe(true);
    expect(states.some(s => !s.over && s.stacks.includes(0))).toBe(true);
  });

  it.each(RANDOM_MATCHES)(
    'random legal match %o: every state has none',
    (overrides, botSeed) => {
      const { states } = randomMatch(overrides, botSeed);
      for (const state of states) expect(checkState(state)).toEqual([]);
    },
  );

  it('works on JSON round-tripped states', () => {
    for (const [, overrides, steps] of SCENARIOS) {
      for (const state of trace(overrides, steps).states) {
        expect(checkState(JSON.parse(JSON.stringify(state)))).toEqual([]);
      }
    }
  });

  it('does not change its input', () => {
    for (const [, overrides, steps] of SCENARIOS) {
      for (const state of trace(overrides, steps).states) {
        const copy = structuredClone(state);
        deepFreeze(state);
        checkState(state);
        expect(state).toEqual(copy);
      }
    }
    const broken = structuredClone(startMatch(config()));
    broken.stacks[0] += 5;
    const copy = structuredClone(broken);
    deepFreeze(broken);
    checkState(broken);
    expect(broken).toEqual(copy);
  });
});

describe('checkState reports broken states', () => {
  // Seed ...001a, 40 chips: preflop raise 6 / call; flop seat 1 bets 2.
  // bets [0, 2], contributed [6, 8], stacks [34, 32], seat 0 to act.
  const flopBet = () =>
    stateAfter(
      {
        seed: '000000000000000000000000000000000000000000000000000000000000001a',
      },
      [
        [0, raise(6)],
        [1, CALL],
        [1, raise(2)],
      ],
    );
  // Fresh flop after limp/check: seat 1 (non-button) to act, no flop events.
  const freshFlop = () =>
    stateAfter({}, [
      [0, CALL],
      [1, CHECK],
    ]);
  // Hand 2 preflop (seat 1 button) at its start.
  const hand2 = () => stateAfter({}, [[0, FOLD]]);
  // Over after 2 of 2 hands, stacks [40, 40].
  const overByHands = () =>
    stateAfter({ maxHands: 2 }, [
      [0, FOLD],
      [1, FOLD],
    ]);
  // Over by a bust, stacks [0, 80].
  const overByBust = () =>
    stateAfter({}, [
      [0, raise(40)],
      [1, CALL],
    ]);

  it('the base states themselves are fine', () => {
    for (const make of [flopBet, freshFlop, hand2, overByHands, overByBust]) {
      expect(checkState(make())).toEqual([]);
    }
    expect(flopBet()).toMatchObject({
      street: 'flop',
      bets: [0, 2],
      contributed: [6, 8],
      stacks: [34, 32],
      toAct: 0,
    });
    expect(freshFlop()).toMatchObject({ street: 'flop', toAct: 1 });
    expect(overByHands()).toMatchObject({ over: true, stacks: [40, 40] });
    expect(overByBust()).toMatchObject({ over: true, stacks: [0, 80] });
  });

  const cases: [string, () => MatchState, (s: MatchState) => void][] = [
    // 1. chip total
    [
      'a chip appears from nowhere',
      flopBet,
      s => {
        s.stacks[0] += 1;
      },
    ],
    [
      'a chip disappears',
      flopBet,
      s => {
        s.contributed[1] -= 1;
      },
    ],
    [
      'chip total off when over',
      overByHands,
      s => {
        s.stacks[1] += 2;
      },
    ],
    // 2. negative, non-integer, bet above contributed
    [
      'a negative stack (total kept)',
      flopBet,
      s => {
        s.stacks = [-1, s.stacks[0] + s.stacks[1] + 1];
      },
    ],
    [
      'a non-integer stack (total kept)',
      flopBet,
      s => {
        s.stacks[0] -= 0.5;
        s.stacks[1] += 0.5;
      },
    ],
    [
      'a negative contributed (total kept)',
      freshFlop,
      s => {
        s.contributed[0] = -1;
        s.stacks[0] += 3;
      },
    ],
    [
      'a non-integer contributed (total kept)',
      flopBet,
      s => {
        s.contributed[0] += 0.5;
        s.stacks[0] -= 0.5;
      },
    ],
    [
      'a negative bet',
      flopBet,
      s => {
        s.bets[0] = -1;
      },
    ],
    [
      'a non-integer bet',
      flopBet,
      s => {
        s.bets[1] = 1.5;
      },
    ],
    [
      'a bet above what was contributed',
      flopBet,
      s => {
        s.bets[1] = s.contributed[1] + 1;
      },
    ],
    // 3. over vs toAct
    [
      'over while someone is to act',
      flopBet,
      s => {
        s.over = true;
      },
    ],
    [
      'nobody to act mid-hand',
      flopBet,
      s => {
        s.toAct = null;
      },
    ],
    [
      'someone to act after the match',
      overByHands,
      s => {
        s.toAct = 0;
      },
    ],
    [
      'not over, but nobody to act, after the match ended',
      overByHands,
      s => {
        s.over = false;
      },
    ],
    // 4. the seat to act and the legal list
    [
      'the seat to act has no chips',
      flopBet,
      s => {
        s.stacks = [0, s.stacks[0] + s.stacks[1]];
      },
    ],
    [
      'raise min not above the highest bet (minRaise 0)',
      flopBet,
      s => {
        s.minRaise = 0;
      },
    ],
    [
      'raise min not above the highest bet (minRaise negative)',
      freshFlop,
      s => {
        s.minRaise = -2;
      },
    ],
    // 5. board, street, cards
    ['board too short for the flop', flopBet, s => void s.board.pop()],
    [
      'board too long for the flop',
      flopBet,
      s => {
        s.board = dealHand(
          '000000000000000000000000000000000000000000000000000000000000001a',
          1,
        ).board.slice(0, 4);
      },
    ],
    [
      'street says turn with a 3-card flop',
      flopBet,
      s => {
        s.street = 'turn';
      },
    ],
    [
      'a board card not from this hand',
      flopBet,
      s => {
        s.board[0] = dealHand(
          '000000000000000000000000000000000000000000000000000000000000001a',
          1,
        ).board[4];
      },
    ],
    [
      'board from another hand',
      freshFlop,
      s => {
        s.board = dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          2,
        ).board.slice(0, 3);
      },
    ],
    [
      'hole cards swapped between seats',
      flopBet,
      s => {
        s.holeCards = [s.holeCards[1], s.holeCards[0]];
      },
    ],
    [
      'hole cards from another hand',
      hand2,
      s => {
        s.holeCards = dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          1,
        ).holeCards;
      },
    ],
    [
      'hole cards from another seed',
      freshFlop,
      s => {
        s.holeCards = dealHand(
          '0000000000000000000000000000000000000000000000000000000000000002',
          1,
        ).holeCards;
      },
    ],
    // 6. button and hand number
    [
      'button on the wrong seat (hand 1)',
      flopBet,
      s => {
        s.button = 1;
      },
    ],
    [
      'button on the wrong seat (hand 2)',
      hand2,
      s => {
        s.button = 0;
      },
    ],
    [
      'hand number 0',
      flopBet,
      s => {
        s.handNumber = 0;
      },
    ],
    [
      'hand number above config.maxHands',
      hand2,
      s => {
        s.config.maxHands = 1;
      },
    ],
    // 7. history order and who acts next
    ['history without blinds', flopBet, s => void s.history.splice(0, 2)],
    [
      'blinds in the wrong order',
      flopBet,
      s => {
        s.history.splice(0, 2, s.history[1], s.history[0]);
      },
    ],
    [
      'an extra post_blind',
      freshFlop,
      s => void s.history.push({ ...blind(1, 0), street: 'flop' }),
    ],
    ['only one blind', hand2, s => void s.history.splice(1, 1)],
    [
      'a street goes back',
      flopBet,
      s => {
        // raise 6 (preflop) recorded as flop, then the call as preflop.
        s.history[2].street = 'flop';
      },
    ],
    [
      'the same seat acts twice in a row on a street',
      flopBet,
      s => {
        s.history[3].seat = 0;
      },
    ],
    [
      'the big blind acts first preflop',
      flopBet,
      s => {
        s.history[2].seat = 1;
        s.history[3].seat = 0;
      },
    ],
    [
      'the button acts first on the flop',
      flopBet,
      s => {
        s.history[4].seat = 0;
      },
    ],
    [
      'the wrong seat to act mid-street',
      flopBet,
      s => {
        s.toAct = 1;
      },
    ],
    [
      'the button to act first on a fresh flop',
      freshFlop,
      s => {
        s.toAct = 0;
      },
    ],
    [
      'the big blind to act first preflop',
      hand2,
      s => {
        s.toAct = 0;
      },
    ],
    // 8. a finished match
    [
      'bets left on the table after the match',
      overByHands,
      s => {
        s.stacks = [39, 39];
        s.bets = [1, 1];
        s.contributed = [1, 1];
      },
    ],
    [
      'contributed left after the match',
      overByHands,
      s => {
        s.stacks = [39, 39];
        s.contributed = [1, 1];
      },
    ],
    [
      'no last hand after the match',
      overByBust,
      s => {
        s.lastHand = null;
      },
    ],
    [
      'over early: both have chips and hands remain',
      overByHands,
      s => {
        s.config.maxHands = 3;
      },
    ],
  ];

  it.each(cases)('%s', (_name, make, corrupt) => {
    const state = structuredClone(make());
    corrupt(state);
    expectViolations(checkState(state));
  });
});

describe('checkHand on legal play', () => {
  it.each(SCENARIOS)(
    '%s: every hand record has none',
    (_name, overrides, steps) => {
      const { hands } = trace(overrides, steps);
      expect(hands.length).toBeGreaterThan(0);
      for (const hand of hands) {
        expect(checkHand(hand, config(overrides))).toEqual([]);
      }
    },
  );

  it.each(RANDOM_MATCHES)(
    'random legal match %o: every hand record has none',
    (overrides, botSeed) => {
      const { hands } = randomMatch(overrides, botSeed);
      for (const hand of hands) {
        expect(checkHand(hand, config(overrides))).toEqual([]);
      }
    },
  );

  it('the records cover fold, showdown, split, runout and timeouts', () => {
    const hands = SCENARIOS.flatMap(
      ([, overrides, steps]) => trace(overrides, steps).hands,
    );
    expect(hands.some(h => h.ended_by === 'fold')).toBe(true);
    expect(hands.some(h => h.ended_by === 'showdown')).toBe(true);
    expect(hands.some(h => h.winner_seat === null)).toBe(true);
    expect(hands.some(h => h.events.length === 2)).toBe(true);
    expect(hands.some(h => h.events.some(e => e.timeout))).toBe(true);
    expect(hands.some(h => h.button_seat === 1)).toBe(true);
  });

  it('does not change its input', () => {
    const { hands } = trace({}, CHECK_DOWN_HAND_1);
    const copy = structuredClone(hands[0]);
    deepFreeze(hands[0]);
    checkHand(hands[0], config());
    expect(hands[0]).toEqual(copy);
  });
});

describe('checkHand reports broken records', () => {
  // Seed ...0005 hand 1 checked down: seat 1 wins, pot 4, stacks [38, 42].
  // events: blinds, call, check, then check/check on flop, turn, river.
  const showdown = () => trace({}, CHECK_DOWN_HAND_1).hands[0];
  // Seed ...0005 hand 1: limp, check, seat 1 bets 6 on the flop, seat 0 folds.
  const flopFold = () =>
    trace({}, [
      [0, CALL],
      [1, CHECK],
      [1, raise(6)],
      [0, FOLD],
    ]).hands[0];
  // Seed ...0016 hand 1: split pot.
  const split = () =>
    trace(
      {
        seed: '0000000000000000000000000000000000000000000000000000000000000016',
      },
      [[0, raise(6)], [1, CALL], ...checkPostflop(1)],
    ).hands[0];
  // Seed ...0005, 10 chips, hand 3: blinds only, board runs out.
  const runout = () =>
    trace({ startingStack: 10 }, BLIND_ALL_IN_SCRIPT).hands.find(
      h => h.hand_number === 3,
    ) as HandRecord;
  // Hand 2 of 2 (seat 1 button): seat 1 folds its small blind.
  const hand2Fold = () =>
    trace({ maxHands: 2 }, [
      [0, FOLD],
      [1, FOLD],
    ]).hands[1];

  const tenChips = config({ startingStack: 10 });
  const twoHands = config({ maxHands: 2 });

  it('the base records themselves are fine', () => {
    expect(checkHand(showdown(), config())).toEqual([]);
    expect(checkHand(flopFold(), config())).toEqual([]);
    expect(
      checkHand(
        split(),
        config({
          seed: '0000000000000000000000000000000000000000000000000000000000000016',
        }),
      ),
    ).toEqual([]);
    expect(checkHand(runout(), tenChips)).toEqual([]);
    expect(checkHand(hand2Fold(), twoHands)).toEqual([]);
    expect(showdown()).toMatchObject({ winner_seat: 1, ended_by: 'showdown' });
    expect(flopFold()).toMatchObject({ winner_seat: 1, ended_by: 'fold' });
    expect(split().winner_seat).toBeNull();
    expect(runout().events).toHaveLength(2);
    expect(hand2Fold()).toMatchObject({ button_seat: 1, winner_seat: 0 });
  });

  const cases: [
    string,
    () => HandRecord,
    MatchConfig,
    (h: HandRecord) => void,
  ][] = [
    // 1. stacks
    [
      'stacks do not sum',
      showdown,
      config(),
      h => {
        h.stacks[0] += 1;
      },
    ],
    [
      'a negative stack',
      showdown,
      config(),
      h => {
        h.stacks = [-1, 81];
      },
    ],
    [
      'a non-integer stack',
      showdown,
      config(),
      h => {
        h.stacks = [37.5, 42.5];
      },
    ],
    [
      'stacks from another starting stack',
      runout,
      config({ startingStack: 40 }),
      () => {},
    ],
    // 2. button and hand number
    [
      'button flipped (hand 1)',
      showdown,
      config(),
      h => {
        h.button_seat = 1;
      },
    ],
    [
      'button flipped (hand 2)',
      hand2Fold,
      twoHands,
      h => {
        h.button_seat = 0;
      },
    ],
    [
      'hand number 0',
      showdown,
      config(),
      h => {
        h.hand_number = 0;
      },
    ],
    [
      'hand number above config.maxHands',
      hand2Fold,
      config({ maxHands: 1 }),
      () => {},
    ],
    // 3. event order
    ['no blinds', showdown, config(), h => void h.events.splice(0, 2)],
    [
      'blinds in the wrong order',
      showdown,
      config(),
      h => void h.events.splice(0, 2, h.events[1], h.events[0]),
    ],
    [
      'an extra post_blind',
      showdown,
      config(),
      h => void h.events.splice(4, 0, { ...blind(1, 2), street: 'flop' }),
    ],
    [
      'a street goes back',
      showdown,
      config(),
      h => {
        // flop check (1), turn check (1), flop check (0), ...
        h.events.splice(5, 2, h.events[6], h.events[5]);
      },
    ],
    [
      'the same seat acts twice in a row',
      showdown,
      config(),
      h => {
        h.events[5].seat = 1;
      },
    ],
    [
      'the button acts first on the flop',
      showdown,
      config(),
      h => {
        h.events[4].seat = 0;
        h.events[5].seat = 1;
      },
    ],
    [
      'the big blind acts first preflop',
      showdown,
      config(),
      h => {
        h.events[2].seat = 1;
        h.events[3].seat = 0;
      },
    ],
    [
      'the button acts first on the river',
      showdown,
      config(),
      h => {
        h.events[8].seat = 0;
        h.events[9].seat = 1;
      },
    ],
    // 4. how it ended
    [
      'fold, but the last event is not a fold',
      showdown,
      config(),
      h => {
        h.ended_by = 'fold';
        h.hole_cards = null;
      },
    ],
    [
      'fold, but the last event was removed',
      flopFold,
      config(),
      h => void h.events.pop(),
    ],
    [
      'fold won by the folder',
      flopFold,
      config(),
      h => {
        h.winner_seat = 0;
      },
    ],
    [
      'fold with no winner',
      flopFold,
      config(),
      h => {
        h.winner_seat = null;
      },
    ],
    [
      'fold showing hole cards',
      flopFold,
      config(),
      h => {
        h.hole_cards = dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          1,
        ).holeCards;
      },
    ],
    [
      'showdown with a fold event',
      showdown,
      config(),
      h => {
        h.events[9] = { seat: 0, street: 'river', type: 'fold' };
      },
    ],
    [
      'showdown without hole cards',
      showdown,
      config(),
      h => {
        h.hole_cards = null;
      },
    ],
    [
      'showdown with a 4-card board',
      showdown,
      config(),
      h => void h.board.pop(),
    ],
    [
      'runout showdown with only the flop',
      runout,
      tenChips,
      h => {
        h.board = h.board.slice(0, 3);
      },
    ],
    // 5. cards from the seed
    [
      'hole cards swapped',
      showdown,
      config(),
      h => {
        const cards = dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          1,
        ).holeCards;
        h.hole_cards = [cards[1], cards[0]];
      },
    ],
    [
      'a showdown board card not from this hand',
      showdown,
      config(),
      // Kc is not among the 9 cards dealt in seed ...0005 hand 1.
      h => {
        h.board[4] = 'Kc';
      },
    ],
    [
      'a fold board not a prefix of the deal',
      flopFold,
      config(),
      h => {
        h.board = dealHand(
          '0000000000000000000000000000000000000000000000000000000000000005',
          1,
        ).board.slice(1, 4);
      },
    ],
    [
      'the record checked against another seed',
      showdown,
      config({
        seed: '0000000000000000000000000000000000000000000000000000000000000002',
      }),
      () => {},
    ],
    // 6. showdown winner
    [
      'the loser wins',
      showdown,
      config(),
      h => {
        h.winner_seat = 0;
      },
    ],
    [
      'a tie when one hand is better',
      showdown,
      config(),
      h => {
        h.winner_seat = null;
      },
    ],
    [
      'a winner on a tie',
      split,
      config({
        seed: '0000000000000000000000000000000000000000000000000000000000000016',
      }),
      h => {
        h.winner_seat = 0;
      },
    ],
    // 7. pot
    [
      'pot 0',
      showdown,
      config(),
      h => {
        h.pot = 0;
      },
    ],
    [
      'pot negative',
      showdown,
      config(),
      h => {
        h.pot = -4;
      },
    ],
    [
      'pot not an integer',
      showdown,
      config(),
      h => {
        h.pot = 4.5;
      },
    ],
  ];

  it.each(cases)('%s', (_name, make, matchConfig, corrupt) => {
    const hand = structuredClone(make());
    corrupt(hand);
    expectViolations(checkHand(hand, matchConfig));
  });
});

describe('checkHand: pot matches the events', () => {
  // Pot = chips put in per the events, minus the uncalled excess returned.
  const showdown = () => trace({}, CHECK_DOWN_HAND_1).hands[0]; // pot 4
  // Flop: seat 1 bets 6, seat 0 folds: 6 returned, pot 4 (not 10).
  const flopFold = () =>
    trace({}, [
      [0, CALL],
      [1, CHECK],
      [1, raise(6)],
      [0, FOLD],
    ]).hands[0];
  // Preflop shove to 40, big blind folds: 38 returned, pot 4 (not 42).
  const shoveFold = () =>
    trace({}, [
      [0, raise(40)],
      [1, FOLD],
    ]).hands[0];
  // Hand 2: seat 1 shoves 42, seat 0 calls all-in for 36 more: 4 returned,
  // pot 76 (not 80).
  const shortCall = () =>
    trace({}, [...CHECK_DOWN_HAND_1, [1, raise(42)], [0, CALL]]).hands[1];
  // Hand 3 at 10 chips: small blind all-in with 1, big blind posts 2:
  // 1 returned, pot 2 (not 3).
  const blindRunout = () =>
    trace({ startingStack: 10 }, BLIND_ALL_IN_SCRIPT).hands.find(
      h => h.hand_number === 3,
    ) as HandRecord;
  // Raises on two streets, then a split (seed ...001a): pot 28.
  const multiStreet = () =>
    trace(
      {
        seed: '000000000000000000000000000000000000000000000000000000000000001a',
      },
      SCENARIOS[1][2],
    ).hands[0];

  const bases: [string, () => HandRecord, MatchConfig, number, number][] = [
    ['check-down', showdown, config(), 4, 4],
    ['fold to a flop bet', flopFold, config(), 4, 10],
    ['fold to a preflop shove', shoveFold, config(), 4, 42],
    ['short all-in call', shortCall, config(), 76, 80],
    [
      'small blind all-in by posting',
      blindRunout,
      config({ startingStack: 10 }),
      2,
      3,
    ],
    [
      'raises on two streets',
      multiStreet,
      config({
        seed: '000000000000000000000000000000000000000000000000000000000000001a',
      }),
      28,
      28,
    ],
  ];

  it.each(bases)(
    '%s: the real pot gives no violation',
    (_name, make, matchConfig, pot) => {
      const hand = make();
      expect(hand.pot).toBe(pot);
      expect(checkHand(hand, matchConfig)).toEqual([]);
    },
  );

  it.each(bases)('%s: pot + 1 is reported', (_name, make, matchConfig) => {
    const hand = structuredClone(make());
    hand.pot += 1;
    expectViolations(checkHand(hand, matchConfig));
  });

  it.each(bases)(
    '%s: pot - 1 (still positive) is reported',
    (_name, make, matchConfig) => {
      const hand = structuredClone(make());
      hand.pot -= 1;
      expect(hand.pot).toBeGreaterThan(0);
      expectViolations(checkHand(hand, matchConfig));
    },
  );

  it.each(bases.filter(([, , , pot, total]) => total !== pot))(
    '%s: pot counting the returned excess is reported',
    (_name, make, matchConfig, _pot, total) => {
      const hand = structuredClone(make());
      hand.pot = total;
      expectViolations(checkHand(hand, matchConfig));
    },
  );
});

describe('order rules on their own', () => {
  // Each corruption breaks exactly one rule: chips, cards, turn order and
  // who acts next stay right, so only that rule's check can report it.
  const preflopBlindsSwapped = (events: HistoryEvent[]) => {
    events.splice(0, 2, events[1], events[0]);
  };
  // A post_blind for 0 chips among the preflop actions.
  const extraZeroBlind = (events: HistoryEvent[]) => {
    const seat = events[3].seat;
    events.splice(3, 0, {
      seat,
      street: 'preflop',
      type: 'post_blind',
      amount: 0,
    });
  };
  // Flop events relabelled turn and turn events flop: turn comes before the
  // flop, but each street still starts with the non-button and alternates.
  const turnBeforeFlop = (events: HistoryEvent[]) => {
    for (const event of events) {
      if (event.street === 'flop') event.street = 'turn';
      else if (event.street === 'turn') event.street = 'flop';
    }
    expect(events.map(e => e.street)).toContain('turn');
  };

  // Seed ...0005, checked down to the river: seat 1 (non-button) to act.
  const river = () => stateAfter({}, CHECK_DOWN_HAND_1.slice(0, -2));
  const showdown = () => trace({}, CHECK_DOWN_HAND_1).hands[0];

  it('the base state and record are fine', () => {
    expect(river()).toMatchObject({ street: 'river', toAct: 1 });
    expect(checkState(river())).toEqual([]);
    expect(checkHand(showdown(), config())).toEqual([]);
  });

  it.each([
    ['blinds swapped (big blind posted first)', preflopBlindsSwapped],
    ['an extra post_blind for 0 chips', extraZeroBlind],
    ['turn before flop, seats still alternating', turnBeforeFlop],
  ])('checkState: %s', (_name, corrupt) => {
    const state = structuredClone(river());
    corrupt(state.history);
    expectViolations(checkState(state));
  });

  it.each([
    ['blinds swapped (big blind posted first)', preflopBlindsSwapped],
    ['an extra post_blind for 0 chips', extraZeroBlind],
    ['turn before flop, seats still alternating', turnBeforeFlop],
  ])('checkHand: %s', (_name, corrupt) => {
    const hand = structuredClone(showdown());
    corrupt(hand.events);
    expectViolations(checkHand(hand, config()));
  });
});

describe('bad numbers are reported, not thrown', () => {
  const flop = () =>
    stateAfter({}, [
      [0, CALL],
      [1, CHECK],
    ]);
  const showdown = () => trace({}, CHECK_DOWN_HAND_1).hands[0];

  it.each<[string, (s: MatchState) => void]>([
    [
      'handNumber 0',
      s => {
        s.handNumber = 0;
      },
    ],
    [
      'handNumber -1',
      s => {
        s.handNumber = -1;
      },
    ],
    [
      'handNumber above config.maxHands',
      s => {
        s.handNumber = 11;
      },
    ],
    [
      'handNumber 1.5',
      s => {
        s.handNumber = 1.5;
      },
    ],
    [
      'uppercase seed',
      s => {
        s.config.seed = 'A'.repeat(64);
      },
    ],
    [
      '63-character seed',
      s => {
        s.config.seed = '0'.repeat(63);
      },
    ],
    [
      '65-character seed',
      s => {
        s.config.seed = '0'.repeat(65);
      },
    ],
    [
      'non-hex seed',
      s => {
        s.config.seed = 'g'.repeat(64);
      },
    ],
    [
      'empty seed',
      s => {
        s.config.seed = '';
      },
    ],
  ])('checkState: %s', (_name, corrupt) => {
    const state = structuredClone(flop());
    corrupt(state);
    let found: unknown;
    expect(() => {
      found = checkState(state);
    }).not.toThrow();
    expectViolations(found);
  });

  it.each<[string, (h: HandRecord) => void, MatchConfig]>([
    [
      'hand_number 0',
      h => {
        h.hand_number = 0;
      },
      config(),
    ],
    [
      'hand_number -1',
      h => {
        h.hand_number = -1;
      },
      config(),
    ],
    [
      'hand_number above config.maxHands',
      h => {
        h.hand_number = 11;
      },
      config(),
    ],
    [
      'hand_number 1.5',
      h => {
        h.hand_number = 1.5;
      },
      config(),
    ],
    ['uppercase seed', () => {}, config({ seed: 'A'.repeat(64) })],
    ['63-character seed', () => {}, config({ seed: '0'.repeat(63) })],
    ['65-character seed', () => {}, config({ seed: '0'.repeat(65) })],
    ['non-hex seed', () => {}, config({ seed: 'g'.repeat(64) })],
    ['empty seed', () => {}, config({ seed: '' })],
  ])('checkHand: %s', (_name, corrupt, matchConfig) => {
    const hand = structuredClone(showdown());
    corrupt(hand);
    let found: unknown;
    expect(() => {
      found = checkHand(hand, matchConfig);
    }).not.toThrow();
    expectViolations(found);
  });
});

describe('blind invariants', () => {
  it('accepts upgraded blinds and checks each posted amount against pre-hand stacks', () => {
    const matchConfig = config({
      blindEvery: 1,
      maxHands: 20,
      startingStack: 10,
    });
    const { states, hands } = trace(matchConfig, [
      [0, FOLD],
      [1, FOLD],
      [0, FOLD],
    ]);
    for (const state of states) expect(checkState(state)).toEqual([]);
    let before: [number, number] = [10, 10];
    expect(hands).toHaveLength(4);
    for (const hand of hands) {
      const original = structuredClone(before);
      expect(checkHand(hand, matchConfig, before)).toEqual([]);
      expect(before).toEqual(original);
      before = [...hand.stacks];
    }
    expect(hands[3].blinds).toEqual([8, 16]);
    expect(hands[3].events.slice(0, 2).map(event => event.amount)).toEqual([
      8, 7,
    ]);
  });

  it('reports a record with the wrong scheduled level even when postings are unchanged', () => {
    const hand = structuredClone(trace({}, CHECK_DOWN_HAND_1).hands[0]);
    hand.blinds = [2, 4];
    expect(checkHand(hand, config())).toContain(
      'Recorded blinds do not match the scheduled blinds',
    );
  });

  it.each([0, 1])('reports a wrong posted amount for blind index %i', index => {
    const hand = structuredClone(trace({}, CHECK_DOWN_HAND_1).hands[0]);
    hand.events[index].amount = (hand.events[index].amount ?? 0) + 1;
    const expected = index === 0 ? 1 : 2;
    expect(checkHand(hand, config(), [40, 40])).toContain(
      `Seat ${index} blind must be ${expected}`,
    );
    const state = structuredClone(startMatch(config()));
    state.history[index].amount = expected + 1;
    expect(checkState(state)).toContain(
      `Seat ${index} blind must be ${expected}`,
    );
  });

  it('checks capped small and big blinds in the existing short-stack fixtures', () => {
    const matchConfig = config({ startingStack: 10 });
    const { hands } = trace(matchConfig, BLIND_ALL_IN_SCRIPT);
    for (const handNumber of [3, 4]) {
      const index = hands.findIndex(hand => hand.hand_number === handNumber);
      expect(index).toBeGreaterThan(0);
      const hand = structuredClone(hands[index]);
      const before = hands[index - 1].stacks;
      expect(checkHand(hand, matchConfig, before)).toEqual([]);
      const blindIndex = handNumber === 3 ? 0 : 1;
      hand.events[blindIndex].amount =
        (hand.events[blindIndex].amount ?? 0) + 1;
      expect(
        checkHand(hand, matchConfig, before).some(message =>
          message.includes('blind must be'),
        ),
      ).toBe(true);
    }
  });
});
