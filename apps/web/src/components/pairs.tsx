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

// Terms and values as a list: `rows` beside each other, `tiles` stacked in
// a grid (the felt's plate). A pair's `className` styles its value in
// `rows`, its whole tile in `tiles`.
export function Pairs({
  items,
  label,
  layout = 'rows',
  className,
}: {
  items: Pair[];
  label?: string;
  layout?: 'rows' | 'tiles';
  className?: string;
}) {
  if (layout === 'tiles') {
    return (
      <dl
        aria-label={label}
        className={cn('grid gap-3 text-ivory text-sm', className)}>
        {items.map(([term, value, itemClass]) => (
          <div
            key={term}
            className={cn('flex flex-col items-center gap-1', itemClass)}>
            <dt className="text-mist text-xs">{term}</dt>
            <dd className="tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl
      aria-label={label}
      className={cn(
        'grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-ivory text-sm',
        className,
      )}>
      {items.map(([term, value, itemClass]) => (
        <div key={term} className="contents">
          <dt className="text-mist">{term}</dt>
          <dd className={cn('tabular-nums', itemClass)}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
