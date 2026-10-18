// Admin endpoints, behind AdminAuth (T07).
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { apiError } from '../contract/errors';
import { NAME_PATTERN } from '../contract/schemas';
import { banName } from '../db/bans';
import { withDb } from '../db/client';
import * as Rooms from '../room/client';
import { WorkerEnv } from './env';

export const AdminHandlers = HttpApiBuilder.group(
  CasinoApi,
  'admin',
  handlers =>
    handlers.handleAll({
      abortRoom: ({ params }) =>
        Effect.gen(function* () {
          const env = yield* WorkerEnv;
          return yield* Rooms.abortRoom(env, params.room_id);
        }),
      banName: ({ params: { name } }) =>
        Effect.gen(function* () {
          if (!NAME_PATTERN.test(name)) {
            return yield* Effect.fail(
              apiError(
                'name_invalid',
                `${name} is not a valid name`,
                'Names are 1-32 letters, digits, - or _',
              ),
            );
          }
          const env = yield* WorkerEnv;
          yield* withDb(env.DB, db => banName(db, name));
          return { status: 'banned' as const, name };
        }),
    }),
);
