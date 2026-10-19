import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { PageTitle } from '@/components/panel';

export function PageError() {
  return <Notice title="暫時無法載入">目前無法取得資料，請稍後再試。</Notice>;
}

// A page that cannot show what was asked for: what happened, in red-400
// beside an icon, and the way back home.
export function Notice({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <PageTitle>{title}</PageTitle>
      <div className="flex items-start gap-2 text-red-400">
        <span aria-hidden="true" className="font-bold">
          ⚠
        </span>
        <p>{children}</p>
      </div>
      <Link
        to="/"
        className="inline-block text-gold-400 underline underline-offset-4 hover:text-gold-200">
        回首頁
      </Link>
    </section>
  );
}
