import { describe, expect, it } from 'vitest';
import { eloUpdate, INITIAL_RATING, K_FACTOR } from './elo';

describe('eloUpdate', () => {
  it('uses the spec constants', () => {
    expect(INITIAL_RATING).toBe(1500);
    expect(K_FACTOR).toBe(32);
  });

  it('moves 16 points when equal ratings play to a win', () => {
    expect(eloUpdate(1500, 1500, 1)).toEqual([1516, 1484]);
    expect(eloUpdate(1500, 1500, 0)).toEqual([1484, 1516]);
  });

  it('leaves equal ratings unchanged on a draw', () => {
    expect(eloUpdate(1500, 1500, 0.5)).toEqual([1500, 1500]);
  });

  it('moves unequal ratings toward each other on a draw', () => {
    const [a, b] = eloUpdate(1600, 1400, 0.5);
    expect(a).toBeLessThan(1600);
    expect(b).toBeGreaterThan(1400);
    expect(a).toBeGreaterThan(b);
    // E_A = 1 / (1 + 10^(-200/400)) ≈ 0.7597
    expect(a).toBeCloseTo(1600 + 32 * (0.5 - 1 / (1 + 10 ** -0.5)), 9);
  });

  it('is zero-sum', () => {
    for (const [a, b] of [
      [1500, 1500],
      [1623.4, 1377.9],
      [1200, 1900],
    ]) {
      for (const score of [0, 0.5, 1] as const) {
        const [newA, newB] = eloUpdate(a, b, score);
        expect(newA + newB).toBeCloseTo(a + b, 9);
      }
    }
  });

  it('gives an underdog win more points than a favourite win', () => {
    const [underdog] = eloUpdate(1400, 1600, 1);
    const [favourite] = eloUpdate(1600, 1400, 1);
    expect(underdog - 1400).toBeGreaterThan(favourite - 1600);
    expect(underdog - 1400).toBeLessThan(K_FACTOR);
    expect(favourite - 1600).toBeGreaterThan(0);
  });

  it('follows the expected-score formula', () => {
    const expectedA = 1 / (1 + 10 ** ((1450 - 1530) / 400));
    const [a, b] = eloUpdate(1530, 1450, 0);
    expect(a).toBeCloseTo(1530 - 32 * expectedA, 9);
    expect(b).toBeCloseTo(1450 + 32 * expectedA, 9);
  });
});
