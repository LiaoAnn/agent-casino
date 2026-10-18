import { useEffect, useState } from 'react';
import { ChipStack } from '@/components/chip-stack';
import { type Pair, Pairs } from '@/components/pairs';
import { Cards } from '@/components/playing-card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

// One seat of the hand in play. `cards` is null for the opponent, whose
// cards the watched seat has not seen; `deadline` only on the watched seat's
// own turn, out of `turnSeconds`.
export function SeatPanel({
  name,
  stack,
  bet,
  cards,
  toAct,
  deadline,
  turnSeconds,
}: {
  name: string;
  stack: number;
  bet: number;
  cards: readonly string[] | null;
  toAct: boolean;
  deadline: string | null;
  turnSeconds: number;
}) {
  const items: Pair[] = [
    ['籌碼', String(stack), 'font-semibold text-gold-400 text-lg'],
    ['本街下注', <ChipStack key="b" amount={bet} />],
    ['底牌', <Cards key="c" cards={cards} size="md" deal />],
  ];
  if (toAct)
    items.push([
      '行動',
      <Badge key="a" variant="turn">
        輪到
      </Badge>,
    ]);
  if (deadline !== null) {
    items.push([
      '剩餘時間',
      <Remaining key="t" deadline={deadline} turnSeconds={turnSeconds} />,
    ]);
  }
  return (
    <section
      aria-label={`座位：${name}`}
      className={cn(
        'space-y-3 rounded-lg bg-navy-800 p-4 transition-[border-color,box-shadow] duration-150 ease-out',
        toAct
          ? 'glow-turn border-2 border-gold-400'
          : 'border-2 border-gold-600/40',
      )}>
      <h4 className="font-semibold text-ivory text-lg">{name}</h4>
      <Pairs items={items} />
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
