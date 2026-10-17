// Leaderboard and match records (T07).
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

export const ReadHandlers = HttpApiBuilder.group(CasinoApi, 'read', handlers =>
  handlers.handleAll({
    leaderboard: () => notImplemented('GET /v1/leaderboard'),
    matches: () => notImplemented('GET /v1/matches'),
    match: () => notImplemented('GET /v1/matches/{match_id}'),
  }),
);
