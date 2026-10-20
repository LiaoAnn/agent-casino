// POST /v1/rooms/quick (T39; casino-api A2, A25): the lobby (the Matchmaker
// DO, matchmaker/lobby.ts) seats the caller at the oldest open public table
// with default settings, or opens one. Joins the lobby group in
// routes/lobby.ts.
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import type { Matchmaker } from '../matchmaker/matchmaker';
import * as Rooms from '../room/client';
import { type Bindings, WorkerEnv } from './env';
import { hostAnswer, joinAnswer, refuseBanned } from './room';

// The platform's one lobby. Typed as the class: RPC types would turn the
// contract's tuples into plain arrays.
export const lobby = (env: Bindings) =>
  env.MATCHMAKER.get(env.MATCHMAKER.idFromName('global')) as unknown as Pick<
    Matchmaker,
    'quick' | 'rooms'
  >;

export const quickRoom = HttpApiBuilder.handler(
  CasinoApi,
  'lobby',
  'quickRoom',
  ({ payload }) =>
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      const badName = Rooms.nameError(payload.name, 'POST /v1/rooms/quick');
      if (badName) return yield* Effect.fail(badName);
      yield* refuseBanned(env, payload.name, 'POST /v1/rooms/quick');
      const seated = yield* Rooms.callRoom(() =>
        lobby(env).quick({
          name: payload.name,
          display_name: Rooms.displayNameOf(payload),
        }),
      );
      return seated.is_host
        ? hostAnswer(seated, { visibility: 'public' })
        : joinAnswer(seated);
    }),
);
