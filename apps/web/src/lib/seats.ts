// Where each seat sits around the table (web-design 牌桌版面): a 3×3 grid
// with the middle plate in its centre, the bottom seat in the middle of the
// bottom row and the rest clockwise from it.
export type Slot =
  | 'bottom'
  | 'bottomLeft'
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'bottomRight';

export const SLOTS_BY_COUNT: Record<number, readonly Slot[]> = {
  2: ['bottom', 'top'],
  3: ['bottom', 'topLeft', 'topRight'],
  4: ['bottom', 'bottomLeft', 'top', 'bottomRight'],
  5: ['bottom', 'bottomLeft', 'topLeft', 'topRight', 'bottomRight'],
  6: ['bottom', 'bottomLeft', 'topLeft', 'top', 'topRight', 'bottomRight'],
};

// Each slot's cell of the 3×3 grid, the top row's bets below the seat and
// the bottom row's above, towards the middle.
export const SLOT_CLASS: Record<Slot, string> = {
  bottom: 'col-start-2 row-start-3 flex-col-reverse',
  bottomLeft: 'col-start-1 row-start-3 flex-col-reverse',
  topLeft: 'col-start-1 row-start-1 flex-col',
  top: 'col-start-2 row-start-1 flex-col',
  topRight: 'col-start-3 row-start-1 flex-col',
  bottomRight: 'col-start-3 row-start-3 flex-col-reverse',
};

// The seats of an `n`-seat table in the order they sit clockwise from the
// bottom, which `bottom` takes: seat numbers go up clockwise.
export const aroundTable = (n: number, bottom: number) =>
  Array.from({ length: n }, (_, i) => (bottom + i) % n);

export type Out = { place: number | null; left: boolean };

// Which seats are out of the match once hand `index` of `hands` is over: no
// chips left, gone by a `leave` in that hand or one before. `places` is
// each seat's place where known. Heads-up has none: there the hand that
// takes the last chips ends the match, and its plates say so already.
export function outAfter(
  hands: readonly {
    stacks: readonly number[];
    events: readonly { seat: number; type: string }[];
  }[],
  index: number,
  places: readonly (number | null)[] | null,
): (Out | null)[] {
  const stacks = hands[index]?.stacks ?? [];
  if (stacks.length <= 2) return stacks.map(() => null);
  const upTo = hands.slice(0, index + 1);
  return stacks.map((stack, seat) =>
    stack > 0
      ? null
      : {
          place: places?.[seat] ?? null,
          left: upTo.some(hand =>
            hand.events.some(e => e.type === 'leave' && e.seat === seat),
          ),
        },
  );
}
