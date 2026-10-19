import { describe, expect, it } from 'vitest';
import { handle } from '../app';
import type { Bindings } from '../routes/env';
import { renderCasinoSh } from './casino-sh';
import { renderKitSkill, renderLlmsTxt } from './render';

const ENV = {
  TOKEN_SECRET: 'kit-route-secret',
  ADMIN_KEY: 'kit-route-admin',
  DB: {},
  ROOM: {},
  MATCHMAKER: {},
} as unknown as Bindings;

const routes = [
  ['/llms.txt', 'text/plain', (base: string) => renderLlmsTxt(base)],
  [
    '/skills/agent-casino/SKILL.md',
    'text/markdown',
    (base: string) => renderKitSkill('agent-casino', base),
  ],
  ['/skills/agent-casino/scripts/casino.sh', 'text/plain', renderCasinoSh],
  [
    '/skills/agent-casino-holdem/SKILL.md',
    'text/markdown',
    (base: string) => renderKitSkill('agent-casino-holdem', base),
  ],
] as const;

for (const [path, contentType, render] of routes) {
  describe(`A24 GET ${path}`, () => {
    it.each([
      ['http://api.example', {}, undefined, 'api.example'],
      ['https://api.example', {}, undefined, 'api.example'],
      [
        'http://api.example',
        { host: 'play.example' },
        undefined,
        'play.example',
      ],
      [
        'http://api.example',
        { host: 'play.example:8787' },
        undefined,
        'play.example:8787',
      ],
      [
        'https://api.example',
        { 'x-forwarded-host': 'web.example' },
        'https://web.example',
        'web.example',
      ],
      [
        'https://api.example',
        { 'x-forwarded-host': 'web.example:8443' },
        'https://web.example:8443',
        'web.example:8443',
      ],
      [
        'https://api.example',
        { 'x-forwarded-host': 'untrusted.example' },
        'https://web.example',
        'api.example',
      ],
      [
        'https://api.example',
        { 'x-forwarded-host': 'web.example' },
        undefined,
        'api.example',
      ],
      ['https://api.example', {}, 'https://web.example', 'api.example'],
      [
        'http://api.example',
        { authorization: 'Bearer invalid' },
        undefined,
        'api.example',
      ],
    ] as const)(
      'uses the public HTTPS host for %s with %j',
      async (origin, headers, webUrl, host) => {
        const env = { ...ENV, ...(webUrl ? { WEB_URL: webUrl } : {}) };
        const response = await handle(
          new Request(`${origin}${path}`, { headers }),
          env,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain(contentType);
        const body = await response.text();
        expect(body).toBe(render(`https://${host}`));
        expect(body).toContain(`https://${host}`);
        expect(body).not.toContain('{{');
        if (path.endsWith('casino.sh')) {
          const legacy = await handle(
            new Request(`${origin}/casino.sh`, { headers }),
            env,
          );
          expect(legacy.status).toBe(200);
          expect(body).toBe(await legacy.text());
        }
      },
    );
  });
}
