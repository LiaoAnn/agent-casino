import { describe, expect, it } from 'vitest';
import { forwardApi } from '../../../web/src/lib/api-forward';
import { handle } from '../app';
import type { Bindings } from '../routes/env';
import { CASINO_SH_VERSION } from './casino-sh';

const WEB_URL = 'https://casino.example';
const ENV = {
  TOKEN_SECRET: 'test-token-secret',
  ADMIN_KEY: 'test-admin-key',
  WEB_URL,
  DB: {},
  ROOM: {},
  MATCHMAKER: {
    idFromName: (name: string) => name,
    get: () => ({ rooms: async () => ({ rooms: [] }) }),
  },
} as unknown as Bindings;

const [currentDate = '', currentRevision = ''] = CASINO_SH_VERSION.split('.');
const year = Number(currentDate.slice(0, 4));
const oldVersion = `${year - 1}${currentDate.slice(4)}.9999`;
const newVersion = `${year + 1}${currentDate.slice(4)}.1`;
const OLD_UA = `casino.sh/${oldVersion}`;
const LATEST_HEADER = 'X-Casino-Sh-Latest';

const scenarios = [
  { path: '/health', method: 'GET', status: 200 },
  { path: '/v1/lobby', method: 'GET', status: 200 },
  { path: '/v1/not-an-endpoint', method: 'GET', status: 404 },
  { path: '/v1/queue', method: 'POST', status: 410 },
  { path: '/skill.md', method: 'GET', status: 200 },
];

describe('T57 kit version response header', () => {
  it.each(scenarios)(
    'announces the latest kit on $method $path without changing status or body',
    async ({ path, method, status }) => {
      const request = (userAgent?: string) =>
        new Request(`https://api.example${path}`, {
          method,
          headers: userAgent ? { 'user-agent': userAgent } : {},
        });
      const baseline = await handle(request(), ENV);
      const response = await handle(request(OLD_UA), ENV);

      expect(baseline.status).toBe(status);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe(await baseline.text());
      expect(response.headers.get(LATEST_HEADER)).toBe(CASINO_SH_VERSION);
    },
  );

  it.each([
    { label: 'same version', userAgent: `casino.sh/${CASINO_SH_VERSION}` },
    { label: 'newer date', userAgent: `casino.sh/${newVersion}` },
    { label: 'unparseable revision', userAgent: 'casino.sh/ci' },
    { label: 'missing version', userAgent: 'casino.sh/' },
    { label: 'another client', userAgent: 'curl/8.5.0' },
    { label: 'no User-Agent', userAgent: undefined },
  ])('omits the header for $label', async ({ userAgent }) => {
    const response = await handle(
      new Request('https://api.example/health', {
        headers: userAgent ? { 'user-agent': userAgent } : {},
      }),
      ENV,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.has(LATEST_HEADER)).toBe(false);
  });

  it.each([1, 2, 9, 10])(
    'compares same-date revision %i numerically against the current revision',
    async revision => {
      const response = await handle(
        new Request('https://api.example/health', {
          headers: {
            'user-agent': `casino.sh/${currentDate}.${revision}`,
          },
        }),
        ENV,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get(LATEST_HEADER)).toBe(
        revision < Number(currentRevision) ? CASINO_SH_VERSION : null,
      );
    },
  );

  it.each(scenarios.filter(({ path }) => path.startsWith('/v1/')))(
    'preserves the latest header through forwardApi for $method $path',
    async ({ path, method, status }) => {
      const response = await forwardApi(
        new Request(`${WEB_URL}${path}`, {
          method,
          headers: { host: 'casino.example', 'user-agent': OLD_UA },
        }),
        (request: Request) => handle(request, ENV),
      );
      expect(response?.status).toBe(status);
      expect(response?.headers.get(LATEST_HEADER)).toBe(CASINO_SH_VERSION);
    },
  );
});

describe('T57 retired queue reinstall guidance', () => {
  it.each([
    { label: 'empty body', body: undefined },
    {
      label: 'legacy queue request',
      body: JSON.stringify({ game: 'holdem', name: 'alice' }),
    },
    { label: 'malformed JSON', body: '{broken' },
  ])(
    'returns 410 with the direct request Host reinstall URL for $label',
    async ({ body }) => {
      const response = await handle(
        new Request('http://binding.internal/v1/queue', {
          method: 'POST',
          headers: {
            host: 'api.example',
            'user-agent': OLD_UA,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body }),
        }),
        ENV,
      );
      expect(response.status).toBe(410);
      const error = await response.json();
      expect(error).toMatchObject({ status: 'error', code: 'gone' });
      expect.soft(error.message).toContain('https://api.example/llms.txt');
      expect.soft(error.hint).toContain('POST /v1/rooms/quick');
      expect.soft(error.hint).toContain('/skill.md');
      expect.soft(error.hint).toContain('update');
    },
  );

  it('preserves the web request Host through service binding in the reinstall message', async () => {
    const response = await forwardApi(
      new Request(`${WEB_URL}/v1/queue`, {
        method: 'POST',
        headers: { host: 'casino.example', 'user-agent': OLD_UA },
      }),
      (request: Request) => handle(request, ENV),
    );
    expect(response?.status).toBe(410);
    const error = await response?.json();
    expect(error).toMatchObject({ status: 'error', code: 'gone' });
    expect.soft(error.message).toContain(`${WEB_URL}/llms.txt`);
    expect.soft(error.hint).toContain('POST /v1/rooms/quick');
    expect.soft(error.hint).toContain('/skill.md');
    expect.soft(error.hint).toContain('update');
  });

  it('uses the trusted web forwarded host for local dev in the reinstall message', async () => {
    const response = await handle(
      new Request('http://127.0.0.1:8787/v1/queue', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:8787',
          'x-forwarded-host': 'casino.example',
          'user-agent': OLD_UA,
        },
      }),
      ENV,
    );
    expect(response.status).toBe(410);
    const error = await response.json();
    expect(error).toMatchObject({ status: 'error', code: 'gone' });
    expect.soft(error.message).toContain(`${WEB_URL}/llms.txt`);
    expect.soft(error.message).not.toContain('127.0.0.1');
  });

  it('ignores an untrusted forwarded host in the reinstall message', async () => {
    const response = await handle(
      new Request('http://127.0.0.1:8787/v1/queue', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:8787',
          'x-forwarded-host': 'evil.example',
          'user-agent': OLD_UA,
        },
      }),
      ENV,
    );
    expect(response.status).toBe(410);
    const error = await response.json();
    expect(error).toMatchObject({ status: 'error', code: 'gone' });
    expect.soft(error.message).toContain('https://127.0.0.1:8787/llms.txt');
    expect.soft(error.message).not.toContain('evil.example');
  });
});
