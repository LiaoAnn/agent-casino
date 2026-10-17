// RoomAuth: checks the room token's signature, expiry and room (casino-api
// skill: 房間 token, A8). Refusing tokens of rooms that ended over an hour ago
// is the Room DO's job.
import { Clock, Effect, Layer, Redacted } from 'effect';
import { HttpRouter } from 'effect/http';
import { RoomAuth, RoomSession } from '../contract/api';
import { WorkerEnv } from '../routes/env';
import { tokenRejectionError, verifyRoomToken } from '../token/token';

export const RoomAuthLive = Layer.effect(
  RoomAuth,
  Effect.gen(function* () {
    const { TOKEN_SECRET } = yield* WorkerEnv;
    return {
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          if (!TOKEN_SECRET) {
            return yield* Effect.die(new Error('TOKEN_SECRET is not set'));
          }
          const params = yield* HttpRouter.params;
          const nowMs = yield* Clock.currentTimeMillis;
          const result = yield* Effect.promise(() =>
            verifyRoomToken(
              Redacted.value(credential),
              TOKEN_SECRET,
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
