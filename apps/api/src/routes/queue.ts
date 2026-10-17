// POST /v1/queue (T12). Joins the lobby group in routes/lobby.ts.
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

export const queue = HttpApiBuilder.handler(CasinoApi, 'lobby', 'queue', () =>
  notImplemented('POST /v1/queue'),
);
