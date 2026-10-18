// Opening and joining rooms, and the room endpoints behind RoomAuth (T09).
// createRoom and joinRoom join the lobby group in routes/lobby.ts. The game
// itself is refereed by the room's Durable Object (room/referee.ts).
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi, RoomSession } from '../contract/api';
import { apiError } from '../contract/errors';
import * as Rooms from '../room/client';
import type { RoomApi } from '../room/referee';
import { WorkerEnv } from './env';
import { refuseBanned } from './queue';

export const createRoom = HttpApiBuilder.handler(
  CasinoApi,
  'lobby',
  'createRoom',
  ({ payload }) =>
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      const badName = Rooms.nameError(payload.name, 'POST /v1/rooms');
      if (badName) return yield* Effect.fail(badName);
      yield* refuseBanned(env, payload.name, 'POST /v1/rooms');
      if (payload.opponent === 'bot') {
        return yield* Effect.fail(
          apiError(
            'invalid_request',
            'Playing against the house bot is not available yet',
            'Leave out "opponent" and give room_id and invite_code to another player',
          ),
        );
      }
      const room = yield* Rooms.openRoom(env, payload);
      return {
        ...room,
        hint: `Give room_id and invite_code to your opponent, then call GET /v1/rooms/${room.room_id}/wait`,
      };
    }),
);

export const joinRoom = HttpApiBuilder.handler(
  CasinoApi,
  'lobby',
  'joinRoom',
  ({ params, payload }) =>
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      const roomId = params.room_id;
      const badName = Rooms.nameError(
        payload.name,
        `POST /v1/rooms/${roomId}/join`,
      );
      if (badName) return yield* Effect.fail(badName);
      yield* refuseBanned(env, payload.name, `POST /v1/rooms/${roomId}/join`);
      const seated = yield* Rooms.joinRoom(env, roomId, payload);
      return {
        ...seated,
        hint: `Joined. Call GET /v1/rooms/${roomId}/wait for your first turn`,
      };
    }),
);

// Calls the caller's room with the seat from their token.
const inRoom = <A, E>(
  roomId: string,
  call: (stub: RoomApi, seat: 0 | 1) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* RoomSession;
    const stub = yield* Rooms.roomStub(env, roomId);
    return yield* call(stub, session.seat);
  });

export const RoomHandlers = HttpApiBuilder.group(CasinoApi, 'room', handlers =>
  handlers.handleAll({
    wait: ({ params }) =>
      inRoom(params.room_id, (stub, seat) =>
        Rooms.callRoom(() => stub.status(seat, { wait: true })),
      ),
    state: ({ params }) =>
      inRoom(params.room_id, (stub, seat) =>
        Rooms.callRoom(() => stub.status(seat, { wait: false })),
      ),
    act: ({ params, payload }) =>
      inRoom(params.room_id, (stub, seat) =>
        Rooms.callRoom(() => stub.act(seat, payload)),
      ),
    leave: ({ params }) =>
      inRoom(params.room_id, (stub, seat) =>
        Rooms.callRoom(() => stub.leave(seat)),
      ),
  }),
);
