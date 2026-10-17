import { describe, expect, it } from 'vitest';
import { type Card, newDeck } from './cards';
import { dealHand, mulberry32, shuffledDeck } from './shuffle';

// Golden values below were produced by a throwaway Node script (not the
// project's implementation) that copies the holdem-rules skill's reference
// mulberry32 snippet verbatim, seeds it with `(seed + n * 0x9E3779B9) >>> 0`,
// and runs Durstenfeld Fisher-Yates (i = 51 down to 1,
// j = Math.floor(rng() * (i + 1)), swap) over the standard 2s..Ac deck.
// These values must never change: old matches are replayed from them.

const UINT32_MAX = 0xffffffff;

describe('mulberry32', () => {
  it('matches the reference outputs for seed 0', () => {
    const rng = mulberry32(0);
    expect([rng(), rng(), rng(), rng()]).toEqual([
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197,
      0.1462021479383111,
    ]);
  });

  it('matches the reference outputs for seed 0xDEADBEEF', () => {
    const rng = mulberry32(0xdeadbeef);
    expect([rng(), rng(), rng(), rng()]).toEqual([
      0.9413696140982211, 0.26719574979506433, 0.772033357527107,
      0.35816076025366783,
    ]);
  });

  it('outputs floats in [0, 1)', () => {
    const rng = mulberry32(123456789);
    for (let i = 0; i < 10_000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

const GOLDEN: {
  seed: number;
  hand: number;
  first9: Card[];
}[] = [
  {
    seed: 0,
    hand: 1,
    first9: ['9s', 'Kh', 'Jh', '8c', '3c', 'Qc', '8h', '4c', 'As'],
  },
  {
    // seed + n * 0x9E3779B9 overflows 32 bits; derived seed 2654435768
    seed: UINT32_MAX,
    hand: 1,
    first9: ['Qd', 'Th', '7c', 'Qh', 'Ac', '8c', '7h', 'Js', '2h'],
  },
  {
    // derived seed 3668340010
    seed: UINT32_MAX,
    hand: 3,
    first9: ['9c', '8s', '7s', '2s', '7h', '3d', 'Ts', '4s', 'Qc'],
  },
  {
    // derived seed 2606188737
    seed: 12345,
    hand: 200,
    first9: ['Ts', 'Jc', '3s', '2c', '9c', 'Qd', '5d', '4c', 'Jh'],
  },
  {
    // derived seed 454865505
    seed: 0xdeadbeef,
    hand: 2,
    first9: ['9h', '3d', 'Qc', 'Ac', '4c', 'Jh', '8s', 'Kh', 'Kc'],
  },
];

describe('shuffledDeck', () => {
  it.each(GOLDEN)(
    'seed $seed hand $hand deals the golden first 9 cards',
    ({ seed, hand, first9 }) => {
      expect(shuffledDeck(seed, hand).slice(0, 9)).toEqual(first9);
    },
  );

  it('pins the full 52-card deck for seed 0 hand 1', () => {
    expect(shuffledDeck(0, 1)).toEqual([
      '9s',
      'Kh',
      'Jh',
      '8c',
      '3c',
      'Qc',
      '8h',
      '4c',
      'As',
      'Ts',
      'Kc',
      '6s',
      '4d',
      '6h',
      'Qs',
      'Ad',
      '2s',
      'Jd',
      '2d',
      'Jc',
      '7d',
      'Ac',
      '5c',
      '9c',
      '4s',
      'Ah',
      'Kd',
      'Td',
      '8d',
      '8s',
      'Qd',
      '9d',
      'Qh',
      '3d',
      '9h',
      'Js',
      '4h',
      '2c',
      '5h',
      'Tc',
      '5s',
      '7h',
      '7c',
      '6c',
      '7s',
      '2h',
      '5d',
      '3s',
      'Ks',
      'Th',
      '3h',
      '6d',
    ]);
  });

  it('shuffles the same seed and hand number identically twice', () => {
    for (const { seed, hand } of GOLDEN) {
      expect(shuffledDeck(seed, hand)).toEqual(shuffledDeck(seed, hand));
    }
  });

  it('gives different hands of the same seed different decks', () => {
    const decks = [1, 2, 3, 4, 5].map(hand => shuffledDeck(42, hand).join());
    expect(new Set(decks).size).toBe(decks.length);
  });

  it('always returns a permutation of the 52 cards', () => {
    const sorted = [...newDeck()].sort();
    for (let i = 0; i < 300; i++) {
      const seed = (i * 2654435761) >>> 0;
      const deck = shuffledDeck(seed, (i % 7) + 1);
      expect(deck).toHaveLength(52);
      expect([...deck].sort()).toEqual(sorted);
    }
    expect([...shuffledDeck(UINT32_MAX, 1)].sort()).toEqual(sorted);
  });

  it('does not share state between calls', () => {
    const first = shuffledDeck(0, 1);
    const copy = [...first];
    first.reverse();
    first[0] = '2s';
    expect(shuffledDeck(0, 1)).toEqual(copy);
  });

  it.each([-1, 2 ** 32, 1.5, Number.NaN])(
    'throws RangeError for seed %s',
    seed => {
      expect(() => shuffledDeck(seed, 1)).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5])('throws RangeError for hand number %s', hand => {
    expect(() => shuffledDeck(0, hand)).toThrow(RangeError);
  });

  it('accepts the seed bounds 0 and 2^32 - 1', () => {
    expect(() => shuffledDeck(0, 1)).not.toThrow();
    expect(() => shuffledDeck(UINT32_MAX, 1)).not.toThrow();
  });
});

describe('dealHand', () => {
  it.each(GOLDEN)(
    'seed $seed hand $hand deals hole cards and board in order',
    ({ seed, hand, first9 }) => {
      const [c0, c1, c2, c3, f1, f2, f3, turn, river] = first9;
      expect(dealHand(seed, hand)).toEqual({
        holeCards: [
          [c0, c2],
          [c1, c3],
        ],
        board: [f1, f2, f3, turn, river],
      });
    },
  );

  it('matches the first 9 cards of shuffledDeck', () => {
    for (let hand = 1; hand <= 20; hand++) {
      const deck = shuffledDeck(777, hand);
      const { holeCards, board } = dealHand(777, hand);
      expect([
        holeCards[0][0],
        holeCards[1][0],
        holeCards[0][1],
        holeCards[1][1],
        ...board,
      ]).toEqual(deck.slice(0, 9));
    }
  });

  it.each([-1, 2 ** 32, 1.5, Number.NaN])(
    'throws RangeError for seed %s',
    seed => {
      expect(() => dealHand(seed, 1)).toThrow(RangeError);
    },
  );

  it.each([0, -1, 1.5])('throws RangeError for hand number %s', hand => {
    expect(() => dealHand(0, hand)).toThrow(RangeError);
  });
});
