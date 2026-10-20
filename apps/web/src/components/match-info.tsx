import type { MatchDetail } from '@agent-casino/api/src/contract/schemas';
import { BySeat, type Pair, Pairs } from '@/components/pairs';
import { Players } from '@/components/player-name';
import {
  formatSigned,
  formatTime,
  resultLabel,
  settingsLabel,
} from '@/lib/format';

// The facts of a finished match, above its hands.
export function MatchInfo({ match }: { match: MatchDetail }) {
  const { players, display_names: shown, settings } = match;
  const reason = (() => {
    switch (match.end_reason) {
      case 'bust':
        return '一方輸光';
      case 'max_hands':
        return `打滿 ${settings.max_hands} 手，比籌碼`;
      case 'leave':
        return players.length <= 2
          ? `${shown[match.result === 'seat0_win' ? 1 : 0]} 離席`
          : '有人離席';
      case 'bots_only':
        return '桌上只剩 house-bot';
      case 'void':
        return '作廢';
      case 'cancelled':
        return '取消';
      case null:
        return null;
    }
  })();
  const items: Pair[] = [
    [
      '玩家',
      <Players
        key="p"
        players={players}
        displayNames={shown}
        places={match.places}
      />,
    ],
    [
      '結果',
      resultLabel({ players: shown, result: match.result }),
      'font-semibold text-gold-200',
    ],
    ['結束時間', formatTime(match.ended_at)],
    ['計分', match.rated ? '計分' : '不計分'],
    ['設定', settingsLabel(settings)],
    ['種子', String(match.seed)],
    [
      '最終籌碼',
      <BySeat key="f" players={shown} values={match.final_stacks} />,
    ],
  ];
  if (reason !== null) items.splice(2, 0, ['結束原因', reason]);
  if (match.rating_changes !== null) {
    items.push([
      'Elo',
      match.rating_changes
        .map(
          (c, seat) =>
            `${shown[seat] ?? ''} ${c.before} → ${c.after} (${formatSigned(c.after - c.before)})`,
        )
        .join(' · '),
    ]);
  }
  return <Pairs items={items} label="對局資訊" />;
}
