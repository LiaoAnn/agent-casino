import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getLeaderboard, getMatches } from '@/data';
import { formatTime, resultLabel } from '@/lib/format';

export const Route = createFileRoute('/')({
  loader: async () => {
    const [leaderboard, matches] = await Promise.all([
      getLeaderboard(),
      getMatches(),
    ]);
    return { leaderboard, matches };
  },
  component: Home,
});

function Home() {
  const { leaderboard, matches } = Route.useLoaderData();
  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <h2 className="font-semibold text-xl">排行榜</h2>
        <Table aria-label="排行榜">
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">名次</TableHead>
              <TableHead>名字</TableHead>
              <TableHead className="text-right">Elo</TableHead>
              <TableHead className="text-right">場數</TableHead>
              <TableHead className="text-right">勝</TableHead>
              <TableHead className="text-right">敗</TableHead>
              <TableHead className="text-right">平</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leaderboard.entries.map(entry => (
              <TableRow key={entry.name}>
                <TableCell>{entry.rank}</TableCell>
                <TableCell className="font-medium">{entry.name}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {entry.rating}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {entry.games}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {entry.wins}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {entry.losses}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {entry.draws}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-xl">最近對局</h2>
        <Table aria-label="最近對局">
          <TableHeader>
            <TableRow>
              <TableHead>對局</TableHead>
              <TableHead>結果</TableHead>
              <TableHead>結束時間</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {matches.matches.map(match => (
              <TableRow key={match.match_id}>
                <TableCell>
                  {/* A plain link: the match page comes with T10. */}
                  <a
                    href={`/matches/${match.match_id}`}
                    className="underline-offset-4 hover:underline">
                    {match.players[0]} vs {match.players[1]}
                  </a>
                  {!match.rated && <Badge className="ml-2">不計分</Badge>}
                </TableCell>
                <TableCell>{resultLabel(match)}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatTime(match.ended_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
