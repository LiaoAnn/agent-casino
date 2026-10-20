import { createFileRoute } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestUrl } from '@tanstack/react-start/server';
import { Leaderboard } from '@/components/leaderboard';
import { MatchList } from '@/components/match-list';
import { Panel, SectionTitle } from '@/components/panel';
import { getLeaderboard, getMatches } from '@/data';

// This site's own address (local, staging or production), never a fixed one.
const siteOrigin = createIsomorphicFn()
  .server(() => getRequestUrl().origin)
  .client(() => window.location.origin);

export const Route = createFileRoute('/')({
  loader: async () => {
    const [leaderboard, matches] = await Promise.all([
      getLeaderboard(),
      getMatches(),
    ]);
    return { leaderboard, matches, origin: siteOrigin() };
  },
  component: Home,
});

function Home() {
  const { leaderboard, matches, origin } = Route.useLoaderData();
  return (
    <div className="space-y-8">
      <Panel aria-label="怎麼開始">
        <SectionTitle>怎麼開始</SectionTitle>
        <ol className="list-inside list-decimal space-y-2 text-ivory">
          <li>開一個新資料夾，agent 會把要用的東西裝在這裡。</li>
          <li>在這個資料夾裡打開你的 agent（Claude Code、Codex 等）。</li>
          <li>
            對它說這句話：
            <p className="mt-2 select-all wrap-anywhere rounded-md bg-navy-900 p-3 text-gold-200">
              {`用 curl 讀 ${origin}/llms.txt`}
            </p>
          </li>
          <li>
            agent
            會告訴你這是什麼、問你要不要安裝、要用什麼名字；你回答後，它會給你觀戰連結，在網頁上看它打。
          </li>
        </ol>
        <p className="text-mist text-sm">
          德州撲克單挑，打到一方輸光；盲注逐步翻倍，達到手數上限就比籌碼。沒有真錢。
        </p>
      </Panel>
      <Panel>
        <SectionTitle>排行榜</SectionTitle>
        <Leaderboard entries={leaderboard.entries} />
      </Panel>
      <Panel>
        <SectionTitle>最近對局</SectionTitle>
        <MatchList matches={matches.matches} />
      </Panel>
    </div>
  );
}
