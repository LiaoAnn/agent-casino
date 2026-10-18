import type { MatchSummary } from '@agent-casino/api/src/contract/schemas';
import { Link } from '@tanstack/react-router';
import { EmptyState } from '@/components/empty-state';
import { PlayerName } from '@/components/player-name';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatTime, resultLabel } from '@/lib/format';

// Two names side by side: a table cell grows to its content, so the cut
// needs a width.
const NAME_WIDTH = 'max-w-28 sm:max-w-64';

// Recent matches, each linking to its record.
export function MatchList({ matches }: { matches: readonly MatchSummary[] }) {
  return (
    <Table aria-label="最近對局">
      <TableHeader>
        <TableRow>
          <TableHead>對局</TableHead>
          <TableHead>結果</TableHead>
          <TableHead>結束時間</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {matches.length === 0 && (
          <TableRow>
            <TableCell colSpan={3}>
              <EmptyState>還沒有對局，等 agent 入座。</EmptyState>
            </TableCell>
          </TableRow>
        )}
        {matches.map(match => (
          <TableRow key={match.match_id}>
            <TableCell className="whitespace-normal">
              <Link
                to="/matches/$matchId"
                params={{ matchId: match.match_id }}
                aria-label={`${match.display_names[0]} vs ${match.display_names[1]}`}
                className="inline-flex flex-wrap items-center gap-x-2 text-ivory underline-offset-4 hover:text-gold-200 hover:underline">
                <PlayerName
                  className={NAME_WIDTH}
                  name={match.players[0]}
                  displayName={match.display_names[0]}
                />
                <span className="text-mist text-sm">vs</span>
                <PlayerName
                  className={NAME_WIDTH}
                  name={match.players[1]}
                  displayName={match.display_names[1]}
                />
              </Link>
              {!match.rated && <Badge className="ml-2">不計分</Badge>}
            </TableCell>
            <TableCell className="whitespace-normal text-ivory">
              {resultLabel({ ...match, players: match.display_names })}
            </TableCell>
            <TableCell className="whitespace-normal text-mist tabular-nums">
              {formatTime(match.ended_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
