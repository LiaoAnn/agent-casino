import { createFileRoute, notFound } from '@tanstack/react-router';
import { EmptyState } from '@/components/empty-state';
import { Hand } from '@/components/hand';
import { MatchInfo } from '@/components/match-info';
import { Notice } from '@/components/notice';
import { PageTitle, Panel } from '@/components/panel';
import { getMatch } from '@/data';

export const Route = createFileRoute('/matches/$matchId')({
  loader: async ({ params }) => {
    const match = await getMatch({ data: params.matchId });
    if (match === null) throw notFound();
    return match;
  },
  component: MatchPage,
  notFoundComponent: MatchNotFound,
});

function MatchPage() {
  const match = Route.useLoaderData();
  const { players } = match;
  return (
    <div className="space-y-6">
      <PageTitle>
        {players[0]} vs {players[1]}
      </PageTitle>
      <Panel>
        <MatchInfo match={match} />
      </Panel>
      {match.hands.length === 0 ? (
        <EmptyState>這場沒有打任何一手。</EmptyState>
      ) : (
        match.hands.map(hand => (
          <Hand key={hand.hand_number} hand={hand} players={players} />
        ))
      )}
    </div>
  );
}

function MatchNotFound() {
  const { matchId } = Route.useParams();
  return <Notice title="找不到這場對局">沒有 ID 為 {matchId} 的對局。</Notice>;
}
