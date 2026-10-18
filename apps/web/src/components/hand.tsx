import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import type { ReactNode } from 'react';
import { ActionLogEntry } from '@/components/action-log-entry';
import { formatCards } from '@/lib/format';

// `alice 41 · Bob 39`
export const bySeat = (
  players: MatchDetail['players'],
  values: readonly [string | number, string | number],
) => `${players[0]} ${values[0]} · ${players[1]} ${values[1]}`;

export function Pairs({
  items,
  label,
}: {
  items: [string, ReactNode][];
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

// A finished hand of a match record, or of a watch link: there the
// opponent's cards may be unknown and the watched seat's steps carry notes.
export type HandRecord = WatchResponse['hands'][number];

const holeCards = (cards: readonly string[] | null) =>
  cards === null ? '未亮牌' : formatCards(cards);

export function Hand({
  hand,
  players,
}: {
  hand: HandRecord;
  players: MatchDetail['players'];
}) {
  const title = `第 ${hand.hand_number} 手`;
  const items: [string, string][] = [['莊家', players[hand.button_seat]]];
  if (hand.board.length > 0) items.push(['公共牌', formatCards(hand.board)]);
  // A match record shows both in every hand (the seed is public once the
  // match is over); a watch link in play only the cards the seat has seen.
  items.push([
    '底牌',
    bySeat(players, [
      holeCards(hand.hole_cards[0]),
      holeCards(hand.hole_cards[1]),
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
      <Steps title={title} events={hand.events} players={players} />
    </section>
  );
}

// The steps of a hand in order, each with its note when it has one.
export function Steps({
  title,
  events,
  players,
}: {
  title: string;
  events: HandRecord['events'];
  players: MatchDetail['players'];
}) {
  return (
    <ol
      aria-label={`${title}的動作`}
      className="list-decimal space-y-1 pl-6 text-sm">
      {events.map((event, i) => (
        // Events have no id; their order is fixed.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <ActionLogEntry key={i} event={event} players={players} />
      ))}
    </ol>
  );
}
