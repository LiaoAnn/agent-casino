import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { CurrentHand } from '@/components/current-hand';
import { Hand, Pairs, Steps } from '@/components/hand';
import { WatchResult } from '@/components/watch-result';
import { getWatch, type WatchData } from '@/data';
import { formatClock } from '@/lib/format';

// Each poll is a Durable Object request (docs/cost.md 6b): every 2.5 s while
// the match is on, never once it is over.
const POLL_MS = 2500;

// The owner's read-only view of their agent's seat (A16), from the
// `watch_url` the agent hands over.
export const Route = createFileRoute('/watch/$roomId')({
  // Optional, so a link without one shows the explanation, not a redirect.
  validateSearch: (search: Record<string, unknown>): { token?: string } =>
    search.token === undefined ? {} : { token: String(search.token) },
  loaderDeps: ({ search }) => ({ token: search.token ?? '' }),
  loader: ({ params, deps }) =>
    getWatch({ data: { roomId: params.roomId, token: deps.token } }),
  // The URL holds the token: never send it on to another page.
  headers: () => ({ 'Referrer-Policy': 'no-referrer' }),
  component: WatchPage,
});

function WatchPage() {
  const { roomId } = Route.useParams();
  const { token } = Route.useLoaderDeps();
  const initial = Route.useLoaderData();
  return (
    <Watch
      key={`${roomId}?${token}`}
      roomId={roomId}
      token={token}
      initial={initial}
    />
  );
}

const over = (watch: WatchData) =>
  'error' in watch ||
  watch.room_status === 'finished' ||
  watch.room_status === 'void';

function Watch({
  roomId,
  token,
  initial,
}: {
  roomId: string;
  token: string;
  initial: WatchData;
}) {
  const [watch, setWatch] = useState(initial);
  const [offline, setOffline] = useState(false);
  // When the data on screen was fetched; set in the browser only, so the
  // server's render and the page's hydration agree.
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => setUpdatedAt(Date.now()), []);
  // Bumped after every poll, so the next one is scheduled only once the
  // previous one has answered.
  const [polls, setPolls] = useState(0);
  const done = over(watch);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `polls` schedules the next poll
  useEffect(() => {
    if (done) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await getWatch({ data: { roomId, token } });
        if (cancelled) return;
        setWatch(next);
        setUpdatedAt(Date.now());
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      } finally {
        if (!cancelled) setPolls(n => n + 1);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [done, polls, roomId, token]);

  if ('error' in watch) return <WatchError code={watch.error} />;
  return <WatchView watch={watch} offline={offline} updatedAt={updatedAt} />;
}

const STATUS = {
  waiting: '等待對手',
  playing: '進行中',
  finished: '已結束',
  void: '作廢',
} as const;

function WatchView({
  watch,
  offline,
  updatedAt,
}: {
  watch: WatchResponse;
  offline: boolean;
  updatedAt: number | null;
}) {
  const { settings, view, hand_number } = watch;
  const players: MatchDetail['players'] = [
    watch.players[0],
    watch.players[1] ?? '（等待對手）',
  ];
  const info: [string, string][] = [
    ['觀看', players[watch.seat]],
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
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="font-semibold text-xl">
          {players[0]} vs {players[1]}
        </h2>
        <Pairs items={info} label="觀戰資訊" />
        {offline && (
          <p role="status" className="text-muted-foreground text-sm">
            暫時連不上，稍後自動重試。
          </p>
        )}
      </section>
      {watch.room_status === 'waiting' && (
        <p className="text-muted-foreground">等待對手加入…</p>
      )}
      {inPlay && (
        <CurrentHand
          watch={watch}
          view={view}
          handNumber={hand_number}
          players={players}
        />
      )}
      {'result' in watch && <WatchResult watch={watch} players={players} />}
      <section className="space-y-3">
        <h3 className="font-semibold">時間線</h3>
        {watch.hands.length === 0 && !inPlay && (
          <p className="text-muted-foreground text-sm">還沒有任何動作。</p>
        )}
      </section>
      {watch.hands.map(hand => (
        <Hand key={hand.hand_number} hand={hand} players={players} />
      ))}
      {inPlay && (
        <section
          aria-label={`第 ${hand_number} 手（進行中）`}
          className="space-y-3 border-t pt-6">
          <h3 className="font-semibold">第 {hand_number} 手（進行中）</h3>
          <Steps
            title={`第 ${hand_number} 手（進行中）`}
            events={view.history}
            players={players}
          />
        </section>
      )}
    </div>
  );
}

const ERRORS = {
  invalid_token:
    '這個觀戰連結無效。請確認網址完整，或向你的 agent 重新要一次 watch_url。',
  room_not_found: '找不到這個房間。',
} as const;

function WatchError({ code }: { code: keyof typeof ERRORS }) {
  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-xl">無法觀看這場對局</h2>
      <p className="text-muted-foreground">{ERRORS[code]}</p>
      <Link to="/" className="underline underline-offset-4">
        回首頁
      </Link>
    </section>
  );
}
