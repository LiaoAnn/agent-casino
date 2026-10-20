import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  readdirSync,
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
import { RatingWriter } from '../matchmaker/ratings';
import { RoomReferee, type RoomStorage } from '../room/referee';
import type { Bindings } from '../routes/env';
import { CASINO_SH_VERSION, LATEST_HEADER, renderCasinoSh } from './casino-sh';
import { renderKitSkill, renderLlmsTxt } from './render';

const OLD_VERSION = '2026-10-19.1';
const KIT_DIRS = ['.claude/skills', '.agents/skills', '.casino/kit'];
const SCRIPT = 'agent-casino/scripts/casino.sh';

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

// Compare every installed file, including unexpected temporary files.
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(dir.length + 1), readFileSync(path, 'utf8')];
      }),
  );
}

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'casino-update-'));
  const tools = mkdtempSync(join(tmpdir(), 'casino-update-posix-'));
  writeFileSync(
    join(tools, 'sed'),
    '#!/bin/sh\nexec /usr/bin/sed --posix "$@"\n',
    {
      mode: 0o755,
    },
  );
  const d1 = await startTestD1();
  const ratings = new RatingWriter(d1.db);
  const rooms = new Map<string, RoomReferee>();
  const web = 'https://update-web.test';
  const env = {
    TOKEN_SECRET: 'update-test-secret',
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
  let old = true;
  let failPath = '';
  let last: Record<string, unknown> = {};
  let lastStatus = 0;
  const errors: unknown[] = [];
  const downloads: string[] = [];
  const headers: (string | null)[] = [];
  const script = () => {
    const current = renderCasinoSh(base);
    return old
      ? current.replace(
          /CASINO_SH_VERSION=[^\n]+/,
          `CASINO_SH_VERSION='${OLD_VERSION}'`,
        )
      : current;
  };
  const files = () => ({
    'agent-casino/SKILL.md': renderKitSkill('agent-casino', base),
    [SCRIPT]: script(),
    'agent-casino-holdem/SKILL.md': renderKitSkill('agent-casino-holdem', base),
  });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const path = incoming.url ?? '';
      if (path === '/casino.sh' || path.startsWith('/skills/')) {
        downloads.push(path);
        const content =
          path === '/casino.sh'
            ? script()
            : Object.entries(files()).find(
                ([name]) => path === `/skills/${name}`,
              )?.[1];
        if (path === failPath || content === undefined) {
          outgoing.writeHead(404).end();
          return;
        }
        outgoing.writeHead(200, { 'content-type': 'text/plain' }).end(content);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const requestHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          requestHeaders.set(
            key,
            Array.isArray(value) ? value.join(', ') : value,
          );
      const response = await handle(
        new Request(`${base}${path}`, {
          method: incoming.method,
          headers: requestHeaders,
          ...(body ? { body } : {}),
        }),
        env,
      );
      headers.push(response.headers.get(LATEST_HEADER));
      lastStatus = response.status;
      const text = await response.text();
      last = JSON.parse(text);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(text);
    } catch (error) {
      errors.push(error);
      outgoing.writeHead(500).end('test HTTP adapter failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing TCP address');
  base = `http://127.0.0.1:${address.port}`;

  const run = async (block: string) => {
    const child = spawn('dash', ['-c', block], {
      cwd,
      env: { PATH: `${tools}:/usr/bin:/bin`, HOME: cwd },
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
      expect(signal, `${block}: ${out}\n${err}`).toBeNull();
      expect(errors).toEqual([]);
      return { code: Number(code), out, err };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    cwd,
    run,
    files,
    downloads,
    headers,
    get last() {
      return last;
    },
    get lastStatus() {
      return lastStatus;
    },
    current() {
      old = false;
    },
    fail(path: string) {
      failPath = path;
    },
    command(path: string, args: string) {
      return run(`dash ${path} ${args}`);
    },
    async install(dir: string) {
      const blocks = [
        ...renderLlmsTxt(base).matchAll(
          /^```(?:bash|sh|shell)\n([\s\S]*?)^```$/gm,
        ),
      ];
      const block = blocks[KIT_DIRS.indexOf(dir)]?.[1];
      if (!block) throw new Error('Missing install block');
      const result = await run(block);
      expect(result.code, `${result.out}\n${result.err}`).toBe(0);
      return `${dir}/${SCRIPT}`;
    },
    async standalone() {
      const result = await run(
        `mkdir -p .casino && curl -fsS ${base}/casino.sh -o .casino/casino.sh`,
      );
      expect(result.code, result.err).toBe(0);
      return '.casino/casino.sh';
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve())),
      );
      await d1.dispose();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(tools, { recursive: true, force: true });
    },
  };
}

function reminderLines(out: string) {
  return out
    .trimEnd()
    .split('\n')
    .filter(
      line => line.includes(CASINO_SH_VERSION) && /\bupdate\b/.test(line),
    );
}

function expectReminder(out: string, report = false) {
  const reminders = reminderLines(out);
  expect.soft(reminders, out).toHaveLength(1);
  if (report) {
    expect.soft(out).not.toMatch(/^Next:/m);
    expect.soft(out.trimEnd().split('\n').at(-1)).toBe(reminders[0]);
  } else {
    const next = out.indexOf('Next:');
    expect.soft(next, out).toBeGreaterThanOrEqual(0);
    if (reminders[0]) expect.soft(out.indexOf(reminders[0])).toBeLessThan(next);
  }
}

describe('T57 installed casino.sh updates', () => {
  it.each(KIT_DIRS)(
    'updates all kit files installed at %s and preserves profile',
    async dir => {
      const f = await fixture();
      try {
        const path = await f.install(dir);
        expect((await f.command(path, 'version')).out).toContain(OLD_VERSION);
        const installed = snapshot(join(f.cwd, dir));
        f.current();
        const profile = await f.command(path, 'profile "Kit Player" codex');
        expect(profile.code, profile.err).toBe(0);
        const queue = await f.command(path, 'queue');
        expect(queue.code, `${queue.out}\n${queue.err}`).toBe(1);
        expect(f.lastStatus).toBe(410);
        expect(f.last).toMatchObject({ status: 'error', code: 'gone' });
        expect(f.last.message).toEqual(expect.stringContaining('llms.txt'));
        expect(queue.out).toContain(f.last.message);
        expectReminder(queue.out);
        expect(snapshot(join(f.cwd, dir))).toEqual(installed);
        const savedProfile = readFileSync(
          join(f.cwd, '.casino/profile.json'),
          'utf8',
        );
        const before = snapshot(f.cwd);
        f.downloads.length = 0;
        const updated = await f.command(path, 'update');
        expect(updated.code, `${updated.out}\n${updated.err}`).toBe(0);
        expect(updated.out).toContain(OLD_VERSION);
        expect(updated.out).toContain(CASINO_SH_VERSION);
        expect(updated.out.trimEnd().split('\n').at(-1)).toMatch(
          new RegExp(
            `^Next: sh ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .+`,
          ),
        );
        expect((await f.command(path, 'version')).out.trim()).toBe(
          `casino.sh ${CASINO_SH_VERSION}`,
        );
        expect(f.downloads.sort()).toEqual(
          Object.keys(f.files())
            .map(file => `/skills/${file}`)
            .sort(),
        );
        const expected = { ...before };
        for (const [file, content] of Object.entries(f.files()))
          expected[`${dir}/${file}`] = content;
        expect(snapshot(f.cwd)).toEqual(expected);
        expect(readFileSync(join(f.cwd, '.casino/profile.json'), 'utf8')).toBe(
          savedProfile,
        );
        f.headers.length = 0;
        const afterUpdate = snapshot(join(f.cwd, dir));
        const freshQueue = await f.command(path, 'queue');
        expect(freshQueue.code, `${freshQueue.out}\n${freshQueue.err}`).toBe(1);
        expect(f.lastStatus).toBe(410);
        expect(f.last).toMatchObject({ status: 'error', code: 'gone' });
        expect(freshQueue.out).toContain(f.last.message);
        expect(f.headers).toEqual([null]);
        expect(reminderLines(freshQueue.out)).toEqual([]);
        expect(snapshot(join(f.cwd, dir))).toEqual(afterUpdate);
        expect(readFileSync(join(f.cwd, '.casino/profile.json'), 'utf8')).toBe(
          savedProfile,
        );
      } finally {
        await f.close();
      }
    },
    180_000,
  );

  it('updates only the standalone script and preserves an active room', async () => {
    const f = await fixture();
    try {
      const path = await f.standalone();
      expect((await f.command(path, 'profile "Kit Player" codex')).code).toBe(
        0,
      );
      expect((await f.command(path, 'bot')).code).toBe(0);
      const before = snapshot(f.cwd);
      f.current();
      f.downloads.length = 0;
      const result = await f.command(path, 'update');
      expect(result.code, `${result.out}\n${result.err}`).toBe(0);
      expect(result.out).toContain(OLD_VERSION);
      expect(result.out).toContain(CASINO_SH_VERSION);
      expect(result.out.trimEnd().split('\n').at(-1)).toMatch(
        /^Next: sh \.casino\/casino\.sh .+/,
      );
      expect(f.downloads).toEqual(['/casino.sh']);
      expect(snapshot(f.cwd)).toEqual({ ...before, [path]: f.files()[SCRIPT] });
      expect((await f.command(path, 'version')).out.trim()).toBe(
        `casino.sh ${CASINO_SH_VERSION}`,
      );
    } finally {
      await f.close();
    }
  }, 180_000);

  it('leaves every installed file unchanged and removes temporary downloads after a 404', async () => {
    const f = await fixture();
    try {
      const path = await f.install('.casino/kit');
      expect((await f.command(path, 'profile "Kit Player" codex')).code).toBe(
        0,
      );
      const before = snapshot(f.cwd);
      f.current();
      f.downloads.length = 0;
      f.fail('/skills/agent-casino-holdem/SKILL.md');
      const result = await f.command(path, 'update');
      expect(result.code, `${result.out}\n${result.err}`).toBe(1);
      expect
        .soft(f.downloads, `${result.out}\n${result.err}`)
        .toContain('/skills/agent-casino-holdem/SKILL.md');
      expect(snapshot(f.cwd)).toEqual(before);
      expect((await f.command(path, 'version')).out).toContain(OLD_VERSION);
    } finally {
      await f.close();
    }
  }, 180_000);

  it('suppresses reminders while seated and prints one after report without updating files', async () => {
    const f = await fixture();
    try {
      const path = await f.install('.agents/skills');
      expect((await f.command(path, 'profile "Kit Player" codex')).code).toBe(
        0,
      );
      const installed = snapshot(join(f.cwd, '.agents/skills'));
      const bot = await f.command(path, 'bot');
      expect(bot.code, bot.err).toBe(0);
      expect(reminderLines(bot.out)).toEqual([]);
      let result = await f.command(path, 'wait');
      expect(reminderLines(result.out)).toEqual([]);
      const state = await f.command(path, 'state');
      expect([0, 2, 3], state.out).toContain(state.code);
      expect(reminderLines(state.out)).toEqual([]);
      for (let step = 0; step < 200 && result.code !== 3; step++) {
        if (result.code === 2) {
          result = await f.command(path, 'wait');
        } else {
          expect(result.code, `${result.out}\n${result.err}`).toBe(0);
          const legal = f.last.legal_actions as
            | { type: string; min?: number }[]
            | undefined;
          const action =
            legal?.find(a => a.type === 'check') ??
            legal?.find(a => a.type === 'call') ??
            legal?.find(a => a.type === 'fold') ??
            legal?.[0];
          if (!action)
            throw new Error(`No legal continuation: ${JSON.stringify(f.last)}`);
          result = await f.command(
            path,
            `act ${action.type}${action.type === 'raise' ? ` ${action.min}` : ''}`,
          );
        }
        if (result.code !== 3) expect(reminderLines(result.out)).toEqual([]);
      }
      expect(result.code, result.out).toBe(3);
      expect(f.headers).toContain(CASINO_SH_VERSION);
      const report = await f.command(path, 'report');
      expect(report.code, report.err).toBe(0);
      expectReminder(report.out, true);
      expect(snapshot(join(f.cwd, '.agents/skills'))).toEqual(installed);
      expect((await f.command(path, 'version')).out).toContain(OLD_VERSION);
    } finally {
      await f.close();
    }
  }, 180_000);

  it('prints no reminder when the installed version receives no latest header', async () => {
    const f = await fixture();
    try {
      f.current();
      const path = await f.standalone();
      const before = readFileSync(join(f.cwd, path), 'utf8');
      const profile = await f.command(path, 'profile "Kit Player" codex');
      expect(profile.code, profile.err).toBe(0);
      expect(reminderLines(profile.out)).toEqual([]);
      f.headers.length = 0;
      const bot = await f.command(path, 'bot');
      expect(bot.code, bot.err).toBe(0);
      expect(f.headers.length).toBeGreaterThan(0);
      expect(f.headers.every(header => header === null)).toBe(true);
      expect(reminderLines(bot.out)).toEqual([]);
      expect(readFileSync(join(f.cwd, path), 'utf8')).toBe(before);
    } finally {
      await f.close();
    }
  }, 180_000);

  it.each(['help update', 'update -h', 'help'])(
    'documents update through %s',
    async args => {
      const f = await fixture();
      try {
        const path = await f.standalone();
        const result = await f.command(path, args);
        expect(result.code, `${result.out}\n${result.err}`).toBe(0);
        expect(result.out).toContain('update');
        if (args !== 'help')
          expect(result.out).toMatch(/download|install|refresh|new|version/i);
      } finally {
        await f.close();
      }
    },
    180_000,
  );
});
