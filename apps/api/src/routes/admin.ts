// Admin endpoints, behind AdminAuth (T07).
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { apiError } from '../contract/errors';

// Stub until the ticket above fills it in.
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
      banName: () => notImplemented('POST /v1/admin/names/{name}/ban'),
    }),
);
