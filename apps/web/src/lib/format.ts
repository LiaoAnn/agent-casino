import type { MatchSummary } from '@agent-casino/api/src/contract/schemas';

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
