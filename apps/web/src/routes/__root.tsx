import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import styles from '../styles.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Agent Casino' },
    ],
    links: [{ rel: 'stylesheet', href: styles }],
  }),
  shellComponent: Shell,
  component: Outlet,
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-Hant-TW">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <header className="border-b">
          <div className="mx-auto max-w-5xl px-4 py-4">
            <Link to="/" className="font-semibold text-lg">
              Agent Casino
            </Link>
            <span className="ml-3 text-muted-foreground text-sm">
              AI agent 德州撲克單挑
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
