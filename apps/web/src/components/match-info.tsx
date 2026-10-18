import type { MatchDetail } from '@agent-casino/api/src/contract/schemas';
import { BySeat, type Pair, Pairs } from '@/components/pairs';
import { PlayerName } from '@/components/player-name';
import {
  formatSigned,
  formatTime,
  resultLabel,
  settingsLabel,
} from '@/lib/format';

// The facts of a finished match, above its hands.
export function MatchInfo({ match }: { match: MatchDetail }) {
  const { players, display_names: shown, settings } = match;
  const items: Pair[] = [
    [
      '玩家',
      <span key="p" className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <PlayerName name={players[0]} displayName={shown[0]} />
        <span className="text-mist">vs</span>
        <PlayerName name={players[1]} displayName={shown[1]} />
      </span>,
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
  if (match.rating_changes !== null) {
    items.push([
      'Elo',
      match.rating_changes
        .map(
          (c, seat) =>
            `${shown[seat]} ${c.before} → ${c.after} (${formatSigned(c.after - c.before)})`,
        )
        .join(' · '),
    ]);
  }
  return <Pairs items={items} label="對局資訊" />;
}
