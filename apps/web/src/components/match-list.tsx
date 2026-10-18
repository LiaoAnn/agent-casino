import type { MatchSummary } from '@agent-casino/api/src/contract/schemas';
import { Link } from '@tanstack/react-router';
import { EmptyState } from '@/components/empty-state';
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
                className="font-medium text-ivory underline-offset-4 hover:text-gold-200 hover:underline">
                {match.players[0]} vs {match.players[1]}
              </Link>
              {!match.rated && <Badge className="ml-2">不計分</Badge>}
            </TableCell>
            <TableCell className="whitespace-normal text-ivory">
              {resultLabel(match)}
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
