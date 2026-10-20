// Execute the rendered manual itself, including a complete match.
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
import { handle } from '../app';
import { startTestD1 } from '../db/test-d1';
import { lobbyIn } from '../matchmaker/lobby';
import { RatingWriter } from '../matchmaker/ratings';
import { RoomReferee, type RoomStorage } from '../room/referee';
import type { Bindings } from '../routes/env';
import { renderCasinoSh } from './casino-sh';
import { renderSkill } from './render';

const blocks = (md: string) =>
  [...md.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(m => (m[1] ?? '').trim());

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
  it('runs the manual blocks in fresh shells through a bot match, report and reconnect/leave', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'manual-run-'));
    const d1 = await startTestD1();
    const ratings = new RatingWriter(d1.db);
    const rooms = new Map<string, RoomReferee>();
    const web = 'https://manual-web.test';
    const env = {
      TOKEN_SECRET: 'manual-test-secret',
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
              listRoom: update => lobby.update(update),
            });
            rooms.set(id, room);
          }
          return room;
        },
      },
    } as unknown as Bindings;
    const lobby = lobbyIn(env, { storage: new MemoryStorage() });
    Object.assign(env, {
      MATCHMAKER: {
        idFromName: (name: string) => name,
        get: () => ({ quick: lobby.quick, rooms: lobby.list }),
      },
    });
    let base = '';
    const requests: string[] = [];
    const exchanges: { path: string; response: Record<string, unknown> }[] = [];
    const errors: unknown[] = [];
    // Render the download locally because the public route enforces HTTPS;
    // all game requests go through the real application and referee.
    const server = createServer(async (incoming, outgoing) => {
      try {
        const path = incoming.url ?? '';
        requests.push(path);
        if (path === '/casino.sh') {
          outgoing.writeHead(200, { 'content-type': 'text/plain' });
          outgoing.end(renderCasinoSh(base));
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
        exchanges.push({ path, response: JSON.parse(text) });
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
        throw new Error('Missing server address');
      base = `http://127.0.0.1:${address.port}`;
      mkdirSync(join(cwd, 'bin'));
      writeFileSync(
        join(cwd, 'bin/sed'),
        '#!/bin/sh\nexec /usr/bin/sed --posix "$@"\n',
        { mode: 0o755 },
      );
      const md = renderSkill(base, web);
      const game = md.split('## Save as a skill')[0] ?? '';
      const gameBlocks = blocks(game);
      expect(gameBlocks[0], 'first example downloads the official script').toBe(
        `mkdir -p .casino && curl -fsS ${base}/casino.sh -o .casino/casino.sh && sh .casino/casino.sh help`,
      );
      expect(
        gameBlocks,
        'manual includes the automatic-seating command',
      ).toContain('sh .casino/casino.sh play');
      const seatAt = gameBlocks.findIndex(block =>
        /^sh \.casino\/casino\.sh (?:play|bot|room)\b/.test(block),
      );
      expect(
        seatAt,
        'onboarding finishes before acquiring a seat',
      ).toBeGreaterThan(2);
      const onboarding = gameBlocks.slice(0, seatAt);
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
      const commandBlock = (command: string) => {
        const found = gameBlocks.find(block =>
          new RegExp(`^sh \\.casino/casino\\.sh ${command}(?:\\s|$)`).test(
            block,
          ),
        );
        expect(found, `manual ${command} block`).toBeDefined();
        if (!found) throw new Error(`Missing manual ${command} block`);
        return found;
      };
      const bot = commandBlock('bot');
      const wait = commandBlock('wait');
      const act = commandBlock('act');
      const report = commandBlock('report');
      // Play and bot are alternative seat-acquisition paths. Keep the
      // actual manual commands and their main-flow order unchanged.
      expect(gameBlocks.indexOf(wait)).toBeGreaterThan(seatAt);
      expect(gameBlocks.indexOf(act)).toBeGreaterThan(gameBlocks.indexOf(wait));
      expect(gameBlocks.indexOf(report)).toBeGreaterThan(
        gameBlocks.indexOf(act),
      );
      expect(await run(cwd, bot)).toMatchObject({ code: 0 });
      let result = await run(cwd, wait);
      expect(result.code, `${result.out}\n${result.err}`).toBe(0);
      result = await run(cwd, act);
      expect([0, 1, 2, 3], `${act}\n${result.out}\n${result.err}`).toContain(
        result.code,
      );
      expect(`${result.out}\n${result.err}`).not.toContain('Usage:');
      expect(exchanges.at(-1)?.path).toMatch(/\/actions\?wait=1$/);
      if (result.code === 1) {
        const response = exchanges.at(-1)?.response;
        expect(response?.code).toBe('invalid_action');
        expect(`${result.out}\n${result.err}`).toContain(response?.message);
      }
      // Legal continuation is chosen from the server, never from script
      // internals. A rejected example keeps the same legal turn available.
      for (let step = 0; step < 200 && result.code !== 3; step++) {
        if (result.code === 2) {
          result = await run(cwd, wait);
          continue;
        }
        const response = exchanges.at(-1)?.response;
        const legal = response?.legal_actions as
          | {
              type: string;
              min?: number;
            }[]
          | undefined;
        const action =
          legal?.find(entry => entry.type === 'check') ??
          legal?.find(entry => entry.type === 'call') ??
          legal?.find(entry => entry.type === 'fold') ??
          legal?.[0];
        expect(action, JSON.stringify(response)).toBeDefined();
        if (!action) throw new Error('No legal continuation');
        result = await run(
          cwd,
          `sh .casino/casino.sh act ${action.type}${action.type === 'raise' ? ` ${action.min}` : ''}`,
        );
        expect([0, 2, 3], `${result.out}\n${result.err}`).toContain(
          result.code,
        );
      }
      expect(result.code, `${result.out}\n${result.err}`).toBe(3);
      const reported = await run(cwd, report);
      expect(reported.code, `${reported.out}\n${reported.err}`).toBe(0);
      expect(reported.out).toContain(`${web}/matches/`);

      // Run the manual's public seating example in another fresh shell.
      const played = await run(cwd, commandBlock('play'));
      expect(played.code, `${played.out}\n${played.err}`).toBe(0);
      expect(exchanges.at(-1)?.path).toBe('/v1/rooms/quick');
      expect(exchanges.at(-1)?.response).toMatchObject({ is_host: true });
      expect(await run(cwd, commandBlock('leave'))).toMatchObject({ code: 3 });
      expect(await run(cwd, report)).toMatchObject({ code: 0 });

      // Reconnect and owner-requested leave apply to a live second match.
      expect(await run(cwd, bot)).toMatchObject({ code: 0 });
      const state = await run(cwd, commandBlock('state'));
      expect(state.code, `${state.out}\n${state.err}`).toBe(0);
      const left = await run(cwd, commandBlock('leave'));
      expect(left.code, `${left.out}\n${left.err}`).toBe(3);
      expect(await run(cwd, report)).toMatchObject({ code: 0 });

      const mentioned = [
        ...md.matchAll(/sh \.casino\/casino\.sh ([a-z][a-z-]*)/g),
      ].map(m => m[1] ?? '');
      expect(mentioned.length).toBeGreaterThan(0);
      for (const command of new Set(mentioned)) {
        const result = await run(cwd, `sh .casino/casino.sh help ${command}`);
        expect(result.code, `${command}: ${result.out} ${result.err}`).toBe(0);
        expect(result.out.trim()).not.toBe('');
      }
      expect(requests[0]).toBe('/casino.sh');
      expect(errors).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      await d1.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});
