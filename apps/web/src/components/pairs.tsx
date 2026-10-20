import { Fragment, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// `alice 41 · Bob 39 · carol 0`, one per seat, where the values may be cards.
export function BySeat({
  players,
  values,
}: {
  players: readonly string[];
  values: readonly ReactNode[];
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {values.map((value, seat) => (
        // Seats have a fixed order.
        // biome-ignore lint/suspicious/noArrayIndexKey: one per seat
        <Fragment key={seat}>
          {seat > 0 && (
            <>
              {' '}
              <span aria-hidden="true" className="text-mist">
                ·
              </span>{' '}
            </>
          )}
          <span className="inline-flex items-center gap-2">
            {players[seat]} {value}
          </span>
        </Fragment>
      ))}
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
