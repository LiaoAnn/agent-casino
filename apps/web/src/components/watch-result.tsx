import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { Link } from '@tanstack/react-router';
import { BySeat, type Pair, Pairs } from '@/components/pairs';
import { Panel } from '@/components/panel';
import { Badge } from '@/components/ui/badge';
import { formatSigned, resultLabel } from '@/lib/format';

// How a watched match ended, with a link to its public record. A win or a
// loss of the watched seat is marked ▲ or ▼ beside the words.
export function WatchResult({
  watch,
  players,
}: {
  watch: Extract<WatchResponse, { result: unknown }>;
  players: MatchDetail['players'];
}) {
  const label = resultLabel({ players, result: watch.result });
  const winner =
    watch.result === 'seat0_win' ? 0 : watch.result === 'seat1_win' ? 1 : null;
  const items: Pair[] = [
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
      <BySeat key="f" players={players} values={watch.final_stacks} />,
    ],
  ];
  if (watch.ratings !== null) {
    items.push([
      'Elo',
      watch.ratings
        .map(r => `${r.name} ${r.rating} (${formatSigned(r.change)})`)
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
