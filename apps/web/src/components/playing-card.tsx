import { Fragment } from 'react';
// Relative, not `@/`: the root vitest config, which runs
// playing-card.test.ts, has no alias.
import { parseCard } from '../lib/format';
import { cn } from '../lib/utils';

const SUIT_COLOR = {
  s: 'text-suit-black',
  h: 'text-suit-red',
  d: 'text-suit-red',
  c: 'text-suit-black',
} as const;

const SUIT_NAME = { s: '黑桃', h: '紅心', d: '方塊', c: '梅花' } as const;

// 5:7. `sm` is the timeline's card, too small for pips: corners only. `md`
// is the table's, about 40×56 on a phone and 56×80 from `sm` up. Everything
// inside is sized in em, from the card's font size.
const SIZE = {
  sm: 'h-[42px] w-[30px] text-[9px]',
  md: 'h-14 w-10 text-[8px] sm:h-20 sm:w-14 sm:text-[11px]',
} as const;

type Size = keyof typeof SIZE;

// Where a real card puts its pips, as [x, y] in the pip area: three columns
// (0, 0.5, 1) from top (0) to bottom (1). Pips below the middle stand upside
// down, as printed.
const PIPS: Record<string, readonly (readonly [number, number])[]> = {
  A: [[0.5, 0.5]],
  '2': [
    [0.5, 0],
    [0.5, 1],
  ],
  '3': [
    [0.5, 0],
    [0.5, 0.5],
    [0.5, 1],
  ],
  '4': [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  '5': [
    [0, 0],
    [1, 0],
    [0.5, 0.5],
    [0, 1],
    [1, 1],
  ],
  '6': [
    [0, 0],
    [1, 0],
    [0, 0.5],
    [1, 0.5],
    [0, 1],
    [1, 1],
  ],
  '7': [
    [0, 0],
    [1, 0],
    [0.5, 0.25],
    [0, 0.5],
    [1, 0.5],
    [0, 1],
    [1, 1],
  ],
  '8': [
    [0, 0],
    [1, 0],
    [0.5, 0.25],
    [0, 0.5],
    [1, 0.5],
    [0.5, 0.75],
    [0, 1],
    [1, 1],
  ],
  '9': [
    [0, 0],
    [1, 0],
    [0, 1 / 3],
    [1, 1 / 3],
    [0.5, 0.5],
    [0, 2 / 3],
    [1, 2 / 3],
    [0, 1],
    [1, 1],
  ],
  '10': [
    [0, 0],
    [1, 0],
    [0.5, 1 / 6],
    [0, 1 / 3],
    [1, 1 / 3],
    [0, 2 / 3],
    [1, 2 / 3],
    [0.5, 5 / 6],
    [0, 1],
    [1, 1],
  ],
};

// One face-up card, as printed: two colours, an index in the top-left
// corner and the same upside down in the bottom-right, and in the middle
// the pips of its rank, or a framed letter for J, Q and K. The corners sit
// left and right of the pips, never on them. Its text is just `A♠`, in the
// top-left index; everything else is drawn by CSS and hidden. `dealIndex`
// deals it in with a short move and flip, 80 ms after the card before it.
export function PlayingCard({
  card,
  size = 'sm',
  dealIndex,
}: {
  card: string;
  size?: Size;
  dealIndex?: number;
}) {
  const { rank, suit, symbol } = parseCard(card);
  const face = rank === 'J' || rank === 'Q' || rank === 'K';
  return (
    <span
      role="img"
      aria-label={`${SUIT_NAME[suit]} ${rank}`}
      style={
        dealIndex === undefined
          ? undefined
          : { animationDelay: `${dealIndex * 80}ms` }
      }
      className={cn(
        'relative inline-block shrink-0 rounded-[6px] bg-card-face font-bold leading-none card-shadow',
        SIZE[size],
        SUIT_COLOR[suit],
        dealIndex !== undefined &&
          'motion-safe:animate-deal motion-reduce:animate-fade',
      )}>
      <span
        data-corner
        className="absolute top-[0.25em] left-[0.2em] flex flex-col items-center tracking-tighter">
        <span>{rank}</span>
        <span>{symbol}</span>
      </span>
      <span
        aria-hidden="true"
        data-corner
        data-rank={rank}
        data-symbol={symbol}
        className="absolute right-[0.2em] bottom-[0.25em] flex rotate-180 flex-col items-center tracking-tighter before:content-[attr(data-rank)] after:content-[attr(data-symbol)]"
      />
      {size === 'md' &&
        (face ? (
          <span
            aria-hidden="true"
            data-face={rank}
            data-symbol={symbol}
            className="absolute inset-x-[30%] inset-y-[22%] flex flex-col items-center justify-center rounded-[2px] border border-current text-[1.6em] before:content-[attr(data-face)] after:text-[0.6em] after:content-[attr(data-symbol)]"
          />
        ) : (
          <span
            aria-hidden="true"
            className="absolute inset-x-[33%] inset-y-[17%]">
            {PIPS[rank]?.map(([x, y]) => (
              <span
                key={`${x},${y}`}
                data-pip
                data-symbol={symbol}
                style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                className={cn(
                  'absolute -translate-x-1/2 -translate-y-1/2 after:content-[attr(data-symbol)]',
                  rank === 'A' ? 'text-[2.6em]' : 'text-[1em]',
                  y > 0.5 && 'rotate-180',
                )}
              />
            ))}
          </span>
        ))}
    </span>
  );
}

// The back of a card, for a card nobody has seen.
export function CardBack({ size = 'sm' }: { size?: Size }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'card-back inline-block shrink-0 rounded-[6px] border border-gold-600/60 card-shadow',
        SIZE[size],
      )}
    />
  );
}

// An empty place on the board for a card not dealt yet.
function CardSlot({ size = 'md' }: { size?: Size }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-block shrink-0 rounded-[6px] border border-ivory/20 border-dashed',
        SIZE[size],
      )}
    />
  );
}

// A row of cards with a space between each, so the text reads `A♠ K♥`; or,
// when they are unknown, two backs that read `未亮牌`.
export function Cards({
  cards,
  size,
  deal = false,
}: {
  cards: readonly string[] | null;
  size?: Size;
  deal?: boolean;
}) {
  if (cards === null) {
    return (
      <span className="inline-flex gap-1">
        <CardBack size={size} />
        <CardBack size={size} />
        <span className="sr-only">未亮牌</span>
      </span>
    );
  }
  return (
    <span className="inline-flex gap-1 [perspective:600px]">
      {cards.map((card, i) => (
        <Fragment key={card}>
          {i > 0 && ' '}
          <PlayingCard
            card={card}
            size={size}
            dealIndex={deal ? i : undefined}
          />
        </Fragment>
      ))}
    </span>
  );
}

// The board in the middle of the table: five places, the cards dealt so far
// and an empty frame for each one still to come. With no card yet it reads
// `emptyText`.
export function Board({
  cards,
  emptyText,
  deal = false,
}: {
  cards: readonly string[];
  emptyText: string;
  deal?: boolean;
}) {
  return (
    <span className="inline-flex gap-1">
      {cards.length > 0 ? (
        <Cards cards={cards} size="md" deal={deal} />
      ) : (
        <span className="sr-only">{emptyText}</span>
      )}
      {Array.from({ length: 5 - cards.length }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: empty places have no identity
        <CardSlot key={i} />
      ))}
    </span>
  );
}
