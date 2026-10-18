import type { MatchDetail } from '@agent-casino/api/src/contract/schemas';
import { BySeat, type Pair, Pairs } from '@/components/pairs';
import { formatSigned, formatTime, resultLabel } from '@/lib/format';

// The facts of a finished match, above its hands.
export function MatchInfo({ match }: { match: MatchDetail }) {
  const { players, settings } = match;
  const items: Pair[] = [
    ['結果', resultLabel(match), 'font-semibold text-gold-200'],
    ['結束時間', formatTime(match.ended_at)],
    ['計分', match.rated ? '計分' : '不計分'],
    [
      '設定',
      `${settings.hands} 手 · 每步 ${settings.turn_seconds} 秒 · 起始籌碼 ${settings.starting_stack}`,
    ],
    ['種子', String(match.seed)],
    [
      '最終籌碼',
      <BySeat key="f" players={players} values={match.final_stacks} />,
    ],
  ];
  if (match.rating_changes !== null) {
    items.push([
      'Elo',
      match.rating_changes
        .map(
          c =>
            `${c.name} ${c.before} → ${c.after} (${formatSigned(c.after - c.before)})`,
        )
        .join(' · '),
    ]);
  }
  return <Pairs items={items} label="對局資訊" />;
}
