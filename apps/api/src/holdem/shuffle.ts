import { type Card, newDeck } from './cards';

/** bryc's mulberry32: a 32-bit seed to a stream of floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The deck for hand `handNumber` (from 1) of a match: Durstenfeld
 * Fisher–Yates from the end, one random number per swap. `deck[0]` is dealt
 * first. Changing this breaks the replay of every recorded match.
 */
export function shuffledDeck(seed: number, handNumber: number): Card[] {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be a 32-bit unsigned integer: ${seed}`);
  }
  if (!Number.isInteger(handNumber) || handNumber < 1) {
    throw new RangeError(
      `hand number must be an integer from 1: ${handNumber}`,
    );
  }
  const random = mulberry32((seed + handNumber * 0x9e3779b9) >>> 0);
  const deck = newDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export interface Deal {
  /** Indexed by seat. */
  holeCards: [[Card, Card], [Card, Card]];
  /** Flop, flop, flop, turn, river. */
  board: [Card, Card, Card, Card, Card];
}

/** Seat 0, seat 1, seat 0, seat 1, then the board; no burn cards. */
export function dealHand(seed: number, handNumber: number): Deal {
  const deck = shuffledDeck(seed, handNumber);
  return {
    holeCards: [
      [deck[0], deck[2]],
      [deck[1], deck[3]],
    ],
    board: [deck[4], deck[5], deck[6], deck[7], deck[8]],
  };
}
