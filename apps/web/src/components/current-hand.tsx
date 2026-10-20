import type { WatchResponse } from '@agent-casino/api/src/contract/schemas';
import { Bet, Felt, TableCenter } from '@/components/felt';
import type { Pair } from '@/components/pairs';
import { EmptySeat, SeatPanel } from '@/components/seat-panel';
import { blindsLabel, STREETS } from '@/lib/format';
import { aroundTable } from '@/lib/seats';

type Ratings = readonly (number | undefined)[];

// A seat that is out of the match, as its plate shows it.
const outOf = (seat: WatchResponse['seats'][number]) =>
  seat.status === 'out' || seat.status === 'left'
    ? { place: seat.place, left: seat.status === 'left' }
    : null;

// The hand in play, as the watched seat sees it: every player at the table,
// the watched one at the bottom edge and the others clockwise, their bets
// this street in front of them, the board and the pots in the middle.
// `players` is each seat's display name, `ratings` its Elo where known.
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
  players: readonly string[];
  ratings: Ratings;
}) {
  const compact = watch.seats.length > 2;
  const seats = aroundTable(watch.seats.length, watch.seat).map(s => {
    const seat = watch.seats[s];
    const mine = s === watch.seat;
    const out = seat === undefined ? null : outOf(seat);
    return {
      key: s,
      bet:
        out === null ? (
          <Bet name={players[s] ?? ''} amount={seat?.bet_this_street ?? 0} />
        ) : undefined,
      seat: (
        <SeatPanel
          name={players[s] ?? ''}
          stack={seat?.stack ?? 0}
          rating={ratings[s]}
          cards={mine && out === null ? view.my_cards : null}
          dealer={view.button_seat === s}
          toAct={watch.to_act_seat === s}
          deadline={mine ? watch.deadline : null}
          turnSeconds={watch.settings.turn_seconds}
          folded={seat?.status === 'folded'}
          out={out}
          compact={compact}
          inPlay
          deal
        />
      ),
    };
  });
  return (
    <section aria-label="目前這一手" className="space-y-4">
      <h3 className="font-semibold text-ivory text-lg">
        目前這一手：第 {handNumber} 手
      </h3>
      <Felt seats={seats}>
        <TableCenter
          board={view.board}
          emptyBoard="尚未發出"
          pots={view.pots.length > 0 ? view.pots : [view.pot]}
          deal
          details={[
            ['街', STREETS[view.street]],
            ['莊家', players[view.button_seat] ?? ''],
            ['盲注', blindsLabel(view.blinds)],
            ...(view.next_blinds_at_hand === null
              ? []
              : ([
                  ['下次升盲', `第 ${view.next_blinds_at_hand} 手`],
                ] satisfies Pair[])),
          ]}
        />
      </Felt>
    </section>
  );
}

// A table not started yet: the players seated so far, the watched one at the
// bottom, and a dashed frame for each seat still open.
export function WaitingTable({
  watch,
  players,
  ratings,
}: {
  watch: WatchResponse;
  players: readonly string[];
  ratings: Ratings;
}) {
  const seated = watch.seats.length;
  const total = seated + watch.seats_open;
  const compact = total > 2;
  // The open seats come after the last one taken, the next to sit down.
  const seats = aroundTable(total, watch.seat).map(s => ({
    key: s,
    seat:
      s < seated ? (
        <SeatPanel
          name={players[s] ?? ''}
          stack={watch.seats[s]?.stack ?? watch.settings.starting_stack}
          rating={ratings[s]}
          cards={[]}
          dealer={false}
          compact={compact}
        />
      ) : (
        <EmptySeat compact={compact} />
      ),
  }));
  return (
    <section aria-label="等待開打" className="space-y-4">
      <h3 className="font-semibold text-ivory text-lg">牌桌</h3>
      <Felt seats={seats}>
        <p className="text-center font-semibold text-gold-200">等待開打</p>
        <p className="mt-1 text-center text-ivory text-sm">
          {watch.seats_open === 0
            ? '已經坐滿'
            : `還有 ${watch.seats_open} 個空位`}
        </p>
      </Felt>
    </section>
  );
}
