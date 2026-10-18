import { describe, expect, it } from 'vitest';
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
import { type ReplayResult, replay } from './replay';
import { mulberry32 } from './shuffle';

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

/** The live match after each accepted action, with the events so far. */
interface Snapshot {
  state: MatchState;
  hands: HandRecord[];
  /** Finished hands' events, then the in-progress hand's history. */
  events: HistoryEvent[];
  /** Same, without the in-progress hand (cut before its blinds). */
  finishedEvents: HistoryEvent[];
}

function snapshot(state: MatchState, hands: HandRecord[]): Snapshot {
  const finishedEvents = hands.flatMap(hand => hand.events);
  return {
    state,
    hands: [...hands],
    events: state.over ? finishedEvents : [...finishedEvents, ...state.history],
    finishedEvents,
  };
}

function trace(matchConfig: MatchConfig, steps: Step[]): Snapshot[] {
  let state = startMatch(matchConfig);
  const hands: HandRecord[] = [];
  const snapshots = [snapshot(state, hands)];
  for (const [seat, action, options] of steps) {
    const result = applyAction(state, seat, action, options);
    if (!result.ok) {
      throw new Error(
        `seat ${seat} ${JSON.stringify(action)} rejected: ${result.message}`,
      );
    }
    hands.push(...result.finishedHands);
    state = result.state;
    snapshots.push(snapshot(state, hands));
  }
  return snapshots;
}

/** Random legal play, independent of bot.ts. */
function pick(legal: LegalAction[], random: () => number): Action {
  const option = legal[Math.floor(random() * legal.length)];
  if (option.type === 'raise') {
    const span = option.max - option.min + 1;
    return raise(option.min + Math.floor(random() * span));
  }
  return { type: option.type };
}

function randomTrace(matchConfig: MatchConfig, botSeed: number): Snapshot[] {
  const random = mulberry32(botSeed);
  let state = startMatch(matchConfig);
  const steps: Step[] = [];
  while (!state.over) {
    const seat = state.toAct as Seat;
    const step: Step = [
      seat,
      pick(legalActions(state), random),
      { timeout: random() < 0.2 },
    ];
    const result = applyAction(state, ...step);
    if (!result.ok) throw new Error(result.message);
    state = result.state;
    steps.push(step);
  }
  return trace(matchConfig, steps);
}

function expectReplayed(result: ReplayResult, expected: Snapshot): void {
  if (!result.ok) {
    throw new Error(
      `replay rejected event ${result.index}: ${result.code}: ${result.message}`,
    );
  }
  expect(result.state).toEqual(expected.state);
  expect(result.hands).toEqual(expected.hands);
}

function expectRejected(
  result: ReplayResult,
): Extract<ReplayResult, { ok: false }> {
  if (result.ok) throw new Error('expected the replay to be rejected');
  expect(typeof result.message).toBe('string');
  expect(result.message.length).toBeGreaterThan(0);
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

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

const SCRIPTS: [string, MatchConfig, Step[]][] = [
  [
    'check-down, then a short all-in and a bust (seed ...0005)',
    config(),
    [...CHECK_DOWN_HAND_1, [1, raise(42)], [0, CALL], [0, raise(4)], [1, CALL]],
  ],
  [
    'blind all-ins by posting (seed ...0005, 10 chips)',
    config({ startingStack: 10 }),
    [
      [0, raise(4)],
      [1, raise(8)],
      [0, FOLD],
      [1, raise(5)],
      [0, CALL],
      [0, CHECK],
      [1, raise(2)],
      [0, FOLD],
      [1, CALL],
    ],
  ],
  [
    'big blind shorter than the blind (seed ...0005, 10 chips)',
    config({ startingStack: 10, maxHands: 3 }),
    [
      [0, raise(9)],
      [1, raise(10)],
      [0, FOLD],
      [0, CALL],
    ],
  ],
  [
    'short all-in raise does not reopen (10 chips)',
    config({ startingStack: 10 }),
    [
      [0, raise(4)],
      [1, raise(8)],
      [0, raise(10)],
      [1, CALL],
    ],
  ],
  [
    'split pot on the last hand (seed ...0016, hands 1)',
    config({
      seed: '0000000000000000000000000000000000000000000000000000000000000016',
      maxHands: 1,
    }),
    [[0, raise(6)], [1, CALL], ...checkPostflop(1)],
  ],
  [
    'raises on every street, split pot, then folds to the end (seed ...001a)',
    config({
      seed: '000000000000000000000000000000000000000000000000000000000000001a',
      maxHands: 3,
    }),
    [
      [0, raise(6)],
      [1, CALL],
      [1, raise(2)],
      [0, raise(8)],
      [1, CALL],
      ...checkPostflop(1).slice(2),
      [1, FOLD],
      [0, FOLD],
    ],
  ],
  [
    'timeouts (seed ...0005, hands 2)',
    config({ maxHands: 2 }),
    [
      [0, CALL, { timeout: true }],
      [1, CHECK, { timeout: true }],
      [1, FOLD, { timeout: true }],
      [1, FOLD, { timeout: true }],
    ],
  ],
];

describe('replay', () => {
  it('no events, or only the first blinds, gives the start of the match', () => {
    for (const matchConfig of [
      config(),
      config({ seed: '0'.repeat(64), maxHands: 1, startingStack: 10 }),
      config({ seed: 'f'.repeat(64), maxHands: 200, startingStack: 2000 }),
    ]) {
      const start = startMatch(matchConfig);
      expectReplayed(replay(matchConfig, []), {
        state: start,
        hands: [],
        events: [],
        finishedEvents: [],
      });
      expectReplayed(replay(matchConfig, start.history), {
        state: start,
        hands: [],
        events: [],
        finishedEvents: [],
      });
    }
  });

  it.each(SCRIPTS)(
    '%s: the full match gives the same final state and records',
    (_name, matchConfig, steps) => {
      const snapshots = trace(matchConfig, steps);
      const end = snapshots[snapshots.length - 1];
      expect(end.state.over).toBe(true);
      expectReplayed(replay(matchConfig, end.events), end);
    },
  );

  it.each(SCRIPTS)(
    '%s: every prefix gives the live state at that point',
    (_name, matchConfig, steps) => {
      for (const point of trace(matchConfig, steps)) {
        expectReplayed(replay(matchConfig, point.events), point);
        // Cut before a fresh hand's blinds: the engine posts them itself.
        if (!point.state.over && point.state.history.length === 2) {
          expectReplayed(replay(matchConfig, point.finishedEvents), point);
        }
      }
    },
  );

  it.each<[MatchConfig, number]>([
    [config({ seed: '0'.repeat(64), maxHands: 50, startingStack: 10 }), 1],
    [config({ seed: 'f'.repeat(64), maxHands: 40, startingStack: 12 }), 2],
    [
      config({
        seed: '0000000000000000000000000000000000000000000000000000000000000309',
        maxHands: 30,
        startingStack: 40,
      }),
      3,
    ],
    [
      config({
        seed: '0000000000000000000000000000000000000000000000000000000000007a69',
        maxHands: 20,
        startingStack: 2000,
      }),
      4,
    ],
  ])(
    'random legal match %o replays exactly, prefixes too',
    (matchConfig, botSeed) => {
      const snapshots = randomTrace(matchConfig, botSeed);
      for (const point of snapshots) {
        expectReplayed(replay(matchConfig, point.events), point);
      }
    },
  );

  it('keeps timeout flags in the replayed records', () => {
    const matchConfig = config({ maxHands: 2 });
    const end = trace(matchConfig, SCRIPTS[6][2]).at(-1) as Snapshot;
    const result = replay(matchConfig, end.events);
    if (!result.ok) throw new Error(result.message);
    const timeouts = result.hands.flatMap((hand: HandRecord) =>
      hand.events.filter((event: HistoryEvent) => event.timeout === true),
    );
    expect(timeouts).toHaveLength(4);
    expect(result.state.history.at(-1)).toEqual({
      seat: 1,
      street: 'preflop',
      type: 'fold',
      timeout: true,
    });
  });

  it('keeps timeout flags in the in-progress history', () => {
    const matchConfig = config();
    const point = trace(matchConfig, [
      [0, CALL],
      [1, CHECK, { timeout: true }],
    ]).at(-1) as Snapshot;
    const result = replay(matchConfig, point.events);
    expectReplayed(result, point);
    if (!result.ok) return;
    expect(result.state.history[3]).toEqual({
      seat: 1,
      street: 'preflop',
      type: 'check',
      timeout: true,
    });
  });

  it('ignores the amount on a call event', () => {
    const matchConfig = config();
    const point = trace(matchConfig, [
      [0, raise(6)],
      [1, CALL],
    ]).at(-1) as Snapshot;
    const events = structuredClone(point.events);
    expect(events[3]).toEqual({
      seat: 1,
      street: 'preflop',
      type: 'call',
      amount: 4,
    });
    expectReplayed(replay(matchConfig, events), point);
    events[3].amount = 999;
    expectReplayed(replay(matchConfig, events), point);
    delete events[3].amount;
    expectReplayed(replay(matchConfig, events), point);
  });

  it('works on JSON round-tripped events', () => {
    const [, matchConfig, steps] = SCRIPTS[0];
    const end = trace(matchConfig, steps).at(-1) as Snapshot;
    const events = JSON.parse(JSON.stringify(end.events)) as HistoryEvent[];
    expectReplayed(replay(matchConfig, events), end);
  });

  it('does not change the events', () => {
    const [, matchConfig, steps] = SCRIPTS[1];
    const end = trace(matchConfig, steps).at(-1) as Snapshot;
    const events = structuredClone(end.events);
    const copy = structuredClone(events);
    deepFreeze(events);
    expectReplayed(replay(matchConfig, events), end);
    expect(events).toEqual(copy);
  });
});

describe('replay rejects', () => {
  const blinds = startMatch(config()).history;

  it('an event after the match is over: match_over at its index', () => {
    const matchConfig = config({ maxHands: 1 });
    const end = trace(matchConfig, [[0, FOLD]]).at(-1) as Snapshot;
    const events: HistoryEvent[] = [
      ...end.events,
      { seat: 1, street: 'preflop', type: 'check' },
    ];
    const result = expectRejected(replay(matchConfig, events));
    expect(result.code).toBe('match_over');
    expect(result.index).toBe(end.events.length);
    expect(result.index).toBe(3);
  });

  it('the wrong seat: not_your_turn, index counts the blinds', () => {
    const result = expectRejected(
      replay(config(), [
        ...blinds,
        { seat: 1, street: 'preflop', type: 'call', amount: 1 },
      ]),
    );
    expect(result.code).toBe('not_your_turn');
    expect(result.index).toBe(2);
  });

  it('an illegal raise amount: invalid_action', () => {
    for (const amount of [3, 41, 4.5]) {
      const result = expectRejected(
        replay(config(), [
          ...blinds,
          { seat: 0, street: 'preflop', type: 'raise', amount },
        ]),
      );
      expect(result.code).toBe('invalid_action');
      expect(result.index).toBe(2);
    }
  });

  it('check when facing a bet: invalid_action', () => {
    const result = expectRejected(
      replay(config(), [
        ...blinds,
        { seat: 0, street: 'preflop', type: 'check' },
      ]),
    );
    expect(result.code).toBe('invalid_action');
    expect(result.index).toBe(2);
  });

  it('reports the first bad event deep in a match', () => {
    const matchConfig = config();
    const point = trace(matchConfig, [...CHECK_DOWN_HAND_1, [1, CALL]]).at(
      -1,
    ) as Snapshot;
    // Hand 2: seat 1 (button) limped, seat 0 (big blind) to act.
    expect(point.state.toAct).toBe(0);
    const events: HistoryEvent[] = [
      ...point.events,
      { seat: 1, street: 'preflop', type: 'check' },
      { seat: 0, street: 'preflop', type: 'raise', amount: 1 },
    ];
    const result = expectRejected(replay(matchConfig, events));
    expect(result.code).toBe('not_your_turn');
    expect(result.index).toBe(point.events.length);
    expect(result.index).toBe(13);
  });

  it('a bad event after earlier hands keeps its index in the input', () => {
    const matchConfig = config();
    const point = trace(matchConfig, [[0, FOLD]]).at(-1) as Snapshot;
    // Hand 2 blinds are in the events; the button (seat 1) raises too small.
    const events: HistoryEvent[] = [
      ...point.events,
      { seat: 1, street: 'preflop', type: 'raise', amount: 3 },
    ];
    expect(events).toHaveLength(6);
    const result = expectRejected(replay(matchConfig, events));
    expect(result.code).toBe('invalid_action');
    expect(result.index).toBe(5);
  });

  it.each([
    ['maxHands 0', { maxHands: 0 }],
    ['maxHands 201', { maxHands: 201 }],
    ['startingStack 5', { startingStack: 5 }],
    ['startingStack 2001', { startingStack: 2001 }],
    ['uppercase seed', { seed: 'A'.repeat(64) }],
    ['63-character seed', { seed: '0'.repeat(63) }],
    ['non-hex seed', { seed: 'g'.repeat(64) }],
    ['empty seed', { seed: '' }],
    ['65-character seed', { seed: '0'.repeat(65) }],
  ])('a bad config (%s) throws RangeError', (_name, overrides) => {
    expect(() => replay(config(overrides), [])).toThrow(RangeError);
  });
});
