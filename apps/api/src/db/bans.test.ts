import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handle } from '../app';
import type { Bindings } from '../routes/env';
import { banName, isBanned } from './bans';
import { startTestD1, type TestD1 } from './test-d1';

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

describe('banName / isBanned', () => {
  it('nobody is banned at first', async () => {
    expect(await isBanned(testD1.db, 'alice')).toBe(false);
  });

  it('a banned name is banned in any casing', async () => {
    await banName(testD1.db, 'Alice');
    for (const name of ['Alice', 'alice', 'ALICE', 'aLiCe']) {
      expect(await isBanned(testD1.db, name)).toBe(true);
    }
  });

  it('unrelated names stay unbanned', async () => {
    await banName(testD1.db, 'Alice');
    for (const name of ['Bob', 'Alice2', 'alic', 'house-bot']) {
      expect(await isBanned(testD1.db, name)).toBe(false);
    }
  });

  it('banning twice, in any casing, is fine', async () => {
    await banName(testD1.db, 'Alice');
    await banName(testD1.db, 'Alice');
    await banName(testD1.db, 'ALICE');
    expect(await isBanned(testD1.db, 'alice')).toBe(true);
  });

  it('bans several names independently', async () => {
    await banName(testD1.db, 'alice');
    await banName(testD1.db, 'Bob');
    expect(await isBanned(testD1.db, 'ALICE')).toBe(true);
    expect(await isBanned(testD1.db, 'bob')).toBe(true);
    expect(await isBanned(testD1.db, 'carol')).toBe(false);
  });

  it('a ban through the admin endpoint is seen by isBanned', async () => {
    const env = {
      TOKEN_SECRET: 'test-token-secret',
      ADMIN_KEY: 'test-admin-key',
      DB: testD1.d1,
      ROOM: {},
      MATCHMAKER: {},
    } as unknown as Bindings;
    const response = await handle(
      new Request('http://api.test/v1/admin/names/Mallory/ban', {
        method: 'POST',
        headers: { authorization: 'Bearer test-admin-key' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await isBanned(testD1.db, 'mallory')).toBe(true);
    expect(await isBanned(testD1.db, 'MALLORY')).toBe(true);
    expect(await isBanned(testD1.db, 'alice')).toBe(false);
  });
});
