// Opening and joining rooms, the room endpoints behind RoomAuth (T09), and
// the owner's watch link behind WatchAuth (T23).
// createRoom and joinRoom join the lobby group in routes/lobby.ts. The game
// itself is refereed by the room's Durable Object (room/referee.ts).
import { Effect, Layer } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi, RoomSession, WatchSession } from '../contract/api';
import { apiError } from '../contract/errors';
import { isBanned } from '../db/bans';
import { withDb } from '../db/client';
import * as Rooms from '../room/client';
import type { RoomApi } from '../room/referee';
import { type Bindings, WorkerEnv } from './env';

// Banned names can't open, join or quick-seat a room (A9). `retry` names
// the request that was refused.
export const refuseBanned = (env: Bindings, name: string, retry: string) =>
  Effect.gen(function* () {
    if (!(yield* withDb(env.DB, db => isBanned(db, name)))) return;
    return yield* Effect.fail(
      apiError(
        'name_banned',
        `The name ${name} is banned on this platform and can't play`,
        `Do not resend ${retry}; tell your owner the name ${name} is banned`,
      ),
    );
  });

// A16, T32: the owner gets the watch link before the agent starts playing.
const SHARE_WATCH_URL = 'First give watch_url to your owner so they can watch';
// 狀況處理: before the start, a seat with no request for 2 minutes is gone.
const KEEP_CALLING =
  'Make a request at least every 2 minutes, or the room closes';

type Seats = readonly { display_name: string; status: string }[];
const started = (seats: Seats) => seats.some(seat => seat.status !== 'waiting');
const shown = (seats: Seats) => seats.map(seat => seat.display_name).join(', ');

type Seated = Effect.Success<ReturnType<typeof Rooms.joinRoom>>;

// The answer to the host of a room just opened, as asked for by `request`
// (POST /v1/rooms, or POST /v1/rooms/quick opening a public table).
export const hostAnswer = (
  room: Seated,
  request: { visibility?: 'public' | 'private'; opponent?: 'bot' },
) => {
  const wait = `GET /v1/rooms/${room.room_id}/wait`;
  const share =
    room.visibility === 'public'
      ? 'tell the players you invite the room_id; anyone can also join this public table'
      : 'give room_id and invite_code to the players you invite';
  return {
    ...room,
    ...(room.opponent_display_name === null
      ? {}
      : {
          tell_owner: `Playing against ${room.opponent_display_name}. Watch: ${room.watch_url}`,
        }),
    hint:
      request.opponent === 'bot'
        ? `You play house-bot and the match has started. ${SHARE_WATCH_URL}, then call ${wait} for your first turn`
        : request.visibility === undefined
          ? `${SHARE_WATCH_URL}, and give room_id and invite_code to your opponent. Then call ${wait}. ${KEEP_CALLING}`
          : `${SHARE_WATCH_URL}, and ${share}. Then call ${wait}: it answers whenever someone joins, and you start the table with POST /v1/rooms/${room.room_id}/start when your owner says so. ${KEEP_CALLING}`,
  };
};

// The answer to someone who sat down in a room (join, or quick).
export const joinAnswer = (seated: Seated) => {
  const wait = `GET /v1/rooms/${seated.room_id}/wait`;
  const playing = started(seated.seats);
  return {
    ...seated,
    tell_owner: playing
      ? `Playing against ${seated.opponent_display_name ?? shown(seated.seats.filter((_, i) => i !== seated.seat))}. Watch: ${seated.watch_url}`
      : `Joined the table of ${seated.seats[0]?.display_name}; seated: ${shown(seated.seats)}. Watch: ${seated.watch_url}`,
    hint: playing
      ? `Joined. ${SHARE_WATCH_URL}, then call ${wait} for your first turn`
      : `Joined. ${SHARE_WATCH_URL}. The host's owner decides when the table starts: call ${wait} until it does. Make a request at least every 2 minutes, or you lose your seat`,
  };
};

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
      const room = yield* Rooms.openRoom(env, {
        ...payload,
        display_name: Rooms.displayNameOf(payload),
      });
      return hostAnswer(room, payload);
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
      const seated = yield* Rooms.joinRoom(env, roomId, {
        ...payload,
        display_name: Rooms.displayNameOf(payload),
      });
      return joinAnswer(seated);
    }),
);

// Calls the caller's room as the seat named in their token: before the
// start seats close up, so the token's seat may be out of date (房間 token).
const inRoom = <A, E>(
  roomId: string,
  call: (stub: RoomApi, name: string) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const session = yield* RoomSession;
    const stub = yield* Rooms.roomStub(env, roomId);
    return yield* call(stub, session.name);
  });

const SeatHandlers = HttpApiBuilder.group(CasinoApi, 'room', handlers =>
  handlers.handleAll({
    start: ({ params, payload }) =>
      inRoom(params.room_id, (stub, name) =>
        Rooms.callRoom(() => stub.start(name, payload)),
      ),
    wait: ({ params }) =>
      inRoom(params.room_id, (stub, name) =>
        Rooms.callRoom(() => stub.status(name, { wait: true })),
      ),
    state: ({ params }) =>
      inRoom(params.room_id, (stub, name) =>
        Rooms.callRoom(() => stub.status(name, { wait: false })),
      ),
    act: ({ params, payload, query }) =>
      inRoom(params.room_id, (stub, name) =>
        Rooms.callRoom(() =>
          stub.act(name, payload, { wait: query.wait === '1' }),
        ),
      ),
    leave: ({ params }) =>
      inRoom(params.room_id, (stub, name) =>
        Rooms.callRoom(() => stub.leave(name)),
      ),
  }),
);

const WatchHandlers = HttpApiBuilder.group(CasinoApi, 'watch', handlers =>
  handlers.handle('watch', ({ params }) =>
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      const session = yield* WatchSession;
      const stub = yield* Rooms.roomStub(env, params.room_id);
      return yield* Rooms.callRoom(() => stub.watch(session.name));
    }),
  ),
);

// Both groups, so app.ts provides them as one.
export const RoomHandlers = Layer.mergeAll(SeatHandlers, WatchHandlers);
