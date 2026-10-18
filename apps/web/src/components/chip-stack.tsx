// A few flat chips beside an amount: more chips for more, five at most. The
// chips are decoration; the number says how much.
export function ChipStack({ amount }: { amount: number }) {
  const chips = Math.min(5, Math.ceil(Math.log2(amount + 1) / 2));
  return (
    <span className="inline-flex items-center gap-2">
      {chips > 0 && (
        <span aria-hidden="true" className="inline-flex pl-2.5">
          {Array.from({ length: chips }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: identical chips
              key={i}
              className="-ml-2.5 size-4 rounded-full border-2 border-navy-950 border-dashed bg-gold-400"
            />
          ))}
        </span>
      )}
      <span className="tabular-nums">{amount}</span>
    </span>
  );
}
