import type { WatchResponse } from '@agent-casino/api/src/contract/schemas';
import { Link } from '@tanstack/react-router';
import { BySeat, type Pair, Pairs } from '@/components/pairs';
import { Panel } from '@/components/panel';
import { Players } from '@/components/player-name';
import { Badge } from '@/components/ui/badge';
import { formatSigned, resultLabel } from '@/lib/format';

// How a watched match ended, with a link to its public record. A win or a
// loss of the watched seat is marked ▲ or ▼ beside the words. `shown` is
// the players' display names.
export function WatchResult({
  watch,
  players,
  shown,
}: {
  watch: Extract<WatchResponse, { result: unknown }>;
  players: readonly string[];
  shown: readonly string[];
}) {
  const label = resultLabel({ players: shown, result: watch.result });
  const winner = watch.result.endsWith('_win') ? Number(watch.result[4]) : null;
  const items: Pair[] = [
    [
      '玩家',
      <Players
        key="p"
        players={players}
        displayNames={shown}
        places={watch.places}
      />,
    ],
    [
      '結果',
      winner === null ? (
        label
      ) : (
        <Badge
          key="r"
          variant={winner === watch.seat ? 'win' : 'loss'}
          className="text-sm">
          {label}
        </Badge>
      ),
    ],
    [
      '最終籌碼',
      <BySeat key="f" players={shown} values={watch.final_stacks} />,
    ],
  ];
  // At a bigger table, where the watched seat came.
  const place = watch.places?.[watch.seat];
  if (players.length > 2 && place != null) {
    items.splice(2, 0, [
      '名次',
      `${shown[watch.seat] ?? ''} 第 ${place} 名`,
      'font-semibold text-gold-200',
    ]);
  }
  if (watch.ratings !== null) {
    items.push([
      'Elo',
      watch.ratings
        .map(
          (r, seat) =>
            `${shown[seat] ?? ''} ${r.rating} (${formatSigned(r.change)})`,
        )
        .join(' · '),
    ]);
  }
  return (
    <Panel aria-label="結果">
      <h3 className="font-semibold text-ivory text-lg">結果</h3>
      <Pairs items={items} />
      <Link
        to="/matches/$matchId"
        params={{ matchId: watch.match_id }}
        className="inline-block text-gold-400 text-sm underline underline-offset-4 hover:text-gold-200">
        完整對局紀錄
      </Link>
    </Panel>
  );
}
