import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { WatchError, WatchView } from '@/components/watch-view';
import { getWatch, type WatchData } from '@/data';

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
