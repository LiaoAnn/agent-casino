// AdminAuth: `Authorization: Bearer <ADMIN_KEY>`, ADMIN_KEY being a Worker
// secret.
import { Effect, Layer, Redacted } from 'effect';
import { AdminAuth } from '../contract/api';
import { apiError } from '../contract/errors';
import { WorkerEnv } from '../routes/env';

const encoder = new TextEncoder();
const digest = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

// Compares fixed-length digests in constant time, so the response time says
// nothing about how much of the key was right.
const sameKey = async (given: string, expected: string) => {
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

const wrongKey = apiError(
  'invalid_token',
  'Missing or wrong admin key',
  'Send the header "Authorization: Bearer <ADMIN_KEY>" with the admin key of this deployment',
);

export const AdminAuthLive = Layer.effect(
  AdminAuth,
  Effect.gen(function* () {
    const { ADMIN_KEY } = yield* WorkerEnv;
    return {
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          if (!ADMIN_KEY) {
            return yield* Effect.die(new Error('ADMIN_KEY is not set'));
          }
          const ok = yield* Effect.promise(() =>
            sameKey(Redacted.value(credential), ADMIN_KEY),
          );
          if (!ok) return yield* Effect.fail(wrongKey);
          return yield* httpEffect;
        }),
    };
  }),
);
