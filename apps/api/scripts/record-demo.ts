/// <reference types="node" />
/**
 * Records two random-bot matches between the same two players straight into
 * the local D1 that `pnpm dev:api` reads, through recordMatch():
 *   pnpm db:migrate:local
 *   node apps/api/scripts/record-demo.ts [--players alice,bob] [--seed N]
 * Then GET /v1/leaderboard and /v1/matches show them. Never touches a remote
 * database: getPlatformProxy here only opens apps/api/.wrangler/state.
 */
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import type { TableHandRecord, TableState } from '../src/holdem/table';

// src uses extensionless imports, which Node's own TypeScript support can't
// resolve; add `.ts` before loading them.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { applyTableAction, startTable, tableLegalActions } = await import(
  '../src/holdem/table'
);
const { randomAction } = await import('../src/holdem/bot');
const { mulberry32 } = await import('../src/holdem/shuffle');
const { openDb } = await import('../src/db/client');
const { recordMatch } = await import('../src/db/records');

const { values } = parseArgs({
  options: {
    players: { type: 'string', default: 'alice,bob' },
    seed: { type: 'string', default: String(Date.now() % 2 ** 32) },
  },
});
const [p0 = 'alice', p1 = 'bob'] = (values.players ?? '').split(',');
const firstSeed = Number(values.seed);
const settings = {
  starting_stack: 40,
  blind_every: 5,
  max_hands: 50,
  turn_seconds: 30,
};

const random = mulberry32(firstSeed);
const roomId = () =>
  `r_${Array.from({ length: 10 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[Math.floor(random() * 36)]).join('')}`;

function play(seed: string) {
  let state: TableState = startTable({
    seed,
    players: 2,
    startingStack: settings.starting_stack,
    blindEvery: settings.blind_every,
    maxHands: settings.max_hands,
  });
  const hands: TableHandRecord[] = [];
  while (!state.over) {
    const result = applyTableAction(
      state,
      state.toAct ?? 0,
      randomAction(tableLegalActions(state), random),
    );
    if (!result.ok) throw new Error(result.message);
    state = result.state;
    hands.push(...result.finishedHands);
  }
  return { hands, stacks: state.stacks, places: state.places as number[] };
}

const proxy = await getPlatformProxy<{ DB: D1Database }>({
  configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
  // Where `wrangler dev` and `d1 migrations apply --local` keep it.
  persist: {
    path: fileURLToPath(new URL('../.wrangler/state/v3', import.meta.url).href),
  },
});
try {
  const db = openDb(proxy.env.DB);
  for (const [i, players] of [
    [p0, p1],
    [p1, p0],
  ].entries()) {
    // Match seeds are 64 hex characters (holdem-rules 種子與洗牌).
    const seed = createHash('sha256').update(`${firstSeed}:${i}`).digest('hex');
    const { hands, stacks, places } = play(seed);
    const input = {
      match_id: roomId(),
      players: [players[0] ?? p0, players[1] ?? p1] as [string, string],
      settings,
      seed,
      result:
        stacks[0] > stacks[1]
          ? ('seat0_win' as const)
          : stacks[1] > stacks[0]
            ? ('seat1_win' as const)
            : ('draw' as const),
      places,
      ended_at: new Date(Date.now() + i).toISOString(),
      final_stacks: [stacks[0], stacks[1]] as [number, number],
      hands,
    };
    const recorded = await recordMatch(db, input);
    console.log(
      `${input.match_id} ${input.players.join(' vs ')} ${input.result} ` +
        `stacks ${stacks.join('/')} hands ${hands.length} ` +
        JSON.stringify(recorded.ratings),
    );
  }
} finally {
  await proxy.dispose();
}
