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

// `As` → `A♠`, `Td` → `10♦`.
function formatCard(card: string) {
  const rank = card[0] === 'T' ? '10' : card[0];
  return `${rank}${SUITS[card[1] as keyof typeof SUITS]}`;
}

export const formatCards = (cards: readonly string[]) =>
  cards.map(formatCard).join(' ');

// `+16`, `-16`, `+0`.
export const formatSigned = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export const STREETS = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '轉牌',
  river: '河牌',
} as const;

// One step of a hand in words. A call's amount is the chips added, a raise's
// the total raised to.
export function eventLabel(
  event: MatchHand['events'][number],
  players: MatchDetail['players'],
) {
  const who = `${STREETS[event.street]} ${players[event.seat]}`;
  switch (event.type) {
    case 'post_blind':
      return `${who} 下盲注 ${event.amount}`;
    case 'fold':
      return `${who} 棄牌`;
    case 'check':
      return `${who} 過牌`;
    case 'call':
      return `${who} 跟注 ${event.amount}`;
    case 'raise':
      return `${who} 加注到 ${event.amount}`;
  }
}
