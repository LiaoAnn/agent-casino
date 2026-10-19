import { createMiddleware, createStart } from '@tanstack/react-start';
import { forwardApi } from './lib/api-forward';

const api = createMiddleware().server(async ({ request, next }) => {
  const response = await forwardApi(request, async incoming => {
    if (import.meta.env.DEV) {
      // The same local API as data.ts. Keep the public Host for skill.md.
      const publicUrl = new URL(incoming.url);
      const target = new URL(
        import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8787',
      );
      target.pathname = publicUrl.pathname;
      target.search = publicUrl.search;
      const forwarded = new Request(target, incoming);
      forwarded.headers.set(
        'x-forwarded-host',
        incoming.headers.get('x-forwarded-host') ??
          incoming.headers.get('host') ??
          publicUrl.host,
      );
      return fetch(forwarded);
    }
    const { env } = await import('cloudflare:workers');
    return env.API.fetch(incoming);
  });
  return response ?? next();
});

export const startInstance = createStart(() => ({ requestMiddleware: [api] }));
