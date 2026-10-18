import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { Link } from '@tanstack/react-router';
import { bySeat, Pairs } from '@/components/hand';
import { formatSigned, resultLabel } from '@/lib/format';

// How a watched match ended, with a link to its public record.
export function WatchResult({
  watch,
  players,
}: {
  watch: Extract<WatchResponse, { result: unknown }>;
  players: MatchDetail['players'];
}) {
  const items: [string, string][] = [
    ['結果', resultLabel({ players, result: watch.result })],
    ['最終籌碼', bySeat(players, watch.final_stacks)],
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
    <section aria-label="結果" className="space-y-3">
      <h3 className="font-semibold">結果</h3>
      <Pairs items={items} />
      <Link
        to="/matches/$matchId"
        params={{ matchId: watch.match_id }}
        className="inline-block text-sm underline underline-offset-4">
        完整對局紀錄
      </Link>
    </section>
  );
}
