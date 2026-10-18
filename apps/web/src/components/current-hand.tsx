import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { Bet, Felt, TableCenter } from '@/components/felt';
import { SeatPanel } from '@/components/seat-panel';
import { STREETS } from '@/lib/format';

// The hand in play, as the watched seat sees it: both players at the table,
// the watched one at the bottom edge, their bets this street in front of
// them, the board and the pot in the middle. `ratings` is each player's Elo
// where known.
export function CurrentHand({
  watch,
  view,
  handNumber,
  players,
  ratings,
}: {
  watch: WatchResponse;
  view: NonNullable<WatchResponse['view']>;
  handNumber: number;
  players: MatchDetail['players'];
  ratings: readonly [number | undefined, number | undefined];
}) {
  const seat = (s: 0 | 1) => {
    const mine = s === watch.seat;
    return {
      name: players[s],
      bet: mine ? view.my_bet_this_street : view.opponent_bet_this_street,
      seat: (
        <SeatPanel
          name={players[s]}
          stack={mine ? view.my_stack : view.opponent_stack}
          rating={ratings[s]}
          cards={mine ? view.my_cards : null}
          dealer={view.button_seat === s}
          toAct={watch.to_act_seat === s}
          deadline={mine ? watch.deadline : null}
          turnSeconds={watch.settings.turn_seconds}
          deal
        />
      ),
    };
  };
  const bottom = seat(watch.seat);
  const top = seat(watch.seat === 0 ? 1 : 0);
  return (
    <section aria-label="目前這一手" className="space-y-4">
      <h3 className="font-semibold text-ivory text-lg">
        目前這一手：第 {handNumber} 手
      </h3>
      <Felt
        top={top.seat}
        topBet={<Bet name={top.name} amount={top.bet} />}
        bottom={bottom.seat}
        bottomBet={<Bet name={bottom.name} amount={bottom.bet} />}>
        <TableCenter
          board={view.board}
          emptyBoard="尚未發出"
          pot={view.pot}
          deal
          details={[
            ['街', STREETS[view.street]],
            ['莊家', players[view.button_seat]],
          ]}
        />
      </Felt>
    </section>
  );
}
