import type { MatchDetail } from '@agent-casino/api/src/contract/schemas';
import { Felt, TableCenter } from '@/components/felt';
import { type HandRecord, Steps } from '@/components/hand';
import { Panel } from '@/components/panel';
import { SeatPanel } from '@/components/seat-panel';

type Ratings = readonly [number | undefined, number | undefined];

// A finished hand's table as it ended: `bottom` at the bottom edge, the
// other seat at the top, each with their hole cards (backs where unknown)
// and chips after the hand, the winner marked; the board, the pot, the
// dealer and the result in the middle. `ratings` is each player's Elo
// where known.
export function HandTable({
  hand,
  players,
  ratings,
  bottom,
}: {
  hand: HandRecord;
  players: MatchDetail['players'];
  ratings: Ratings;
  bottom: 0 | 1;
}) {
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
    <Felt top={seat(bottom === 0 ? 1 : 0)} bottom={seat(bottom)}>
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
  );
}

// One hand of a match record: its table as it ended, seat 0 at the bottom
// (every hole card is public once the match is over), and beside it (below
// it on a narrow screen) every step. `ratings` is each player's Elo before
// the match, for a rated one.
export function MatchHand({
  hand,
  players,
  ratings,
}: {
  hand: HandRecord;
  players: MatchDetail['players'];
  ratings: Ratings;
}) {
  const title = `第 ${hand.hand_number} 手`;
  return (
    <Panel aria-label={title} tone="sunken">
      <h3 className="font-semibold text-ivory">{title}</h3>
      <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
        <div className="min-w-0 lg:col-span-2">
          <HandTable
            hand={hand}
            players={players}
            ratings={ratings}
            bottom={0}
          />
        </div>
        {/* Its own scroll on a wide screen, so the table stays in view. */}
        <div className="min-w-0 lg:max-h-[36rem] lg:overflow-y-auto">
          <Steps title={title} events={hand.events} players={players} />
        </div>
      </div>
    </Panel>
  );
}
