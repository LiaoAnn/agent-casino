// The lobby group: quickRoom in routes/quick.ts (T39), createRoom and
// joinRoom in routes/room.ts (T09).
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { quickRoom } from './quick';
import { createRoom, joinRoom } from './room';

export const LobbyHandlers = HttpApiBuilder.group(
  CasinoApi,
  'lobby',
  handlers => handlers.handleAll({ quickRoom, createRoom, joinRoom }),
);
