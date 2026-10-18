import type { ReactNode } from 'react';
import { CardBack } from '@/components/playing-card';

// Nothing to show yet: a card back and a sentence.
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-mist">
      <CardBack />
      <p>{children}</p>
    </div>
  );
}
