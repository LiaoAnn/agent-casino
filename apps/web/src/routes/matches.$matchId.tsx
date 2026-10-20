import { createFileRoute, notFound } from '@tanstack/react-router';
import { EmptyState } from '@/components/empty-state';
import { MatchHand } from '@/components/match-hand';
import { MatchInfo } from '@/components/match-info';
import { Notice } from '@/components/notice';
import { PageTitle, Panel } from '@/components/panel';
import { getMatch } from '@/data';
import { outAfter } from '@/lib/seats';

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
  // The table and the timeline show the display names (A20).
  const { display_names: shown, rating_changes } = match;
  const ratings = shown.map((_, seat) => rating_changes?.[seat]?.before);
  return (
    <div className="space-y-6">
      <PageTitle>
        {shown.length <= 2
          ? `${shown[0]} vs ${shown[1]}`
          : `${shown.length} 人桌`}
      </PageTitle>
      <Panel>
        <MatchInfo match={match} />
      </Panel>
      {match.hands.length === 0 ? (
        <EmptyState>這場沒有打任何一手。</EmptyState>
      ) : (
        match.hands.map((hand, i) => (
          <MatchHand
            key={hand.hand_number}
            hand={hand}
            players={shown}
            ratings={ratings}
            outs={outAfter(match.hands, i, match.places)}
          />
        ))
      )}
    </div>
  );
}

function MatchNotFound() {
  const { matchId } = Route.useParams();
  return <Notice title="找不到這場對局">沒有 ID 為 {matchId} 的對局。</Notice>;
}
