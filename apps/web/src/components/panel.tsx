import type * as React from 'react';
import { cn } from '@/lib/utils';

// A plain panel: navy with a thin gold-600 line, faded in when it appears.
// `sunken` is the darker block a record sits on, so notes (navy-800) show.
export function Panel({
  className,
  tone = 'raised',
  ...props
}: React.ComponentProps<'section'> & { tone?: 'raised' | 'sunken' }) {
  return (
    <section
      className={cn(
        'space-y-3 rounded-lg border border-gold-600/40 p-4 motion-safe:animate-enter motion-reduce:animate-fade sm:p-5',
        tone === 'raised' ? 'bg-navy-800' : 'bg-navy-900',
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
