// T05: the Worker serves skill.md at GET /skill.md, filled in with the host
// the agent reached it on (casino-api skill: A12). Agents always talk https.
import { describe, expect, it } from 'vitest';
import { handle } from '../app';
import type { Bindings } from '../routes/env';
import { renderSkill } from './render';

const ENV = {
  TOKEN_SECRET: 'test-token-secret',
  ADMIN_KEY: 'test-admin-key',
  DB: {},
  ROOM: {},
  MATCHMAKER: {},
} as unknown as Bindings;

const getSkill = (url: string, headers: Record<string, string> = {}) =>
  handle(new Request(url, { method: 'GET', headers }), ENV);

describe('GET /skill.md', () => {
  it('uses WEB_URL for every watch_url while keeping the request host for the API', async () => {
    const response = await handle(
      new Request('http://casino.example/skill.md', {
        headers: { host: 'play.casino.test' },
      }),
      { ...ENV, WEB_URL: 'https://web.casino.test' } as Bindings,
    );
    expect(response.status).toBe(200);
    const md = await response.text();
    const urls = [...md.matchAll(/"watch_url": "([^"]*)"/g)].map(
      m => m[1] ?? '',
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/web\.casino\.test\/watch\/r_[a-z0-9]{10}\?token=\S+$/,
      );
    }
    expect(md).toBe(
      renderSkill('https://play.casino.test', 'https://web.casino.test'),
    );
    expect(md).toContain('export CASINO_URL=https://play.casino.test');
  });

  it('serves the rendered skill as markdown, over https', async () => {
    const response = await getSkill('http://casino.example/skill.md');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type') ?? '').toMatch(
      /^text\/markdown/,
    );
    expect(await response.text()).toBe(renderSkill('https://casino.example'));
  });

  it('keeps https when the request was https', async () => {
    const response = await getSkill('https://casino.example/skill.md');
    expect(await response.text()).toBe(renderSkill('https://casino.example'));
  });

  it('uses the Host header when it differs from the URL', async () => {
    const response = await getSkill('http://casino.example/skill.md', {
      host: 'play.casino.test',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(renderSkill('https://play.casino.test'));
  });

  it('keeps a port in the Host header as is', async () => {
    const response = await getSkill('http://casino.example/skill.md', {
      host: 'localhost:8787',
    });
    expect(await response.text()).toBe(renderSkill('https://localhost:8787'));
  });

  it('needs no authorization, and ignores a bad one', async () => {
    const response = await getSkill('http://casino.example/skill.md', {
      authorization: 'Bearer not-a-token',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(renderSkill('https://casino.example'));
  });
});
