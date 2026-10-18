// POST /v1/queue (T12; casino-api skill: POST /v1/queue, A2, A9). Joins the
// lobby group in routes/lobby.ts. The queue itself is the Matchmaker DO
// (matchmaker/pairing.ts).
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { apiError } from '../contract/errors';
import { isBanned } from '../db/bans';
import { withDb } from '../db/client';
import type { MatchQueue } from '../matchmaker/pairing';
import * as Rooms from '../room/client';
import { type Bindings, WorkerEnv } from './env';

// Banned names can't queue, open or join a room (A9). `retry` names the
// request that was refused.
export const refuseBanned = (env: Bindings, name: string, retry: string) =>
  Effect.gen(function* () {
    if (!(yield* withDb(env.DB, db => isBanned(db, name)))) return;
    return yield* Effect.fail(
      apiError(
        'name_banned',
        `The name ${name} is banned on this platform and can't play`,
        `Do not resend ${retry}; tell your owner the name ${name} is banned`,
      ),
    );
  });

// The one queue of the whole platform.
const matchmaker = (env: Bindings) =>
  env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global')) as unknown as Pick<
    MatchQueue,
    'queue'
  >;

export const queue = HttpApiBuilder.handler(
  CasinoApi,
  'lobby',
  'queue',
  ({ payload }) =>
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      const { name, settings, test } = payload;
      const badName = Rooms.nameError(name, 'POST /v1/queue');
      if (badName) return yield* Effect.fail(badName);
      yield* refuseBanned(env, name, 'POST /v1/queue');
      // `test` settings only count where ALLOW_TEST_ROOMS=true (casino-api
      // 測試房); dropped here so they don't keep two players apart.
      const allowTest =
        (env as Bindings & { ALLOW_TEST_ROOMS?: string }).ALLOW_TEST_ROOMS ===
        'true';
      return yield* Rooms.callRoom(() =>
        matchmaker(env).queue({
          name,
          ...(settings && { settings }),
          ...(allowTest && test && { test }),
        }),
      );
    }),
);
