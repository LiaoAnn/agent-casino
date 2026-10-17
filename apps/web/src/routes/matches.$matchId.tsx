import type {
  MatchDetail,
  MatchHand,
} from '@agent-casino/api/src/contract/schemas';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { getMatch } from '@/data';
import {
  eventLabel,
  formatCards,
  formatSigned,
  formatTime,
  resultLabel,
} from '@/lib/format';

export const Route = createFileRoute('/matches/$matchId')({
  loader: async ({ params }) => {
    const match = await getMatch({ data: params.matchId });
    if (match === null) throw notFound();
    return match;
  },
  component: MatchPage,
  notFoundComponent: MatchNotFound,
});

// `alice 41 · Bob 39`
const bySeat = (
  players: MatchDetail['players'],
  values: readonly [string | number, string | number],
) => `${players[0]} ${values[0]} · ${players[1]} ${values[1]}`;

function Pairs({
  items,
  label,
}: {
  items: [string, string][];
  label?: string;
}) {
  return (
    <dl
      aria-label={label}
      className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
      {items.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

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

function Hand({
  hand,
  players,
}: {
  hand: MatchHand;
  players: MatchDetail['players'];
}) {
  const title = `第 ${hand.hand_number} 手`;
  const items: [string, string][] = [['莊家', players[hand.button_seat]]];
  if (hand.board.length > 0) items.push(['公共牌', formatCards(hand.board)]);
  // A folded hand never shows hole cards, whatever the data says.
  if (hand.ended_by === 'showdown' && hand.hole_cards !== null) {
    items.push([
      '底牌',
      bySeat(players, [
        formatCards(hand.hole_cards[0]),
        formatCards(hand.hole_cards[1]),
      ]),
    ]);
  }
  items.push([
    '結果',
    hand.winner_seat === null
      ? `平分底池 ${hand.pot}`
      : `${players[hand.winner_seat]} 贏得 ${hand.pot}（${hand.ended_by === 'showdown' ? '攤牌' : '對手棄牌'}）`,
  ]);
  items.push(['籌碼', bySeat(players, hand.stacks)]);
  return (
    <section aria-label={title} className="space-y-3 border-t pt-6">
      <h3 className="font-semibold">{title}</h3>
      <Pairs items={items} />
      <ol
        aria-label={`${title}的動作`}
        className="list-decimal space-y-1 pl-6 text-sm">
        {hand.events.map((event, i) => (
          // Events have no id; their order is fixed.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <li key={i}>
            {eventLabel(event, players)}
            {event.timeout && (
              <>
                {' '}
                <Badge>超時代打</Badge>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
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
