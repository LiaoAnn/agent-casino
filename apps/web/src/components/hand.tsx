import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { ActionLogEntry } from '@/components/action-log-entry';
import { BySeat, type Pair, Pairs } from '@/components/pairs';
import { Panel } from '@/components/panel';
import { Cards } from '@/components/playing-card';

// A finished hand of a watch link: the opponent's cards may be unknown and
// the watched seat's steps carry notes. A match record's hand has the same
// fields, with every card known.
export type HandRecord = WatchResponse['hands'][number];

// A finished hand in the watch page's timeline, compact: small cards,
// corners only, and its steps.

export function Hand({
  hand,
  players,
  enter = false,
}: {
  hand: HandRecord;
  players: MatchDetail['players'];
  enter?: boolean;
}) {
  const title = `第 ${hand.hand_number} 手`;
  const items: Pair[] = [['莊家', players[hand.button_seat]]];
  if (hand.board.length > 0) {
    items.push(['公共牌', <Cards key="b" cards={hand.board} />]);
  }
  // While the match is on, only the cards the seat has seen; once it is
  // over, both (the seed is public then).
  items.push([
    '底牌',
    <BySeat
      key="h"
      players={players}
      values={[
        <Cards key={0} cards={hand.hole_cards[0]} />,
        <Cards key={1} cards={hand.hole_cards[1]} />,
      ]}
    />,
  ]);
  items.push([
    '結果',
    hand.winner_seat === null
      ? `平分底池 ${hand.pot}`
      : `${players[hand.winner_seat]} 贏得 ${hand.pot}（${hand.ended_by === 'showdown' ? '攤牌' : '對手棄牌'}）`,
    'text-gold-200',
  ]);
  items.push([
    '籌碼',
    <BySeat key="s" players={players} values={hand.stacks} />,
  ]);
  return (
    <Panel aria-label={title} tone="sunken" enter={enter}>
      <h3 className="font-semibold text-ivory">{title}</h3>
      <Pairs items={items} />
      <Steps title={title} events={hand.events} players={players} />
    </Panel>
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
      className="list-decimal space-y-1 border-gold-600/25 border-t pt-3 pl-6 text-sm marker:text-slate">
      {events.map((event, i) => (
        // Events have no id; their order is fixed.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <ActionLogEntry key={i} event={event} players={players} />
      ))}
    </ol>
  );
}
