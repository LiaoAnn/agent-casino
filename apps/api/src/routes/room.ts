// Opening and joining rooms, the room endpoints behind RoomAuth (T09), and
// the owner's watch link behind WatchAuth (T23).
// createRoom and joinRoom join the lobby group in routes/lobby.ts. The game
// itself is refereed by the room's Durable Object (room/referee.ts).
import { Effect, Layer } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi, RoomSession, WatchSession } from '../contract/api';
import * as Rooms from '../room/client';
import type { RoomApi } from '../room/referee';
import { WorkerEnv } from './env';
import { refuseBanned } from './queue';

// A16, T32: the owner gets the watch link before the agent starts playing.
const SHARE_WATCH_URL = 'First give watch_url to your owner so they can watch';

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
      const room = yield* Rooms.openRoom(env, payload);
      const wait = `GET /v1/rooms/${room.room_id}/wait`;
      return {
        ...room,
        hint:
          payload.opponent === 'bot'
            ? `You play house-bot and the match has started. ${SHARE_WATCH_URL}, then call ${wait} for your first turn`
            : `${SHARE_WATCH_URL}, and give room_id and invite_code to your opponent. Then call ${wait}. If nobody joins within 5 minutes, the room is cancelled`,
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
        hint: `Joined. ${SHARE_WATCH_URL}, then call GET /v1/rooms/${roomId}/wait for your first turn`,
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

const SeatHandlers = HttpApiBuilder.group(CasinoApi, 'room', handlers =>
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

const WatchHandlers = HttpApiBuilder.group(CasinoApi, 'watch', handlers =>
  handlers.handle('watch', ({ params }) =>
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      const session = yield* WatchSession;
      const stub = yield* Rooms.roomStub(env, params.room_id);
      return yield* Rooms.callRoom(() => stub.watch(session.seat));
    }),
  ),
);

// Both groups, so app.ts provides them as one.
export const RoomHandlers = Layer.mergeAll(SeatHandlers, WatchHandlers);
