import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { matchQueueIn, type QueueInput } from '../matchmaker/pairing';
import { RatingWriter } from '../matchmaker/ratings';
import { RoomReferee, type RoomStorage } from '../room/referee';
import type { Bindings } from '../routes/env';
import { CASINO_SH_VERSION, renderCasinoSh } from './casino-sh';

const BEGIN =
  '>>> TELL YOUR OWNER (write this in your reply, in their language) <<<';
const END = '>>> END <<<';
const COMMANDS = [
  'help',
  'version',
  'profile',
  'queue',
  'bot',
  'room',
  'wait',
  'act',
  'state',
  'leave',
  'report',
];
const NOTE = '我想一下："跟注"，路徑 \\，🃏';

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

let d1: TestD1;
const folders: string[] = [];
const servers: Server[] = [];

beforeAll(async () => {
  d1 = await startTestD1();
}, 30_000);
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve())),
    );
  }
  await d1?.dispose();
  for (const folder of folders)
    rmSync(folder, { recursive: true, force: true });
}, 30_000);

function makeEnv(chaos = false): Bindings {
  const ratings = new RatingWriter(d1.db);
  const referees = new Map<string, RoomReferee>();
  const env = {
    TOKEN_SECRET: 'casino-sh-test-secret',
    WEB_URL: 'https://web.test',
    ADMIN_KEY: 'casino-sh-test-admin',
    DB: d1.d1,
    ALLOW_TEST_ROOMS: 'true',
    DEFAULT_SETTINGS_JSON: JSON.stringify({
      starting_stack: 40,
      blind_every: 5,
      max_hands: 3,
      turn_seconds: 30,
    }),
    DEFAULT_TEST_JSON: JSON.stringify({
      seed: '0'.repeat(64),
      ...(chaos ? { chaos: { fail_request_every: 3 } } : {}),
    }),
    ROOM: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        let referee = referees.get(id);
        if (!referee) {
          referee = new RoomReferee(new MemoryStorage(), {
            waitMs: 30,
            record: input => ratings.record(input),
          });
          referees.set(id, referee);
        }
        return referee;
      },
    },
  } as unknown as Bindings;
  const queue = matchQueueIn(env, { waitMs: 30 });
  Object.assign(env, {
    MATCHMAKER: {
      idFromName: (name: string) => name,
      get: () => ({ queue: (input: QueueInput) => queue.queue(input) }),
    },
  });
  return env;
}

interface Exchange {
  path: string;
  method: string;
  body: Record<string, unknown>;
  response: Record<string, unknown>;
  status: number;
  userAgent: string | undefined;
}

async function serve(chaos = false) {
  const env = makeEnv(chaos);
  const exchanges: Exchange[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const request = new Request(
        `http://${incoming.headers.host}${incoming.url}`,
        {
          method: incoming.method,
          headers,
          ...(body ? { body } : {}),
        },
      );
      const response = await handle(request, env);
      const text = await response.text();
      exchanges.push({
        path: incoming.url ?? '',
        method: incoming.method ?? 'GET',
        body: body ? JSON.parse(body) : {},
        response: JSON.parse(text),
        status: response.status,
        userAgent: incoming.headers['user-agent'],
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(text);
    } catch (error) {
      errors.push(error);
      outgoing.writeHead(500);
      outgoing.end('test HTTP adapter failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address');
  return { url: `http://127.0.0.1:${address.port}`, exchanges, errors };
}

function player(url: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'casino-sh-'));
  folders.push(cwd);
  mkdirSync(join(cwd, '.casino'));
  mkdirSync(join(cwd, 'bin'));
  writeFileSync(join(cwd, '.casino/casino.sh'), renderCasinoSh(url));
  // Absolute sed path prevents the wrapper from calling itself.
  writeFileSync(
    join(cwd, 'bin/sed'),
    '#!/bin/sh\nexec /usr/bin/sed --posix "$@"\n',
    { mode: 0o755 },
  );
  return cwd;
}

interface Result {
  code: number;
  out: string;
  err: string;
}
async function run(cwd: string, ...args: string[]): Promise<Result> {
  return runShell(cwd, args);
}

async function runShell(
  cwd: string,
  args: string[],
  overrideUrl?: string,
): Promise<Result> {
  const argv =
    overrideUrl === undefined
      ? ['.casino/casino.sh', ...args]
      : [
          '-c',
          'CASINO_URL="$1"; export CASINO_URL; shift; exec /usr/bin/dash .casino/casino.sh "$@"',
          'casino-test',
          overrideUrl,
          ...args,
        ];
  const child = spawn('/usr/bin/dash', argv, {
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
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try {
    const [code, signal] = await once(child, 'close');
    expect(
      signal,
      `command ${args.join(' ')} timed out: ${out} ${err}`,
    ).toBeNull();
    if (
      !['help', '-h', '--help', 'version', 'report'].includes(args[0] ?? '') &&
      !args.includes('--help')
    ) {
      expect(out.trimEnd().split('\n').at(-1), `${out}\n${err}`).toMatch(
        /^Next: sh \.casino\/casino\.sh .+/,
      );
    }
    return { code: Number(code), out, err };
  } finally {
    clearTimeout(timeout);
  }
}

function relay(out: string, tell: unknown) {
  expect(typeof tell).toBe('string');
  expect(out).toContain(`${BEGIN}\n${String(tell)}\n${END}`);
}

function legal(result: Result): string[] {
  const line = result.out.split('\n').find(line => line.startsWith('Legal: '));
  expect(line, result.out).toBeDefined();
  const entries = (line ?? '').slice('Legal: '.length).split(' | ');
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries)
    expect(entry).toMatch(/^(fold|check|call \d+|raise \d+-\d+)$/);
  expect(result.out).toMatch(/^Time left: \d+s$/m);
  return entries;
}

function action(result: Result): string[] {
  const entries = legal(result);
  if (entries.includes('check')) return ['act', 'check', NOTE];
  if (entries.some(entry => entry.startsWith('call ')))
    return ['act', 'call', NOTE];
  if (entries.includes('fold')) return ['act', 'fold', NOTE];
  const raise = entries.find(entry => entry.startsWith('raise '));
  if (!raise) throw new Error(`No legal action: ${result.out}`);
  return ['act', 'raise', raise.slice(6).split('-')[0] ?? '', NOTE];
}

async function finish(cwd: string, first?: Result): Promise<Result> {
  let result = first ?? (await run(cwd, 'wait'));
  for (let step = 0; step < 200 && result.code !== 3; step++) {
    expect([0, 2], `${result.out}\n${result.err}`).toContain(result.code);
    result = await run(cwd, ...(result.code === 2 ? ['wait'] : action(result)));
  }
  expect(result.code, `${result.out}\n${result.err}`).toBe(3);
  return result;
}

function profile(cwd: string): { name: string; display_name: string } {
  return JSON.parse(readFileSync(join(cwd, '.casino/profile.json'), 'utf8'));
}

function checkRequests(api: Awaited<ReturnType<typeof serve>>) {
  expect(api.errors).toEqual([]);
  expect(api.exchanges.length).toBeGreaterThan(0);
  for (const exchange of api.exchanges)
    expect(exchange.userAgent).toBe(`casino.sh/${CASINO_SH_VERSION}`);
  for (const exchange of api.exchanges.filter(exchange =>
    exchange.path.includes('/actions'),
  )) {
    expect(exchange.path).toMatch(/\/actions\?wait=1$/);
  }
}

async function report(
  cwd: string,
  final: Result,
  api: Awaited<ReturnType<typeof serve>>,
) {
  const over = api.exchanges.findLast(
    exchange => exchange.response.status === 'match_over',
  );
  relay(final.out, over?.response.tell_owner);
  const result = await run(cwd, 'report');
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  relay(result.out, over?.response.tell_owner);
  expect(readdirSync(join(cwd, '.casino')).sort()).toEqual([
    'casino.sh',
    'profile.json',
  ]);
}

describe('casino.sh in fresh POSIX shells (A23)', () => {
  it('has no dependencies on the forbidden tools or shell extensions', () => {
    const script = renderCasinoSh('https://casino.example');
    for (const forbidden of [
      'jq',
      'openssl',
      'sed -E',
      'sed -i',
      'grep -P',
      'bash',
    ]) {
      expect(script).not.toContain(forbidden);
    }
    // POSIX bracket classes such as [[:space:]] are not shell [[ commands.
    expect(script).not.toMatch(/(^|[ \t;|&])\[\[(?=\s|$)/m);
  });

  it('prints the version, overview aliases and use cases with examples for every command', async () => {
    const cwd = player('http://127.0.0.1:1');
    const version = await run(cwd, 'version');
    expect(version).toMatchObject({ code: 0 });
    expect(version.out).toContain(CASINO_SH_VERSION);
    for (const alias of ['help', '-h', '--help']) {
      const result = await run(cwd, alias);
      expect(result).toMatchObject({ code: 0 });
      expect(result.out.split('\n')[0]).toContain(CASINO_SH_VERSION);
      for (const command of COMMANDS)
        expect(result.out).toMatch(new RegExp(`\\b${command}\\b`));
    }
    for (const command of COMMANDS) {
      for (const args of [
        ['help', command],
        [command, '--help'],
      ]) {
        const result = await run(cwd, ...args);
        expect(result.code, `${result.out}\n${result.err}`).toBe(0);
        expect(result.out.trim()).not.toBe('');
        // Wording is deliberately loose; help must explain when and show a runnable example.
        expect(result.out).toMatch(
          /when|before|after|use|start|unsure|finish|show|print/i,
        );
        expect(result.out).toMatch(/(?:sh\s+)?\.casino\/casino\.sh\s+\S+/);
      }
    }
  }, 120_000);

  it('preserves a generated identity and plays a complete bot match with Unicode data', async () => {
    const api = await serve();
    const cwd = player(api.url);
    expect(await run(cwd, 'profile', '第一次', 'codex')).toMatchObject({
      code: 0,
    });
    const first = profile(cwd);
    expect(first.name).toMatch(/^codex-[0-9a-f]{4}$/);
    const display = '中文 玩家 "鯊魚" \\ 🃏';
    expect(await run(cwd, 'profile', display, 'different')).toMatchObject({
      code: 0,
    });
    expect(profile(cwd)).toMatchObject({
      name: first.name,
      display_name: display,
    });
    const shown = await run(cwd, 'profile');
    expect(shown).toMatchObject({ code: 0 });
    expect(shown.out).toContain(first.name);
    expect(shown.out).toContain(display);
    const bot = await run(cwd, 'bot');
    expect(bot.code, `${bot.out}\n${bot.err}`).toBe(0);
    const created = api.exchanges.find(
      exchange => exchange.path === '/v1/rooms',
    );
    expect(created?.body).toMatchObject({
      name: first.name,
      display_name: display,
      opponent: 'bot',
    });
    relay(bot.out, created?.response.tell_owner);
    const turn = await run(cwd, 'wait');
    const final = await finish(cwd, turn);
    expect(api.exchanges.some(exchange => exchange.body.note === NOTE)).toBe(
      true,
    );
    await report(cwd, final, api);
    checkRequests(api);
  }, 180_000);

  it('lets CASINO_URL override the rendered default', async () => {
    const api = await serve();
    const cwd = player('http://127.0.0.1:1');
    expect(await run(cwd, 'profile', 'override')).toMatchObject({ code: 0 });
    // The initial shell still starts with only PATH and HOME. Its exported
    // CASINO_URL must win over the unreachable URL baked into the script.
    const bot = await runShell(cwd, ['bot'], api.url);
    expect(bot.code, `${bot.out}\n${bot.err}`).toBe(0);
    expect(api.exchanges.some(exchange => exchange.path === '/v1/rooms')).toBe(
      true,
    );
    const left = await runShell(cwd, ['leave'], api.url);
    expect(left.code, `${left.out}\n${left.err}`).toBe(3);
    checkRequests(api);
  }, 120_000);

  it('queues two persistent players, relays matching and finishes and reports both seats', async () => {
    const api = await serve();
    const a = player(api.url);
    const b = player(api.url);
    for (const [cwd, name] of [
      [a, '甲'],
      [b, '乙'],
    ] as const) {
      expect(await run(cwd, 'profile', name)).toMatchObject({ code: 0 });
      expect(profile(cwd).name).toMatch(/^agent-[0-9a-f]{4}$/);
    }
    const waiting = await run(a, 'queue');
    expect(waiting.code, `${waiting.out}\n${waiting.err}`).toBe(2);
    expect(waiting.out).toContain(BEGIN);
    expect(waiting.out).toContain(END);
    for (const cwd of [b, a]) {
      const result = await run(cwd, 'queue');
      expect(result.code, `${result.out}\n${result.err}`).toBe(0);
      relay(result.out, api.exchanges.at(-1)?.response.tell_owner);
    }
    const queueCalls = api.exchanges.filter(
      exchange => exchange.path === '/v1/queue',
    );
    expect(queueCalls[0]?.body.queue_key).toMatch(/^[0-9a-f]{32}$/);
    expect(queueCalls[2]?.body.queue_key).toBe(queueCalls[0]?.body.queue_key);
    const results = new Map<string, Result>();
    for (let step = 0; step < 200 && results.size < 2; step++) {
      for (const cwd of [a, b]) {
        if (results.has(cwd)) continue;
        let result = await run(cwd, 'state');
        expect([0, 2, 3], `${result.out}\n${result.err}`).toContain(
          result.code,
        );
        if (result.code === 0) result = await run(cwd, ...action(result));
        expect([0, 2, 3], `${result.out}\n${result.err}`).toContain(
          result.code,
        );
        if (result.code === 3) results.set(cwd, result);
      }
    }
    expect(results.size).toBe(2);
    // Capture each seat's own tell_owner before report does any leaderboard fetches.
    for (const cwd of [a, b]) {
      const final = await run(cwd, 'wait');
      expect(final).toMatchObject({ code: 3 });
      await report(cwd, final, api);
    }
    checkRequests(api);
  }, 180_000);

  it('rejects missing profile and pending turn locally, and blocks a second room', async () => {
    const api = await serve();
    const cwd = player(api.url);
    expect(await run(cwd, 'queue')).toMatchObject({ code: 1 });
    expect(await run(cwd, 'act', 'check')).toMatchObject({ code: 1 });
    expect(api.exchanges).toHaveLength(0);
    expect(await run(cwd, 'profile', '測試')).toMatchObject({ code: 0 });
    expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
    const before = api.exchanges.length;
    expect(await run(cwd, 'act', 'check')).toMatchObject({ code: 1 });
    expect(api.exchanges.length).toBe(before);
    expect(await run(cwd, 'queue')).toMatchObject({ code: 1 });
    expect(await run(cwd, 'bot')).toMatchObject({ code: 1 });
    const left = await run(cwd, 'leave');
    expect(left).toMatchObject({ code: 3 });
    await report(cwd, left, api);
    checkRequests(api);
  }, 120_000);

  it('keeps a rejected raise turn available for a legal action', async () => {
    const api = await serve();
    const cwd = player(api.url);
    await run(cwd, 'profile', 'raise-test');
    expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
    const turn = await run(cwd, 'wait');
    expect(turn).toMatchObject({ code: 0 });
    expect(
      legal(turn).some(entry => entry.startsWith('raise ')),
      `stdout:\n${turn.out}\nstderr:\n${turn.err}\nAPI legal_actions: ${JSON.stringify(api.exchanges.at(-1)?.response.legal_actions)}`,
    ).toBe(true);
    const rejected = await run(cwd, 'act', 'raise', '999999', NOTE);
    expect(rejected).toMatchObject({ code: 1 });
    const error = api.exchanges.at(-1);
    expect(error?.response.code).toBe('invalid_action');
    expect(`${rejected.out}\n${rejected.err}`).toContain(
      error?.response.message,
    );
    const retried = await run(cwd, ...action(turn));
    expect([0, 2, 3], `${retried.out}\n${retried.err}`).toContain(retried.code);
    const actions = api.exchanges.filter(exchange =>
      exchange.path.includes('/actions'),
    );
    expect(actions).toHaveLength(2);
    expect(actions[1]?.body.turn_id).toBe(actions[0]?.body.turn_id);
    await report(cwd, await finish(cwd, retried), api);
    checkRequests(api);
  }, 180_000);

  it('automatically retries unavailable requests through a complete match', async () => {
    const api = await serve(true);
    const cwd = player(api.url);
    expect(await run(cwd, 'profile', 'chaos')).toMatchObject({ code: 0 });
    expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
    const final = await finish(cwd);
    expect(
      api.exchanges.some(
        exchange =>
          exchange.status === 503 && exchange.response.code === 'unavailable',
      ),
    ).toBe(true);
    const actions = api.exchanges.filter(exchange =>
      exchange.path.includes('/actions'),
    );
    for (let index = 0; index < actions.length; index++) {
      if (actions[index]?.status === 503) {
        expect(actions[index + 1]?.body).toEqual(actions[index]?.body);
      }
    }
    await report(cwd, final, api);
    checkRequests(api);
  }, 180_000);
});
