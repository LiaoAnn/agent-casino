import { describe, expect, it } from 'vitest';
import { handle } from '../app';
import type { Bindings } from './env';

const ENV = {
  TOKEN_SECRET: 'test-token-secret',
  ADMIN_KEY: 'test-admin-key',
  DB: {},
  ROOM: {},
  MATCHMAKER: {},
} as unknown as Bindings;

const getSkill = async (forwardedHost: string, webUrl?: string) => {
  const response = await handle(
    new Request('http://127.0.0.1:8787/skill.md', {
      headers: {
        host: '127.0.0.1:8787',
        'x-forwarded-host': forwardedHost,
      },
    }),
    { ...ENV, ...(webUrl === undefined ? {} : { WEB_URL: webUrl }) },
  );
  expect(response.status).toBe(200);
  return response.text();
};

const expectWatchUrls = (md: string, origin: string) => {
  const urls = [...md.matchAll(/"watch_url": "([^"]*)"/g)].map(
    match => match[1] ?? '',
  );
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    const parsed = new URL(url);
    expect(parsed.origin).toBe(origin);
    expect(parsed.pathname).toMatch(/^\/watch\/r_[a-z0-9]{10}$/);
    expect(parsed.searchParams.get('token')).toBeTruthy();
  }
};

describe('GET /skill.md through the public web transport', () => {
  it.each(['web.casino.test', 'web.casino.test:8443'])(
    'uses the forwarded host %s when it exactly matches WEB_URL host',
    async host => {
      const origin = `https://${host}`;
      const md = await getSkill(host, origin);
      expect.soft(md).toContain(`export CASINO_URL=${origin}`);
      expectWatchUrls(md, origin);
    },
  );

  it('ignores the forwarded host when WEB_URL is not configured', async () => {
    const md = await getSkill('web.casino.test');
    expect(md).toContain('export CASINO_URL=https://127.0.0.1:8787');
    expectWatchUrls(md, 'https://127.0.0.1:8787');
  });

  it.each([
    'other.casino.test',
    'web.casino.test:8443',
    'web.casino.test, other.casino.test',
  ])('ignores a forwarded host that does not exactly match: %s', async host => {
    const md = await getSkill(host, 'https://web.casino.test');
    expect(md).toContain('export CASINO_URL=https://127.0.0.1:8787');
    expectWatchUrls(md, 'https://web.casino.test');
  });
});
