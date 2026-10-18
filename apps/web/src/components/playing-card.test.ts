import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PlayingCard } from './playing-card';

const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const suits = [
  { code: 's', name: '黑桃', symbol: '♠', color: 'black' },
  { code: 'h', name: '紅心', symbol: '♥', color: 'red' },
  { code: 'd', name: '方塊', symbol: '♦', color: 'red' },
  { code: 'c', name: '梅花', symbol: '♣', color: 'black' },
] as const;
const sizes = ['sm', 'md'] as const;

function renderCard(card: string, size: 'sm' | 'md') {
  return renderToStaticMarkup(createElement(PlayingCard, { card, size }));
}

function countAttribute(html: string, attribute: string) {
  return [...html.matchAll(new RegExp(`\\s${attribute}(?=[\\s=>])`, 'g'))]
    .length;
}

describe('PlayingCard', () => {
  it.each(ranks)('renders the central pips and face for md rank %s', rank => {
    const html = renderCard(`${rank}s`, 'md');
    const isFace = ['J', 'Q', 'K'].includes(rank);
    const pipCount = isFace
      ? 0
      : rank === 'A'
        ? 1
        : rank === 'T'
          ? 10
          : Number(rank);

    expect(countAttribute(html, 'data-pip')).toBe(pipCount);
    expect(countAttribute(html, 'data-face')).toBe(isFace ? 1 : 0);
    if (isFace) {
      expect(html).toContain(`data-face="${rank}"`);
    }
  });

  it.each(ranks)('renders only corners for sm rank %s', rank => {
    const html = renderCard(`${rank}h`, 'sm');

    expect(countAttribute(html, 'data-corner')).toBe(2);
    expect(countAttribute(html, 'data-pip')).toBe(0);
    expect(countAttribute(html, 'data-face')).toBe(0);
  });

  const cards = sizes.flatMap(size =>
    suits.flatMap(suit =>
      ranks.map(rank => ({ size, suit, rank, card: `${rank}${suit.code}` })),
    ),
  );

  it.each(cards)(
    '$size $card has two corners, the suit color, accessible name, and one text label',
    ({ size, suit, rank, card }) => {
      const html = renderCard(card, size);
      const root = html.match(/^<[^>]+>/)?.[0] ?? '';
      const classes = root.match(/\sclass="([^"]*)"/)?.[1]?.split(/\s+/) ?? [];
      const displayRank = rank === 'T' ? '10' : rank;

      expect(root).toContain('role="img"');
      expect(root).toContain(`aria-label="${suit.name} ${displayRank}"`);
      expect(classes).toContain(`text-suit-${suit.color}`);
      expect(classes).not.toContain(
        `text-suit-${suit.color === 'black' ? 'red' : 'black'}`,
      );
      expect(countAttribute(html, 'data-corner')).toBe(2);
      expect(html.replace(/<[^>]*>/g, '')).toBe(`${displayRank}${suit.symbol}`);
    },
  );
});
