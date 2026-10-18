import { type ReactNode, useEffect, useState } from 'react';
import { Pairs } from '@/components/hand';
import { formatCards } from '@/lib/format';

// One seat of the hand in play. `cards` is null for the opponent, whose
// cards the watched seat has not seen; `deadline` only on the watched seat's
// own turn.
export function SeatPanel({
  name,
  stack,
  bet,
  cards,
  toAct,
  deadline,
}: {
  name: string;
  stack: number;
  bet: number;
  cards: readonly string[] | null;
  toAct: boolean;
  deadline: string | null;
}) {
  const items: [string, ReactNode][] = [
    ['籌碼', String(stack)],
    ['本街下注', String(bet)],
    ['底牌', cards === null ? '未亮牌' : formatCards(cards)],
  ];
  if (toAct) items.push(['行動', '輪到']);
  if (deadline !== null) {
    items.push(['剩餘時間', <Remaining key="t" deadline={deadline} />]);
  }
  return (
    <section aria-label={`座位：${name}`} className="space-y-2">
      <h4 className="font-medium">{name}</h4>
      <Pairs items={items} />
    </section>
  );
}

// Seconds left until `deadline`, counted in the browser only: the server's
// clock would not match the page's by the time it hydrates.
function Remaining({ deadline }: { deadline: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (now === null) return null;
  return `${Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000))} 秒`;
}
