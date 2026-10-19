// Execute the manual itself. Full games and script internals live in casino-sh.test.ts.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderCasinoSh } from './casino-sh';
import { renderSkill } from './render';

const blocks = (md: string) =>
  [...md.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(m => (m[1] ?? '').trim());

async function run(cwd: string, block: string) {
  const child = spawn('dash', ['-c', block], {
    cwd,
    env: { PATH: `${join(cwd, 'bin')}:/usr/bin:/bin`, HOME: cwd },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', chunk => {
    out += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    err += chunk.toString();
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
  try {
    const [code, signal] = await once(child, 'close');
    expect(signal, `${block}: ${out} ${err}`).toBeNull();
    return { code: Number(code), out, err };
  } finally {
    clearTimeout(timer);
  }
}

describe('manual commands in fresh POSIX shells', () => {
  it('downloads, checks profile, creates it and resolves every documented command with help', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'manual-run-'));
    let base = '';
    const requests: string[] = [];
    // Like the casino-sh harness, this is real local HTTP. Only download is
    // needed before queue; profile and help must be entirely local. Render
    // with the local HTTP base here because the public route enforces HTTPS.
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url !== '/casino.sh') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(renderCasinoSh(base));
    });
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing server address');
      base = `http://127.0.0.1:${address.port}`;
      mkdirSync(join(cwd, 'bin'));
      writeFileSync(
        join(cwd, 'bin/sed'),
        '#!/bin/sh\nexec /usr/bin/sed --posix "$@"\n',
        { mode: 0o755 },
      );
      const md = renderSkill(base);
      const game = md.split('## Save as a skill')[0] ?? '';
      const gameBlocks = blocks(game);
      expect(gameBlocks[0], 'first example downloads the official script').toBe(
        `mkdir -p .casino && curl -fsS ${base}/casino.sh -o .casino/casino.sh && sh .casino/casino.sh help`,
      );
      const queueAt = gameBlocks.findIndex(block =>
        /^sh \.casino\/casino\.sh (?:queue|bot|room)\b/.test(block),
      );
      expect(
        queueAt,
        'onboarding finishes before acquiring a seat',
      ).toBeGreaterThan(2);
      const onboarding = gameBlocks.slice(0, queueAt);
      expect(
        onboarding[1],
        'inspect the persistent profile before asking a name',
      ).toBe('sh .casino/casino.sh profile');
      expect(
        onboarding.some(block =>
          /^sh \.casino\/casino\.sh profile .+/.test(block),
        ),
        'runnable profile creation example',
      ).toBe(true);
      for (const [index, block] of onboarding.entries()) {
        const result = await run(cwd, block);
        expect(result.code, `${block}\n${result.out}\n${result.err}`).toBe(
          index === 1 ? 1 : 0,
        );
      }
      const profile = JSON.parse(
        readFileSync(join(cwd, '.casino/profile.json'), 'utf8'),
      ) as { name: string; display_name: string };
      expect(profile.name).toMatch(/^[a-zA-Z0-9_-]+-[a-f0-9]{4}$/);
      expect(profile.display_name.length).toBeGreaterThan(0);
      const shown = await run(cwd, 'sh .casino/casino.sh profile');
      expect(shown.code).toBe(0);
      expect(shown.out).toContain(profile.name);
      expect(shown.out).toContain(profile.display_name);
      const mentioned = [
        ...md.matchAll(/sh \.casino\/casino\.sh ([a-z][a-z-]*)/g),
      ].map(m => m[1] ?? '');
      expect(mentioned.length).toBeGreaterThan(0);
      for (const command of new Set(mentioned)) {
        const result = await run(cwd, `sh .casino/casino.sh help ${command}`);
        expect(result.code, `${command}: ${result.out} ${result.err}`).toBe(0);
        expect(result.out.trim()).not.toBe('');
      }
      expect(requests).toEqual(['/casino.sh']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
