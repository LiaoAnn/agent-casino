import { describe, expect, it } from 'vitest';
import { dealTable, shuffledDeck } from './shuffle';
import {
  type Action,
  applyTableAction,
  leaveTable,
  replayTable,
  startTable,
  type TableApplyResult,
  type TableConfig,
  type TableEvent,
  type TableHandRecord,
  type TableState,
  tableLegalActions,
} from './table';

const SEED = '0'.repeat(64);
const SIDE_SEED = '2'.padStart(64, '0');
const ODD_SEED = (826).toString(16).padStart(64, '0');
const config = (changes: Partial<TableConfig> = {}): TableConfig => ({
  seed: SEED,
  players: 6,
  startingStack: 40,
  blindEvery: 50,
  maxHands: 10,
  ...changes,
});

type Step = [number, Action];
function accepted(result: TableApplyResult) {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}
function play(state: TableState, steps: Step[]) {
  const hands: TableHandRecord[] = [];
  for (const [seat, action] of steps) {
    const result = accepted(applyTableAction(state, seat, action));
    state = result.state;
    hands.push(...result.finishedHands);
  }
  return { state, hands };
}
const call = (seat: number): Step => [seat, { type: 'call' }];
const fold = (seat: number): Step => [seat, { type: 'fold' }];
const check = (seat: number): Step => [seat, { type: 'check' }];
const raise = (seat: number, amount: number): Step => [
  seat,
  { type: 'raise', amount },
];

// A legal first hand, won by seat 4 by folds. Contributions are
// [0,22,18,0,26,26], so hand 2 starts with [40,18,22,40,106,14].
// No showdown oracle or edited state is needed to arrange these stacks.
const SETUP: Step[] = [
  fold(3),
  call(4),
  call(5),
  fold(0),
  call(1),
  check(2),
  raise(1, 16),
  call(2),
  call(4),
  call(5),
  raise(1, 4),
  fold(2),
  call(4),
  call(5),
  check(1),
  raise(4, 2),
  raise(5, 4),
  fold(1),
  raise(4, 6),
  fold(5),
];
function uneven(changes: Partial<TableConfig> = {}) {
  const result = play(startTable(config(changes)), SETUP);
  expect(result.hands).toHaveLength(1);
  expect(result.hands[0].stacks).toEqual([40, 18, 22, 40, 106, 14]);
  expect(result.state.handNumber).toBe(2);
  expect(result.state.toAct).toBe(4);
  return result;
}
function passiveToHandEnd(state: TableState) {
  const number = state.handNumber;
  const hands: TableHandRecord[] = [];
  for (let i = 0; i < 100 && !state.over && state.handNumber === number; i++) {
    const action = tableLegalActions(state).find(
      a => a.type === 'check' || a.type === 'call',
    );
    if (!action || state.toAct === null)
      throw new Error('missing passive action');
    const result = accepted(
      applyTableAction(state, state.toAct, { type: action.type }),
    );
    state = result.state;
    hands.push(...result.finishedHands);
  }
  expect(hands.length).toBeGreaterThan(0);
  return { state, hands };
}

describe('table positions and betting rounds', () => {
  for (const players of [3, 4, 5, 6]) {
    it(`${players} players: button 0, blinds 1/2, correct preflop and postflop order`, () => {
      let state = startTable(config({ players }));
      expect(state.button).toBe(0);
      expect(state.toAct).toBe(3 % players);
      expect(state.history).toEqual([
        { seat: 1, street: 'preflop', type: 'post_blind', amount: 1 },
        { seat: 2, street: 'preflop', type: 'post_blind', amount: 2 },
      ]);
      expect(state.acted).toEqual(Array(players).fill(false));
      for (let i = 0; i < players - 1; i++) {
        const seat = (3 + i) % players;
        expect(state.toAct).toBe(seat);
        state = play(state, [call(seat)]).state;
        expect(state.street).toBe('preflop');
      }
      expect(state.toAct).toBe(2);
      expect(tableLegalActions(state)).toEqual([
        { type: 'fold' },
        { type: 'check' },
        { type: 'raise', min: 4, max: 40 },
      ]);
      state = play(state, [check(2)]).state;
      expect(state.street).toBe('flop');
      expect(state.board).toEqual(
        shuffledDeck(SEED, 1).slice(2 * players, 2 * players + 3),
      );
      expect(state.toAct).toBe(1);
      expect(state.bets).toEqual(Array(players).fill(0));
      for (const nextStreet of ['turn', 'river'] as const) {
        for (let i = 0; i < players; i++) {
          const seat = (1 + i) % players;
          expect(state.toAct).toBe(seat);
          state = play(state, [check(seat)]).state;
        }
        expect(state.street).toBe(nextStreet);
        expect(state.toAct).toBe(1);
      }
    });
  }

  it('a fold with several live opponents keeps the hand running', () => {
    const { state, hands } = play(startTable(config()), [fold(3)]);
    expect(hands).toEqual([]);
    expect(state.folded[3]).toBe(true);
    expect(state.toAct).toBe(4);
    expect(state.handNumber).toBe(1);
  });

  it('moves the button past the previous button after that dealer is eliminated', () => {
    // Seed 0, A=4: seat 3 Js/Jh beats seat 0 Tc/2c on 4h Qc 7h 9h 5c.
    const { state, hands } = play(
      startTable(config({ players: 4, startingStack: 10 })),
      [raise(3, 10), call(0), fold(1), fold(2)],
    );
    expect(hands[0].stacks).toEqual([0, 9, 8, 23]);
    expect(state.places[0]).toBe(4);
    expect(state.button).toBe(1);
    expect(state.toAct).toBe(1);
    expect(state.history.slice(0, 2)).toEqual([
      { seat: 2, street: 'preflop', type: 'post_blind', amount: 1 },
      { seat: 3, street: 'preflop', type: 'post_blind', amount: 2 },
    ]);
    const deck = shuffledDeck(SEED, 2);
    expect(state.holeCards).toEqual([
      null,
      [deck[0], deck[3]],
      [deck[1], deck[4]],
      [deck[2], deck[5]],
    ]);
  });

  it('compresses the board deal to three players after an elimination', () => {
    let { state, hands } = play(
      startTable(config({ players: 4, startingStack: 10, blindEvery: 50 })),
      [raise(3, 10), call(0), fold(1), fold(2)],
    );
    expect(hands[0].stacks).toEqual([0, 9, 8, 23]);
    expect(state.places).toEqual([4, null, null, null]);
    expect(state.handNumber).toBe(2);
    expect(state.button).toBe(1);
    expect(state.toAct).toBe(1);
    expect(state.history.slice(0, 2).map(e => e.seat)).toEqual([2, 3]);

    // Three remaining players use deck[6..8], rather than deck[8..10].
    const flop = ['Kd', '6s', '7h'];
    expect(shuffledDeck(SEED, 2).slice(6, 9)).toEqual(flop);
    expect(dealTable(SEED, 2, 3).board.slice(0, 3)).toEqual(flop);
    state = play(state, [call(1), call(2), check(3)]).state;
    expect(state.street).toBe('flop');
    expect(state.toAct).toBe(2);
    expect(state.board).toEqual(flop);
  });

  it('switches to heads-up positions when three players become two', () => {
    // Seed 0, A=3: seat 0 Tc/Js beats seat 1 6h/2c, board Qs Jh 4h Qc 7h.
    let { state } = play(
      startTable(config({ players: 3, startingStack: 10 })),
      [raise(0, 10), call(1), fold(2)],
    );
    expect(state.places[1]).toBe(3);
    expect(state.holeCards[1]).toBeNull();
    expect(state.button).toBe(2);
    expect(state.toAct).toBe(2);
    expect(state.history.slice(0, 2).map(e => e.seat)).toEqual([2, 0]);
    state = play(state, [call(2), check(0)]).state;
    expect(state.street).toBe('flop');
    expect(state.toAct).toBe(0);
  });
});

describe('raise rights and short all-ins', () => {
  it('an unacted player can raise after a short all-in; its increment stays ten', () => {
    const { state: initial } = uneven();
    const { state } = play(initial, [raise(4, 12), raise(5, 14)]);
    expect(state.toAct).toBe(0);
    expect(state.minRaise).toBe(10);
    expect(tableLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 14 },
      { type: 'raise', min: 24, max: 40 },
    ]);
  });

  it('a single short all-in does not reopen a prior raiser', () => {
    const { state: initial } = uneven();
    const { state } = play(initial, [
      raise(4, 12),
      raise(5, 14),
      call(0),
      call(1),
      call(2),
      fold(3),
    ]);
    expect(state.toAct).toBe(4);
    expect(state.minRaise).toBe(10);
    expect(tableLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 2 },
    ]);
    expect(
      applyTableAction(state, 4, { type: 'raise', amount: 24 }),
    ).toMatchObject({ ok: false, code: 'invalid_action' });
    const next = play(state, [call(4)]).state;
    expect(next.street).toBe('flop');
    expect(next.toAct).toBe(2); // First active seat after button 1; seat 2 still has 8 chips.
  });

  it('cumulative short all-ins reopen only players facing a full increment', () => {
    const { state: initial } = uneven();
    let { state } = play(initial, [
      raise(4, 12),
      raise(5, 14),
      call(0),
      raise(1, 18),
      raise(2, 22),
      call(3),
    ]);
    expect(state.toAct).toBe(4);
    expect(state.minRaise).toBe(10);
    expect(tableLegalActions(state)).toContainEqual({
      type: 'raise',
      min: 32,
      max: 106,
    });
    state = play(state, [call(4)]).state;
    expect(state.toAct).toBe(0);
    // Seat 0 last called 14: 22-14 is only eight, while seat 4 faced 22-12=10.
    expect(tableLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 8 },
    ]);
    state = play(state, [call(0)]).state;
    expect(state.street).toBe('flop');
    expect(state.toAct).toBe(3);
  });

  it('a short call reports actual chips and no raise against only all-in opponents', () => {
    const { state: initial } = uneven();
    const { state } = play(initial, [
      raise(4, 106),
      call(5),
      fold(0),
      fold(1),
      fold(2),
    ]);
    expect(state.toAct).toBe(3);
    expect(tableLegalActions(state)).toEqual([
      { type: 'fold' },
      { type: 'call', amount: 38 },
    ]);
  });
});

describe('side pots, odd chips, elimination and places', () => {
  it('pays ordered main/side pots, returns the unmatched excess, and ranks unequal busts', () => {
    const { state: initial } = uneven({ seed: SIDE_SEED, maxHands: 2 });
    const { state, hands } = play(initial, [
      raise(4, 106),
      call(5),
      call(0),
      call(1),
      call(2),
      call(3),
    ]);
    // Hand 2: board Qs 5h 4d 7d Tc.
    // Seat 5 Qh/Ks wins main (queens, K kicker); seat 1 6c/Qd wins next;
    // seat 3 9s/7h beats seat 4 6d/7c by kicker in both remaining pools.
    const last = hands[0];
    expect(hands).toHaveLength(1);
    expect(last.pots).toEqual([
      { amount: 84, winners: [5] },
      { amount: 20, winners: [1] },
      { amount: 16, winners: [3] },
      { amount: 54, winners: [3] },
    ]);
    expect(last.pot).toBe(174); // 240 on table, 66 uncalled returned to seat 4.
    expect(last.winner_seat).toBeNull();
    expect(last.stacks).toEqual([0, 20, 0, 70, 66, 84]);
    expect(last.hole_cards).toEqual([
      ['As', 'Jd'],
      ['6c', 'Qd'],
      ['5c', '2h'],
      ['9s', '7h'],
      ['6d', '7c'],
      ['Qh', 'Ks'],
    ]);
    expect(state.over).toBe(true);
    expect(state.places).toEqual([5, 4, 6, 2, 3, 1]);
    expect(state.bets).toEqual([0, 0, 0, 0, 0, 0]);
    expect(state.contributed).toEqual([0, 0, 0, 0, 0, 0]);
    expect(state.board).toEqual(last.board);
    expect(state.history).toEqual(last.events);
    expect(state.street).toBe('river');
  });

  it('eliminated seats receive neither cards nor blinds on subsequent hands', () => {
    const { state: initial } = uneven({ seed: SIDE_SEED });
    const { state, hands } = play(initial, [
      raise(4, 106),
      call(5),
      call(0),
      call(1),
      call(2),
      call(3),
    ]);
    expect(hands[0].stacks).toEqual([0, 20, 0, 70, 66, 84]);
    expect(state.handNumber).toBe(3);
    expect(state.button).toBe(3); // button 1 -> skip eliminated 2 -> 3.
    expect(state.holeCards[0]).toBeNull();
    expect(state.holeCards[2]).toBeNull();
    expect(state.history.map(e => e.seat)).toEqual([4, 5]);
    const deck = shuffledDeck(SIDE_SEED, 3);
    expect(state.holeCards).toEqual([
      null,
      [deck[0], deck[4]],
      null,
      [deck[1], deck[5]],
      [deck[2], deck[6]],
      [deck[3], deck[7]],
    ]);
    expect(state.places).toEqual([5, null, 6, null, null, null]);
  });

  it('awards BOTH odd chips to the nearest winning seat left of the dealer, and uses 1224 places', () => {
    const initial = startTable(config({ seed: ODD_SEED, maxHands: 1 }));
    const preflop = play(initial, [
      call(3),
      call(4),
      call(5),
      call(0),
      fold(1),
      check(2),
    ]).state;
    const { state, hands } = passiveToHandEnd(preflop);
    // Board Ah Js Qc Kc 5d; seats 0 Ts/9c, 2 Ks/Tc, 4 Td/6h
    // tie with Broadway. Seat 1's folded small blind makes 11 = 3*3+2.
    expect(hands[0].pots).toEqual([{ amount: 11, winners: [0, 2, 4] }]);
    expect(hands[0].pot).toBe(11);
    expect(hands[0].winner_seat).toBeNull();
    expect(hands[0].hole_cards).toEqual([
      ['Ts', '9c'],
      null,
      ['Ks', 'Tc'],
      ['8s', 'Jh'],
      ['Td', '6h'],
      ['Ad', '3c'],
    ]);
    expect(state.stacks).toEqual([41, 39, 43, 38, 41, 38]);
    expect(state.places).toEqual([2, 4, 1, 5, 2, 5]);
    expect(state.over).toBe(true);
  });

  it('equal starting stacks bust together in tied second; sole survivor is first', () => {
    // Seed 2 hand 1: seat 1 has kings and sevens; all others have weaker hands.
    const { state, hands } = play(
      startTable(config({ seed: SIDE_SEED, startingStack: 10 })),
      [raise(3, 10), call(4), call(5), call(0), call(1), call(2)],
    );
    expect(hands[0].pots).toEqual([{ amount: 60, winners: [1] }]);
    expect(hands[0].winner_seat).toBe(1);
    expect(state.stacks).toEqual([0, 60, 0, 0, 0, 0]);
    expect(state.places).toEqual([2, 1, 2, 2, 2, 2]);
    expect(state.toAct).toBeNull();
    expect(state.over).toBe(true);
    expect(tableLegalActions(state)).toEqual([]);
  });

  it('a fold victory is one pot, hides all holes, and excludes an uncalled raise', () => {
    const { hands } = play(startTable(config()), [
      raise(3, 20),
      fold(4),
      fold(5),
      fold(0),
      fold(1),
      fold(2),
    ]);
    expect(hands[0]).toMatchObject({
      ended_by: 'fold',
      winner_seat: 3,
      pot: 5,
      pots: [{ amount: 5, winners: [3] }],
      hole_cards: null,
      stacks: [40, 39, 38, 43, 40, 40],
    });
  });
});

describe('leaving a table', () => {
  it('allows leaving out of turn, folds implicitly, keeps the blind and takes chips', () => {
    const initial = startTable(config());
    const snapshot = structuredClone(initial);
    const { state, finishedHands } = accepted(leaveTable(initial, 1));
    expect(initial).toEqual(snapshot);
    expect(finishedHands).toEqual([]);
    expect(state.toAct).toBe(3);
    expect(state.folded[1]).toBe(true);
    expect(state.stacks[1]).toBe(0);
    expect(state.taken).toEqual([0, 39, 0, 0, 0, 0]);
    expect(state.contributed[1]).toBe(1);
    expect(state.places[1]).toBe(6);
    expect(state.history).toEqual([
      ...initial.history,
      { seat: 1, street: 'preflop', type: 'leave', amount: 39 },
    ]);
    expect(
      state.stacks.reduce((a, b) => a + b, 0) +
        state.contributed.reduce((a, b) => a + b, 0) +
        state.taken.reduce((a, b) => a + b, 0),
    ).toBe(240);
    expect(leaveTable(state, 1)).toMatchObject({
      ok: false,
      code: 'invalid_action',
    });
  });

  it('advances to the next actor when the current actor leaves', () => {
    const { state } = accepted(leaveTable(startTable(config()), 3));
    expect(state.toAct).toBe(4);
    expect(state.history.at(-1)).toEqual({
      seat: 3,
      street: 'preflop',
      type: 'leave',
      amount: 40,
    });
  });

  it('can leave after folding, without inserting a second fold', () => {
    const initial = play(startTable(config()), [fold(3)]).state;
    const { state } = accepted(leaveTable(initial, 3));
    expect(state.history).toEqual([
      ...initial.history,
      { seat: 3, street: 'preflop', type: 'leave', amount: 40 },
    ]);
    expect(state.taken[3]).toBe(40);
    expect(state.toAct).toBe(4);
  });

  it('ends a hand with one nonfolded player, then continues with the players still seated', () => {
    let state = startTable(config({ players: 4 }));
    state = play(state, [fold(3), fold(0)]).state;
    const result = accepted(leaveTable(state, 1));
    expect(result.finishedHands).toHaveLength(1);
    expect(result.finishedHands[0]).toMatchObject({
      ended_by: 'fold',
      winner_seat: 2,
      hole_cards: null,
    });
    expect(result.state.over).toBe(false);
    expect(result.state.handNumber).toBe(2);
    expect(result.state.places).toEqual([null, 4, null, null]);
    expect(result.state.taken[1]).toBe(39);
    expect(result.state.holeCards[1]).toBeNull();
  });

  it('ends the tournament when only one player remains, and rejects subsequent leaves', () => {
    let state = accepted(
      leaveTable(startTable(config({ players: 3 })), 1),
    ).state;
    const result = accepted(leaveTable(state, 0));
    state = result.state;
    expect(result.finishedHands).toHaveLength(1);
    expect(state.over).toBe(true);
    expect(state.toAct).toBeNull();
    expect(state.places).toEqual([2, 3, 1]);
    expect(state.taken).toEqual([40, 39, 0]);
    expect(state.stacks).toEqual([0, 0, 41]);
    expect(leaveTable(state, 2)).toMatchObject({
      ok: false,
      code: 'match_over',
    });
  });

  it("merges a departed player's contribution above the last eligible level into the final pot", () => {
    const initial = uneven({ seed: SIDE_SEED, maxHands: 2 }).state;
    let state = play(initial, [
      raise(4, 106),
      call(5),
      call(0),
      call(1),
      call(2),
    ]).state;
    state = accepted(leaveTable(state, 4)).state;
    expect(state.taken[4]).toBe(0);
    expect(state.history.at(-1)).toEqual({
      seat: 4,
      street: 'preflop',
      type: 'leave',
      amount: 0,
    });
    const { state: final, hands } = play(state, [call(3)]);
    // The departed seat's 66 above the highest eligible 40 is not returned.
    expect(hands[0].pots).toEqual([
      { amount: 84, winners: [5] },
      { amount: 20, winners: [1] },
      { amount: 16, winners: [3] },
      { amount: 120, winners: [3] },
    ]);
    expect(hands[0].pot).toBe(240);
    expect(hands[0].hole_cards?.[4]).toBeNull();
    expect(final.stacks).toEqual([0, 20, 0, 136, 0, 84]);
  });

  it('rejects a player eliminated by showdown', () => {
    const { state } = play(
      startTable(config({ players: 4, startingStack: 10 })),
      [raise(3, 10), call(0), fold(1), fold(2)],
    );
    expect(leaveTable(state, 0)).toMatchObject({
      ok: false,
      code: 'invalid_action',
    });
  });
});

describe('replaying table events', () => {
  it('replays complete hands, blinds, a leave event and a partial next hand identically', () => {
    const cfg = config();
    const setup = uneven();
    let state = accepted(leaveTable(setup.state, 1)).state;
    state = play(state, [
      raise(4, 12),
      call(5),
      fold(0),
      call(2),
      fold(3),
    ]).state;
    const end = passiveToHandEnd(state);
    const hands = [...setup.hands, ...end.hands];
    const events = [...hands.flatMap(h => h.events), ...end.state.history];
    const snapshot = structuredClone(events);
    const replay = replayTable(cfg, events);
    if (!replay.ok)
      throw new Error(
        `replay rejected event ${replay.index}: ${replay.message}`,
      );
    expect(replay.state).toEqual(end.state);
    expect(replay.hands).toEqual(hands);
    expect(events).toEqual(snapshot);
  });

  it('reports the original event index of an out-of-turn action after skipped blinds', () => {
    const cfg = config();
    const events: TableEvent[] = [
      ...startTable(cfg).history,
      { seat: 4, street: 'preflop', type: 'check' },
    ];
    expect(replayTable(cfg, events)).toMatchObject({
      ok: false,
      index: 2,
      code: 'not_your_turn',
    });
  });

  it('reports the index of a repeated leave', () => {
    const cfg = config();
    const events: TableEvent[] = [
      ...startTable(cfg).history,
      { seat: 1, street: 'preflop', type: 'leave', amount: 39 },
      { seat: 1, street: 'preflop', type: 'leave', amount: 0 },
    ];
    expect(replayTable(cfg, events)).toMatchObject({
      ok: false,
      index: 3,
      code: 'invalid_action',
    });
  });
});

describe('configuration bounds and immutable actions', () => {
  const invalid: [keyof TableConfig, number][] = [
    ['players', 1],
    ['players', 7],
    ['players', 2.5],
    ['startingStack', 9],
    ['startingStack', 2001],
    ['startingStack', 10.5],
    ['blindEvery', 0],
    ['blindEvery', 51],
    ['blindEvery', 1.5],
    ['maxHands', 0],
    ['maxHands', 101],
    ['maxHands', 1.5],
  ];
  for (const [key, value] of invalid) {
    it(`rejects ${key}=${value} with RangeError`, () => {
      expect(() => startTable(config({ [key]: value }))).toThrow(RangeError);
    });
  }

  it('accepts inclusive numeric configuration boundaries', () => {
    for (const players of [2, 6]) {
      for (const startingStack of [10, 2000]) {
        for (const blindEvery of [1, 50]) {
          for (const maxHands of [1, 100]) {
            expect(() =>
              startTable(
                config({ players, startingStack, blindEvery, maxHands }),
              ),
            ).not.toThrow();
          }
        }
      }
    }
  });

  it('preserves input state for successful, illegal and out-of-turn actions', () => {
    const state = startTable(config());
    const snapshot = structuredClone(state);
    accepted(applyTableAction(state, 3, { type: 'raise', amount: 10 }));
    expect(state).toEqual(snapshot);
    expect(applyTableAction(state, 3, { type: 'check' })).toMatchObject({
      ok: false,
      code: 'invalid_action',
    });
    expect(state).toEqual(snapshot);
    expect(applyTableAction(state, 4, { type: 'call' })).toMatchObject({
      ok: false,
      code: 'not_your_turn',
    });
    expect(state).toEqual(snapshot);
  });

  it('preserves the input when an action pays a hand and deals the next one', () => {
    const state = play(startTable(config()), [
      fold(3),
      fold(4),
      fold(5),
      fold(0),
    ]).state;
    const snapshot = structuredClone(state);
    const result = accepted(applyTableAction(state, 1, { type: 'fold' }));
    expect(result.finishedHands).toHaveLength(1);
    expect(result.state.handNumber).toBe(2);
    expect(state).toEqual(snapshot);
  });
});
