import type { ReactNode } from 'react';
import { ChipStack } from '@/components/chip-stack';
import type { Pair } from '@/components/pairs';
import { Board } from '@/components/playing-card';
import { potNames } from '@/lib/format';
import { SLOT_CLASS, SLOTS_BY_COUNT } from '@/lib/seats';
import { cn } from '@/lib/utils';

// One place at the table: the seat's plate and its bet this street.
export interface FeltSeat {
  key: string | number;
  seat: ReactNode;
  bet?: ReactNode;
}

// The table: green felt, lighter in the middle, a 2px gold-600 rim, the
// hero of its screen. The players sit on it, their plates over the rim, the
// first of `seats` at the bottom and the others clockwise from it (web-design
// 牌桌版面); each one's bet this street lies between their seat and the
// middle, where the board and the pot are. Text never sits on the felt
// itself, only on the navy plates.
export function Felt({
  seats,
  children,
}: {
  seats: readonly FeltSeat[];
  children: ReactNode;
}) {
  const [bottom, top] = seats;
  if (seats.length === 2 && bottom !== undefined && top !== undefined) {
    return (
      <div className="relative grid justify-items-center gap-3 px-2 sm:px-10">
        <Rim className="top-12 bottom-12" />
        <div className="relative w-full max-w-xs">{top.seat}</div>
        <div className="relative flex min-h-8 items-center">{top.bet}</div>
        <Plate>{children}</Plate>
        <div className="relative flex min-h-8 items-center">{bottom.bet}</div>
        <div className="relative w-full max-w-xs">{bottom.seat}</div>
      </div>
    );
  }
  const slots = SLOTS_BY_COUNT[seats.length] ?? SLOTS_BY_COUNT[6] ?? [];
  return (
    <div className="relative grid grid-cols-3 items-start justify-items-center gap-x-2 gap-y-3 sm:gap-x-4 sm:px-4">
      <Rim className="top-16 bottom-16" />
      {seats.map((place, i) => {
        const slot = slots[i] ?? 'bottom';
        return (
          <div
            key={place.key}
            className={cn(
              'relative flex w-full min-w-0 max-w-xs items-center gap-2',
              SLOT_CLASS[slot],
            )}>
            <div className="w-full">{place.seat}</div>
            <div className="flex min-h-8 items-center">{place.bet}</div>
          </div>
        );
      })}
      <div className="relative col-span-3 row-start-2 flex justify-center">
        <Plate>{children}</Plate>
      </div>
    </div>
  );
}

function Rim({ className }: { className: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'felt-surface absolute inset-x-0 rounded-[50%] border-2 border-gold-600',
        className,
      )}
    />
  );
}

function Plate({ children }: { children: ReactNode }) {
  return (
    <div className="relative max-w-[calc(100%-3rem)] rounded-xl bg-navy-900/80 px-3 py-3 sm:max-w-full sm:px-5">
      {children}
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
  pots,
  details,
  deal = false,
}: {
  board: readonly string[];
  emptyBoard: string;
  // Main pot first; one pot reads 底池, more 主池 and 邊池.
  pots: readonly number[];
  details: Pair[];
  deal?: boolean;
}) {
  const names = potNames(pots.length);
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
      <div className="flex basis-full flex-wrap items-center justify-center gap-x-4 gap-y-2">
        {pots.map((amount, i) => (
          <div key={names[i]} className="flex items-center gap-2">
            <dt className="text-mist">{names[i]}</dt>
            <dd>
              <ChipStack
                amount={amount}
                className="font-bold text-gold-200 text-xl"
              />
            </dd>
          </div>
        ))}
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
