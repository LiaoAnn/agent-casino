import { Felt, TableCenter } from '@/components/felt';
import { type HandRecord, Steps } from '@/components/hand';
import { Panel } from '@/components/panel';
import { SeatPanel } from '@/components/seat-panel';
import { blindsLabel, handResult } from '@/lib/format';
import { aroundTable, type Out } from '@/lib/seats';

type Ratings = readonly (number | undefined)[];

// A finished hand's table as it ended: `bottom` at the bottom edge and the
// other seats clockwise, each with their hole cards (backs where unknown)
// and chips after the hand, the winners marked, the seats out of the match
// (`outs`) dimmed; the board, the pots, the dealer and the result in the
// middle. `players` is each seat's display name, `ratings` its Elo where
// known.
export function HandTable({
  hand,
  players,
  ratings,
  bottom,
  outs = [],
}: {
  hand: HandRecord;
  players: readonly string[];
  ratings: Ratings;
  bottom: number;
  outs?: readonly (Out | null)[];
}) {
  const n = hand.stacks.length;
  // Heads-up marks only the one winner of the whole pot, as it always has.
  const won = (s: number) =>
    hand.winner_seat === s ||
    (n > 2 && hand.pots.some(pot => pot.winner_seats.some(w => w === s)));
  const seats = aroundTable(n, bottom).map(s => ({
    key: s,
    seat: (
      <SeatPanel
        name={players[s] ?? ''}
        stack={hand.stacks[s] ?? 0}
        rating={ratings[s]}
        cards={hand.hole_cards[s] ?? null}
        dealer={hand.button_seat === s}
        won={won(s)}
        out={outs[s] ?? null}
        compact={n > 2}
      />
    ),
  }));
  return (
    <Felt seats={seats}>
      <TableCenter
        board={hand.board}
        emptyBoard="沒有發公共牌"
        pots={hand.pots.length > 0 ? hand.pots.map(p => p.amount) : [hand.pot]}
        details={[
          ['莊家', players[hand.button_seat] ?? ''],
          ['盲注', blindsLabel(hand.blinds)],
          [
            '結果',
            handResult(hand, players),
            'basis-full justify-center text-gold-200',
          ],
        ]}
      />
    </Felt>
  );
}

// One hand of a match record: its table as it ended, seat 0 at the bottom
// (every hole card is public once the match is over), and beside it (below
// it on a narrow screen) every step. `ratings` is each player's Elo before
// the match, for a rated one; `outs` the seats out of the match by the end
// of this hand.
export function MatchHand({
  hand,
  players,
  ratings,
  outs,
}: {
  hand: HandRecord;
  players: readonly string[];
  ratings: Ratings;
  outs?: readonly (Out | null)[];
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
            outs={outs}
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
