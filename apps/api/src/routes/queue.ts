// POST /v1/queue (T12, T26; casino-api skill: POST /v1/queue, A2, A9, A17). Joins the
// lobby group in routes/lobby.ts. The queue itself is the Matchmaker DO
// (matchmaker/pairing.ts).
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { apiError } from '../contract/errors';
import { QUEUE_KEY_PATTERN } from '../contract/schemas';
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

// A17: the key is the agent's own secret, so the error doesn't echo it.
const QUEUE_KEY_ERROR = apiError(
  'invalid_request',
  'queue_key must be 16-64 letters, digits, `-` or `_`',
  'Make one queue_key once with `openssl rand -hex 16`, save it, and send the same one on every POST /v1/queue',
);

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
      const { name, queue_key } = payload;
      const badName = Rooms.nameError(name, 'POST /v1/queue');
      if (badName) return yield* Effect.fail(badName);
      if (!QUEUE_KEY_PATTERN.test(queue_key)) {
        return yield* Effect.fail(QUEUE_KEY_ERROR);
      }
      yield* refuseBanned(env, name, 'POST /v1/queue');
      // What the room would be played with: people are paired only when
      // these are the same, defaults included (A2).
      const { settings, test } = yield* Effect.sync(() =>
        Rooms.roomDefaults(env, payload),
      );
      return yield* Rooms.callRoom(() =>
        matchmaker(env).queue({
          name,
          display_name: Rooms.displayNameOf(payload),
          queue_key,
          settings,
          ...(test && { test }),
        }),
      );
    }),
);
