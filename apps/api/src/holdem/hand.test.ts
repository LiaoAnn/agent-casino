import { describe, expect, it } from 'vitest';
import { type Card, newDeck } from './cards';
import {
  compareHands,
  evaluateHand,
  type HandCategory,
  type HandValue,
} from './hand';

const hand = (text: string): Card[] => text.split(' ') as Card[];
const ranksOf = (value: HandValue): string =>
  value.cards.map(card => card[0]).join('');
const evalText = (text: string): HandValue => evaluateHand(hand(text));
const compareText = (a: string, b: string): number =>
  compareHands(evalText(a), evalText(b));

const CATEGORIES_LOW_TO_HIGH: HandCategory[] = [
  'high-card',
  'pair',
  'two-pair',
  'three-of-a-kind',
  'straight',
  'flush',
  'full-house',
  'four-of-a-kind',
  'straight-flush',
];

interface Enumeration {
  hands: Record<HandCategory, number>;
  scores: Record<HandCategory, Set<number>>;
  minScore: Record<HandCategory, number>;
  maxScore: Record<HandCategory, number>;
  nonIntegerScores: number;
  total: number;
}

let enumeration: Enumeration | undefined;

/** Evaluates every one of the C(52,5) five-card hands once. */
function enumerateAllFiveCardHands(): Enumeration {
  if (enumeration) return enumeration;
  const perCategory = <T>(make: () => T) =>
    Object.fromEntries(
      CATEGORIES_LOW_TO_HIGH.map(category => [category, make()]),
    ) as Record<HandCategory, T>;
  const result: Enumeration = {
    hands: perCategory(() => 0),
    scores: perCategory(() => new Set<number>()),
    minScore: perCategory(() => Number.POSITIVE_INFINITY),
    maxScore: perCategory(() => Number.NEGATIVE_INFINITY),
    nonIntegerScores: 0,
    total: 0,
  };
  const deck = newDeck();
  for (let a = 0; a < 48; a++) {
    for (let b = a + 1; b < 49; b++) {
      for (let c = b + 1; c < 50; c++) {
        for (let d = c + 1; d < 51; d++) {
          for (let e = d + 1; e < 52; e++) {
            const { category, score } = evaluateHand([
              deck[a],
              deck[b],
              deck[c],
              deck[d],
              deck[e],
            ]);
            result.total++;
            result.hands[category]++;
            result.scores[category].add(score);
            if (!Number.isInteger(score)) result.nonIntegerScores++;
            if (score < result.minScore[category]) {
              result.minScore[category] = score;
            }
            if (score > result.maxScore[category]) {
              result.maxScore[category] = score;
            }
          }
        }
      }
    }
  }
  enumeration = result;
  return result;
}

describe('evaluateHand over all 2,598,960 five-card hands', () => {
  // Reference numbers: Wikipedia "Poker probability", section "5-card poker
  // hands" (frequency column and "distinct hands" column). The distinct-hand
  // counts are the same 7,462 equivalence classes as Cactus Kev's evaluator
  // (suffe.cool/poker/evaluator.html). Royal flush is counted in straight
  // flush (4 + 36 = 40; 1 + 9 = 10 distinct).
  it('matches the public frequency of each category', () => {
    const { hands, total, nonIntegerScores } = enumerateAllFiveCardHands();
    expect(total).toBe(2_598_960);
    expect(nonIntegerScores).toBe(0);
    expect(hands).toEqual({
      'straight-flush': 40,
      'four-of-a-kind': 624,
      'full-house': 3_744,
      flush: 5_108,
      straight: 10_200,
      'three-of-a-kind': 54_912,
      'two-pair': 123_552,
      pair: 1_098_240,
      'high-card': 1_302_540,
    });
  }, 60_000);

  it('gives each category the public number of distinct strengths', () => {
    const { scores } = enumerateAllFiveCardHands();
    const distinct = Object.fromEntries(
      CATEGORIES_LOW_TO_HIGH.map(category => [category, scores[category].size]),
    );
    expect(distinct).toEqual({
      'straight-flush': 10,
      'four-of-a-kind': 156,
      'full-house': 156,
      flush: 1_277,
      straight: 10,
      'three-of-a-kind': 858,
      'two-pair': 858,
      pair: 2_860,
      'high-card': 1_277,
    });
    const all = new Set<number>();
    for (const category of CATEGORIES_LOW_TO_HIGH) {
      for (const score of scores[category]) all.add(score);
    }
    expect(all.size).toBe(7_462);
  }, 60_000);

  it('orders score ranges by category without overlap', () => {
    const { minScore, maxScore } = enumerateAllFiveCardHands();
    for (let i = 1; i < CATEGORIES_LOW_TO_HIGH.length; i++) {
      const lower = CATEGORIES_LOW_TO_HIGH[i - 1];
      const higher = CATEGORIES_LOW_TO_HIGH[i];
      expect(maxScore[lower], `every ${lower} < every ${higher}`).toBeLessThan(
        minScore[higher],
      );
    }
  }, 60_000);
});

describe('evaluateHand: straights and the wheel', () => {
  it('counts A2345 as a straight, ordered 5 4 3 2 A', () => {
    const wheel = evalText('Ah 2c 3d 4s 5h');
    expect(wheel.category).toBe('straight');
    expect(ranksOf(wheel)).toBe('5432A');
  });

  it('ranks the wheel as the lowest straight: A2345 < 23456', () => {
    expect(compareText('Ah 2c 3d 4s 5h', '2c 3d 4s 5h 6h')).toBeLessThan(0);
    expect(compareText('2c 3d 4s 5h 6h', 'Ah 2c 3d 4s 5h')).toBeGreaterThan(0);
  });

  it('counts TJQKA as the highest straight', () => {
    const broadway = evalText('Ts Jd Qh Kc Ah');
    expect(broadway.category).toBe('straight');
    expect(ranksOf(broadway)).toBe('AKQJT');
    expect(compareText('Ts Jd Qh Kc Ah', '9s Ts Jd Qh Kc')).toBeGreaterThan(0);
  });

  it('does not wrap around the ace: QKA23 is high card', () => {
    expect(evalText('Qh Kd Ac 2s 3h').category).toBe('high-card');
  });

  it('picks the highest five of a longer straight', () => {
    const seven = evalText('4c 5d 6h 7s 8c 9d Th');
    expect(seven.category).toBe('straight');
    expect(ranksOf(seven)).toBe('T9876');
    const sixHigh = evalText('Ah 2c 3d 4s 5h 6c Kd');
    expect(sixHigh.category).toBe('straight');
    expect(ranksOf(sixHigh)).toBe('65432');
  });

  it('beats three of a kind with a straight and loses to a flush', () => {
    expect(compareText('2c 3d 4s 5h 6h', 'Ah Ad Ac Kd Qs')).toBeGreaterThan(0);
    expect(compareText('2c 3d 4s 5h 6h', '2h 4h 6h 8h Th')).toBeLessThan(0);
  });
});

describe('evaluateHand: straight flushes', () => {
  it('recognises a royal flush as the top straight flush', () => {
    const royal = evalText('Ts Js Qs Ks As');
    expect(royal.category).toBe('straight-flush');
    expect(royal.cards).toEqual(['As', 'Ks', 'Qs', 'Js', 'Ts']);
    expect(compareText('Ts Js Qs Ks As', '9h Th Jh Qh Kh')).toBeGreaterThan(0);
  });

  it('ranks the wheel straight flush below 6-high but above quads', () => {
    const steelWheel = evalText('Ah 2h 3h 4h 5h');
    expect(steelWheel.category).toBe('straight-flush');
    expect(steelWheel.cards).toEqual(['5h', '4h', '3h', '2h', 'Ah']);
    expect(compareText('Ah 2h 3h 4h 5h', '2s 3s 4s 5s 6s')).toBeLessThan(0);
    expect(compareText('Ah 2h 3h 4h 5h', 'Ac Ad As Kh Kc')).toBeGreaterThan(0);
  });

  it('finds the straight flush even when a higher plain straight exists', () => {
    const value = evalText('5h 6h 7h 8h 9h Td 2c');
    expect(value.category).toBe('straight-flush');
    expect(value.cards).toEqual(['9h', '8h', '7h', '6h', '5h']);
  });

  it('prefers a flush when the straight and flush cards differ', () => {
    const value = evalText('5h 6d 7h 8h 9c Kh 2h');
    expect(value.category).toBe('flush');
    expect(value.cards).toEqual(['Kh', '8h', '7h', '5h', '2h']);
  });
});

describe('evaluateHand: four of a kind and full house', () => {
  it('decides equal quads by the kicker', () => {
    const board = 'Qh Qd Qc Qs 2c';
    const a = evalText(`${board} Ah 3c`);
    expect(a.category).toBe('four-of-a-kind');
    expect(ranksOf(a)).toBe('QQQQA');
    expect(compareHands(a, evalText(`${board} Kh Kc`))).toBeGreaterThan(0);
    expect(compareHands(a, evalText(`${board} As 7d`))).toBe(0);
  });

  it('beats a full house with four of a kind', () => {
    expect(compareText('2c 2d 2h 2s 3c', 'Ac Ad Ah Kc Kd')).toBeGreaterThan(0);
  });

  it('compares full houses by the trips first: 333AA < 44422', () => {
    const low = evalText('3h 3d 3c Ah Ad');
    expect(low.category).toBe('full-house');
    expect(ranksOf(low)).toBe('333AA');
    expect(compareHands(low, evalText('4h 4d 4c 2h 2d'))).toBeLessThan(0);
  });

  it('compares full houses with equal trips by the pair', () => {
    expect(compareText('Kh Kd Kc 9s 9h', 'Kh Kd Ks 8s 8h')).toBeGreaterThan(0);
  });

  it('makes a full house from two trips, using the higher as trips', () => {
    const value = evalText('9h 9d 9c 5s 5h 5d Kc');
    expect(value.category).toBe('full-house');
    expect(ranksOf(value)).toBe('99955');
  });

  it('beats a flush with a full house', () => {
    expect(compareText('2c 2d 2h 3s 3c', 'Ah Kh Qh Jh 9h')).toBeGreaterThan(0);
  });
});

describe('evaluateHand: flushes', () => {
  it('decides flushes down to the fifth card', () => {
    const a = evalText('Ah Jh 9h 6h 4h');
    expect(a.category).toBe('flush');
    expect(a.cards).toEqual(['Ah', 'Jh', '9h', '6h', '4h']);
    expect(compareHands(a, evalText('As Js 9s 6s 3s'))).toBeGreaterThan(0);
  });

  it('picks the top five of a six- or seven-card flush', () => {
    const six = evalText('Ah Kh 9h 7h 4h 2h');
    expect(six.category).toBe('flush');
    expect(six.cards).toEqual(['Ah', 'Kh', '9h', '7h', '4h']);
    const seven = evalText('2h 4h 7h 9h Kh Ah 3s');
    expect(seven.cards).toEqual(['Ah', 'Kh', '9h', '7h', '4h']);
  });
});

describe('evaluateHand: trips, pairs and high card', () => {
  it('decides equal trips by the first and then the second kicker', () => {
    const board = '7h 7d 7c 2s 3d';
    const ace5 = evalText(`${board} Ah 5c`);
    expect(ace5.category).toBe('three-of-a-kind');
    expect(ranksOf(ace5)).toBe('777A5');
    expect(compareHands(ace5, evalText(`${board} Kh Qc`))).toBeGreaterThan(0);
    expect(compareHands(ace5, evalText(`${board} As 4c`))).toBeGreaterThan(0);
  });

  it('decides equal two pair by the kicker', () => {
    const a = evalText('Kh Kd 8c 8s As');
    expect(a.category).toBe('two-pair');
    expect(ranksOf(a)).toBe('KK88A');
    expect(compareHands(a, evalText('Ks Kc 8h 8d Qc'))).toBeGreaterThan(0);
  });

  it('compares two pair by the high pair, then the low pair', () => {
    expect(compareText('Ah Ad 2c 2s 3h', 'Kh Kd Qc Qs Jh')).toBeGreaterThan(0);
    expect(compareText('Ah Ad 9c 9s 3h', 'As Ac 8h 8d Kh')).toBeGreaterThan(0);
  });

  it('keeps the best two of three pairs and the best kicker', () => {
    const sixKicker = evalText('Ah Ad 8c 8s 4h 4d 6c');
    expect(sixKicker.category).toBe('two-pair');
    expect(ranksOf(sixKicker)).toBe('AA886');
    expect(ranksOf(evalText('Ah Ad 8c 8s 4h 4d 2c'))).toBe('AA884');
  });

  it('can use a third pair as the kicker with two pair on the board', () => {
    const board = 'Kh Kd 8c 8s 2h';
    const sevens = evalText(`${board} 7c 7d`);
    expect(sevens.category).toBe('two-pair');
    expect(ranksOf(sevens)).toBe('KK887');
    expect(compareHands(sevens, evalText(`${board} 6c 3d`))).toBeGreaterThan(0);
    expect(compareHands(sevens, evalText(`${board} Qc 3d`))).toBeLessThan(0);
  });

  it('decides equal pairs by the kickers down to the last one', () => {
    const a = evalText('Ah Ad Kc 7s 3h');
    expect(a.category).toBe('pair');
    expect(ranksOf(a)).toBe('AAK73');
    expect(compareHands(a, evalText('As Ac Qd 7h 3c'))).toBeGreaterThan(0);
    expect(compareHands(a, evalText('As Ac Kd 7h 2c'))).toBeGreaterThan(0);
    expect(compareText('2h 2d 3c 4s 5h', 'Ah Kd Qc Js 9h')).toBeGreaterThan(0);
  });

  it('ignores the two worst cards of seven', () => {
    const value = evalText('2c 7d Ah Ad Kc Qs 9h');
    expect(value.category).toBe('pair');
    expect(ranksOf(value)).toBe('AAKQ9');
  });

  it('decides high card down to the fifth card', () => {
    const a = evalText('Ah Qd 9c 6s 4h');
    expect(a.category).toBe('high-card');
    expect(ranksOf(a)).toBe('AQ964');
    expect(compareHands(a, evalText('Ac Qs 9d 6h 3c'))).toBeGreaterThan(0);
    expect(compareHands(evalText('Ac Qs 9d 6h 3c'), a)).toBeLessThan(0);
  });
});

describe('compareHands: ties', () => {
  it('splits when the board plays for both players', () => {
    const board = 'Ts Jd Qh Kc Ac';
    const a = evalText(`${board} 2h 3d`);
    const b = evalText(`${board} 4h 5d`);
    expect(a.category).toBe('straight');
    expect(ranksOf(a)).toBe('AKQJT');
    expect(compareHands(a, b)).toBe(0);
    expect(a.score).toBe(b.score);
  });

  it('ties identical strengths in different suits', () => {
    expect(compareText('Ah Kd 9c 6s 4h', 'As Kc 9d 6h 4c')).toBe(0);
    expect(compareText('2h 4h 6h 8h Th', '2s 4s 6s 8s Ts')).toBe(0);
  });
});

describe('evaluateHand: seven cards mixing categories', () => {
  it('prefers a flush over a pair, two pair or trips in the same cards', () => {
    const overTrips = evalText('Ah Kh 9h 7h 4h As Ad');
    expect(overTrips.category).toBe('flush');
    expect(overTrips.cards).toEqual(['Ah', 'Kh', '9h', '7h', '4h']);
    const overTwoPair = evalText('Ah Kh 9h 7h 4h As Kd');
    expect(overTwoPair.category).toBe('flush');
    expect(overTwoPair.cards).toEqual(['Ah', 'Kh', '9h', '7h', '4h']);
    const overPair = evalText('2h 5h 9h Jh Kh Ks 3d');
    expect(overPair.category).toBe('flush');
    expect(overPair.cards).toEqual(['Kh', 'Jh', '9h', '5h', '2h']);
  });

  it('prefers a straight with a pair inside the run over the pair', () => {
    const value = evalText('5c 6d 7h 7s 8c 9d 2h');
    expect(value.category).toBe('straight');
    expect(ranksOf(value)).toBe('98765');
  });

  it('prefers a straight over two pair or trips inside the run', () => {
    const overTwoPair = evalText('5c 6d 7h 7s 8c 8d 9h');
    expect(overTwoPair.category).toBe('straight');
    expect(ranksOf(overTwoPair)).toBe('98765');
    const overTrips = evalText('5c 6d 7h 7s 7c 8d 9h');
    expect(overTrips.category).toBe('straight');
    expect(ranksOf(overTrips)).toBe('98765');
  });

  it('finds the wheel when one of its cards is paired', () => {
    const pairedAce = evalText('Ah Ad 2c 3s 4h 5d Kc');
    expect(pairedAce.category).toBe('straight');
    expect(ranksOf(pairedAce)).toBe('5432A');
    const pairedThree = evalText('Ah 2c 3s 3d 4h 5d Kc');
    expect(pairedThree.category).toBe('straight');
    expect(ranksOf(pairedThree)).toBe('5432A');
  });

  it('beats a straight with a full house on the same board', () => {
    // One player cannot hold both in 7 cards: trips plus a pair leave room
    // for at most four distinct ranks.
    const board = '7h 7d 8c 9s Tc';
    const straight = evalText(`${board} Js 2d`);
    const fullHouse = evalText(`${board} 7c 8h`);
    expect(straight.category).toBe('straight');
    expect(ranksOf(straight)).toBe('JT987');
    expect(fullHouse.category).toBe('full-house');
    expect(ranksOf(fullHouse)).toBe('77788');
    expect(compareHands(fullHouse, straight)).toBeGreaterThan(0);
  });

  it('beats a flush with quads on the same board', () => {
    const board = '9h 9d 9c 4h 2h';
    const flush = evalText(`${board} Ah Kh`);
    const quads = evalText(`${board} 9s 3c`);
    expect(flush.category).toBe('flush');
    expect(quads.category).toBe('four-of-a-kind');
    expect(ranksOf(quads)).toBe('99994');
    expect(compareHands(quads, flush)).toBeGreaterThan(0);
  });
});

describe('evaluateHand: seven cards agree with the best five-card subset', () => {
  // A small LCG (Numerical Recipes constants) so the hands are fixed.
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
  }

  it('scores 4,000 deterministic 7-card hands as their best 5', () => {
    const next = lcg(20_261_017);
    const seen = new Set<HandCategory>();
    for (let n = 0; n < 4_000; n++) {
      const deck = newDeck();
      // Partial Fisher-Yates: the first 7 cards are a uniform sample.
      for (let i = 0; i < 7; i++) {
        const j = i + (next() % (52 - i));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      const seven = deck.slice(0, 7);
      let best: HandValue | undefined;
      for (let skipA = 0; skipA < 7; skipA++) {
        for (let skipB = skipA + 1; skipB < 7; skipB++) {
          const five = seven.filter((_, k) => k !== skipA && k !== skipB);
          const value = evaluateHand(five);
          if (!best || value.score > best.score) best = value;
        }
      }
      const actual = evaluateHand(seven);
      const label = seven.join(' ');
      expect(actual.score, label).toBe(best?.score);
      expect(actual.category, label).toBe(best?.category);
      seen.add(actual.category);
    }
    // The sample must reach the categories that mix with pairs.
    expect(seen).toContain('straight');
    expect(seen).toContain('flush');
    expect(seen).toContain('full-house');
  });
});

describe('evaluateHand input checks', () => {
  it('accepts 5, 6 and 7 cards and always returns five', () => {
    expect(evalText('Ah Kd 9c 6s 4h').cards).toHaveLength(5);
    expect(evalText('Ah Kd 9c 6s 4h 2c').cards).toHaveLength(5);
    expect(evalText('Ah Kd 9c 6s 4h 2c 3d').cards).toHaveLength(5);
  });

  it('throws for 4 or 8 cards', () => {
    expect(() => evalText('Ah Kd 9c 6s')).toThrow();
    expect(() => evalText('Ah Kd 9c 6s 4h 2c 3d Js')).toThrow();
  });

  it('throws for a duplicated card', () => {
    expect(() => evalText('Ah Kd 9c 6s Ah')).toThrow();
    expect(() => evalText('Ah Kd 9c 6s 4h 2c 2c')).toThrow();
  });
});
