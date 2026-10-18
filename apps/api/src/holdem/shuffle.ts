import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { type Card, newDeck } from './cards';

/**
 * bryc's mulberry32: a 32-bit seed to a stream of floats in [0, 1). For the
 * house bot and test data only; it is guessable, so never for decks.
 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED_PATTERN = /^[0-9a-f]{64}$/;

/** A match seed: 256 secret bits as 64 lowercase hex characters. */
export const isSeed = (seed: string): boolean => SEED_PATTERN.test(seed);

export const hmacSha256 = (key: Uint8Array, message: Uint8Array): Uint8Array =>
  hmac(sha256, key, message);

/**
 * The uint32 stream for hand `handNumber` (from 1): block k (from 0) is
 * HMAC-SHA256(seed bytes, "agent-casino/deck/v1:<n>:<k>"), read as 8
 * big-endian uint32s.
 */
export function deckStream(seed: string, handNumber: number): () => number {
  if (!isSeed(seed)) {
    throw new RangeError(`seed must be 64 lowercase hex characters: ${seed}`);
  }
  if (!Number.isInteger(handNumber) || handNumber < 1) {
    throw new RangeError(
      `hand number must be an integer from 1: ${handNumber}`,
    );
  }
  const key = hexToBytes(seed);
  const encoder = new TextEncoder();
  let k = 0;
  let block: DataView = new DataView(new ArrayBuffer(0));
  let offset = 0;
  return () => {
    if (offset === block.byteLength) {
      const message = encoder.encode(`agent-casino/deck/v1:${handNumber}:${k}`);
      const digest = hmacSha256(key, message);
      block = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
      offset = 0;
      k++;
    }
    const x = block.getUint32(offset);
    offset += 4;
    return x;
  };
}

/** An unbiased integer in [0, m): uint32s at or above the limit are redrawn. */
export function uniformBelow(next: () => number, m: number): number {
  const limit = 2 ** 32 - (2 ** 32 % m);
  for (;;) {
    const x = next();
    if (x < limit) return x % m;
  }
}

/**
 * The deck for hand `handNumber` (from 1) of a match: Durstenfeld
 * Fisher–Yates from the end, j drawn from deckStream. `deck[0]` is dealt
 * first. Changing this breaks the replay of every recorded match.
 */
export function shuffledDeck(seed: string, handNumber: number): Card[] {
  const next = deckStream(seed, handNumber);
  const deck = newDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = uniformBelow(next, i + 1);
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
export function dealHand(seed: string, handNumber: number): Deal {
  const deck = shuffledDeck(seed, handNumber);
  return {
    holeCards: [
      [deck[0], deck[2]],
      [deck[1], deck[3]],
    ],
    board: [deck[4], deck[5], deck[6], deck[7], deck[8]],
  };
}
