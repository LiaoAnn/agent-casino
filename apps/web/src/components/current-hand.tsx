import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { ChipStack } from '@/components/chip-stack';
import { Felt } from '@/components/felt';
import { type Pair, Pairs } from '@/components/pairs';
import { Cards } from '@/components/playing-card';
import { SeatPanel } from '@/components/seat-panel';
import { STREETS } from '@/lib/format';

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
  // The board on top, the rest in a row below it.
  const table: Pair[] = [
    ['街', STREETS[view.street]],
    ['莊家', players[view.button_seat]],
    [
      '公共牌',
      view.board.length > 0 ? (
        <Cards key="b" cards={view.board} size="md" deal />
      ) : (
        '尚未發出'
      ),
      'order-first col-span-3',
    ],
    [
      '底池',
      <ChipStack key="p" amount={view.pot} />,
      'font-bold text-gold-200 text-xl',
    ],
  ];
  return (
    <section aria-label="目前這一手" className="space-y-4">
      <h3 className="font-semibold text-ivory text-lg">
        目前這一手：第 {handNumber} 手
      </h3>
      <Felt>
        <Pairs items={table} layout="tiles" className="grid-cols-3" />
      </Felt>
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
              turnSeconds={watch.settings.turn_seconds}
            />
          );
        })}
      </div>
    </section>
  );
}
