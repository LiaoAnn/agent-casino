import type {
  MatchDetail,
  MatchHand,
} from '@agent-casino/api/src/contract/schemas';
import { Badge } from '@/components/ui/badge';
import { eventLabel, formatCards } from '@/lib/format';

// `alice 41 · Bob 39`
export const bySeat = (
  players: MatchDetail['players'],
  values: readonly [string | number, string | number],
) => `${players[0]} ${values[0]} · ${players[1]} ${values[1]}`;

export function Pairs({
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

export function Hand({
  hand,
  players,
}: {
  hand: MatchHand;
  players: MatchDetail['players'];
}) {
  const title = `第 ${hand.hand_number} 手`;
  const items: [string, string][] = [['莊家', players[hand.button_seat]]];
  if (hand.board.length > 0) items.push(['公共牌', formatCards(hand.board)]);
  // Every hand, folded ones too: the seed is public once the match is over.
  items.push([
    '底牌',
    bySeat(players, [
      formatCards(hand.hole_cards[0]),
      formatCards(hand.hole_cards[1]),
    ]),
  ]);
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
