import { describe, expect, it } from 'vitest';
import { eloUpdate, INITIAL_RATING, K_FACTOR, placesEloUpdate } from './elo';

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

describe('placesEloUpdate', () => {
  it('matches both legacy ratings exactly for every heads-up result', () => {
    let seed = 0x40e10;
    const nextRating = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed / 2 ** 32) * 3000;
    };
    const ratingPairs = [
      [1500, 1500],
      [1623.4, 1377.9],
      [1200, 1900],
      [1900, 1200],
      ...Array.from({ length: 500 }, () => [nextRating(), nextRating()]),
    ];
    const outcomes = [
      { places: [1, 2], score: 1 },
      { places: [2, 1], score: 0 },
      { places: [1, 1], score: 0.5 },
    ] as const;

    for (const [a, b] of ratingPairs) {
      for (const { places, score } of outcomes) {
        const expected = eloUpdate(a, b, score);
        const actual = placesEloUpdate([a, b], places);
        expect(actual).toHaveLength(2);
        expect(actual[0]).toBe(expected[0]);
        expect(actual[1]).toBe(expected[1]);
      }
    }
  });

  it('leaves three equal ratings unchanged when all seats tie', () => {
    expect(placesEloUpdate([1500, 1500, 1500], [1, 1, 1])).toEqual([
      1500, 1500, 1500,
    ]);
  });

  it('scores every pair as a draw when three unequal ratings tie', () => {
    // Rating gaps of 400 and 800 give expected scores 10/11 and 100/101.
    const highDelta = 16 * (0.5 - 10 / 11) + 16 * (0.5 - 100 / 101);
    const actual = placesEloUpdate([1900, 1500, 1100], [1, 1, 1]);
    expect(actual).toHaveLength(3);
    expect(actual[0]).toBeCloseTo(1900 + highDelta, 9);
    expect(actual[1]).toBeCloseTo(1500, 9);
    expect(actual[2]).toBeCloseTo(1100 - highDelta, 9);
  });

  it('uses K = 16 for each pair at a three-seat table', () => {
    expect(placesEloUpdate([1500, 1500, 1500], [1, 2, 3])).toEqual([
      1516, 1500, 1484,
    ]);
  });

  it('uses K = 6.4 for each pair at a six-seat table', () => {
    const actual = placesEloUpdate(Array(6).fill(1500), [1, 2, 3, 4, 5, 6]);
    const expected = [1516, 1509.6, 1503.2, 1496.8, 1490.4, 1484];
    expect(actual).toHaveLength(6);
    for (const [seat, rating] of expected.entries()) {
      expect(actual[seat]).toBeCloseTo(rating, 9);
    }
  });

  it('handles shared second place and preserves seat order', () => {
    const ratings = [1500, 1500, 1500, 1500];
    expect(placesEloUpdate(ratings, [1, 2, 2, 4])).toEqual([
      1516, 1500, 1500, 1484,
    ]);
    expect(placesEloUpdate(ratings, [2, 4, 1, 2])).toEqual([
      1500, 1484, 1516, 1500,
    ]);
  });

  it('sums all pair changes using pre-match ratings before applying them', () => {
    // Each adjacent rating gap is 400; every pair uses K = 16.
    const actual = placesEloUpdate([1900, 1500, 1100], [3, 1, 2]);
    const expected = [
      1900 + 16 * (0 - 10 / 11) + 16 * (0 - 100 / 101),
      1500 + 16 * (1 - 1 / 11) + 16 * (1 - 10 / 11),
      1100 + 16 * (1 - 1 / 101) + 16 * (0 - 1 / 11),
    ];
    expect(actual).toHaveLength(3);
    for (const [seat, rating] of expected.entries()) {
      expect(actual[seat]).toBeCloseTo(rating, 9);
    }
  });

  it('conserves total rating for every supported table size with ties and wins', () => {
    const allRatings = [1823.456, 1211.25, 1500, 2077.875, 999.125, 1624.9];
    for (let seats = 2; seats <= 6; seats++) {
      const ratings = allRatings.slice(0, seats);
      const finishes = [
        Array.from({ length: seats }, (_, seat) => seat + 1),
        Array.from({ length: seats }, (_, seat) => seats - seat),
        Array(seats).fill(1),
        [1, 2, 2, 4, 5, 5].slice(0, seats),
      ];
      for (const places of finishes) {
        const actual = placesEloUpdate(ratings, places);
        expect(actual).toHaveLength(seats);
        expect(actual.reduce((sum, rating) => sum + rating, 0)).toBeCloseTo(
          ratings.reduce((sum, rating) => sum + rating, 0),
          9,
        );
      }
    }
  });

  it.each([
    { ratings: [1500, 1500], places: [1] },
    { ratings: [1500, 1500], places: [1, 2, 3] },
    { ratings: [], places: [] },
    { ratings: [1500], places: [1] },
    { ratings: Array(7).fill(1500), places: [1, 2, 3, 4, 5, 6, 7] },
  ])(
    'rejects unsupported lengths: $ratings / $places',
    ({ ratings, places }) => {
      expect(() => placesEloUpdate(ratings, places)).toThrow(RangeError);
    },
  );
});
