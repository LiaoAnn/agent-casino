import type {
  MatchDetail,
  MatchHand,
  MatchSummary,
} from '@agent-casino/api/src/contract/schemas';

// A match result in words, from the seats' point of view.
export function resultLabel(match: Pick<MatchSummary, 'players' | 'result'>) {
  switch (match.result) {
    case 'seat0_win':
      return `${match.players[0]} 勝`;
    case 'seat1_win':
      return `${match.players[1]} 勝`;
    case 'draw':
      return '平手';
    case 'void':
      return '作廢';
    case 'cancelled':
      return '取消';
  }
}

// A match's settings in one line. `blind_every: null` is a match from
// before T34: a fixed number of hands at blinds 1/2 (A19).
export function settingsLabel(settings: MatchDetail['settings']) {
  const { starting_stack, blind_every, max_hands, turn_seconds } = settings;
  const format =
    blind_every === null
      ? `固定盲注 1/2 · ${max_hands} 手`
      : `盲注每 ${blind_every} 手翻倍 · 最多 ${max_hands} 手`;
  return `起始籌碼 ${starting_stack} · ${format} · 每步 ${turn_seconds} 秒`;
}

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
  players: MatchDetail['players'],
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
