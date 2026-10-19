import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schema } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import { QueueResponse, RoomStatus } from '../contract/schemas';
import { startTestD1, type TestD1 } from '../db/test-d1';
import { matchQueueIn, type QueueInput } from '../matchmaker/pairing';
import { RatingWriter } from '../matchmaker/ratings';
import { RoomReferee, type RoomStorage } from '../room/referee';
import type { Bindings } from '../routes/env';
import { renderSkill } from './render';

const BASE = 'https://casino.example';
const WEB_URL = 'https://web.test';
const QUEUE_KEY = 'relay-alice-queue-key-0123456789';
let testD1: TestD1;

beforeAll(async () => {
  testD1 = await startTestD1();
}, 30_000);
beforeEach(async () => {
  await testD1.reset();
});
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
    TOKEN_SECRET: 'relay-test-token-secret',
    WEB_URL,
    DB: testD1.d1,
    ROOM: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        let referee = referees.get(id);
        if (!referee) {
          referee = new RoomReferee(new MemoryStorage(), {
            waitMs: 1,
            webUrl: WEB_URL,
            record: input => ratings.record(input),
          });
          referees.set(id, referee);
        }
        return referee;
      },
    },
  } as unknown as Bindings;
  const queue = matchQueueIn(env, { waitMs: 1 });
  Object.assign(env, {
    MATCHMAKER: {
      idFromName: (name: string) => name,
      get: () => ({ queue: (input: QueueInput) => queue.queue(input) }),
    },
  });
  return env;
};

const post = (env: Bindings, path: string, body: unknown) =>
  handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );

const matchedSeat = async (env: Bindings, displayName: string) => {
  const enqueue = (name: string) =>
    post(env, '/v1/queue', {
      game: 'holdem',
      name,
      display_name: displayName,
      queue_key:
        name === 'alice' ? QUEUE_KEY : 'relay-bob-queue-key-0123456789',
    });
  expect(await (await enqueue('bob')).json()).toMatchObject({
    status: 'waiting',
  });
  const response = await enqueue('alice');
  expect(response.status).toBe(200);
  const text = await response.text();
  const seat = Schema.decodeUnknownSync(QueueResponse)(JSON.parse(text));
  expect(seat.status).toBe('matched');
  if (seat.status !== 'matched') throw new Error('Expected matched seat');
  expect(seat.tell_owner).toContain(displayName);
  return { seat, text };
};

const bashBlocks = (md: string) =>
  [...md.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(m => m[1] ?? '');

const runBlock = (block: string, cwd: string, roomId: string) =>
  execFileSync('bash', ['-ec', block], {
    cwd,
    env: { PATH: process.env.PATH ?? '', HOME: cwd, ROOM_ID: roomId },
    encoding: 'utf8',
  });

const lastLine = (stdout: string) =>
  stdout.replace(/\n$/, '').split('\n').at(-1);

describe('T46 skill bash blocks end with decoded tell_owner', () => {
  it.each(['Alice the Shark', 'Al "Ace" \\ 王'])(
    'matched save block preserves room files and prints the full message for %s',
    async displayName => {
      const { seat, text } = await matchedSeat(makeEnv(), displayName);
      const block = bashBlocks(renderSkill(BASE, WEB_URL)).find(b =>
        b.includes('mv .casino/alice.queue_key'),
      );
      expect(block).toBeDefined();
      if (!block) throw new Error('Missing matched save block');
      const cwd = mkdtempSync(join(tmpdir(), 'skill-relay-'));
      try {
        mkdirSync(join(cwd, '.casino'));
        writeFileSync(join(cwd, '.casino/seat.json'), text);
        writeFileSync(join(cwd, '.casino/alice.queue_key'), QUEUE_KEY);
        const stdout = runBlock(block, cwd, seat.room_id);
        const file = (suffix: string) =>
          join(cwd, `.casino/${seat.room_id}.${suffix}`);
        expect(readFileSync(file('token'), 'utf8').trim()).toBe(seat.token);
        expect(readFileSync(file('watch_url'), 'utf8').trim()).toBe(
          seat.watch_url,
        );
        expect(readFileSync(file('queue_key'), 'utf8').trim()).toBe(QUEUE_KEY);
        expect(readFileSync(file('seat.json'), 'utf8')).toBe(text);
        expect(existsSync(join(cwd, '.casino/seat.json'))).toBe(false);
        expect(existsSync(join(cwd, '.casino/alice.queue_key'))).toBe(false);
        expect(lastLine(stdout)).toBe(
          `Tell your owner now, before anything else: ${seat.tell_owner}`,
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.each(['Alice the Shark', 'Al "Ace" \\ 王'])(
    'Step 4 prints the decoded match_over message from the saved wait response for %s',
    async displayName => {
      const env = makeEnv();
      const { seat } = await matchedSeat(env, displayName);
      const leave = await handle(
        new Request(`${BASE}/v1/rooms/${seat.room_id}/leave`, {
          method: 'POST',
          headers: { authorization: `Bearer ${seat.token}` },
        }),
        env,
      );
      expect(leave.status).toBe(200);
      const response = await handle(
        new Request(`${BASE}/v1/rooms/${seat.room_id}/wait`, {
          headers: { authorization: `Bearer ${seat.token}` },
        }),
        env,
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      const over = Schema.decodeUnknownSync(RoomStatus)(JSON.parse(text));
      expect(over.status).toBe('match_over');
      if (over.status !== 'match_over') throw new Error('Expected match_over');
      expect(over.tell_owner).toContain(displayName);
      const step4 =
        renderSkill(BASE, WEB_URL).split('### Step 4')[1]?.split('\n## ')[0] ??
        '';
      const block = bashBlocks(step4).find(
        b => b.includes('.state.json') && !b.includes('curl'),
      );
      expect(
        block,
        'Step 4 needs a bash block that reads the saved match_over and prints tell_owner',
      ).toBeDefined();
      if (!block) throw new Error('Missing Step 4 relay block');
      const cwd = mkdtempSync(join(tmpdir(), 'skill-relay-'));
      try {
        mkdirSync(join(cwd, '.casino'));
        writeFileSync(join(cwd, `.casino/${seat.room_id}.state.json`), text);
        const stdout = runBlock(block, cwd, seat.room_id);
        expect(lastLine(stdout)).toBe(
          `Tell your owner now, before anything else: ${over.tell_owner}`,
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
