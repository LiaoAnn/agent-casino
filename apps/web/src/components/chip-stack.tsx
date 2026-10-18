import { cn } from '@/lib/utils';

// Chip colours by denomination (web-design skill).
const CHIPS = [
  [100, 'border-gold-400 bg-navy-950'],
  [25, 'border-ivory/70 bg-chip-green'],
  [5, 'border-ivory/70 bg-red-500'],
  [1, 'border-slate bg-ivory'],
] as const;

const MAX_CHIPS = 6;

// The chips that make up `amount`, biggest first, as few as possible; only
// the first six are drawn.
function chipsOf(amount: number) {
  const chips: string[] = [];
  let left = amount;
  for (const [value, colour] of CHIPS) {
    while (left >= value && chips.length < MAX_CHIPS) {
      chips.push(colour);
      left -= value;
    }
  }
  return chips;
}

// A stack of flat chips beside an amount, taller for more, six at most. The
// chips are decoration; the number says how much.
export function ChipStack({
  amount,
  className,
}: {
  amount: number;
  className?: string;
}) {
  const chips = chipsOf(amount);
  return (
    <span className="inline-flex items-end gap-2">
      {chips.length > 0 && (
        <span
          aria-hidden="true"
          className="inline-flex flex-col-reverse items-center pt-[3px]">
          {chips.map((colour, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: a stack's chips have no identity
              key={i}
              className={cn(
                '-mt-[3px] h-[7px] w-5 rounded-[50%] border border-dashed',
                colour,
              )}
            />
          ))}
        </span>
      )}
      <span className={cn('tabular-nums leading-none', className)}>
        {amount}
      </span>
    </span>
  );
}
