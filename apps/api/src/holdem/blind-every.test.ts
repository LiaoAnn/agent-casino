/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { evaluateHand } from './hand';
import { type Action, blindsAt } from './match';
import { mulberry32 } from './shuffle';
import {
  applyTableAction,
  DEFAULT_BLIND_EVERY,
  startTable,
  type TableState,
  tableLegalActions,
} from './table';

// The simulation behind DEFAULT_BLIND_EVERY (holdem-rules 人數 → blind_every
// 預設). The house bot shoves too often to time a match (3–6 hands at any
// blind_every), so this plays a tighter bot tuned until heads-up at 5 lasts
// as long as arena matches did. `BLIND_SIM=1` prints the whole sweep.

const RANKS = '23456789TJQKA';
const MADE = ['high-card', 'pair', 'two-pair'];

/** 2 strong, 1 playable, 0 weak; a pair or two pair on the board alone counts as nothing. */
function strength(state: TableState, seat: number): number {
  const [a, b] = state.holeCards[seat] ?? [];
  if (!a || !b) throw new Error(`Seat ${seat} has no cards`);
  if (state.board.length === 0) {
    const [high, low] = [RANKS.indexOf(a[0]), RANKS.indexOf(b[0])].sort(
      (x, y) => y - x,
    );
    if (high === low) return high >= 7 ? 2 : 1;
    if (high === 12 && low >= 10) return 2;
    const suitedConnector = a[1] === b[1] && high - low === 1;
    return high === 12 || low >= 8 || suitedConnector ? 1 : 0;
  }
  const made = MADE.indexOf(evaluateHand([a, b, ...state.board]).category);
  const onBoard =
    state.board.length === 5
      ? MADE.indexOf(evaluateHand(state.board).category)
      : 0;
  if (made === -1) return 2;
  if (made === 0 || made === onBoard) return 0;
  return made;
}

const LOOSE = 0.1;
const AGGRESSIVE = 0.1;

function tightAction(state: TableState, random: () => number): Action {
  const seat = state.toAct as number;
  const legal = tableLegalActions(state);
  const call = legal.find(action => action.type === 'call');
  const raise = legal.find(action => action.type === 'raise');
  const big = blindsAt(state.handNumber, state.config.blindEvery)[1];
  const tier = strength(state, seat);
  const stack = state.stacks[seat];
  if (raise?.type === 'raise') {
    if (stack <= 4 * big && tier >= 1) {
      return { type: 'raise', amount: raise.max };
    }
    const odds = tier === 2 ? 0.6 : tier === 1 ? AGGRESSIVE : AGGRESSIVE / 3;
    if (random() < odds) {
      const pot = state.contributed.reduce((sum, chips) => sum + chips, 0);
      const target =
        Math.max(...state.bets) + Math.round(pot * (0.5 + random() * 0.5));
      return {
        type: 'raise',
        amount: Math.min(raise.max, Math.max(raise.min, target)),
      };
    }
  }
  if (call?.type !== 'call') return { type: 'check' };
  const price = call.amount / (stack + state.bets[seat]);
  const calls =
    tier === 2 ||
    (tier === 1 && (price < 0.35 || random() < LOOSE)) ||
    (tier === 0 &&
      ((call.amount <= big && random() < 0.6) || random() < LOOSE / 3));
  return { type: calls ? 'call' : 'fold' };
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];

/** Median hands and decisions of `matches` tight-bot matches from 40 chips. */
function simulate(players: number, blindEvery: number, matches: number) {
  const hands: number[] = [];
  const decisions: number[] = [];
  for (let match = 0; match < matches; match++) {
    const random = mulberry32(players * 100_000 + blindEvery * 1000 + match);
    const seed = Array.from({ length: 8 }, () =>
      Math.floor(random() * 2 ** 32)
        .toString(16)
        .padStart(8, '0'),
    ).join('');
    let state = startTable({
      seed,
      players,
      startingStack: 40,
      blindEvery,
      maxHands: 100,
    });
    let count = 0;
    while (!state.over) {
      const result = applyTableAction(
        state,
        state.toAct as number,
        tightAction(state, random),
      );
      if (!result.ok) throw new Error(result.message);
      state = result.state;
      count++;
    }
    hands.push(state.handNumber);
    decisions.push(count);
  }
  return { hands: median(hands), decisions: median(decisions) };
}

/** holdem-rules: about 5 seconds a decision, from arena timings. */
const SECONDS_PER_DECISION = 5;

describe('DEFAULT_BLIND_EVERY', () => {
  it('keeps heads-up at 5 and gives every table size a default', () => {
    expect(DEFAULT_BLIND_EVERY).toEqual({ 2: 5, 3: 5, 4: 4, 5: 3, 6: 3 });
  });

  it('heads-up lasts like arena matches; 3–6 players about 10 minutes', () => {
    const minutes: Record<number, number> = {};
    for (let players = 2; players <= 6; players++) {
      const { hands, decisions } = simulate(
        players,
        DEFAULT_BLIND_EVERY[players],
        80,
      );
      minutes[players] = (decisions * SECONDS_PER_DECISION) / 60;
      if (players === 2) expect(hands).toBeGreaterThanOrEqual(9);
      if (players === 2) expect(hands).toBeLessThanOrEqual(15);
      if (players === 6) expect(hands).toBeGreaterThanOrEqual(13);
      if (players === 6) expect(hands).toBeLessThanOrEqual(18);
    }
    for (const players of [3, 4, 5, 6]) {
      expect(minutes[players]).toBeGreaterThanOrEqual(7);
      expect(minutes[players]).toBeLessThanOrEqual(12);
    }
  }, 30_000);

  it.runIf(process.env.BLIND_SIM)(
    'prints the sweep',
    () => {
      const rows = ['players blind_every hands decisions minutes'];
      for (let players = 2; players <= 6; players++) {
        for (let blindEvery = 1; blindEvery <= 6; blindEvery++) {
          const { hands, decisions } = simulate(players, blindEvery, 600);
          const minutes = ((decisions * SECONDS_PER_DECISION) / 60).toFixed(1);
          rows.push(
            `${players} ${blindEvery} ${hands} ${decisions} ${minutes}`,
          );
        }
      }
      console.log(rows.join('\n'));
    },
    600_000,
  );
});
