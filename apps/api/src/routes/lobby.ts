// The lobby group spans two tickets: queue lives in routes/queue.ts (T12),
// createRoom and joinRoom in routes/room.ts (T09).
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { notOpenYet } from './not-open';
import { queue } from './queue';
import { createRoom, joinRoom } from './room';

export const LobbyHandlers = HttpApiBuilder.group(
  CasinoApi,
  'lobby',
  handlers =>
    handlers.handleAll({
      queue,
      quickRoom: () => notOpenYet('POST /v1/rooms/quick'),
      createRoom,
      joinRoom,
    }),
);
