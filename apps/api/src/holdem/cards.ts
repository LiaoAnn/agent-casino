export const RANKS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'T',
  'J',
  'Q',
  'K',
  'A',
] as const;
export const SUITS = ['s', 'h', 'd', 'c'] as const;

type Rank = (typeof RANKS)[number];
type Suit = (typeof SUITS)[number];
/** Two characters, rank then suit, e.g. `Ah`, `Td`, `2c`. */
export type Card = `${Rank}${Suit}`;

/** The 52 cards in the standard order the shuffle starts from. */
export function newDeck(): Card[] {
  return RANKS.flatMap(rank => SUITS.map((suit): Card => `${rank}${suit}`));
}
