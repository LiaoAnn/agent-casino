// RoomAuth: checks the room token's signature, expiry and room (casino-api
// skill: 房間 token, A8). Refusing tokens of rooms that ended over an hour ago
// is the Room DO's job. WatchAuth: the same for the watch token of the
// owner's link (A16), which never expires.
import { Clock, Effect, Layer, Redacted } from 'effect';
import { HttpRouter } from 'effect/http';
import {
  RoomAuth,
  RoomSession,
  WatchAuth,
  WatchSession,
} from '../contract/api';
import { type Bindings, WorkerEnv } from '../routes/env';
import {
  tokenRejectionError,
  verifyRoomToken,
  verifyWatchToken,
  watchRejectionError,
} from '../token/token';

// The secret, or a defect: without it no token can be checked.
const tokenSecret = ({ TOKEN_SECRET }: Bindings) =>
  TOKEN_SECRET
    ? Effect.succeed(TOKEN_SECRET)
    : Effect.die(new Error('TOKEN_SECRET is not set'));

const roomAuth = Layer.effect(
  RoomAuth,
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    return {
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const secret = yield* tokenSecret(env);
          const params = yield* HttpRouter.params;
          const nowMs = yield* Clock.currentTimeMillis;
          const result = yield* Effect.promise(() =>
            verifyRoomToken(
              Redacted.value(credential),
              secret,
              params.room_id ?? '',
              nowMs,
            ),
          );
          if (!result.ok) {
            return yield* Effect.fail(tokenRejectionError(result.reason));
          }
          return yield* Effect.provideService(
            httpEffect,
            RoomSession,
            result.claims,
          );
        }),
    };
  }),
);

const watchAuth = Layer.effect(
  WatchAuth,
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    return {
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const secret = yield* tokenSecret(env);
          const params = yield* HttpRouter.params;
          const result = yield* Effect.promise(() =>
            verifyWatchToken(
              Redacted.value(credential),
              secret,
              params.room_id ?? '',
            ),
          );
          if (!result.ok) {
            return yield* Effect.fail(watchRejectionError(result.reason));
          }
          return yield* Effect.provideService(
            httpEffect,
            WatchSession,
            result.claims,
          );
        }),
    };
  }),
);

// Both, so app.ts provides them as one.
export const RoomAuthLive = Layer.mergeAll(roomAuth, watchAuth);
