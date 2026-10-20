/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { randomAction } from './bot';
import { compareHands, evaluateHand } from './hand';
import { dealTable, mulberry32 } from './shuffle';
import {
  type Action,
  applyTableAction,
  type LegalAction,
  leaveTable,
  replayTable,
  startTable,
  type TableConfig,
  type TableEvent,
  type TableHandRecord,
  type TableState,
  tableLegalActions,
} from './table';

function envInt(name: string, fallback: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < (name === 'FUZZ_SEED' ? 0 : 1) ||
    value > max
  ) {
    throw new RangeError(`${name} is out of range`);
  }
  return value;
}

const FUZZ_HANDS = envInt('FUZZ_HANDS', 500, 10_000_000);
const FUZZ_SEED = envInt('FUZZ_SEED', 20261020, 0xffffffff);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const int = (random: () => number, min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));

function requireThat(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function chips(values: number[], label: string) {
  requireThat(
    values.every(n => Number.isInteger(n) && n >= 0),
    `${label}: negative or noninteger chips ${values}`,
  );
}

function pickConfig(random: () => number, index: number): TableConfig {
  return {
    // The run continues until every table size has been sampled.
    players: int(random, 2, 6),
    seed:
      index < 2
        ? (index === 0 ? '0' : 'f').repeat(64)
        : Array.from({ length: 8 }, () =>
            int(random, 0, 0xffffffff).toString(16).padStart(8, '0'),
          ).join(''),
    startingStack: random() < 0.8 ? int(random, 10, 40) : int(random, 10, 2000),
    blindEvery: int(random, 1, 50),
    maxHands: int(random, 1, 100),
  };
}

function dealtSeats(start: number[]) {
  return start.flatMap((stack, seat) => (stack > 0 ? [seat] : []));
}

function checkDeal(
  config: TableConfig,
  hand: number,
  start: number[],
  button: number,
  events: TableEvent[],
) {
  const seats = dealtSeats(start);
  const at = seats.indexOf(button);
  requireThat(at >= 0, 'button is not at the table');
  const small = seats.length === 2 ? button : seats[(at + 1) % seats.length];
  const big = seats[(seats.indexOf(small) + 1) % seats.length];
  const blind = 2 ** Math.floor((hand - 1) / config.blindEvery);
  requireThat(
    same(events.slice(0, 2), [
      {
        seat: small,
        street: 'preflop',
        type: 'post_blind',
        amount: Math.min(start[small], blind),
      },
      {
        seat: big,
        street: 'preflop',
        type: 'post_blind',
        amount: Math.min(start[big], 2 * blind),
      },
    ]),
    'history does not start with the scheduled small and big blinds',
  );
  return { seats, deal: dealTable(config.seed, hand, seats.length) };
}

function checkState(state: TableState, start: number[]) {
  const { config, stacks, contributed, taken, toAct } = state;
  for (const [label, values] of Object.entries({
    stacks,
    contributed,
    taken,
    bets: state.bets,
  }))
    chips(values, label);
  requireThat(
    sum(stacks) + sum(contributed) + sum(taken) ===
      config.players * config.startingStack,
    'chip conservation',
  );
  requireThat(state.over === (toAct === null), 'over iff toAct is null');
  requireThat(
    state.board.length ===
      { preflop: 0, flop: 3, turn: 4, river: 5 }[state.street],
    'board length disagrees with street',
  );
  const { seats, deal } = checkDeal(
    config,
    state.handNumber,
    start,
    state.button,
    state.history,
  );
  requireThat(
    same(state.board, deal.board.slice(0, state.board.length)),
    'board differs from seeded deal',
  );
  for (let seat = 0; seat < config.players; seat++) {
    const position = seats.indexOf(seat);
    // Only seats out before this hand miss the deal. A mid-hand leave keeps
    // its original cards and does not move the remaining cards in the deck.
    if (position < 0) {
      requireThat(
        state.holeCards[seat] === null,
        `out seat ${seat} was dealt cards`,
      );
      requireThat(
        !state.history.some(e => e.seat === seat),
        `out seat ${seat} posted or acted`,
      );
    } else {
      requireThat(
        same(state.holeCards[seat], deal.holeCards[position]),
        `hole cards of seat ${seat} differ from seeded deal`,
      );
    }
    const leaveIndex = state.history.findIndex(
      e => e.seat === seat && e.type === 'leave',
    );
    if (leaveIndex >= 0) {
      requireThat(
        state.folded[seat] && stacks[seat] === 0 && toAct !== seat,
        `departed seat ${seat} remains eligible to act`,
      );
      requireThat(
        !state.history.slice(leaveIndex + 1).some(e => e.seat === seat),
        `departed seat ${seat} acted after leaving`,
      );
    }
    requireThat(
      state.bets[seat] <= contributed[seat],
      'street bet exceeds hand contribution',
    );
  }
  const legal = tableLegalActions(state);
  if (toAct !== null) {
    requireThat(
      state.places[toAct] === null && !state.folded[toAct] && stacks[toAct] > 0,
      'ineligible seat to act',
    );
    requireThat(
      legal.length >= 2 && legal[0].type === 'fold',
      'legal actions must start with fold',
    );
    requireThat(
      Number.isInteger(state.minRaise) &&
        state.minRaise >=
          2 ** (1 + Math.floor((state.handNumber - 1) / config.blindEvery)),
      'invalid full raise increment',
    );
    const due = Math.max(...state.bets) - state.bets[toAct];
    requireThat(
      same(
        legal[1],
        due === 0
          ? { type: 'check' }
          : { type: 'call', amount: Math.min(due, stacks[toAct]) },
      ),
      'incorrect check/call',
    );
    const mayRaise =
      stacks[toAct] > due &&
      seats.some(
        s =>
          s !== toAct &&
          state.places[s] === null &&
          !state.folded[s] &&
          stacks[s] > 0,
      ) &&
      (!state.acted[toAct] || due >= state.minRaise);
    const allIn = state.bets[toAct] + stacks[toAct];
    requireThat(
      same(
        legal.slice(2),
        mayRaise
          ? [
              {
                type: 'raise',
                min: Math.min(Math.max(...state.bets) + state.minRaise, allIn),
                max: allIn,
              },
            ]
          : [],
      ),
      'incorrect raise availability or min/max',
    );
  } else {
    requireThat(legal.length === 0, 'finished table offers actions');
    requireThat(
      state.bets.every(n => n === 0) && contributed.every(n => n === 0),
      'terminal bets not zero',
    );
    requireThat(
      state.places.every(
        p => p !== null && Number.isInteger(p) && p >= 1 && p <= config.players,
      ),
      'invalid terminal places',
    );
    const places = state.places as number[];
    for (const place of places)
      requireThat(
        place === 1 + places.filter(p => p < place).length,
        'places do not use 1224 ranking',
      );
    requireThat(places.includes(1), 'no first place');
  }
  return legal;
}

function invalidAction(legal: LegalAction[], random: () => number): Action {
  const raise = legal.find(a => a.type === 'raise');
  const candidates: Action[] =
    raise?.type === 'raise'
      ? [
          { type: 'raise', amount: raise.min - 1 },
          { type: 'raise', amount: raise.max + 1 },
          { type: 'raise', amount: raise.min + 0.5 },
        ]
      : [{ type: 'raise', amount: 1 }];
  candidates.push(
    legal.some(a => a.type === 'check') ? { type: 'call' } : { type: 'check' },
  );
  return candidates[int(random, 0, candidates.length - 1)];
}

/** Reconstruct contributions and eligible winners from the public action log. */
function checkRecord(
  hand: TableHandRecord,
  config: TableConfig,
  start: number[],
  takenBefore: number[],
  places: (number | null)[],
) {
  const { seats, deal } = checkDeal(
    config,
    hand.hand_number,
    start,
    hand.button_seat,
    hand.events,
  );
  requireThat(
    same(hand.board, deal.board.slice(0, hand.board.length)),
    'record board differs from seeded deal',
  );
  requireThat(
    [0, 3, 4, 5].includes(hand.board.length),
    'invalid record board length',
  );
  const small = 2 ** Math.floor((hand.hand_number - 1) / config.blindEvery);
  requireThat(
    same(hand.blinds, [small, small * 2]),
    'record blinds differ from schedule',
  );
  const paid = start.map(() => 0);
  let bets = start.map(() => 0);
  let street = 'preflop';
  const folded = new Set<number>();
  const taken = [...takenBefore];
  for (const event of hand.events) {
    requireThat(
      seats.includes(event.seat) &&
        (event.type === 'leave' || !folded.has(event.seat)) &&
        places[event.seat] === null,
      'out/folded seat acted or posted',
    );
    if (event.street !== street) {
      bets = bets.map(() => 0);
      street = event.street;
    }
    const seat = event.seat;
    if (event.type === 'leave') {
      requireThat(
        event.amount === start[seat] - paid[seat],
        'leave took incorrect chips',
      );
      taken[seat] += event.amount ?? 0;
      places[seat] = places.filter(p => p === null).length;
      folded.add(seat);
    } else if (event.type === 'fold') folded.add(seat);
    else if (event.type !== 'check') {
      const added =
        event.type === 'raise'
          ? (event.amount ?? 0) - bets[seat]
          : (event.amount ?? 0);
      chips([added], 'event chips');
      paid[seat] += added;
      bets[seat] += added;
    }
  }
  const descending = [...paid].sort((a, b) => b - a);
  const maxSeat = paid.indexOf(descending[0]);
  if (descending[0] > descending[1] && !folded.has(maxSeat))
    paid[maxSeat] = descending[1];
  const live = seats.filter(s => !folded.has(s));
  const levels = [...new Set(live.map(s => paid[s]))].sort((a, b) => a - b);
  const expectedPots: { amount: number; winners: number[] }[] = [];
  if (hand.ended_by === 'fold') {
    requireThat(
      live.length === 1 && hand.hole_cards === null,
      'fold ending must have exactly one survivor and hide cards',
    );
    expectedPots.push({ amount: sum(paid), winners: live });
  } else {
    requireThat(
      live.length >= 2 && hand.board.length === 5,
      'showdown must have multiple live hands and five board cards',
    );
    requireThat(
      same(hand.board, deal.board),
      'record board differs from seeded deal',
    );
    for (let seat = 0; seat < config.players; seat++)
      requireThat(
        same(
          hand.hole_cards?.[seat],
          live.includes(seat) ? deal.holeCards[seats.indexOf(seat)] : null,
        ),
        'incorrect showdown hole cards',
      );
    let previous = 0;
    for (const level of levels) {
      const amount = sum(
        paid.map(p => Math.max(0, Math.min(p, level) - previous)),
      );
      previous = level;
      if (amount === 0) continue;
      const eligible = live.filter(s => paid[s] >= level);
      const values = eligible.map(s =>
        evaluateHand([...deal.holeCards[seats.indexOf(s)], ...deal.board]),
      );
      const best = values.reduce((a, b) => (compareHands(a, b) >= 0 ? a : b));
      expectedPots.push({
        amount,
        winners: eligible.filter((_, i) => compareHands(values[i], best) === 0),
      });
    }
    const excess = sum(paid.map(p => Math.max(0, p - previous)));
    if (excess > 0) expectedPots[expectedPots.length - 1].amount += excess;
  }
  requireThat(
    same(hand.pots, expectedPots),
    `pots/winners differ: expected ${JSON.stringify(expectedPots)}, got ${JSON.stringify(hand.pots)}`,
  );
  requireThat(
    hand.pot === sum(hand.pots.map(p => p.amount)) && hand.pot === sum(paid),
    'record pot does not equal contributions and pots',
  );
  const expectedStacks = start.map(
    (stack, s) => stack - paid[s] - (taken[s] - takenBefore[s]),
  );
  for (const pot of expectedPots) {
    const each = Math.floor(pot.amount / pot.winners.length);
    for (const winner of pot.winners) expectedStacks[winner] += each;
    const nearest = [...pot.winners].sort(
      (a, b) =>
        ((a - hand.button_seat - 1 + config.players) % config.players) -
        ((b - hand.button_seat - 1 + config.players) % config.players),
    )[0];
    expectedStacks[nearest] += pot.amount % pot.winners.length;
  }
  chips(hand.stacks, 'record stacks');
  requireThat(
    same(hand.stacks, expectedStacks),
    `payout differs: expected ${expectedStacks}, got ${hand.stacks}`,
  );
  const busts = seats.filter(s => places[s] === null && hand.stacks[s] === 0);
  const survivors = seats.filter(s => places[s] === null && hand.stacks[s] > 0);
  for (const s of busts)
    places[s] =
      1 +
      survivors.length +
      busts.filter(other => start[other] > start[s]).length;
  if (survivors.length === 1 || hand.hand_number === config.maxHands) {
    for (const s of survivors)
      places[s] =
        1 +
        survivors.filter(other => hand.stacks[other] > hand.stacks[s]).length;
  }
  return taken;
}

describe('fuzz: multiplayer random legal play', () => {
  it(
    `plays at least ${FUZZ_HANDS} hands (seed ${FUZZ_SEED}) with 0 violations`,
    () => {
      const random = mulberry32(FUZZ_SEED);
      let handsPlayed = 0;
      let match = 0;
      const sizes = new Set<number>();
      while (handsPlayed < FUZZ_HANDS || sizes.size < 5) {
        const config = pickConfig(random, match++);
        sizes.add(config.players);
        let state = startTable(config);
        let start = Array<number>(config.players).fill(config.startingStack);
        let terminalStart = start;
        let taken = Array<number>(config.players).fill(0);
        const places = Array<number | null>(config.players).fill(null);
        const events: TableEvent[] = [];
        const hands: TableHandRecord[] = [];
        let previousButton: number | null = null;
        let actions = 0;
        try {
          while (true) {
            const before = JSON.stringify(state);
            const legal = checkState(state, state.over ? terminalStart : start);
            requireThat(
              JSON.stringify(state) === before,
              'legalActions changed input',
            );
            if (state.over) break;
            requireThat(++actions < 200_000, 'match did not end');
            const seat = state.toAct as number;
            if (random() < 0.2) {
              const wrong =
                (seat + int(random, 1, config.players - 1)) % config.players;
              const result = applyTableAction(state, wrong, { type: 'fold' });
              requireThat(
                !result.ok && result.code === 'not_your_turn',
                'out-of-turn action accepted',
              );
              requireThat(
                JSON.stringify(state) === before,
                'out-of-turn action changed input',
              );
            }
            if (random() < 0.2) {
              const result = applyTableAction(
                state,
                seat,
                invalidAction(legal, random),
              );
              requireThat(
                !result.ok && result.code === 'invalid_action',
                'illegal action accepted',
              );
              requireThat(
                JSON.stringify(state) === before,
                'illegal action changed input',
              );
            }
            const active = state.places.flatMap((p, s) =>
              p === null ? [s] : [],
            );
            const leaving =
              random() < 0.025
                ? active[int(random, 0, active.length - 1)]
                : null;
            const result =
              leaving === null
                ? applyTableAction(state, seat, randomAction(legal, random), {
                    timeout: random() < 0.1,
                  })
                : leaveTable(state, leaving);
            requireThat(
              JSON.stringify(state) === before,
              'action/leave changed input',
            );
            requireThat(
              result.ok,
              `legal action/leave rejected: ${JSON.stringify(result)}`,
            );
            for (const hand of result.finishedHands) {
              requireThat(
                hand.hand_number === hands.length + 1,
                'nonsequential hand records',
              );
              if (previousButton !== null) {
                const seats = dealtSeats(start);
                const expected = Array.from(
                  { length: config.players },
                  (_, i) =>
                    ((previousButton as number) + i + 1) % config.players,
                ).find(s => seats.includes(s));
                requireThat(
                  hand.button_seat === expected,
                  'button did not move to next remaining seat',
                );
              } else
                requireThat(
                  hand.button_seat === 0,
                  'first button must be seat 0',
                );
              terminalStart = start;
              taken = checkRecord(hand, config, start, taken, places);
              previousButton = hand.button_seat;
              start = [...hand.stacks];
              events.push(...hand.events);
              hands.push(hand);
              handsPlayed++;
            }
            const last = result.finishedHands.at(-1);
            if (last) {
              const { button_seat: _button, events: _events, ...record } = last;
              requireThat(
                same(result.state.lastHand, record),
                'lastHand differs from record',
              );
              requireThat(
                same(
                  result.state.stacks.map(
                    (n, s) => n + result.state.contributed[s],
                  ),
                  start,
                ),
                'stacks do not continue from record',
              );
              requireThat(
                same(result.state.places, places),
                'places disagree with leave, elimination or cap ranking',
              );
            } else if (leaving !== null) {
              requireThat(
                result.state.places[leaving] === active.length,
                'leave assigned wrong place',
              );
              requireThat(
                result.state.taken[leaving] === state.stacks[leaving],
                'leave took wrong stack',
              );
            }
            state = result.state;
          }
          const replayed = replayTable(config, events);
          requireThat(
            replayed.ok,
            `replay rejected: ${JSON.stringify(replayed)}`,
          );
          requireThat(
            same(replayed.state, state),
            'replay final state differs',
          );
          requireThat(
            same(replayed.hands, hands),
            'replay hand records differ',
          );
        } catch (error) {
          throw new Error(
            `[FUZZ_SEED=${FUZZ_SEED} match=${match} config=${JSON.stringify(config)} hand=${state.handNumber} completedHands=${handsPlayed}] ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      expect(handsPlayed).toBeGreaterThanOrEqual(FUZZ_HANDS);
      expect([...sizes].sort()).toEqual([2, 3, 4, 5, 6]);
    },
    Math.max(60_000, FUZZ_HANDS * 30),
  );
});
