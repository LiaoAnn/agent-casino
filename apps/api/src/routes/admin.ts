// Admin endpoints, behind AdminAuth (T07).
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { apiError } from '../contract/errors';
import { NAME_PATTERN } from '../contract/schemas';
import { banName } from '../db/bans';
import { withDb } from '../db/client';
import { WorkerEnv } from './env';

// Stub until T11 fills in abortRoom.
const notImplemented = (endpoint: string) =>
  Effect.fail(
    apiError(
      'internal',
      `${endpoint} is not implemented yet on this server`,
      'This endpoint is not available yet. Read GET /skill.md for what works now',
    ),
  );

export const AdminHandlers = HttpApiBuilder.group(
  CasinoApi,
  'admin',
  handlers =>
    handlers.handleAll({
      abortRoom: () => notImplemented('POST /v1/admin/rooms/{room_id}/abort'),
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
