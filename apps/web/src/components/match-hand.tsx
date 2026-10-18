import type {
  MatchDetail,
  MatchHand as MatchHandRecord,
} from '@agent-casino/api/src/contract/schemas';
import { Felt, TableCenter } from '@/components/felt';
import { Steps } from '@/components/hand';
import { Panel } from '@/components/panel';
import { SeatPanel } from '@/components/seat-panel';

// One hand of a match record: the table as the hand ended, seat 0 at the
// bottom edge and seat 1 at the top, each with their hole cards (all public
// once the match is over) and chips after the hand, the board and the pot
// in the middle; beside it (below it on a narrow screen) every step.
// `ratings` is each player's Elo before the match, for a rated one.
export function MatchHand({
  hand,
  players,
  ratings,
}: {
  hand: MatchHandRecord;
  players: MatchDetail['players'];
  ratings: readonly [number | undefined, number | undefined];
}) {
  const title = `第 ${hand.hand_number} 手`;
  const seat = (s: 0 | 1) => (
    <SeatPanel
      name={players[s]}
      stack={hand.stacks[s]}
      rating={ratings[s]}
      cards={hand.hole_cards[s]}
      dealer={hand.button_seat === s}
      won={hand.winner_seat === s}
    />
  );
  const result =
    hand.winner_seat === null
      ? `平分底池 ${hand.pot}`
      : `${players[hand.winner_seat]} 贏得 ${hand.pot}（${hand.ended_by === 'showdown' ? '攤牌' : '對手棄牌'}）`;
  return (
    <Panel aria-label={title} tone="sunken">
      <h3 className="font-semibold text-ivory">{title}</h3>
      <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
        <div className="min-w-0 lg:col-span-2">
          <Felt top={seat(1)} bottom={seat(0)}>
            <TableCenter
              board={hand.board}
              emptyBoard="沒有發公共牌"
              pot={hand.pot}
              details={[
                ['莊家', players[hand.button_seat]],
                ['結果', result, 'basis-full justify-center text-gold-200'],
              ]}
            />
          </Felt>
        </div>
        <Steps title={title} events={hand.events} players={players} />
      </div>
    </Panel>
  );
}
