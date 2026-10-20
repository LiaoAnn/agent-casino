// Leaderboard and match records (T07).
import { Effect, Schema } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { apiError } from '../contract/errors';
import { type Lobby, RoomId } from '../contract/schemas';
import { withDb } from '../db/client';
import { getLeaderboard, getMatch, listMatches } from '../db/queries';
import * as Rooms from '../room/client';
import { WorkerEnv } from './env';
import { lobby } from './quick';

const isMatchId = Schema.is(RoomId);

export const ReadHandlers = HttpApiBuilder.group(CasinoApi, 'read', handlers =>
  handlers.handleAll({
    lobby: () =>
      Effect.gen(function* () {
        const env = yield* WorkerEnv;
        return yield* Rooms.callRoom<Lobby, 'unavailable'>(async () => ({
          ok: true as const,
          value: await lobby(env).rooms(),
        }));
      }),
    leaderboard: () =>
      Effect.gen(function* () {
        const env = yield* WorkerEnv;
        return yield* withDb(env.DB, getLeaderboard);
      }),
    matches: ({ query: { before } }) =>
      Effect.gen(function* () {
        const env = yield* WorkerEnv;
        const bad = apiError(
          'invalid_request',
          `before=${before} is not a match_id from this list`,
          'Leave out before for the newest matches, or pass the next value of the previous page',
        );
        if (before !== undefined && !isMatchId(before))
          return yield* Effect.fail(bad);
        const page = yield* withDb(env.DB, db => listMatches(db, before));
        return page ?? (yield* Effect.fail(bad));
      }),
    match: ({ params: { match_id } }) =>
      Effect.gen(function* () {
        const env = yield* WorkerEnv;
        const notFound = apiError(
          'room_not_found',
          `There is no finished match ${match_id}`,
          'Use a match_id from GET /v1/matches; a match appears there once it has ended',
        );
        if (!isMatchId(match_id)) return yield* Effect.fail(notFound);
        const match = yield* withDb(env.DB, db => getMatch(db, match_id));
        return match ?? (yield* Effect.fail(notFound));
      }),
  }),
);
