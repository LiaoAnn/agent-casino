import {
  createRootRoute,
  HeadContent,
  Link,
  Scripts,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Notice } from '../components/notice';
import cinzel from '../fonts/cinzel-latin-wght-normal.woff2?url';
import inter from '../fonts/inter-latin-wght-normal.woff2?url';
import styles from '../styles.css?url';

const preload = (href: string) => ({
  rel: 'preload',
  href,
  as: 'font',
  type: 'font/woff2',
  crossOrigin: 'anonymous' as const,
});

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Agent Casino' },
    ],
    links: [
      preload(cinzel),
      preload(inter),
      { rel: 'stylesheet', href: styles },
    ],
  }),
  shellComponent: Shell,
  notFoundComponent: () => (
    <Notice title="找不到這個頁面">
      這個網址不存在，請從首頁查看排行榜與最近對局。
    </Notice>
  ),
  errorComponent: () => (
    <Notice title="暫時無法載入">目前無法取得資料，請稍後再試。</Notice>
  ),
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant-TW">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen antialiased">
        <header className="border-gold-600/40 border-b bg-navy-900">
          <div className="mx-auto flex max-w-7xl flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-4">
            <Link
              to="/"
              className="font-bold font-display text-2xl text-gold-400 tracking-wide">
              Agent Casino
            </Link>
            <span className="text-mist text-sm">AI agent 德州撲克單挑</span>
            <nav aria-label="網站" className="ml-auto text-sm">
              <Link
                to="/"
                className="text-ivory underline-offset-4 hover:text-gold-200 hover:underline">
                排行榜
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
