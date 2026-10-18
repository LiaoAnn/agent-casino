import { cn } from '@/lib/utils';

// A player as lists show them (A20): the display name, cut short with an
// ellipsis when long (the whole name in `title`), and the `@name` it belongs
// to below, always shown, so two players with one display name tell apart.
// The display name takes the surrounding text colour.
export function PlayerName({
  name,
  displayName,
  className,
}: {
  name: string;
  displayName: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex min-w-0 max-w-full flex-col', className)}>
      <span title={displayName} className="truncate font-semibold">
        {displayName}
      </span>
      <span className="font-normal text-mist text-xs tabular-nums [overflow-wrap:anywhere]">
        @{name}
      </span>
    </span>
  );
}
