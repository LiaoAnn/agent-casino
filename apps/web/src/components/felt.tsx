import type { ReactNode } from 'react';
import { ChipStack } from '@/components/chip-stack';
import type { Pair } from '@/components/pairs';
import { Board } from '@/components/playing-card';
import { cn } from '@/lib/utils';

// The table: green felt, lighter in the middle, a 2px gold-600 rim, the
// hero of its screen. The players sit on it, one at the top edge and one at
// the bottom, their plates over the rim; each one's bet this street lies
// between their seat and the middle, where the board and the pot are. Text
// never sits on the felt itself, only on the navy plates.
export function Felt({
  top,
  topBet,
  bottom,
  bottomBet,
  children,
}: {
  top: ReactNode;
  topBet?: ReactNode;
  bottom: ReactNode;
  bottomBet?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative grid justify-items-center gap-3 px-2 sm:px-10">
      <div
        aria-hidden="true"
        className="felt-surface absolute inset-x-0 top-12 bottom-12 rounded-[3rem] border-2 border-gold-600 sm:rounded-[50%]"
      />
      <div className="relative w-full max-w-xs">{top}</div>
      <div className="relative flex min-h-8 items-center">{topBet}</div>
      <div className="relative max-w-full rounded-xl bg-navy-900/80 px-3 py-3 sm:px-5">
        {children}
      </div>
      <div className="relative flex min-h-8 items-center">{bottomBet}</div>
      <div className="relative w-full max-w-xs">{bottom}</div>
    </div>
  );
}

// One player's chips in front of them this street, on a small plate; it
// reads `本街下注：alice 4`.
export function Bet({ name, amount }: { name: string; amount: number }) {
  if (amount === 0) return null;
  return (
    <p className="rounded-full bg-navy-900/80 px-3 py-1 font-semibold text-gold-400 text-sm">
      <span className="sr-only">本街下注：{name} </span>
      <ChipStack amount={amount} />
    </p>
  );
}

// The plate in the middle of the table: the board, the pot as chips and a
// number, then small details such as the street and the dealer.
export function TableCenter({
  board,
  emptyBoard,
  pot,
  details,
  deal = false,
}: {
  board: readonly string[];
  emptyBoard: string;
  pot: number;
  details: Pair[];
  deal?: boolean;
}) {
  return (
    <dl
      aria-label="牌桌"
      className="flex max-w-full flex-wrap justify-center gap-x-4 gap-y-2 text-ivory text-xs">
      <div className="flex basis-full justify-center">
        <dt className="sr-only">公共牌</dt>
        <dd>
          <Board cards={board} emptyText={emptyBoard} deal={deal} />
        </dd>
      </div>
      <div className="flex basis-full items-center justify-center gap-2">
        <dt className="text-mist">底池</dt>
        <dd>
          <ChipStack amount={pot} className="font-bold text-gold-200 text-xl" />
        </dd>
      </div>
      {details.map(([term, value, itemClass]) => (
        <div
          key={term}
          className={cn('flex min-w-0 items-baseline gap-1.5', itemClass)}>
          <dt className="shrink-0 text-mist">{term}</dt>
          <dd className="[overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
