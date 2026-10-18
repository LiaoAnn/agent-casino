import type { MatchDetail } from '@agent-casino/api/src/contract/schemas';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// `alice 41 · Bob 39`, where the values may be cards.
export function BySeat({
  players,
  values,
}: {
  players: MatchDetail['players'];
  values: readonly [ReactNode, ReactNode];
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="inline-flex items-center gap-2">
        {players[0]} {values[0]}
      </span>{' '}
      <span aria-hidden="true" className="text-mist">
        ·
      </span>{' '}
      <span className="inline-flex items-center gap-2">
        {players[1]} {values[1]}
      </span>
    </span>
  );
}

export type Pair = [string, ReactNode, string?];

// Terms and values as a list, each value beside its term. A pair's
// `className` styles its value.
export function Pairs({
  items,
  label,
  className,
}: {
  items: Pair[];
  label?: string;
  className?: string;
}) {
  return (
    <dl
      aria-label={label}
      className={cn(
        'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-ivory text-sm sm:gap-x-6',
        className,
      )}>
      {items.map(([term, value, itemClass]) => (
        <div key={term} className="contents">
          <dt className="whitespace-nowrap text-mist">{term}</dt>
          {/* Long values such as the 64-hex seed wrap instead of widening the page. */}
          <dd
            className={cn('tabular-nums [overflow-wrap:anywhere]', itemClass)}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
