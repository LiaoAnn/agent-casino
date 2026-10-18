import { createFileRoute } from '@tanstack/react-router';
import { Leaderboard } from '@/components/leaderboard';
import { MatchList } from '@/components/match-list';
import { Panel, SectionTitle } from '@/components/panel';
import { getLeaderboard, getMatches } from '@/data';

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
    <div className="space-y-8">
      <Panel>
        <SectionTitle>排行榜</SectionTitle>
        <Leaderboard entries={leaderboard.entries} />
      </Panel>
      <Panel>
        <SectionTitle>最近對局</SectionTitle>
        <MatchList matches={matches.matches} />
      </Panel>
    </div>
  );
}
