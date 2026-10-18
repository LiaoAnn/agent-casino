import type {
  MatchDetail,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { createFileRoute, Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { bySeat, Hand, Pairs, Steps } from '@/components/hand';
import { getWatch, type WatchResult } from '@/data';
import { formatCards, formatSigned, resultLabel } from '@/lib/format';

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

const over = (watch: WatchResult) =>
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
  initial: WatchResult;
}) {
  const [watch, setWatch] = useState(initial);
  const [offline, setOffline] = useState(false);
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
  return <WatchView watch={watch} offline={offline} />;
}

const STATUS = {
  waiting: '等待對手',
  playing: '進行中',
  finished: '已結束',
  void: '作廢',
} as const;

const STREETS = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '轉牌',
  river: '河牌',
} as const;

function WatchView({
  watch,
  offline,
}: {
  watch: WatchResponse;
  offline: boolean;
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
      {'result' in watch && <Result watch={watch} players={players} />}
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

function CurrentHand({
  watch,
  view,
  handNumber,
  players,
}: {
  watch: WatchResponse;
  view: NonNullable<WatchResponse['view']>;
  handNumber: number;
  players: MatchDetail['players'];
}) {
  // The view is the watched seat's: "my" and "opponent" in seat order.
  const seats = (mine: number, theirs: number): [number, number] =>
    watch.seat === 0 ? [mine, theirs] : [theirs, mine];
  const items: [string, ReactNode][] = [
    ['街', STREETS[view.street]],
    ['莊家', players[view.button_seat]],
    ['公共牌', view.board.length > 0 ? formatCards(view.board) : '尚未發出'],
    ['底池', String(view.pot)],
    ['底牌', formatCards(view.my_cards)],
    [
      '本街下注',
      bySeat(
        players,
        seats(view.my_bet_this_street, view.opponent_bet_this_street),
      ),
    ],
    ['籌碼', bySeat(players, seats(view.my_stack, view.opponent_stack))],
    ['輪到', watch.to_act_seat === null ? '—' : players[watch.to_act_seat]],
  ];
  if (watch.deadline !== null) {
    items.push(['剩餘時間', <Remaining key="t" deadline={watch.deadline} />]);
  }
  return (
    <section aria-label="目前這一手" className="space-y-3">
      <h3 className="font-semibold">目前這一手：第 {handNumber} 手</h3>
      <Pairs items={items} />
    </section>
  );
}

// Seconds left until `deadline`, counted in the browser only: the server's
// clock would not match the page's by the time it hydrates.
function Remaining({ deadline }: { deadline: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (now === null) return null;
  return `${Math.max(0, Math.ceil((Date.parse(deadline) - now) / 1000))} 秒`;
}

function Result({
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
