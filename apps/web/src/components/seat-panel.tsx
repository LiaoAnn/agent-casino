import { useEffect, useState } from 'react';
import { ChipStack } from '@/components/chip-stack';
import { Cards } from '@/components/playing-card';
import { Badge } from '@/components/ui/badge';
import { outLabel } from '@/lib/format';
import type { Out } from '@/lib/seats';
import { cn } from '@/lib/utils';

// One player's plate on the rim of the table: name, the dealer button, hole
// cards (backs when unseen), chips behind, Elo when known, and whose turn it
// is. `deadline` only on the watched seat's own turn, out of `turnSeconds`;
// `won` once a hand is over; `deal` deals the cards in, for a hand in play
// (a record shows them still); `folded` this hand; `out` once the seat is out
// of a match the others play on, which dims it; `compact` shrinks it on a
// phone, for a table of three or more. Labels are for screen readers: the
// plate shows the values alone, as a broadcast does.
export function SeatPanel({
  name,
  stack,
  rating,
  cards,
  dealer,
  toAct = false,
  won = false,
  deadline = null,
  turnSeconds = 0,
  deal = false,
  inPlay = false,
  folded = false,
  out = null,
  compact = false,
}: {
  name: string;
  stack: number;
  rating?: number;
  cards: readonly string[] | null;
  dealer: boolean;
  toAct?: boolean;
  won?: boolean;
  deadline?: string | null;
  turnSeconds?: number;
  deal?: boolean;
  inPlay?: boolean;
  folded?: boolean;
  out?: Out | null;
  compact?: boolean;
}) {
  if (out !== null) {
    return (
      <section
        aria-label={`座位：${name}`}
        className={cn(
          'rounded-lg border-2 border-slate/60 bg-navy-900',
          compact ? 'p-2 sm:p-3' : 'p-3',
        )}>
        <h4 title={name} className="mb-2 truncate font-semibold text-mist">
          {name}
        </h4>
        <Badge>{outLabel(out)}</Badge>
        {/* The cards it lost with, shown at the showdown that put it out. */}
        {cards !== null && cards.length > 0 && (
          <div className="mt-2">
            <span className="sr-only">底牌</span>
            <Cards cards={cards} size="sm" />
          </div>
        )}
      </section>
    );
  }
  // Beside the cards; below them on a compact plate.
  const valueCol = compact ? 'col-start-1 sm:col-start-2' : 'col-start-2';
  return (
    <section
      aria-label={`座位：${name}`}
      className={cn(
        'rounded-lg bg-navy-800 transition-[border-color,box-shadow] duration-150 ease-out',
        compact ? 'p-2 sm:p-3' : 'p-3',
        toAct
          ? 'glow-turn border-2 border-gold-400'
          : 'border-2 border-gold-600/40',
      )}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* The display name only, cut when long (A20). */}
        <h4
          title={name}
          className="min-w-0 max-w-full truncate font-semibold text-ivory">
          {name}
        </h4>
        {dealer && (
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-ivory font-bold text-navy-950 text-xs">
            <span aria-hidden="true" className="before:content-['D']" />
            <span className="sr-only">莊家</span>
          </span>
        )}
        {/* No chips behind, all in the pot: nothing left to bet. */}
        {stack === 0 && (
          <Badge variant={inPlay ? 'allin' : 'loss'}>
            {inPlay ? 'ALL-IN' : '出局'}
          </Badge>
        )}
        {folded && <Badge variant="fold">棄牌</Badge>}
        {won && <Badge variant="win">勝</Badge>}
      </div>
      <dl
        className={cn(
          'grid items-center gap-x-3 gap-y-1.5 text-sm',
          compact
            ? 'grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)]'
            : 'grid-cols-[auto_minmax(0,1fr)]',
        )}>
        <div className="contents">
          <dt className="sr-only">底牌</dt>
          <dd
            className={cn(
              'col-start-1 row-start-1',
              compact ? 'sm:row-span-4' : 'row-span-4',
            )}>
            <Cards cards={cards} size="md" deal={deal} />
          </dd>
        </div>
        <div className="contents">
          <dt className="sr-only">籌碼</dt>
          <dd className={valueCol}>
            <ChipStack
              amount={stack}
              className="font-semibold text-gold-400 text-lg"
            />
          </dd>
        </div>
        {rating !== undefined && (
          <div className="contents">
            <dt className="sr-only">Elo</dt>
            <dd className={cn(valueCol, 'text-mist tabular-nums')}>
              <span
                aria-hidden="true"
                className="mr-1 text-xs before:content-['Elo']"
              />
              {rating}
            </dd>
          </div>
        )}
        {toAct && (
          <div className="contents">
            <dt className="sr-only">行動</dt>
            <dd className={valueCol}>
              <Badge variant="turn">輪到</Badge>
            </dd>
          </div>
        )}
        {deadline !== null && (
          <div className="contents">
            <dt className="sr-only">剩餘時間</dt>
            <dd className={valueCol}>
              <Remaining deadline={deadline} turnSeconds={turnSeconds} />
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
// Seconds left until `deadline`, as a ring and a number, counted in the
// browser only: the server's clock would not match the page's by the time
// it hydrates. The last five seconds turn the timeout colour.
function Remaining({
  deadline,
  turnSeconds,
}: {
  deadline: string;
  turnSeconds: number;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (now === null) return null;
  const left = Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000));
  const urgent = left <= 5;
  const circumference = 2 * Math.PI * 10;
  const share = Math.min(1, left / turnSeconds);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 font-semibold',
        urgent ? 'text-timeout' : 'text-ivory',
      )}>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6 -rotate-90">
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          strokeWidth="3"
          className="stroke-navy-700"
        />
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          strokeWidth="3"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - share)}
          className={cn(
            'transition-[stroke-dashoffset] duration-1000 ease-linear',
            urgent ? 'stroke-timeout' : 'stroke-gold-400',
          )}
        />
      </svg>
      {left} 秒
    </span>
  );
}

// A seat still open at a table waiting to start: a dashed frame.
export function EmptySeat({ compact = false }: { compact?: boolean }) {
  return (
    <section
      aria-label="空位"
      className={cn(
        'rounded-lg border-2 border-slate border-dashed bg-navy-900/80 text-center text-mist text-sm',
        compact ? 'p-2 sm:p-3' : 'p-3',
      )}>
      空位
    </section>
  );
}
