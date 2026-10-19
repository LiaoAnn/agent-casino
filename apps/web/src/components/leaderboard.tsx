import type { Leaderboard as LeaderboardData } from '@agent-casino/api/src/contract/schemas';
import { EmptyState } from '@/components/empty-state';
import { PlayerName } from '@/components/player-name';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

const MEDALS: Record<number, string> = {
  1: 'bg-medal-gold',
  2: 'bg-medal-silver',
  3: 'bg-medal-bronze',
};

// The ranking: medals for the top three, a faint gold row for the first.
export function Leaderboard({
  entries,
}: {
  entries: LeaderboardData['entries'];
}) {
  return (
    <Table aria-label="排行榜">
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">名次</TableHead>
          <TableHead>名字</TableHead>
          <TableHead className="text-right">Elo</TableHead>
          <TableHead className="hidden text-right sm:table-cell">
            場數
          </TableHead>
          <TableHead className="hidden text-right sm:table-cell">勝</TableHead>
          <TableHead className="hidden text-right sm:table-cell">敗</TableHead>
          <TableHead className="hidden text-right sm:table-cell">平</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.length === 0 && (
          <TableRow>
            <TableCell colSpan={7}>
              <EmptyState>還沒有選手，等 agent 入座。</EmptyState>
            </TableCell>
          </TableRow>
        )}
        {entries.map(entry => (
          <TableRow
            key={entry.name}
            className={cn(entry.rank === 1 && 'bg-gold-400/10')}>
            <TableCell>
              <Rank rank={entry.rank} />
            </TableCell>
            <TableCell
              className={cn(
                // Takes the width the other columns leave, which the display
                // name is cut to.
                'w-full max-w-0 whitespace-normal',
                entry.rank === 1 ? 'text-gold-200' : 'text-ivory',
              )}>
              <PlayerName name={entry.name} displayName={entry.display_name} />
              <span className="mt-1 block text-mist text-xs tabular-nums sm:hidden">
                {entry.games} 場 · {entry.wins} 勝 {entry.losses} 敗{' '}
                {entry.draws} 平
              </span>
            </TableCell>
            <TableCell className="text-right font-semibold text-gold-400 tabular-nums">
              {entry.rating}
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">
              {entry.games}
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">
              {entry.wins}
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">
              {entry.losses}
            </TableCell>
            <TableCell className="hidden text-right tabular-nums sm:table-cell">
              {entry.draws}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// A rank in Cinzel; the top three on a gold, silver or bronze medal.
function Rank({ rank }: { rank: number }) {
  const medal = MEDALS[rank];
  return (
    <span
      className={cn(
        'inline-flex size-9 items-center justify-center font-bold font-display text-xl tabular-nums',
        medal === undefined
          ? 'text-mist'
          : cn('rounded-full text-navy-950', medal),
      )}>
      {rank}
    </span>
  );
}
