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
        {`@${name}`}
      </span>
    </span>
  );
}

// Everyone at a match: heads-up `A vs B`; a bigger table one under another
// in order of place, each with its place, when the places are known.
export function Players({
  players,
  displayNames,
  places,
  nameClassName,
}: {
  players: readonly string[];
  displayNames: readonly string[];
  places: readonly (number | null)[] | null;
  nameClassName?: string;
}) {
  const [a, b] = [0, 1].map(seat => (
    <PlayerName
      key={seat}
      className={nameClassName}
      name={players[seat] ?? ''}
      displayName={displayNames[seat] ?? ''}
    />
  ));
  if (players.length <= 2) {
    return (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {a}
        <span className="text-mist">vs</span>
        {b}
      </span>
    );
  }
  return (
    <ol className="flex flex-wrap items-start gap-x-4 gap-y-2">
      {byPlace(players.length, places).map(seat => (
        <li key={seat} className="inline-flex min-w-0 items-baseline gap-1.5">
          {places?.[seat] != null && (
            <span className="shrink-0 text-mist text-xs tabular-nums">
              第 {places[seat]} 名
            </span>
          )}
          <PlayerName
            className={nameClassName}
            name={players[seat] ?? ''}
            displayName={displayNames[seat] ?? ''}
          />
        </li>
      ))}
    </ol>
  );
}

// Seats in order of place, then of seat; unknown places last.
export const byPlace = (n: number, places: readonly (number | null)[] | null) =>
  Array.from({ length: n }, (_, seat) => seat).sort(
    (x, y) =>
      (places?.[x] ?? Number.POSITIVE_INFINITY) -
        (places?.[y] ?? Number.POSITIVE_INFINITY) || x - y,
  );
