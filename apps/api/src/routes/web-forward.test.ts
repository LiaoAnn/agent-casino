import { describe, expect, it } from 'vitest';
import { forwardApi } from '../../../web/src/lib/api-forward';
import { handle } from '../app';
import type { Bindings } from './env';

const PUBLIC_ORIGIN = 'https://casino.example';
const ENV = {
  TOKEN_SECRET: 'test-token-secret',
  ADMIN_KEY: 'test-admin-key',
  WEB_URL: PUBLIC_ORIGIN,
  DB: {},
  ROOM: {},
  MATCHMAKER: {},
} as unknown as Bindings;

const errorScenarios: {
  path: string;
  init: RequestInit;
  status: number;
  code: string;
}[] = [
  {
    path: '/v1/queue',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    },
    status: 400,
    code: 'invalid_request',
  },
  {
    path: '/v1/rooms/r_abcde12345/wait',
    init: { headers: { authorization: 'Bearer not-a-token' } },
    status: 401,
    code: 'invalid_token',
  },
  {
    path: '/v1/not-an-endpoint',
    init: {},
    status: 404,
    code: 'not_found',
  },
];

describe('forwarding into the real API handle', () => {
  it.each([
    { urlOrigin: PUBLIC_ORIGIN, host: 'casino.example' },
    { urlOrigin: 'http://binding.internal', host: 'casino.example' },
  ])(
    'serves skill.md using incoming Host $host with URL origin $urlOrigin and public WEB_URL',
    async ({ urlOrigin, host }) => {
      const response = await forwardApi(
        new Request(`${urlOrigin}/skill.md`, { headers: { host } }),
        (request: Request) => handle(request, ENV),
      );
      expect(response?.status).toBe(200);
      expect(response?.headers.get('content-type')).toMatch(/^text\/markdown/);
      const markdown = await response?.text();
      expect(markdown).toContain(`curl -fsS ${PUBLIC_ORIGIN}/casino.sh`);
      expect(markdown).toContain(`${PUBLIC_ORIGIN}/skill.md`);
      const watchUrls = [
        ...(markdown ?? '').matchAll(/"watch_url": "([^"]+)"/g),
      ].map(match => match[1]);
      expect(watchUrls.length).toBeGreaterThan(0);
      for (const url of watchUrls) {
        expect(url).toMatch(
          /^https:\/\/casino\.example\/watch\/r_[a-z0-9]{10}\?token=\S+$/,
        );
      }
      expect(markdown).not.toContain('binding.internal');
    },
  );

  it.each(errorScenarios)(
    'keeps the real API $status $code response for $path',
    async ({ path, init, status, code }) => {
      const response = await forwardApi(
        new Request(`${PUBLIC_ORIGIN}${path}`, init),
        (request: Request) => handle(request, ENV),
      );
      expect(response?.status).toBe(status);
      expect(response?.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response?.json()).toMatchObject({ status: 'error', code });
    },
  );
});
