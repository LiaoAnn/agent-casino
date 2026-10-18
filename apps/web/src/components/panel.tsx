import type * as React from 'react';
import { cn } from '@/lib/utils';

// A plain panel: navy with a thin gold-600 line. `sunken` is the darker
// block a record sits on, so notes (navy-800) show. `enter` fades it in with
// a small rise, for a panel that appears while the page is open (a new hand
// on the watch page), not for the page's own load.
export function Panel({
  className,
  tone = 'raised',
  enter = false,
  ...props
}: React.ComponentProps<'section'> & {
  tone?: 'raised' | 'sunken';
  enter?: boolean;
}) {
  return (
    <section
      className={cn(
        'space-y-3 rounded-lg border border-gold-600/40 p-3 sm:p-5',
        tone === 'raised' ? 'bg-navy-800' : 'bg-navy-900',
        enter && 'motion-safe:animate-enter motion-reduce:animate-fade',
        className,
      )}
      {...props}
    />
  );
}

// The one h2 of a page: Cinzel, as a broadcast title.
export function PageTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-bold font-display text-2xl text-gold-200 tracking-wide sm:text-3xl">
      {children}
    </h2>
  );
}

// The h2 over a section of a page that has several, e.g. the home page.
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-bold font-display text-gold-200 text-xl tracking-wide">
      {children}
    </h2>
  );
}
