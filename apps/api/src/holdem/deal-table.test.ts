import { describe, expect, it } from 'vitest';
import { dealHand, dealTable, shuffledDeck } from './shuffle';

const seeds = ['0'.repeat(64), '1'.repeat(64), '0123456789abcdef'.repeat(4)];

describe('dealTable: seat-order dealing without burn cards', () => {
  for (const players of [2, 3, 4, 5, 6]) {
    for (const hand of [1, 2, 17]) {
      it(`${players} players, hand ${hand}: k and A+k, then five board cards`, () => {
        for (const seed of seeds) {
          const deck = shuffledDeck(seed, hand);
          const deal = dealTable(seed, hand, players);
          expect(deal.holeCards).toEqual(
            Array.from({ length: players }, (_, k) => [
              deck[k],
              deck[players + k],
            ]),
          );
          expect(deal.board).toEqual(deck.slice(2 * players, 2 * players + 5));
          expect(new Set([...deal.holeCards.flat(), ...deal.board]).size).toBe(
            2 * players + 5,
          );
        }
      });
    }
  }

  it('two players preserve every card in the legacy deal', () => {
    for (const seed of seeds) {
      for (const hand of [1, 2, 50, 100]) {
        expect(dealTable(seed, hand, 2)).toEqual(dealHand(seed, hand));
      }
    }
  });
});
