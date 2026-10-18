// T13: every curl in skill.md, run as written (casino-api skill: A12). Each
// ```bash block goes through a real bash, so quoting and variables expand as
// they would for an agent; `curl` is a shell function that hands its argv
// back here, where it becomes a Request to the Worker's handle() with real
// referees, the real queue and a real local D1. Each response must decode
// with its endpoint's schemas, and $ROOM_ID, $CASINO_TOKEN and $TURN_ID come
// from the responses before, as A12 says.
import { execFileSync } from 'node:child_process';
import { Exit, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { CasinoApi } from '../contract/api';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { matchQueueIn, type QueueInput } from '../matchmaker/pairing';
import { RatingWriter } from '../matchmaker/ratings';
import { RoomReferee, type RoomStorage } from '../room/referee';
import type { Bindings } from '../routes/env';
import { renderSkill } from './render';

const BASE = 'https://casino.example';
// The invite code the join example shows; the test sends the real one.
const EXAMPLE_INVITE = 'K7Q2MX';

let testD1: TestD1;

beforeAll(async () => {
  testD1 = await startTestD1();
}, 30_000);

afterAll(async () => {
  await testD1?.dispose();
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
    { env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', ...vars } },
  ).toString();
  return out
    .split('\n\0')
    .filter(chunk => chunk !== '')
    .map(chunk => chunk.split('\0').filter(arg => arg !== ''));
};

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

    for (const block of bashBlocks(md)) {
      // The export lines show example values; the real ones come from the
      // responses, as an agent would copy them.
      if (!block.includes('curl')) continue;
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
        if (endpoint.key === 'lobby.createRoom') {
          vars.ROOM_ID = String(value.room_id);
          vars.CASINO_TOKEN = String(value.token);
          invite = String(value.invite_code);
        }
        if (typeof value.token === 'string') tokens.push(value.token);
        if (typeof value.turn_id === 'string') vars.TURN_ID = value.turn_id;
      }
    }

    // In skill.md's order, each answered as the story goes: alice opens a
    // room, bob joins, alice (the button) raises, checks the leaderboard and
    // her state, then leaves and loses.
    expect(ran.map(r => [r.endpoint, r.status])).toEqual([
      ['lobby.queue', 200],
      ['lobby.createRoom', 200],
      ['lobby.joinRoom', 200],
      ['room.wait', 200],
      ['room.act', 200],
      ['read.leaderboard', 200],
      ['room.state', 200],
      ['room.leave', 200],
      ['skill.skill', 200],
      ['skill.skill', 200],
    ]);
    expect(tokens).toHaveLength(2);
    expect(ran[0]?.body).toMatchObject({ status: 'waiting' });
    expect(ran[3]?.body).toMatchObject({ status: 'your_turn' });
    expect(ran[4]?.body).toMatchObject({ status: 'accepted' });
    expect(ran[7]?.body).toMatchObject({
      status: 'match_over',
      result: 'loss',
      ratings: [
        { name: 'alice', change: expect.any(Number) },
        { name: 'bob', change: expect.any(Number) },
      ],
    });
  });
});
