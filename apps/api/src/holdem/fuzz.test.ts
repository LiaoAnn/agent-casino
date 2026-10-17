import { describe, expect, it } from 'vitest';
import { randomAction } from './bot';
import { checkHand, checkState } from './invariants';
import {
  type Action,
  applyAction,
  type HistoryEvent,
  type LegalAction,
  legalActions,
  type MatchConfig,
  type MatchState,
  otherSeat,
  type Seat,
  startMatch,
} from './match';
import { replay } from './replay';
import { mulberry32 } from './shuffle';

// The random-bot fuzz run (T08). `pnpm test:fuzz` sets FUZZ_HANDS=10000; the
// default keeps `pnpm check` fast. Any violation names the match config and
// hand, and FUZZ_SEED reproduces the whole run.

function envInt(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

const FUZZ_HANDS = envInt('FUZZ_HANDS', 500, 1, 10_000_000);
const FUZZ_SEED = envInt('FUZZ_SEED', 20261017, 0, 0xffffffff);
const MAX_REPORTED = 20;
/** No legal match gets near this; it only stops a runaway loop. */
const MAX_ACTIONS_PER_MATCH = 200_000;

const randomInt = (random: () => number, min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));

/** Seeds 0 and 2^32 - 1 first; stacks mostly small so blinds go all-in. */
function pickConfig(random: () => number, matchIndex: number): MatchConfig {
  const seed =
    matchIndex === 0
      ? 0
      : matchIndex === 1
        ? 0xffffffff
        : Math.floor(random() * 2 ** 32);
  const hands = randomInt(random, 1, 200);
  const roll = random();
  const startingStack =
    roll < 0.4
      ? 10
      : roll < 0.7
        ? randomInt(random, 10, 40)
        : roll < 0.9
          ? randomInt(random, 10, 200)
          : randomInt(random, 10, 2000);
  return { seed, hands, startingStack };
}

/** Plain JSON with sorted keys, for cheap deep comparison. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );

/** Any action, for probing the seat that is not to act. */
function anyAction(random: () => number): Action {
  const actions: Action[] = [
    { type: 'fold' },
    { type: 'check' },
    { type: 'call' },
    { type: 'raise', amount: randomInt(random, 1, 4000) },
  ];
  return actions[Math.floor(random() * actions.length)];
}

/** An action the seat to act may not take now. */
function invalidAction(
  legal: LegalAction[],
  random: () => number,
): Action | null {
  const choices: Action[] = [];
  const range = legal.find(option => option.type === 'raise');
  if (range?.type === 'raise') {
    choices.push(
      { type: 'raise', amount: range.min - 1 },
      { type: 'raise', amount: range.max + 1 },
      { type: 'raise', amount: range.min + 0.5 },
    );
  } else {
    choices.push({ type: 'raise', amount: randomInt(random, 1, 4000) });
  }
  if (!legal.some(option => option.type === 'check')) {
    choices.push({ type: 'check' });
  }
  if (!legal.some(option => option.type === 'call')) {
    choices.push({ type: 'call' });
  }
  return choices.length === 0
    ? null
    : choices[Math.floor(random() * choices.length)];
}

describe('fuzz: random legal play', () => {
  it(
    `plays at least ${FUZZ_HANDS} hands (seed ${FUZZ_SEED}) with 0 violations`,
    () => {
      const random = mulberry32(FUZZ_SEED);
      const violations: string[] = [];
      let violationCount = 0;
      let handsPlayed = 0;
      let matchIndex = 0;

      while (handsPlayed < FUZZ_HANDS) {
        const config = pickConfig(random, matchIndex);
        matchIndex++;
        const tag = (state: MatchState) =>
          `[FUZZ_SEED=${FUZZ_SEED} match=${matchIndex} config=${JSON.stringify(config)} hand=${state.handNumber}]`;
        const report = (state: MatchState, message: string) => {
          violationCount++;
          if (violations.length < MAX_REPORTED) {
            violations.push(`${tag(state)} ${message}`);
          }
        };

        let state = startMatch(config);
        const events: HistoryEvent[] = [];
        const allHands: string[] = [];
        let expectedHand = 1;
        let actions = 0;
        let broken = false;

        while (!broken) {
          for (const message of checkState(state)) report(state, message);
          if (state.over) break;
          if (++actions > MAX_ACTIONS_PER_MATCH) {
            report(state, 'match did not end');
            broken = true;
            break;
          }
          const seat = state.toAct as Seat;
          const before = JSON.stringify(state);

          const wrongSeat = applyAction(
            state,
            otherSeat(seat),
            anyAction(random),
          );
          if (wrongSeat.ok || wrongSeat.code !== 'not_your_turn') {
            report(
              state,
              `seat ${otherSeat(seat)} acting out of turn was not rejected with not_your_turn`,
            );
          }

          const legal = legalActions(state);
          if (random() < 0.2) {
            const bad = invalidAction(legal, random);
            if (bad) {
              const result = applyAction(state, seat, bad);
              if (result.ok || result.code !== 'invalid_action') {
                report(
                  state,
                  `${JSON.stringify(bad)} with legal ${JSON.stringify(legal)} was not rejected with invalid_action`,
                );
              }
            }
          }

          const action = randomAction(legal, random);
          const result = applyAction(state, seat, action, {
            timeout: random() < 0.1,
          });
          if (JSON.stringify(state) !== before) {
            report(state, 'applyAction or legalActions changed its input');
          }
          if (!result.ok) {
            report(
              state,
              `bot action ${JSON.stringify(action)} rejected: ${result.code}: ${result.message}`,
            );
            broken = true;
            break;
          }

          for (const hand of result.finishedHands) {
            if (hand.hand_number !== expectedHand) {
              report(
                state,
                `hand ${hand.hand_number} finished, expected ${expectedHand}`,
              );
            }
            expectedHand = hand.hand_number + 1;
            if (hand.stacks[0] + hand.stacks[1] !== 2 * config.startingStack) {
              report(state, `hand ${hand.hand_number} stacks ${hand.stacks}`);
            }
            for (const message of checkHand(hand, config)) {
              report(state, `hand ${hand.hand_number}: ${message}`);
            }
            events.push(...hand.events);
            allHands.push(canonical(hand));
            handsPlayed++;
          }

          const next = result.state;
          const lastRecord = result.finishedHands.at(-1);
          if (lastRecord) {
            const { button_seat: _b, events: _e, ...lastHand } = lastRecord;
            if (canonical(next.lastHand) !== canonical(lastHand)) {
              report(next, 'lastHand differs from the last hand record');
            }
            const behind: [number, number] = [
              next.stacks[0] + next.contributed[0],
              next.stacks[1] + next.contributed[1],
            ];
            if (canonical(behind) !== canonical(lastRecord.stacks)) {
              report(
                next,
                `stacks ${behind} do not continue from the record ${lastRecord.stacks}`,
              );
            }
          }
          state = next;
        }

        if (!broken && state.over) {
          const replayed = replay(config, events);
          if (!replayed.ok) {
            report(
              state,
              `replay rejected event ${replayed.index}: ${replayed.code}: ${replayed.message}`,
            );
          } else {
            if (canonical(replayed.state) !== canonical(state)) {
              report(state, 'replay final state differs');
            }
            if (
              canonical(replayed.hands.map(canonical)) !== canonical(allHands)
            ) {
              report(state, 'replay hand records differ');
            }
          }
        }
      }

      if (violationCount > violations.length) {
        violations.push(
          `... and ${violationCount - violations.length} more violations`,
        );
      }
      expect(violations).toEqual([]);
      expect(handsPlayed).toBeGreaterThanOrEqual(FUZZ_HANDS);
    },
    Math.max(60_000, FUZZ_HANDS * 30),
  );
});
