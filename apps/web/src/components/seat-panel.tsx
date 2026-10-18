import { useEffect, useState } from 'react';
import { ChipStack } from '@/components/chip-stack';
import { Cards } from '@/components/playing-card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// One player's plate on the rim of the table: name, the dealer button, hole
// cards (backs when unseen), chips behind, Elo when known, and whose turn it
// is. `deadline` only on the watched seat's own turn, out of `turnSeconds`;
// `won` once a hand is over. Labels are for screen readers: the plate shows
// the values alone, as a broadcast does.
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
}) {
  return (
    <section
      aria-label={`座位：${name}`}
      className={cn(
        'rounded-lg bg-navy-800 p-3 transition-[border-color,box-shadow] duration-150 ease-out',
        toAct
          ? 'glow-turn border-2 border-gold-400'
          : 'border-2 border-gold-600/40',
      )}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 font-semibold text-ivory [overflow-wrap:anywhere]">
          {name}
        </h4>
        {dealer && (
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-ivory font-bold text-navy-950 text-xs">
            <span aria-hidden="true" className="before:content-['D']" />
            <span className="sr-only">莊家</span>
          </span>
        )}
        {/* No chips behind, all in the pot: nothing left to bet. */}
        {stack === 0 && <Badge variant="allin">ALL-IN</Badge>}
        {won && <Badge variant="win">勝</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-sm">
        <div className="contents">
          <dt className="sr-only">底牌</dt>
          <dd className="col-start-1 row-span-4 row-start-1">
            <Cards cards={cards} size="md" deal />
          </dd>
        </div>
        <div className="contents">
          <dt className="sr-only">籌碼</dt>
          <dd className="col-start-2">
            <ChipStack
              amount={stack}
              className="font-semibold text-gold-400 text-lg"
            />
          </dd>
        </div>
        {rating !== undefined && (
          <div className="contents">
            <dt className="sr-only">Elo</dt>
            <dd className="col-start-2 text-mist tabular-nums">
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
            <dd className="col-start-2">
              <Badge variant="turn">輪到</Badge>
            </dd>
          </div>
        )}
        {deadline !== null && (
          <div className="contents">
            <dt className="sr-only">剩餘時間</dt>
            <dd className="col-start-2">
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
