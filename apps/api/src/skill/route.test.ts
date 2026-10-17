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
