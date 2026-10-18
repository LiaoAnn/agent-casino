import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { Pairs } from '@/components/hand';
import { SeatPanel } from '@/components/seat-panel';
import { formatCards, STREETS } from '@/lib/format';

// The hand in play, as the watched seat sees it: the table, then both seats
// in seat order.
export function CurrentHand({
  watch,
  view,
  handNumber,
  players,
}: {
  watch: WatchResponse;
  view: NonNullable<WatchResponse['view']>;
  handNumber: number;
  players: MatchDetail['players'];
}) {
  const table: [string, string][] = [
    ['街', STREETS[view.street]],
    ['莊家', players[view.button_seat]],
    ['公共牌', view.board.length > 0 ? formatCards(view.board) : '尚未發出'],
    ['底池', String(view.pot)],
  ];
  return (
    <section aria-label="目前這一手" className="space-y-4">
      <h3 className="font-semibold">目前這一手：第 {handNumber} 手</h3>
      <Pairs items={table} />
      <div className="grid gap-4 sm:grid-cols-2">
        {([0, 1] as const).map(seat => {
          const mine = seat === watch.seat;
          return (
            <SeatPanel
              key={seat}
              name={players[seat]}
              stack={mine ? view.my_stack : view.opponent_stack}
              bet={
                mine ? view.my_bet_this_street : view.opponent_bet_this_street
              }
              cards={mine ? view.my_cards : null}
              toAct={watch.to_act_seat === seat}
              deadline={mine ? watch.deadline : null}
            />
          );
        })}
      </div>
    </section>
  );
}
