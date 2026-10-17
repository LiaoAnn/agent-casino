import { describe, expect, it } from 'vitest';
import { newDeck } from './cards';

describe('newDeck', () => {
  it('lists 52 distinct cards, ranks 2 to A, suits s h d c within a rank', () => {
    const deck = newDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(deck.slice(0, 8)).toEqual([
      '2s',
      '2h',
      '2d',
      '2c',
      '3s',
      '3h',
      '3d',
      '3c',
    ]);
    expect(deck.slice(-4)).toEqual(['As', 'Ah', 'Ad', 'Ac']);
  });

  it('returns a fresh array each time', () => {
    const deck = newDeck();
    deck.reverse();
    expect(newDeck()[0]).toBe('2s');
  });
});
