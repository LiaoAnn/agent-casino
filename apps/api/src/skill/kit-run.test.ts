// Execute the rendered manual itself, including a complete match.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handle } from '../app';
import { startTestD1 } from '../db/test-d1';
import { RatingWriter } from '../matchmaker/ratings';
import { RoomReferee, type RoomStorage } from '../room/referee';
import type { Bindings } from '../routes/env';
import { renderCasinoSh } from './casino-sh';
import { renderKitSkill, renderLlmsTxt } from './render';

const blocks = (md: string) =>
  [...md.matchAll(/^```(?:bash|sh|shell)\n([\s\S]*?)^```$/gm)].map(m =>
    (m[1] ?? '').trim(),
  );

class MemoryStorage implements RoomStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}

async function run(cwd: string, block: string, toolPath = join(cwd, 'bin')) {
  const child = spawn('dash', ['-c', block], {
    cwd,
    env: { PATH: `${toolPath}:/usr/bin:/bin`, HOME: cwd },
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

describe('A24 install and play from llms.txt', () => {
  it.each(['.claude/skills', '.agents/skills', '.casino/kit'])(
    'installs verbatim and plays using %s',
    async dir => {
      const cwd = mkdtempSync(join(tmpdir(), 'kit-run-'));
      const d1 = await startTestD1();
      const ratings = new RatingWriter(d1.db);
      const rooms = new Map<string, RoomReferee>();
      const web = 'https://kit-web.test';
      const env = {
        TOKEN_SECRET: 'kit-play-secret',
        WEB_URL: web,
        DB: d1.d1,
        ALLOW_TEST_ROOMS: 'true',
        DEFAULT_SETTINGS_JSON: JSON.stringify({
          starting_stack: 40,
          blind_every: 5,
          max_hands: 3,
          turn_seconds: 30,
        }),
        DEFAULT_TEST_JSON: JSON.stringify({ seed: '0'.repeat(64) }),
        ROOM: {
          idFromName: (name: string) => name,
          get: (id: string) => {
            let room = rooms.get(id);
            if (!room) {
              room = new RoomReferee(new MemoryStorage(), {
                waitMs: 30,
                webUrl: web,
                record: input => ratings.record(input),
              });
              rooms.set(id, room);
            }
            return room;
          },
        },
      } as unknown as Bindings;
      let base = '';
      const downloads: string[] = [];
      const errors: unknown[] = [];
      let last: Record<string, unknown> = {};
      const files = () => ({
        'agent-casino/SKILL.md': renderKitSkill('agent-casino', base),
        'agent-casino/scripts/casino.sh': renderCasinoSh(base),
        'agent-casino-holdem/SKILL.md': renderKitSkill(
          'agent-casino-holdem',
          base,
        ),
      });
      const server = createServer(async (incoming, outgoing) => {
        try {
          const path = incoming.url ?? '';
          // Only downloads bypass the public HTTPS host rule. All gameplay
          // still uses handle(), contract validation and the real referee.
          if (path.startsWith('/skills/')) {
            const file = Object.entries(files()).find(
              ([name]) => path === `/skills/${name}`,
            );
            if (!file) {
              outgoing.writeHead(404).end();
              return;
            }
            downloads.push(path);
            outgoing.writeHead(200, {
              'content-type': path.endsWith('.sh')
                ? 'text/plain'
                : 'text/markdown',
            });
            outgoing.end(file[1]);
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString();
          const headers = new Headers();
          for (const [key, value] of Object.entries(incoming.headers))
            if (value !== undefined)
              headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          const response = await handle(
            new Request(`${base}${path}`, {
              method: incoming.method,
              headers,
              ...(body ? { body } : {}),
            }),
            env,
          );
          const text = await response.text();
          last = JSON.parse(text);
          outgoing.writeHead(
            response.status,
            Object.fromEntries(response.headers),
          );
          outgoing.end(text);
        } catch (error) {
          errors.push(error);
          outgoing.writeHead(500).end('test HTTP adapter failed');
        }
      });
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing TCP address');
        base = `http://127.0.0.1:${address.port}`;
        const installs = blocks(renderLlmsTxt(base));
        expect(installs).toHaveLength(3);
        const block =
          installs[
            ['.claude/skills', '.agents/skills', '.casino/kit'].indexOf(dir)
          ];
        expect(block).toBeDefined();
        if (!block) throw new Error('Missing install block');
        // Run in an empty project; put only the POSIX sed shim outside it.
        const tools = mkdtempSync(join(tmpdir(), 'kit-posix-'));
        try {
          writeFileSync(
            join(tools, 'sed'),
            '#!/bin/sh\nexec /usr/bin/sed --posix "$@"\n',
            { mode: 0o755 },
          );
          const installed = await run(cwd, block, tools);
          expect(installed.code, `${installed.out}\n${installed.err}`).toBe(0);
          const assertFiles = () => {
            for (const [file, content] of Object.entries(files()))
              expect(readFileSync(join(cwd, dir, file), 'utf8')).toBe(content);
          };
          assertFiles();
          expect(downloads.sort()).toEqual(
            Object.keys(files())
              .map(file => `/skills/${file}`)
              .sort(),
          );
          const script = `sh ${dir}/agent-casino/scripts/casino.sh`;
          const command = async (args: string) => {
            const result = await run(cwd, `${script} ${args}`, tools);
            expect(
              [0, 2, 3],
              `${args}: ${result.out}\n${result.err}`,
            ).toContain(result.code);
            const next = result.out
              .split('\n')
              .filter(line => line.startsWith('Next:'));
            if (args !== 'report') {
              expect(next.length, result.out).toBeGreaterThan(0);
              for (const line of next)
                expect(line).toContain(`Next: ${script} `);
            }
            return result;
          };
          expect((await command('profile "Kit Player" codex')).code).toBe(0);
          const profilePath = join(cwd, '.casino/profile.json');
          const profile = readFileSync(profilePath, 'utf8');
          expect(JSON.parse(profile)).toMatchObject({
            display_name: 'Kit Player',
            name: expect.stringMatching(/^codex-[a-f0-9]{4}$/),
          });
          expect((await command('bot')).code).toBe(0);
          let result = await command('wait');
          for (let step = 0; step < 200 && result.code !== 3; step++) {
            if (result.code === 2) {
              result = await command('wait');
              continue;
            }
            const legal = last.legal_actions as
              | { type: string; min?: number }[]
              | undefined;
            const action =
              legal?.find(entry => entry.type === 'check') ??
              legal?.find(entry => entry.type === 'call') ??
              legal?.find(entry => entry.type === 'fold') ??
              legal?.[0];
            expect(action, JSON.stringify(last)).toBeDefined();
            if (!action) throw new Error('No legal continuation');
            result = await command(
              `act ${action.type}${action.type === 'raise' ? ` ${action.min}` : ''}`,
            );
          }
          expect(result.code, result.out).toBe(3);
          const reported = await command('report');
          expect(reported.code).toBe(0);
          expect(reported.out).toContain(`${web}/matches/`);
          expect(reported.out).not.toMatch(/^Next:/m);
          expect(readFileSync(profilePath, 'utf8')).toBe(profile);
          assertFiles(); // Especially .casino/kit: report must not delete its kit.
          expect(errors).toEqual([]);
        } finally {
          rmSync(tools, { recursive: true, force: true });
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve())),
        );
        await d1.dispose();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
