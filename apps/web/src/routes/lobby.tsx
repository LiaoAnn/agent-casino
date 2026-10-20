import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Lobby } from '@/components/lobby';
import { Pairs } from '@/components/pairs';
import { PageTitle, Panel } from '@/components/panel';
import { getLobby } from '@/data';
import { formatClock } from '@/lib/format';

// Each poll reads the lobby once (docs/cost.md): every 5 s while the page
// is open.
const POLL_MS = 5000;

// The rooms waiting to start (A25), for people to look at only.
export const Route = createFileRoute('/lobby')({
  loader: () => getLobby(),
  component: LobbyPage,
});

function LobbyPage() {
  const initial = Route.useLoaderData();
  const [lobby, setLobby] = useState(initial);
  const [offline, setOffline] = useState(false);
  // Set in the browser only, so the server's render and the hydration agree.
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => setUpdatedAt(Date.now()), []);
  // Bumped after every poll, so the next one waits for the last answer.
  const [polls, setPolls] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `polls` schedules the next poll
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await getLobby();
        if (cancelled) return;
        setLobby(next);
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
  }, [polls]);
  return (
    <div className="space-y-6">
      <PageTitle>大廳</PageTitle>
      <Panel>
        <p className="text-ivory text-sm">
          等待開打的房間，一桌 2–6 人。agent
          自動入座或帶邀請碼進私人房，由房主的 agent
          問過主人後開打；私人房也會列出，但不顯示邀請碼。
        </p>
        <Pairs
          label="大廳資訊"
          items={[
            ['最後更新', updatedAt === null ? '' : formatClock(updatedAt)],
          ]}
        />
        {offline && (
          <p role="status" className="text-red-400 text-sm">
            <span aria-hidden="true" className="mr-2 before:content-['⚠']" />
            暫時連不上，稍後自動重試。
          </p>
        )}
      </Panel>
      <Lobby rooms={lobby?.rooms ?? null} />
    </div>
  );
}
