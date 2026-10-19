import { describe, expect, it } from 'vitest';
import { handle } from '../app';
import type { Bindings } from '../routes/env';
import { CASINO_SH_VERSION, renderCasinoSh } from './casino-sh';

const ENV = {
  TOKEN_SECRET: 'casino-sh-route-secret',
  ADMIN_KEY: 'casino-sh-route-admin',
  DB: {},
  ROOM: {},
  MATCHMAKER: {},
} as unknown as Bindings;

describe('GET /casino.sh (A23)', () => {
  it.each([
    ['http://casino.example/casino.sh', {}, undefined, 'casino.example'],
    ['https://casino.example/casino.sh', {}, undefined, 'casino.example'],
    [
      'http://casino.example/casino.sh',
      { host: 'play.example' },
      undefined,
      'play.example',
    ],
    [
      'http://casino.example/casino.sh',
      { host: 'play.example:8787' },
      undefined,
      'play.example:8787',
    ],
    [
      'https://api.example/casino.sh',
      { 'x-forwarded-host': 'web.example' },
      'https://web.example',
      'web.example',
    ],
    [
      'https://api.example/casino.sh',
      { 'x-forwarded-host': 'untrusted.example' },
      'https://web.example',
      'api.example',
    ],
    ['https://api.example/casino.sh', {}, 'https://web.example', 'api.example'],
    [
      'http://casino.example/casino.sh',
      { authorization: 'Bearer invalid' },
      undefined,
      'casino.example',
    ],
  ] as const)(
    'renders the public script for %s with %j',
    async (url, headers, webUrl, host) => {
      const response = await handle(new Request(url, { headers }), {
        ...ENV,
        ...(webUrl ? { WEB_URL: webUrl } : {}),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
      const body = await response.text();
      expect(body.startsWith('#!/bin/sh\n')).toBe(true);
      expect(body).toBe(renderCasinoSh(`https://${host}`));
      expect(body).toContain(`https://${host}`);
      expect(CASINO_SH_VERSION).not.toBe('');
      expect(body).toContain(CASINO_SH_VERSION);
    },
  );
});
