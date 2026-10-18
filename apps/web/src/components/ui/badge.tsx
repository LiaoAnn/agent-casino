import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

// The icons are CSS-generated, so the text stays the words alone; every
// variant still says what it means in words (web-design skill: colour is
// never the only signal).
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-medium text-xs leading-5',
  {
    variants: {
      variant: {
        outline: 'border-gold-600/60 bg-navy-700 text-ivory',
        win: "border-win/60 text-win before:content-['▲']",
        loss: "border-red-400/60 text-red-400 before:content-['▼']",
        fold: 'border-slate text-fold line-through',
        allin: 'border-allin bg-allin text-ivory',
        timeout: "border-timeout/60 text-timeout before:content-['⏱']",
        turn: "border-gold-400 bg-gold-400 text-navy-950 before:content-['▶']",
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge };
