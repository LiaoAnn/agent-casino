import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

// Every variant says what it means in words (web-design skill: colour is
// never the only signal); some add an icon, hidden from screen readers and
// drawn by CSS so the text stays the words alone.
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 font-medium text-xs leading-5',
  {
    variants: {
      variant: {
        outline: 'border-gold-600/60 bg-navy-700 text-ivory',
        win: 'border-win/60 text-win',
        loss: 'border-red-400/60 text-red-400',
        fold: 'border-slate text-fold line-through',
        allin: 'border-allin bg-allin text-ivory',
        timeout: 'border-timeout/60 text-timeout',
        turn: 'border-gold-400 bg-gold-400 text-navy-950',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

const ICONS = {
  win: "before:content-['▲']",
  loss: "before:content-['▼']",
  timeout: "before:content-['⏱']",
  turn: "before:content-['▶']",
} as const;

function Badge({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  const icon =
    variant != null && variant in ICONS
      ? ICONS[variant as keyof typeof ICONS]
      : null;
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}>
      {icon !== null && <span aria-hidden="true" className={icon} />}
      {children}
    </span>
  );
}

export { Badge };
