import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { CurrentHand } from '@/components/current-hand';
import { EmptyState } from '@/components/empty-state';
import { Hand, Steps } from '@/components/hand';
import { Notice } from '@/components/notice';
import { type Pair, Pairs } from '@/components/pairs';
import { PageTitle, Panel } from '@/components/panel';
import { WatchResult } from '@/components/watch-result';
import { formatClock } from '@/lib/format';

const STATUS = {
  waiting: '等待對手',
  playing: '進行中',
  finished: '已結束',
  void: '作廢',
} as const;

// The owner's view of one seat: who and how on top; below, the table while a
// hand is in play or the result once over, and beside it (below it on a
// narrow screen) the timeline of every hand so far. `ratings` is the
// leaderboard's Elo by lower-case name, for the players on it.
export function WatchView({
  watch,
  offline,
  updatedAt,
  ratings,
}: {
  watch: WatchResponse;
  offline: boolean;
  updatedAt: number | null;
  ratings: ReadonlyMap<string, number>;
}) {
  const { settings, view, hand_number } = watch;
  const players: MatchDetail['players'] = [
    watch.players[0],
    watch.players[1] ?? '（等待對手）',
  ];
  const info: Pair[] = [
    ['觀看', players[watch.seat], 'font-semibold text-gold-200'],
    ['狀態', STATUS[watch.room_status]],
    [
      '設定',
      `${settings.hands} 手 · 每步 ${settings.turn_seconds} 秒 · 起始籌碼 ${settings.starting_stack}`,
    ],
    ['最後更新', updatedAt === null ? '' : formatClock(updatedAt)],
  ];
  const inPlay =
    watch.room_status === 'playing' && view !== null && hand_number !== null;
  return (
    <div className="space-y-6">
      <PageTitle>
        {players[0]} vs {players[1]}
      </PageTitle>
      <Panel>
        <Pairs items={info} label="觀戰資訊" />
        {offline && (
          <p role="status" className="text-red-400 text-sm">
            <span aria-hidden="true" className="mr-2 before:content-['⚠']" />
            暫時連不上，稍後自動重試。
          </p>
        )}
      </Panel>
      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {watch.room_status === 'waiting' && (
            <EmptyState>等待對手加入…</EmptyState>
          )}
          {inPlay && (
            <CurrentHand
              watch={watch}
              view={view}
              handNumber={hand_number}
              players={players}
              ratings={[
                ratings.get(players[0].toLowerCase()),
                ratings.get(players[1].toLowerCase()),
              ]}
            />
          )}
          {'result' in watch && <WatchResult watch={watch} players={players} />}
        </div>
        <section className="min-w-0 space-y-3 lg:sticky lg:top-4">
          <h3 className="font-semibold text-gold-200 text-lg">時間線</h3>
          {watch.hands.length === 0 && !inPlay && (
            <EmptyState>還沒有任何動作。</EmptyState>
          )}
          {/* Its own scroll on a wide screen; column-reverse keeps it at
              the newest step as steps come in. */}
          <div className="flex flex-col-reverse lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <div className="space-y-3">
              {watch.hands.map(hand => (
                <Hand
                  key={hand.hand_number}
                  hand={hand}
                  players={players}
                  enter
                />
              ))}
              {inPlay && (
                <Panel
                  aria-label={`第 ${hand_number} 手（進行中）`}
                  tone="sunken"
                  enter>
                  <h3 className="font-semibold text-ivory">
                    第 {hand_number} 手（進行中）
                  </h3>
                  <Steps
                    title={`第 ${hand_number} 手（進行中）`}
                    events={view.history}
                    players={players}
                  />
                </Panel>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

const ERRORS = {
  invalid_token:
    '這個觀戰連結無效。請確認網址完整，或向你的 agent 重新要一次 watch_url。',
  room_not_found: '找不到這個房間。',
} as const;

export function WatchError({ code }: { code: keyof typeof ERRORS }) {
  return <Notice title="無法觀看這場對局">{ERRORS[code]}</Notice>;
}
