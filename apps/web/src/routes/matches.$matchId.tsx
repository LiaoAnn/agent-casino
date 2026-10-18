import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { bySeat, Hand, Pairs } from '@/components/hand';
import { getMatch } from '@/data';
import { formatSigned, formatTime, resultLabel } from '@/lib/format';

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
  const { players, settings } = match;
  const info: [string, string][] = [
    ['結果', resultLabel(match)],
    ['結束時間', formatTime(match.ended_at)],
    ['計分', match.rated ? '計分' : '不計分'],
    [
      '設定',
      `${settings.hands} 手 · 每步 ${settings.turn_seconds} 秒 · 起始籌碼 ${settings.starting_stack}`,
    ],
    ['種子', String(match.seed)],
    ['最終籌碼', bySeat(players, match.final_stacks)],
  ];
  if (match.rating_changes !== null) {
    info.push([
      'Elo',
      match.rating_changes
        .map(
          c =>
            `${c.name} ${c.before} → ${c.after} (${formatSigned(c.after - c.before)})`,
        )
        .join(' · '),
    ]);
  }
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="font-semibold text-xl">
          {players[0]} vs {players[1]}
        </h2>
        <Pairs items={info} label="對局資訊" />
      </section>
      {match.hands.length === 0 ? (
        <p className="text-muted-foreground">這場沒有打任何一手。</p>
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
  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-xl">找不到這場對局</h2>
      <p className="text-muted-foreground">沒有 ID 為 {matchId} 的對局。</p>
      <Link to="/" className="underline underline-offset-4">
        回首頁
      </Link>
    </section>
  );
}
