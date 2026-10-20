import type { WatchResponse } from '@agent-casino/api/src/contract/schemas';
import { ActionLogEntry } from '@/components/action-log-entry';
import { BySeat, type Pair, Pairs } from '@/components/pairs';
import { Panel } from '@/components/panel';
import { Cards } from '@/components/playing-card';
import { blindsLabel, handResult } from '@/lib/format';

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
  players: readonly string[];
  enter?: boolean;
}) {
  const title = `第 ${hand.hand_number} 手`;
  const items: Pair[] = [
    ['莊家', players[hand.button_seat]],
    ['盲注', blindsLabel(hand.blinds)],
  ];
  if (hand.board.length > 0) {
    items.push(['公共牌', <Cards key="b" cards={hand.board} />]);
  }
  // While the match is on, only the cards the seat has seen; once it is
  // over, every seat's (the seed is public then). At a bigger table, only
  // the seats dealt in: the ones with a step in the hand.
  const dealt = hand.hole_cards
    .map((cards, seat) => ({ cards, seat }))
    .filter(
      ({ seat }) =>
        players.length <= 2 || hand.events.some(e => e.seat === seat),
    );
  items.push([
    '底牌',
    <BySeat
      key="h"
      players={dealt.map(({ seat }) => players[seat] ?? '')}
      values={dealt.map(({ cards, seat }) => (
        <Cards key={seat} cards={cards} />
      ))}
    />,
  ]);
  items.push(['結果', handResult(hand, players), 'text-gold-200']);
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
  players: readonly string[];
}) {
  return (
    <ol
      aria-label={`${title}的動作`}
      className="list-decimal space-y-1 border-gold-600/25 border-t pt-3 pl-6 text-sm marker:text-slate">
      {events.map((event, i) => (
        // Events have no id; their order is fixed.
        <ActionLogEntry
          // biome-ignore lint/suspicious/noArrayIndexKey: events have fixed order
          key={i}
          event={event}
          players={players}
          previousEvents={events.slice(0, i)}
        />
      ))}
    </ol>
  );
}
