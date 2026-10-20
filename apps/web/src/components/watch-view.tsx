import type { WatchResponse } from '@agent-casino/api/src/contract/schemas';
import { CurrentHand, WaitingTable } from '@/components/current-hand';
import { EmptyState } from '@/components/empty-state';
import { Hand, Steps } from '@/components/hand';
import { HandTable } from '@/components/match-hand';
import { Notice } from '@/components/notice';
import { type Pair, Pairs } from '@/components/pairs';
import { PageTitle, Panel } from '@/components/panel';
import { PlayerName } from '@/components/player-name';
import { WatchResult } from '@/components/watch-result';
import { formatClock, outLabel, settingsLabel } from '@/lib/format';
import { outAfter } from '@/lib/seats';

const STATUS = {
  waiting: '等待開打',
  playing: '進行中',
  finished: '已結束',
  void: '作廢',
} as const;

// The owner's view of one seat: who and how on top; below, the table while a
// hand is in play, or once over the result and the table as the last hand
// ended; beside it (below it on a narrow screen) the timeline of every hand
// so far. `ratings` is the
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
  const { settings, view, hand_number, players } = watch;
  // What the table, the timeline and the result show (A20).
  const shown = watch.display_names;
  const waiting = watch.room_status === 'waiting';
  const info: Pair[] = [
    [
      '觀看',
      <PlayerName
        key="w"
        name={players[watch.seat] ?? ''}
        displayName={shown[watch.seat] ?? ''}
      />,
      'text-gold-200',
    ],
    ['狀態', STATUS[watch.room_status]],
    ['設定', settingsLabel(settings, { started: !waiting })],
    ['最後更新', updatedAt === null ? '' : formatClock(updatedAt)],
  ];
  const seatRatings = players.map(name => ratings.get(name.toLowerCase()));
  const places =
    'places' in watch ? watch.places : watch.seats.map(seat => seat.place);
  const last = watch.hands.at(-1);
  const inPlay =
    watch.room_status === 'playing' && view !== null && hand_number !== null;
  // The watched seat is out while the others play on.
  const mine = watch.seats[watch.seat];
  const outEarly =
    watch.room_status === 'playing' &&
    mine !== undefined &&
    (mine.status === 'out' || mine.status === 'left');
  const title = waiting
    ? '等待開打'
    : players.length <= 2
      ? `${shown[0]} vs ${shown[1]}`
      : `${players.length} 人桌`;
  return (
    <div className="space-y-6">
      <PageTitle>{title}</PageTitle>
      <Panel>
        <Pairs items={info} label="觀戰資訊" />
        {outEarly && (
          <p role="status" className="text-ivory text-sm">
            {outLabel({ place: mine.place, left: mine.status === 'left' })}
            。牌桌還在進行，積分在整桌結束後才算。
          </p>
        )}
        {offline && (
          <p role="status" className="text-red-400 text-sm">
            <span aria-hidden="true" className="mr-2 before:content-['⚠']" />
            暫時連不上，稍後自動重試。
          </p>
        )}
      </Panel>
      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {waiting && (
            <WaitingTable watch={watch} players={shown} ratings={seatRatings} />
          )}
          {inPlay && (
            <CurrentHand
              watch={watch}
              view={view}
              handNumber={hand_number}
              players={shown}
              ratings={seatRatings}
            />
          )}
          {'result' in watch && (
            <WatchResult watch={watch} players={players} shown={shown} />
          )}
          {/* Once over, the table stays, as the last hand ended. */}
          {!inPlay && last !== undefined && (
            <section aria-label="最後一手" className="space-y-4">
              <h3 className="font-semibold text-ivory text-lg">
                最後一手：第 {last.hand_number} 手
              </h3>
              <HandTable
                hand={last}
                players={shown}
                ratings={seatRatings}
                bottom={watch.seat}
                outs={outAfter(watch.hands, watch.hands.length - 1, places)}
              />
            </section>
          )}
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
                  players={shown}
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
                    players={shown}
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
