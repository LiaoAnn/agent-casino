import { Fragment } from 'react';
import { parseCard } from '@/lib/format';
import { cn } from '@/lib/utils';

const SUIT_COLOR = {
  s: 'text-suit-spade',
  h: 'text-suit-heart',
  d: 'text-suit-diamond',
  c: 'text-suit-club',
} as const;

const SIZE = {
  sm: 'h-12 w-9 text-xs',
  md: 'h-16 w-12 text-sm',
} as const;

const PIP = { sm: 'text-base', md: 'text-2xl' } as const;

type Size = keyof typeof SIZE;

// One face-up card in four colours. Its text is just `A♠`, in the corner;
// the big suit in the middle is drawn by CSS and hidden from screen readers. `dealIndex` deals it in with
// a short move and flip, 80 ms after the card before it.
function PlayingCard({
  card,
  size = 'sm',
  dealIndex,
}: {
  card: string;
  size?: Size;
  dealIndex?: number;
}) {
  const { rank, suit, symbol } = parseCard(card);
  return (
    <span
      style={
        dealIndex === undefined
          ? undefined
          : { animationDelay: `${dealIndex * 80}ms` }
      }
      className={cn(
        'relative inline-flex shrink-0 flex-col items-start rounded-[6px] bg-card-face px-1 py-0.5 font-bold leading-none card-shadow',
        SIZE[size],
        SUIT_COLOR[suit],
        dealIndex !== undefined &&
          'motion-safe:animate-deal motion-reduce:animate-fade',
      )}>
      <span>{rank}</span>
      <span>{symbol}</span>
      <span
        aria-hidden="true"
        data-symbol={symbol}
        className={cn(
          'absolute inset-0 flex items-center justify-center pt-2 after:content-[attr(data-symbol)]',
          PIP[size],
        )}
      />
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
