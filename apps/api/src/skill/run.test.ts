// T13: every curl in skill.md, run as written (casino-api skill: A12). Each
// ```bash block goes through a real bash, so quoting and variables expand as
// they would for an agent; `curl` is a shell function that hands its argv
// back here, where it becomes a Request to the Worker's handle() with real
// referees, the real queue and a real local D1. Each response must decode
// with its endpoint's schemas, and $ROOM_ID and $TURN_ID come from the
// responses before, as A12 says. Blocks without curl run for real in a fresh
// folder: they make the queue_key file (A17) and save and delete the room's
// token file (T27), so the curls read the token the way an agent's would.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Exit, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { CasinoApi } from '../contract/api';
import { QUEUE_KEY_PATTERN } from '../contract/schemas';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { matchQueueIn, type QueueInput } from '../matchmaker/pairing';
import { RatingWriter } from '../matchmaker/ratings';
import { RoomReferee, type RoomStorage } from '../room/referee';
import type { Bindings } from '../routes/env';
import { renderSkill } from './render';

const BASE = 'https://casino.example';
// The values the examples show; the test sends the real ones, as an agent
// copies them from the responses.
const EXAMPLE_INVITE = 'K7Q2MX';
const EXAMPLE_ROOM = 'r_8f2k1x9q0a';
const EXAMPLE_TOKEN =
  'eyJyb29tX2lkIjoicl84ZjJrMXg5cTBhIiwic2VhdCI6MH0.Hk3vQ9xZ2mPq';

let testD1: TestD1;
// The agent's working folder, where skill.md keeps .casino/.
let cwd: string;

beforeAll(async () => {
  testD1 = await startTestD1();
  cwd = mkdtempSync(join(tmpdir(), 'skill-run-'));
}, 30_000);

afterAll(async () => {
  await testD1?.dispose();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

class MemoryStorage implements RoomStorage {
  readonly #data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.#data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.#data.set(key, structuredClone(value));
  }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}

const makeEnv = (): Bindings => {
  const ratings = new RatingWriter(testD1.db);
  const referees = new Map<string, RoomReferee>();
  const env = {
    TOKEN_SECRET: 'skill-run-token-secret',
    WEB_URL: 'https://web.test',
    ADMIN_KEY: 'skill-run-admin-key',
    DB: testD1.d1,
    ROOM: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        let referee = referees.get(id);
        if (!referee) {
          referee = new RoomReferee(new MemoryStorage(), {
            waitMs: 50,
            record: input => ratings.record(input),
          });
          referees.set(id, referee);
        }
        return referee;
      },
    },
  } as unknown as Bindings;
  const queue = matchQueueIn(env, { waitMs: 50 });
  Object.assign(env, {
    MATCHMAKER: {
      idFromName: (name: string) => name,
      get: () => ({ queue: (input: QueueInput) => queue.queue(input) }),
    },
  });
  return env;
};

// --- the contract's endpoints, by method and path ---------------------------

interface Endpoint {
  key: string;
  method: string;
  pattern: RegExp;
  successes: ReadonlyMap<number, ReadonlyArray<Schema.Top>>;
  errors: ReadonlyMap<number, ReadonlyArray<Schema.Top>>;
}

const ENDPOINTS: Endpoint[] = [];
HttpApi.reflect(CasinoApi, {
  onGroup: () => {},
  onEndpoint: ({ group, endpoint, successes, errors }) => {
    ENDPOINTS.push({
      key: `${group.identifier}.${endpoint.identifier}`,
      method: endpoint.method,
      pattern: new RegExp(`^${endpoint.path.replace(/:\w+/g, '[^/]+')}$`),
      successes,
      errors,
    });
  },
});

const decodes = (schema: Schema.Top, value: unknown) =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(value),
  );

// --- running the blocks -----------------------------------------------------

const bashBlocks = (md: string) =>
  [...md.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(m => m[1] ?? '');

// The argv of every curl the block ran, through a real bash.
const curlsOf = (block: string, vars: Record<string, string>): string[][] => {
  const out = execFileSync(
    'bash',
    [
      '-c',
      `curl() { printf '%s\\0' "$@"; printf '\\n\\0'; }\nmkdir() { :; }\n${block}`,
    ],
    {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', ...vars },
    },
  ).toString();
  return out
    .split('\n\0')
    .filter(chunk => chunk !== '')
    .map(chunk => chunk.split('\0').filter(arg => arg !== ''));
};

// A block without curl, run with `set -e` so a failing line fails the test.
const runBlock = (block: string, vars: Record<string, string>) =>
  execFileSync('bash', ['-ec', block], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', ...vars },
  });

const casinoFiles = () => readdirSync(join(cwd, '.casino')).sort();

// curl's argv (only the options skill.md uses) as a Request.
const requestOf = (argv: string[]) => {
  let method = 'GET';
  let url = '';
  let body: string | undefined;
  const headers = new Headers();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '-X') method = argv[++i] ?? '';
    else if (arg === '-H') {
      const [name, ...value] = (argv[++i] ?? '').split(':');
      headers.set(name ?? '', value.join(':').trim());
    } else if (arg === '-d') body = argv[++i];
    else if (arg === '-o' || arg === '--max-time') i++;
    else if (!arg.startsWith('-')) url = arg;
  }
  if (body !== undefined && method === 'GET') method = 'POST';
  return new Request(url, { method, headers, body });
};

interface Ran {
  endpoint: string;
  status: number;
  body: unknown;
}

describe('skill.md examples, run against the API', () => {
  it('every curl runs as written and answers what the contract says', async () => {
    const env = makeEnv();
    const md = renderSkill(BASE);
    const vars: Record<string, string> = { CASINO_URL: BASE };
    const ran: Ran[] = [];
    const tokens: string[] = [];
    let invite = '';
    // alice's seat, once she has one: what she copies into her blocks.
    let seat: { room: string; token: string } | undefined;
    let queueKey = '';
    // The room alice is matched into from the queue, once she saved it.
    let matchedRoom = '';

    // bob is already in the queue, so alice's queue call is matched, the
    // main way into a game.
    const bobQueues = await handle(
      new Request(`${BASE}/v1/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game: 'holdem',
          name: 'bob',
          queue_key: 'bob-queue-key-0123456789',
        }),
      }),
      env,
    );
    expect(await bobQueues.json()).toMatchObject({ status: 'waiting' });

    for (const block of bashBlocks(md)) {
      if (!block.includes('curl')) {
        // alice copies her own room_id and token into the save blocks.
        const script = seat
          ? block
              .replaceAll(EXAMPLE_ROOM, seat.room)
              .replaceAll(EXAMPLE_TOKEN, seat.token)
          : block;
        runBlock(script, vars);
        if (block.includes('openssl rand')) {
          queueKey = readFileSync(
            join(cwd, '.casino/alice.queue_key'),
            'utf8',
          ).trim();
          expect(queueKey).toMatch(QUEUE_KEY_PATTERN);
        }
        // The matched save block: the token file opens the room, and the
        // queue_key moved next to it.
        if (block.includes('mv .casino/alice.queue_key') && seat) {
          matchedRoom = seat.room;
          const saved = readFileSync(
            join(cwd, `.casino/${matchedRoom}.token`),
            'utf8',
          ).trim();
          const state = await handle(
            new Request(`${BASE}/v1/rooms/${matchedRoom}/state`, {
              headers: { Authorization: `Bearer ${saved}` },
            }),
            env,
          );
          expect(state.status).toBe(200);
          expect(
            readFileSync(
              join(cwd, `.casino/${matchedRoom}.queue_key`),
              'utf8',
            ).trim(),
          ).toBe(queueKey);
        }
        continue;
      }
      const script = block.replaceAll(EXAMPLE_INVITE, invite || EXAMPLE_INVITE);
      for (const argv of curlsOf(script, vars)) {
        const request = requestOf(argv);
        const url = new URL(request.url);
        expect(url.origin).toBe(BASE);
        const response = await handle(request, env);
        const text = await response.text();
        if (url.pathname === '/skill.md') {
          expect(response.status).toBe(200);
          expect(text).toBe(md);
          ran.push({ endpoint: 'skill.skill', status: 200, body: text });
          continue;
        }
        const endpoint = ENDPOINTS.find(
          e => e.method === request.method && e.pattern.test(url.pathname),
        );
        if (!endpoint) throw new Error(`No endpoint for ${argv.join(' ')}`);
        const body: unknown = JSON.parse(text);
        const schemas =
          (response.status < 400 ? endpoint.successes : endpoint.errors).get(
            response.status,
          ) ?? [];
        expect(
          schemas.some(schema => decodes(schema, body)),
          `${endpoint.key} answered ${response.status} ${text}`,
        ).toBe(true);
        ran.push({ endpoint: endpoint.key, status: response.status, body });

        const value = body as Record<string, unknown>;
        if (
          endpoint.key === 'lobby.queue' ||
          endpoint.key === 'lobby.createRoom'
        ) {
          seat = { room: String(value.room_id), token: String(value.token) };
          vars.ROOM_ID = seat.room;
        }
        if (endpoint.key === 'lobby.createRoom')
          invite = String(value.invite_code);
        if (typeof value.token === 'string') tokens.push(value.token);
        if (typeof value.turn_id === 'string') vars.TURN_ID = value.turn_id;
      }
    }

    // In skill.md's order, each answered as the story goes: alice opens a
    // room, bob joins, alice (the button) raises, checks her state, leaves
    // and loses, then checks the leaderboard.
    expect(ran.map(r => [r.endpoint, r.status])).toEqual([
      ['lobby.queue', 200],
      ['lobby.createRoom', 200],
      ['lobby.joinRoom', 200],
      ['room.wait', 200],
      ['room.act', 200],
      ['room.state', 200],
      ['room.leave', 200],
      ['read.leaderboard', 200],
      ['skill.skill', 200],
      ['skill.skill', 200],
    ]);
    expect(queueKey).not.toBe('');
    expect(matchedRoom).not.toBe('');
    expect(tokens).toHaveLength(3);
    // The room she played to the end and reported has no files left; the
    // queue match she never played still has its own.
    expect(casinoFiles()).toEqual([
      `${matchedRoom}.queue_key`,
      `${matchedRoom}.token`,
    ]);
    expect(ran[0]?.body).toMatchObject({ status: 'matched' });
    expect(ran[3]?.body).toMatchObject({ status: 'your_turn' });
    expect(ran[4]?.body).toMatchObject({ status: 'accepted' });
    expect(ran[6]?.body).toMatchObject({
      status: 'match_over',
      result: 'loss',
      ratings: [
        { name: 'alice', change: expect.any(Number) },
        { name: 'bob', change: expect.any(Number) },
      ],
    });
  });
});
