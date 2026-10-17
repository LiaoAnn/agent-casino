import { type Card, RANKS, SUITS } from './cards';

/** Weakest first: the index is the category's strength. */
const CATEGORIES = [
  'high-card',
  'pair',
  'two-pair',
  'three-of-a-kind',
  'straight',
  'flush',
  'full-house',
  'four-of-a-kind',
  'straight-flush',
] as const;

export type HandCategory = (typeof CATEGORIES)[number];

export interface HandValue {
  category: HandCategory;
  /** Higher beats lower; equal scores tie. */
  score: number;
  /** The best five cards, most important first (the wheel is 5 4 3 2 A). */
  cards: Card[];
}

const rankOf = (card: Card): number =>
  RANKS.indexOf(card[0] as (typeof RANKS)[number]);

/** Best five of 5–7 distinct cards. */
export function evaluateHand(cards: readonly Card[]): HandValue {
  if (cards.length < 5 || cards.length > 7) {
    throw new RangeError(`expected 5 to 7 cards, got ${cards.length}`);
  }
  if (new Set(cards).size !== cards.length) {
    throw new RangeError(`duplicate card in ${cards.join(' ')}`);
  }

  const sorted = [...cards].sort((a, b) => rankOf(b) - rankOf(a));
  const withKickers = (used: Card[]): Card[] =>
    [...used, ...sorted.filter(card => !used.includes(card))].slice(0, 5);

  const flush = SUITS.map(suit => sorted.filter(card => card[1] === suit)).find(
    suited => suited.length >= 5,
  );
  const straightFlush = flush && straightIn(flush);
  if (straightFlush) return value('straight-flush', straightFlush);

  // Same-rank groups, biggest group first, then highest rank.
  const groups: Card[][] = [];
  for (const card of sorted) {
    const last = groups.at(-1);
    if (last && rankOf(last[0]) === rankOf(card)) last.push(card);
    else groups.push([card]);
  }
  groups.sort((a, b) => b.length - a.length);
  const [first, second] = groups;

  if (first.length === 4) return value('four-of-a-kind', withKickers(first));
  if (first.length === 3 && second.length >= 2) {
    return value('full-house', [...first, ...second.slice(0, 2)]);
  }
  if (flush) return value('flush', flush.slice(0, 5));
  const straight = straightIn(sorted);
  if (straight) return value('straight', straight);
  if (first.length === 3) return value('three-of-a-kind', withKickers(first));
  if (first.length === 2 && second.length === 2) {
    return value('two-pair', withKickers([...first, ...second]));
  }
  if (first.length === 2) return value('pair', withKickers(first));
  return value('high-card', sorted.slice(0, 5));
}

/** > 0 if `a` wins, < 0 if `b` wins, 0 on a tie. */
export function compareHands(a: HandValue, b: HandValue): number {
  return a.score - b.score;
}

/** The highest five-card straight among cards sorted high to low. */
function straightIn(sorted: readonly Card[]): Card[] | undefined {
  const byRank = new Map<number, Card>();
  for (const card of sorted) {
    if (!byRank.has(rankOf(card))) byRank.set(rankOf(card), card);
  }
  const ace = RANKS.length - 1;
  // Top card from A down to 5; below 2 the ace plays low.
  for (let top = ace; top >= 3; top--) {
    const run: Card[] = [];
    for (let rank = top; rank > top - 5; rank--) {
      const card = byRank.get(rank < 0 ? ace : rank);
      if (!card) break;
      run.push(card);
    }
    if (run.length === 5) return run;
  }
  return undefined;
}

/** Category first, then the five ranks in order, as base-13 digits. */
function value(category: HandCategory, cards: Card[]): HandValue {
  const score = cards.reduce(
    (total, card) => total * RANKS.length + rankOf(card),
    CATEGORIES.indexOf(category),
  );
  return { category, score, cards };
}
