import type {
  MatchDetail,
  MatchHand,
  MatchSummary,
} from '@agent-casino/api/src/contract/schemas';

// A match result in words, from the seats' point of view: heads-up `alice
// 勝`, at a bigger table who came first.
export function resultLabel(match: Pick<MatchSummary, 'players' | 'result'>) {
  const headsUp = match.players.length <= 2;
  switch (match.result) {
    case 'draw':
      return headsUp ? '平手' : '並列第 1';
    case 'void':
      return '作廢';
    case 'cancelled':
      return '取消';
    default: {
      const winner = match.players[Number(match.result[4])];
      return headsUp ? `${winner} 勝` : `冠軍：${winner}`;
    }
  }
}

// A match's settings in one line. `blind_every: null` is a match from
// before T34: a fixed number of hands at blinds 1/2 (A19); for a table not
// `started` yet, a pace set by the player count when it starts (A25).
export function settingsLabel(
  settings: MatchDetail['settings'],
  { started = true }: { started?: boolean } = {},
) {
  const { starting_stack, blind_every, max_hands, turn_seconds } = settings;
  const format =
    blind_every !== null
      ? `盲注每 ${blind_every} 手翻倍 · 最多 ${max_hands} 手`
      : started
        ? `固定盲注 1/2 · ${max_hands} 手`
        : `盲注依人數翻倍 · 最多 ${max_hands} 手`;
  return `起始籌碼 ${starting_stack} · ${format} · 每步 ${turn_seconds} 秒`;
}

// What each pot of a hand is called, main pot first: one pot is just the
// pot; side pots are numbered when there is more than one.
export const potNames = (count: number): string[] =>
  count <= 1
    ? ['底池']
    : [
        '主池',
        ...Array.from({ length: count - 1 }, (_, i) =>
          count === 2 ? '邊池' : `邊池 ${i + 1}`,
        ),
      ];

// How a finished hand ended, in words. Heads-up reads as it always has;
// at a bigger table, who won each pot.
export function handResult(
  hand: Pick<MatchHand, 'winner_seat' | 'pot' | 'pots' | 'ended_by'>,
  players: readonly string[],
) {
  const names = (seats: readonly number[]) =>
    seats.map(seat => players[seat]).join('、');
  const how = hand.ended_by === 'showdown' ? '攤牌' : null;
  if (players.length <= 2 || hand.pots.length <= 1) {
    if (hand.winner_seat !== null) {
      const fold = players.length <= 2 ? '對手棄牌' : '其他人棄牌';
      return `${players[hand.winner_seat]} 贏得 ${hand.pot}（${how ?? fold}）`;
    }
    const winners = hand.pots[0]?.winner_seats ?? [];
    return players.length <= 2 || winners.length === 0
      ? `平分底池 ${hand.pot}`
      : `${names(winners)} 平分底池 ${hand.pot}（${how ?? '其他人棄牌'}）`;
  }
  const label = potNames(hand.pots.length);
  const each = hand.pots.map(
    (pot, i) =>
      `${label[i]} ${pot.amount}：${names(pot.winner_seats)} ${pot.winner_seats.length > 1 ? '平分' : '贏'}`,
  );
  return `${each.join('；')}${how === null ? '' : `（${how}）`}`;
}

// A seat whose match is over before the table's: `第 4 名・出局`.
export const outLabel = ({
  place,
  left,
}: {
  place: number | null;
  left: boolean;
}) => {
  const what = left ? '離開' : '出局';
  return place === null ? what : `第 ${place} 名・${what}`;
};

// `[small, big]` → `1/2`.
export const blindsLabel = ([small, big]: MatchHand['blinds']) =>
  `${small}/${big}`;

// `2026-10-01T00:37:00.000Z` → `2026-10-01 00:37 UTC`. Always UTC, so the
// server and the browser render the same text.
export function formatTime(iso: string) {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

// `21:05:48`, in the browser's zone: only for times shown after hydration.
export const formatClock = (time: number) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(time);

const SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' } as const;

// `As` → `{ rank: 'A', suit: 's', symbol: '♠' }`, `Td` → rank `10`.
export function parseCard(card: string) {
  const suit = card[1] as keyof typeof SUITS;
  return { rank: card[0] === 'T' ? '10' : card[0], suit, symbol: SUITS[suit] };
}

// `+16`, `-16`, `+0`.
export const formatSigned = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export const STREETS = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '轉牌',
  river: '河牌',
} as const;

// One step of a hand in words, in parts so the amount can stand out. A
// call's amount is the chips added, a raise's the total raised to.
export function eventParts(
  event: MatchHand['events'][number],
  players: readonly string[],
  previousEvents: readonly MatchHand['events'][number][] = [],
) {
  const street = STREETS[event.street];
  const who = players[event.seat];
  switch (event.type) {
    case 'post_blind':
      return { street, who, action: '下盲注', amount: event.amount };
    case 'fold':
      return { street, who, action: '棄牌' };
    case 'check':
      return { street, who, action: '過牌' };
    case 'call':
      return { street, who, action: '跟注', amount: event.amount };
    case 'raise':
      return {
        street,
        who,
        action: previousEvents.some(
          e =>
            e.street === event.street &&
            (e.type === 'post_blind' || e.type === 'raise'),
        )
          ? '加注到'
          : '下注',
        amount: event.amount,
      };
    // Only at a multiplayer table (E6): the chips taken off the table.
    case 'leave':
      return { street, who, action: '離開', amount: event.amount };
  }
}
