import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { lobbyIn } from '../matchmaker/lobby';
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
            listRoom: update => lobby.update(update),
          });
          referees.set(id, referee);
        }
        return referee;
      },
    },
  } as unknown as Bindings;
  const lobby = lobbyIn(env, { storage: new MemoryStorage() });
  // T39: the Matchmaker is the lobby; the queue is gone.
  Object.assign(env, {
    MATCHMAKER: {
      idFromName: (name: string) => name,
      get: () => ({ quick: lobby.quick, rooms: lobby.list }),
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

async function serve(
  chaos = false,
  faults: {
    drop?: (path: string, body: Record<string, unknown>) => boolean;
    dropResponse?: (path: string, answer: Record<string, unknown>) => boolean;
    unavailableRooms?: number;
    unavailableJoin?: number;
    waitedSeconds?: number;
    deadlineMs?: number;
    tellOwner?: string;
    answer?: (path: string, answer: Record<string, unknown>) => void;
  } = {},
) {
  const env = makeEnv(chaos);
  const exchanges: Exchange[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const path = incoming.url ?? '';
      const parsedBody = body ? JSON.parse(body) : {};
      if (faults.drop?.(path, parsedBody)) {
        exchanges.push({
          path,
          method: incoming.method ?? 'GET',
          body: parsedBody,
          response: {},
          status: 0,
          userAgent: incoming.headers['user-agent'],
        });
        incoming.socket.destroy();
        return;
      }
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
      let response: Response;
      if (
        (path === '/v1/rooms' && (faults.unavailableRooms ?? 0) > 0) ||
        (path.endsWith('/join') && (faults.unavailableJoin ?? 0) > 0)
      ) {
        if (path.endsWith('/join'))
          faults.unavailableJoin = (faults.unavailableJoin ?? 0) - 1;
        else faults.unavailableRooms = (faults.unavailableRooms ?? 0) - 1;
        response = Response.json(
          {
            status: 'error',
            code: 'unavailable',
            message: 'Retry',
            retryable: true,
          },
          { status: 503 },
        );
      } else response = await handle(request, env);
      const answer = JSON.parse(await response.text());
      faults.answer?.(path, answer);
      if (
        path === '/v1/queue' &&
        answer.status === 'waiting' &&
        faults.waitedSeconds !== undefined
      )
        answer.waited_seconds = faults.waitedSeconds;
      if (answer.status === 'your_turn' && faults.deadlineMs !== undefined) {
        answer.deadline = new Date(
          Date.now() + faults.deadlineMs,
        ).toISOString();
        answer.seconds_remaining = Math.floor(faults.deadlineMs / 1000);
      }
      if (
        typeof answer.tell_owner === 'string' &&
        faults.tellOwner !== undefined
      )
        answer.tell_owner = faults.tellOwner;
      const text = JSON.stringify(answer);
      exchanges.push({
        path: incoming.url ?? '',
        method: incoming.method ?? 'GET',
        body: body ? JSON.parse(body) : {},
        response: JSON.parse(text),
        status: response.status,
        userAgent: incoming.headers['user-agent'],
      });
      // The request took effect, but the client never receives its answer.
      if (faults.dropResponse?.(path, answer)) {
        incoming.socket.destroy();
        return;
      }
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('content-length', String(Buffer.byteLength(text)));
      outgoing.writeHead(response.status, Object.fromEntries(responseHeaders));
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
  scriptPath = '.casino/casino.sh',
): Promise<Result> {
  const argv =
    overrideUrl === undefined
      ? [scriptPath, ...args]
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
        /^Next: sh .+ .+/,
      );
      expect
        .soft(out.trimEnd().split('\n').at(-1), `${out}\n${err}`)
        .toContain(`Next: sh ${scriptPath} `);
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

function tableSummary(result: Result, response: Record<string, unknown>) {
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  const view = response.view as {
    my_cards: string[];
    board: string[];
    pot: number;
    my_stack: number;
    opponent_stack: number;
    my_seat: number;
    history: { seat: number; street: string; type: string; amount?: number }[];
  };
  expect(view, result.out).toBeDefined();
  const tableAt = result.out.search(
    new RegExp(`^Hand\\s+${response.hand_number}\\b`, 'm'),
  );
  expect(tableAt, result.out).toBeGreaterThanOrEqual(0);
  const table = result.out.slice(tableAt, result.out.indexOf('Legal:'));
  const escaped = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opponent = String(
    response.opponent_display_name ?? response.opponent_name,
  );
  expect(table, result.out).toMatch(
    new RegExp(`\\bpot\\s*:?\\s*${view.pot}\\b`, 'i'),
  );
  expect(table, result.out).toMatch(
    new RegExp(`\\b(?:you|your stack)\\s*:?\\s*${view.my_stack}\\b`, 'i'),
  );
  expect(table, result.out).toMatch(
    new RegExp(`${escaped(opponent)}\\s*:?\\s*${view.opponent_stack}\\b`, 'i'),
  );
  for (const card of [...view.my_cards, ...view.board])
    expect(table, JSON.stringify(response)).toContain(card);
  if (view.board.length === 0) expect(table).toMatch(/board[^\n]*none/i);
  const happened = result.out.slice(
    result.out.indexOf('This hand so far:'),
    tableAt,
  );
  for (const move of view.history) {
    const actor = move.seat === view.my_seat ? 'you' : escaped(opponent);
    const verb = move.type === 'post_blind' ? 'post' : move.type;
    expect(happened, JSON.stringify(view.history)).toContain(move.street);
    expect(happened, `${result.out}\n${JSON.stringify(view.history)}`).toMatch(
      new RegExp(
        `${actor}\\s+${verb}\\w*${move.amount === undefined ? '' : `\\s+(?:to\\s+)?${move.amount}\\b`}`,
        'i',
      ),
    );
  }
  if (response.tell_owner)
    expect(result.out.indexOf('This hand so far:'), result.out).toBeGreaterThan(
      result.out.indexOf(END),
    );
  legal(result);
  const legalAt = result.out.indexOf('Legal:');
  expect(result.out.indexOf(view.my_cards[0] ?? ''), result.out).toBeLessThan(
    legalAt,
  );
  expect(result.out.indexOf('Time left:'), result.out).toBeGreaterThan(legalAt);
  expect(result.out.lastIndexOf('Next:'), result.out).toBeGreaterThan(
    result.out.indexOf('Time left:'),
  );
  if (typeof response.tell_owner === 'string') {
    relay(result.out, response.tell_owner);
    expect(result.out.startsWith(`${BEGIN}\n`), result.out).toBe(true);
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
  expect(result.out, result.out).not.toMatch(/^Next:/m);
  expect(readdirSync(join(cwd, '.casino')).sort()).toEqual([
    'casino.sh',
    'profile.json',
  ]);
}

describe('casino.sh in fresh POSIX shells (A23)', () => {
  it.each([
    '.casino/casino.sh',
    '.claude/skills/agent-casino/scripts/casino.sh',
  ])(
    'T51: profile Next and help use the invoked path %s with state in .casino',
    async scriptPath => {
      const cwd = player('http://127.0.0.1:1');
      if (scriptPath !== '.casino/casino.sh') {
        mkdirSync(join(cwd, '.claude/skills/agent-casino/scripts'), {
          recursive: true,
        });
        writeFileSync(
          join(cwd, scriptPath),
          readFileSync(join(cwd, '.casino/casino.sh')),
        );
        rmSync(join(cwd, '.casino'), { recursive: true });
      }
      const result = await runShell(
        cwd,
        ['profile', 'X', 'sonnet'],
        undefined,
        scriptPath,
      );
      expect(result.code, result.err).toBe(0);
      expect.soft(result.out).toContain(`Next: sh ${scriptPath} `);
      expect(profile(cwd)).toMatchObject({
        name: expect.stringMatching(/^sonnet-[0-9a-f]{4}$/),
        display_name: 'X',
      });
      for (const args of [['help'], ['help', 'profile']]) {
        const help = await runShell(cwd, args, undefined, scriptPath);
        expect(help.code, help.err).toBe(0);
        expect.soft(help.out).toContain(`sh ${scriptPath} `);
        if (scriptPath !== '.casino/casino.sh')
          expect.soft(help.out).not.toContain('sh .casino/casino.sh ');
      }
      if (scriptPath !== '.casino/casino.sh')
        expect(
          readdirSync(join(cwd, '.claude/skills/agent-casino/scripts')),
        ).toEqual(['casino.sh']);
    },
  );

  it('T51: report rank line includes the display name and parenthesised identity', async () => {
    const api = await serve();
    const cwd = player(api.url);
    await run(cwd, 'profile', 'Alice the Shark', 'sonnet');
    writeFileSync(
      join(cwd, '.casino/profile.json'),
      JSON.stringify({ name: 'sonnet-3f9a', display_name: 'Alice the Shark' }),
    );
    expect(await run(cwd, 'room', 'create')).toMatchObject({ code: 0 });
    const created = api.exchanges.at(-1)?.response;
    const opponent = player(api.url);
    await run(opponent, 'profile', 'Opponent');
    expect(
      await run(
        opponent,
        'room',
        'join',
        String(created?.room_id),
        String(created?.invite_code),
      ),
    ).toMatchObject({ code: 0 });
    expect(await run(opponent, 'leave')).toMatchObject({ code: 3 });
    expect(await run(cwd, 'wait')).toMatchObject({ code: 3 });
    const result = await run(cwd, 'report');
    expect(result.code, result.err).toBe(0);
    const rank = result.out
      .split('\n')
      .find(line => /leaderboard.*rank/i.test(line));
    expect(rank, result.out).toBeDefined();
    expect.soft(rank).toContain('Alice the Shark');
    expect.soft(rank).toContain('(sonnet-3f9a)');
    checkRequests(api);
  });

  for (const seat of [0, 1] as const) {
    for (const handNumber of [5, 6]) {
      for (const status of ['your_turn', 'match_over'] as const) {
        it.each([-1, 0, 1])(
          `T51: blind-only explanation for seat ${seat}, hand ${handNumber}, ${status}, starting stack = own blind + %i`,
          async offset => {
            const ownBlind = seat === (handNumber - 1) % 2 ? 4 : 8;
            const startingStack = ownBlind + offset;
            const finalStack = startingStack * 2;
            const stacks =
              seat === 0
                ? [finalStack, 80 - finalStack]
                : [80 - finalStack, finalStack];
            const changes =
              seat === 0
                ? [startingStack, -startingStack]
                : [-startingStack, startingStack];
            const hand = {
              hand_number: handNumber,
              blinds: [4, 8],
              winner_seat: seat,
              pot: startingStack * 2,
              ended_by: 'showdown',
              board: ['2s', '3h', '4c', '8d', '9s'],
              hole_cards:
                seat === 0
                  ? [
                      ['Ah', 'Ad'],
                      ['Kh', 'Kd'],
                    ]
                  : [
                      ['Kh', 'Kd'],
                      ['Ah', 'Ad'],
                    ],
              stacks,
              stack_changes: changes,
            };
            const api = await serve(false, {
              answer: (path, answer) => {
                if (!path.endsWith('/wait')) return;
                Object.assign(answer, {
                  status,
                  seat,
                  hand_number: handNumber + (status === 'your_turn' ? 1 : 0),
                  last_hand: hand,
                  hands_since_your_turn: [hand],
                  ...(status === 'match_over'
                    ? {
                        result: 'win',
                        final_stacks: stacks,
                        ratings: null,
                        tell_owner:
                          'Match over. Unrated. Record: https://web.test/matches/test',
                      }
                    : {}),
                });
                Object.assign(answer.settings as object, {
                  blind_every: 2,
                  max_hands: 50,
                });
                if (answer.view) Object.assign(answer.view, { my_seat: seat });
              },
            });
            const cwd = player(api.url);
            await run(cwd, 'profile', 'Blind Player');
            expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
            const result = await run(cwd, 'wait');
            expect(result.code, `${result.out}\n${result.err}`).toBe(
              status === 'match_over' ? 3 : 0,
            );
            const since = result.out.slice(
              result.out.indexOf('Since your last move:'),
            );
            const line = since
              .split('\n')
              .find(value =>
                new RegExp(
                  `\\b${handNumber}\\b.*showdown|showdown.*\\b${handNumber}\\b`,
                ).test(value),
              );
            expect(line, result.out).toBeDefined();
            const explanation =
              'you were all-in from posting the blind, so this hand needed no move from you';
            if (offset <= 0) expect(line, result.out).toContain(explanation);
            else expect(line, result.out).not.toContain(explanation);
            checkRequests(api);
          },
        );
      }
    }
  }

  for (const seat of [0, 1] as const) {
    it.each(['busted by blind', 'decision then loss', 'split pot'] as const)(
      `T51 hardening: seat ${seat}, %s`,
      async scenario => {
        const ownBlind = seat === 0 ? 4 : 8; // Hand 5: seat 0 is the button.
        const start = scenario === 'decision then loss' ? 20 : ownBlind;
        const change =
          scenario === 'busted by blind'
            ? -start
            : scenario === 'decision then loss'
              ? -5
              : 0;
        const final = start + change;
        const stacks = seat === 0 ? [final, 80 - final] : [80 - final, final];
        const hand = {
          hand_number: 5,
          blinds: [4, 8],
          winner_seat: scenario === 'split pot' ? null : 1 - seat,
          pot:
            scenario === 'split pot'
              ? start * 2
              : scenario === 'busted by blind'
                ? start * 2
                : 10,
          ended_by: 'showdown',
          board: ['Ts', 'Js', 'Qs', 'Ks', 'As'],
          hole_cards: [
            ['2h', '3h'],
            ['4d', '5d'],
          ],
          stacks,
          stack_changes: seat === 0 ? [change, -change] : [-change, change],
        };
        // Losing cases use an opponent-winning board; split uses the royal board.
        if (scenario !== 'split pot') {
          Object.assign(hand, {
            board: ['2s', '3h', '4c', '8d', '9s'],
            hole_cards:
              seat === 0
                ? [
                    ['Kh', 'Kd'],
                    ['Ah', 'Ad'],
                  ]
                : [
                    ['Ah', 'Ad'],
                    ['Kh', 'Kd'],
                  ],
          });
        }
        const api = await serve(false, {
          answer: (path, answer) => {
            if (!path.endsWith('/wait')) return;
            Object.assign(answer, {
              status: 'match_over',
              seat,
              hand_number: 5,
              last_hand: hand,
              hands_since_your_turn: [hand],
              result: 'loss',
              final_stacks: stacks,
              ratings: null,
              tell_owner:
                'Match over. Unrated. Record: https://web.test/matches/test',
            });
            Object.assign(answer.settings as object, {
              blind_every: 2,
              max_hands: 5,
            });
            if (answer.view) Object.assign(answer.view, { my_seat: seat });
          },
        });
        const cwd = player(api.url);
        await run(cwd, 'profile', 'Blind Hardening');
        expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
        const result = await run(cwd, 'wait');
        expect(result.code, `${result.out}\n${result.err}`).toBe(3);
        const line = result.out
          .split('\n')
          .find(value => /\b5\b.*showdown|showdown.*\b5\b/.test(value));
        expect(line, result.out).toBeDefined();
        const note =
          'you were all-in from posting the blind, so this hand needed no move from you';
        if (scenario === 'decision then loss')
          expect(line, result.out).not.toContain(note);
        else expect(line, result.out).toContain(note);
        checkRequests(api);
      },
    );
  }

  it('recovers the table and the seat watch link after an accepted action without tell_owner', async () => {
    const api = await serve();
    const cwd = player(api.url);
    await run(cwd, 'profile', 'reconnected');
    expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
    const watchUrl = api.exchanges.at(-1)?.response.watch_url;
    expect(watchUrl).toEqual(
      expect.stringMatching(/^https:\/\/web\.test\/watch\//),
    );
    const turn = await run(cwd, 'wait');
    const acted = await run(cwd, ...action(turn));
    expect(acted.code, `${acted.out}\n${acted.err}`).toBe(0);
    expect(api.exchanges.at(-1)?.path).toMatch(/\/actions\?wait=1$/);
    expect(api.exchanges.at(-1)?.status).toBe(200);
    const state = await run(cwd, 'state');
    const response = api.exchanges.at(-1)?.response;
    expect(response).toBeDefined();
    expect(response?.tell_owner).toBeUndefined();
    expect(state.code, `${state.out}\n${state.err}`).toBe(0);
    expect(state.out).toContain(watchUrl);
    if (!response) throw new Error('Missing state response');
    tableSummary(state, response);
    checkRequests(api);
  }, 60_000);

  it('prints the current table and moves, then reports completed hands before the next table', async () => {
    const api = await serve();
    const cwd = player(api.url);
    await run(cwd, 'profile', 'turn-summary');
    expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
    let result = await run(cwd, 'wait');
    let sawCompletedHand = false;
    for (let step = 0; step < 100 && result.code !== 3; step++) {
      const response = api.exchanges.at(-1)?.response;
      expect(response).toBeDefined();
      if (!response) throw new Error('Missing response');
      if (result.code === 0) {
        tableSummary(result, response);
        const view = response.view as { board: string[]; my_cards: string[] };
        const hands = response.hands_since_your_turn as Record<
          string,
          unknown
        >[];
        if (hands?.length) {
          sawCompletedHand = true;
          const sinceAt = result.out.indexOf('Since your last move:');
          expect(sinceAt, result.out).toBeGreaterThanOrEqual(0);
          const tableAt = result.out.indexOf(view.my_cards[0] ?? '');
          expect(sinceAt, result.out).toBeLessThan(tableAt);
          if (response.tell_owner)
            expect(sinceAt, result.out).toBeGreaterThan(
              result.out.indexOf(END),
            );
          const happened = result.out.slice(sinceAt, tableAt);
          for (const hand of hands) {
            expect(happened, JSON.stringify(hand)).toMatch(
              new RegExp(`\\b${hand.hand_number}\\b`),
            );
            // Completion reason and pot must describe the server's completed hand.
            expect(happened, JSON.stringify(hand)).toContain(
              String(hand.ended_by),
            );
            expect(happened, JSON.stringify(hand)).toMatch(
              new RegExp(`\\b${hand.pot}\\b`),
            );
          }
        }
      }
      result = await run(
        cwd,
        ...(result.code === 2
          ? ['wait']
          : step === 0
            ? ['act', 'fold', NOTE]
            : action(result)),
      );
    }
    expect(result.code, `${result.out}\n${result.err}`).toBe(3);
    expect(sawCompletedHand).toBe(true);
    checkRequests(api);
  }, 180_000);

  it('retries identical actions after dropped connections', async () => {
    let drops = 2;
    const api = await serve(false, {
      drop: path => path.includes('/actions') && drops-- > 0,
    });
    const cwd = player(api.url);
    await run(cwd, 'profile', 'dropped-action');
    expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
    const turn = await run(cwd, 'wait');
    const result = await run(cwd, ...action(turn));
    expect([0, 2, 3], `${result.out}\n${result.err}`).toContain(result.code);
    const actions = api.exchanges.filter(exchange =>
      exchange.path.includes('/actions'),
    );
    expect(actions.map(exchange => exchange.status)).toEqual([0, 0, 200]);
    for (const exchange of actions)
      expect(exchange.body).toEqual(actions[0]?.body);
    expect(actions[0]?.body.turn_id).toBe(
      api.exchanges.find(exchange => exchange.response.status === 'your_turn')
        ?.response.turn_id,
    );
    checkRequests(api);
  }, 120_000);

  it.each([2_000, 60_000])(
    'stops retrying dropped actions at the deadline or 20 seconds and shows state (deadline %i ms)',
    async deadlineMs => {
      const api = await serve(false, {
        drop: path => path.includes('/actions'),
        deadlineMs,
      });
      const cwd = player(api.url);
      await run(cwd, 'profile', 'deadline');
      expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
      const turn = await run(cwd, 'wait');
      const before = api.exchanges.length;
      const started = Date.now();
      const result = await run(cwd, ...action(turn));
      expect(Date.now() - started, `${result.out}\n${result.err}`).toBeLessThan(
        Math.min(deadlineMs, 20_000) + 5_000,
      );
      expect(result.code, `${result.out}\n${result.err}`).toBe(0);
      const calls = api.exchanges.slice(before);
      const actions = calls.filter(exchange =>
        exchange.path.includes('/actions'),
      );
      expect(actions.length, result.out).toBeGreaterThan(0);
      expect(actions.every(exchange => exchange.status === 0)).toBe(true);
      for (const exchange of actions)
        expect(exchange.body).toEqual(actions[0]?.body);
      expect(calls.at(-1)?.path).toMatch(/\/state$/);
      expect(calls.at(-1)?.method).toBe('GET');
      expect(calls.at(-1)?.response.status).toBe('your_turn');
      legal(result);
      checkRequests(api);
    },
    60_000,
  );

  it.each([['bot'], ['room', 'create']])(
    'does not reopen %s after a dropped room-creation connection',
    async (...command) => {
      let drops = 1;
      const api = await serve(false, {
        drop: path => path === '/v1/rooms' && drops-- > 0,
      });
      const cwd = player(api.url);
      await run(cwd, 'profile', 'dropped-create');
      const result = await run(cwd, ...command);
      expect(result.code, `${result.out}\n${result.err}`).toBe(1);
      expect(`${result.out}\n${result.err}`).toMatch(
        /connection|network|curl|failed|lost|unable/i,
      );
      expect(
        api.exchanges.filter(
          exchange =>
            exchange.method === 'POST' && exchange.path === '/v1/rooms',
        ),
      ).toHaveLength(1);
      checkRequests(api);
    },
    60_000,
  );

  it.each([['bot'], ['room', 'create']])(
    'retries %s creation after an explicit 503',
    async (...command) => {
      const api = await serve(false, { unavailableRooms: 1 });
      const cwd = player(api.url);
      await run(cwd, 'profile', 'unavailable-create');
      const result = await run(cwd, ...command);
      expect(result.code, `${result.out}\n${result.err}`).toBe(0);
      const calls = api.exchanges.filter(
        exchange => exchange.path === '/v1/rooms',
      );
      expect(calls.map(exchange => exchange.status)).toEqual([503, 200]);
      expect(calls[1]?.body).toEqual(calls[0]?.body);
      checkRequests(api);
    },
    60_000,
  );

  it.each(['dropped connection', '503'])(
    'room join handles %s without unsafe resends',
    async fault => {
      let drops = 1;
      const api = await serve(false, {
        drop: path =>
          fault === 'dropped connection' &&
          path.endsWith('/join') &&
          drops-- > 0,
        unavailableJoin: fault === '503' ? 1 : 0,
      });
      const host = player(api.url);
      const guest = player(api.url);
      await run(host, 'profile', 'host');
      await run(guest, 'profile', 'guest');
      expect(await run(host, 'room', 'create')).toMatchObject({ code: 0 });
      const created = api.exchanges.at(-1)?.response;
      const result = await run(
        guest,
        'room',
        'join',
        String(created?.room_id),
        String(created?.invite_code),
      );
      expect(result.code, `${result.out}\n${result.err}`).toBe(
        fault === '503' ? 0 : 1,
      );
      const calls = api.exchanges.filter(exchange =>
        exchange.path.endsWith('/join'),
      );
      expect(calls.map(exchange => exchange.status)).toEqual(
        fault === '503' ? [503, 200] : [0],
      );
      if (fault === '503') expect(calls[1]?.body).toEqual(calls[0]?.body);
      else
        expect(`${result.out}\n${result.err}`).toMatch(
          /connection|network|curl|failed|lost|unable/i,
        );
      checkRequests(api);
    },
    60_000,
  );

  it.each(['your_turn', 'waiting', 'match_over'])(
    'recovers a lost accepted-action response ending in %s',
    async status => {
      let lost = false;
      const api = await serve(false, {
        dropResponse: (path, answer) => {
          if (
            !lost &&
            path.endsWith('/actions?wait=1') &&
            answer.status === status
          ) {
            lost = true;
            return true;
          }
          return false;
        },
      });
      const cwd = player(api.url);
      await run(cwd, 'profile', 'lost-response');
      if (status === 'waiting') {
        expect(await run(cwd, 'room', 'create')).toMatchObject({ code: 0 });
        const created = api.exchanges.at(-1)?.response;
        const guest = player(api.url);
        await run(guest, 'profile', 'opponent');
        expect(
          await run(
            guest,
            'room',
            'join',
            String(created?.room_id),
            String(created?.invite_code),
          ),
        ).toMatchObject({ code: 0 });
      } else expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
      let turn = await run(cwd, 'wait');
      for (let step = 0; step < 100 && !lost; step++) {
        const before = api.exchanges.length;
        const result = await run(
          cwd,
          ...(turn.code === 2 ? ['wait'] : action(turn)),
        );
        if (lost) {
          const calls = api.exchanges
            .slice(before)
            .filter(exchange => exchange.path.endsWith('/actions?wait=1'));
          expect(calls, `${result.out}\n${result.err}`).toHaveLength(2);
          expect(calls[1]?.body).toEqual(calls[0]?.body);
          expect(calls[0]?.response.status).toBe(status);
          expect(calls[1]?.response.status).toBe(status);
          expect(result.code, `${result.out}\n${result.err}`).toBe(
            { your_turn: 0, waiting: 2, match_over: 3 }[status],
          );
          expect(result.out).toMatch(/^Next: /m);
          if (status === 'your_turn') {
            const next = calls[1]?.response;
            expect(next?.duplicate).toBe(true);
            expect(result.out).toMatch(
              /nothing was sent|no action was sent|did not send|not sent/i,
            );
            expect(next?.turn_id).not.toBe(calls[0]?.body.turn_id);
            if (!next) throw new Error('Missing duplicate response');
            tableSummary(result, next);
            const following = await run(cwd, ...action(result));
            expect([0, 2, 3], `${following.out}\n${following.err}`).toContain(
              following.code,
            );
            expect(api.exchanges.at(-1)?.body.turn_id).toBe(next.turn_id);
          } else expect(calls[1]?.response.duplicate).toBeUndefined();
        }
        turn = result;
        if (result.code === 3) break;
      }
      expect(lost).toBe(true);
      checkRequests(api);
    },
    180_000,
  );

  // T42: casino.sh queue → quick. T39 took the queue out (POST /v1/queue
  // answers 410 gone), so this fails until T42 rewrites it for quick.
  it.fails.each([180, 181])(
    'asks the owner to choose and pauses queue instructions after %i seconds',
    async waitedSeconds => {
      const api = await serve(false, { waitedSeconds });
      const cwd = player(api.url);
      await run(cwd, 'profile', 'patient-player');
      const result = await run(cwd, 'queue');
      expect(result.code, `${result.out}\n${result.err}`).toBe(2);
      const block = result.out.slice(
        result.out.indexOf(BEGIN) + BEGIN.length,
        result.out.indexOf(END),
      );
      expect(result.out).toContain(BEGIN);
      expect(result.out).toContain(END);
      expect(block).toMatch(/keep waiting|continue waiting/i);
      expect(block).toMatch(/bot/i);
      expect(block).toMatch(/stop/i);
      expect(block).toMatch(/ask|choose|would you|want|\?/i);
      expect(result.out.trimEnd().split('\n').at(-1)).toMatch(
        /^Next: .*wait.*owner.*(?:answer|reply|respond)/i,
      );
      checkRequests(api);
    },
    60_000,
  );

  it('keeps both private-room players tokens out of every curl argv, including act', async () => {
    const api = await serve();
    const players = [player(api.url), player(api.url)];
    for (const [index, cwd] of players.entries()) {
      writeFileSync(
        join(cwd, 'bin/curl'),
        '#!/bin/sh\nprintf "%s\\n" "$@" >> curl-argv\nexec /usr/bin/curl "$@"\n',
        { mode: 0o755 },
      );
      await run(cwd, 'profile', `private-${index}`);
    }
    const [a, b] = players;
    if (!a || !b) throw new Error('Missing players');
    // T39: was the queue; a private room seats both the same way.
    expect(await run(a, 'room', 'create')).toMatchObject({ code: 0 });
    const created = api.exchanges.at(-1)?.response;
    expect(
      await run(
        b,
        'room',
        'join',
        String(created?.room_id),
        String(created?.invite_code),
      ),
    ).toMatchObject({ code: 0 });
    const turn = await run(a, 'wait');
    expect(turn.code, `${turn.out}\n${turn.err}`).toBe(0);
    const acted = await run(a, ...action(turn));
    expect([0, 2, 3], `${acted.out}\n${acted.err}`).toContain(acted.code);
    expect(api.exchanges.at(-1)?.path).toMatch(/\/actions\?wait=1$/);
    const seated = api.exchanges.filter(
      exchange =>
        exchange.path === '/v1/rooms' || exchange.path.endsWith('/join'),
    );
    const secrets = seated
      .map(exchange => exchange.response.token)
      .filter((value): value is string => typeof value === 'string');
    expect(new Set(secrets).size).toBe(2);
    for (const cwd of players) {
      const argv = readFileSync(join(cwd, 'curl-argv'), 'utf8');
      for (const secret of secrets)
        expect(
          argv,
          `curl argv leaked a secret for ${profile(cwd).name}`,
        ).not.toContain(secret);
      expect(argv).toMatch(/(?:^|\n)--data-binary\n@[^\n]+/);
    }
    checkRequests(api);
  }, 60_000);

  // T42: casino.sh queue → quick. T39 took the queue out (POST /v1/queue
  // answers 410 gone), so this fails until T42 rewrites it for quick.
  it.fails('switches from a waiting queue to a bot and clears the queue key when reporting', async () => {
    const api = await serve();
    const cwd = player(api.url);
    await run(cwd, 'profile', 'queue-to-bot');
    const queued = await run(cwd, 'queue');
    expect(queued.code, `${queued.out}\n${queued.err}`).toBe(2);
    expect(api.exchanges.at(-1)?.body.queue_key).toMatch(/^[0-9a-f]{32}$/);
    const bot = await run(cwd, 'bot');
    expect(bot.code, `${bot.out}\n${bot.err}`).toBe(0);
    await report(cwd, await finish(cwd), api);
    checkRequests(api);
  }, 180_000);

  it('keeps token files private and sends authorization through a header file', async () => {
    const api = await serve();
    const cwd = player(api.url);
    writeFileSync(
      join(cwd, 'bin/curl'),
      '#!/bin/sh\nprintf "%s\\n" "$@" >> curl-argv\nexec /usr/bin/curl "$@"\n',
      { mode: 0o755 },
    );
    await run(cwd, 'profile', 'private-token');
    expect(await run(cwd, 'bot')).toMatchObject({ code: 0 });
    const token = api.exchanges.find(exchange => exchange.path === '/v1/rooms')
      ?.response.token;
    expect(typeof token).toBe('string');
    const turn = await run(cwd, 'wait');
    expect(turn.code, `${turn.out}\n${turn.err}`).toBe(0);
    const files = readdirSync(join(cwd, '.casino')).filter(file =>
      readFileSync(join(cwd, '.casino', file), 'utf8').includes(String(token)),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(statSync(join(cwd, '.casino', file)).mode & 0o077, file).toBe(0);
    const argv = readFileSync(join(cwd, 'curl-argv'), 'utf8');
    expect(argv).not.toContain(String(token));
    expect(argv).toMatch(/(?:^|\n)-H\n@[^\n]+/);
    checkRequests(api);
  }, 60_000);

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
    const display = '中文 玩家 "鯊魚" C:\\new \\ 🃏';
    const api = await serve(false, {
      tellOwner: `Your player is ${display}. Watch: https://web.test/watch/escaped`,
    });
    const cwd = player(api.url);
    expect(await run(cwd, 'profile', '第一次', 'codex')).toMatchObject({
      code: 0,
    });
    const first = profile(cwd);
    expect(first.name).toMatch(/^codex-[0-9a-f]{4}$/);
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
    expect(created?.response.tell_owner).toContain(display);
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

  it('seats two persistent players in a private room, relays the join and finishes and reports both seats', async () => {
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
    // T39: was the queue; T42 moves this to quick.
    expect(await run(a, 'room', 'create')).toMatchObject({ code: 0 });
    const created = api.exchanges.at(-1)?.response;
    const joined = await run(
      b,
      'room',
      'join',
      String(created?.room_id),
      String(created?.invite_code),
    );
    expect(joined.code, `${joined.out}\n${joined.err}`).toBe(0);
    relay(joined.out, api.exchanges.at(-1)?.response.tell_owner);
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
    // T39: was queueing again; any new seat shows the room was let go.
    const again = await run(cwd, 'bot');
    expect(again.code, `${again.out}\n${again.err}`).toBe(0);
    expect(api.exchanges.at(-1)?.path).toBe('/v1/rooms');
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
