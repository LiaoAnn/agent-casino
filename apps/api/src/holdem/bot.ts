import type { Action, LegalAction } from './match';

/**
 * The house-bot strategy: random but legal. It draws only from `random`
 * (e.g. `mulberry32(seed)`), so the same stream plays the same actions.
 * Never folds when it could check.
 */
export function randomAction(
  legal: LegalAction[],
  random: () => number,
): Action {
  if (legal.length === 0) {
    throw new RangeError('No legal actions: it is nobody’s turn');
  }
  const canCheck = legal.some(action => action.type === 'check');
  const raise = legal.find(action => action.type === 'raise');
  const roll = random();
  if (raise?.type === 'raise' && roll < (canCheck ? 0.35 : 0.3)) {
    return { type: 'raise', amount: raiseAmount(raise, random) };
  }
  if (canCheck) return { type: 'check' };
  if (roll >= 0.8) return { type: 'fold' };
  return { type: 'call' };
}

/** A third at the minimum, a sixth all-in, the rest anywhere in between. */
function raiseAmount(
  { min, max }: { min: number; max: number },
  random: () => number,
): number {
  const roll = random();
  if (roll < 1 / 3) return min;
  if (roll < 1 / 2) return max;
  return min + Math.floor(random() * (max - min + 1));
}
