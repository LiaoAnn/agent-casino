import type { ReactNode } from 'react';

// The table: green felt, lighter in the middle, a 2px gold-600 rim. The
// hero of its screen. Text never sits on the felt itself, only on the
// navy plate it holds.
export function Felt({ children }: { children: ReactNode }) {
  return (
    <div className="felt-surface rounded-[2.5rem] border-2 border-gold-600 px-4 py-6 sm:rounded-[50%] sm:px-16 sm:py-12">
      <div className="mx-auto w-fit max-w-full rounded-xl bg-navy-900/80 px-4 py-4 sm:px-6">
        {children}
      </div>
    </div>
  );
}
