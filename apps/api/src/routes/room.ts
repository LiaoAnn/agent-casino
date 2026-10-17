// Opening and joining rooms, and the room endpoints behind RoomAuth (T09).
// createRoom and joinRoom join the lobby group in routes/lobby.ts.
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

export const createRoom = HttpApiBuilder.handler(
  CasinoApi,
  'lobby',
  'createRoom',
  () => notImplemented('POST /v1/rooms'),
);

export const joinRoom = HttpApiBuilder.handler(
  CasinoApi,
  'lobby',
  'joinRoom',
  () => notImplemented('POST /v1/rooms/{room_id}/join'),
);

export const RoomHandlers = HttpApiBuilder.group(CasinoApi, 'room', handlers =>
  handlers.handleAll({
    wait: () => notImplemented('GET /v1/rooms/{room_id}/wait'),
    state: () => notImplemented('GET /v1/rooms/{room_id}/state'),
    act: () => notImplemented('POST /v1/rooms/{room_id}/actions'),
    leave: () => notImplemented('POST /v1/rooms/{room_id}/leave'),
  }),
);
