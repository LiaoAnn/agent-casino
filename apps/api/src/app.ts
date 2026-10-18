// The Worker's request handling: GET /health, then every CasinoApi endpoint.
// Kept free of `cloudflare:workers` imports so it can be unit tested in Node;
// the env (D1, DOs, secrets) comes in from index.ts or a test.
import { Cause, Effect, Exit, Layer, Result, SchemaIssue } from 'effect';
import {
  HttpRouter,
  HttpServer,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http';
import { HttpApiBuilder, HttpApiError } from 'effect/http-api';
import { AdminAuthLive } from './auth/admin';
import { RoomAuthLive } from './auth/room';
import { CasinoApi } from './contract/api';
import { type ApiError, apiError, ERROR_STATUS } from './contract/errors';
import { AdminHandlers } from './routes/admin';
import { type Bindings, WorkerEnv } from './routes/env';
import { LobbyHandlers } from './routes/lobby';
import { ReadHandlers } from './routes/read';
import { RoomHandlers } from './routes/room';
import { SkillHandlers } from './routes/skill';

const errorResponse = (error: ApiError) =>
  HttpServerResponse.jsonUnsafe(error, { status: ERROR_STATUS[error.code] });

const READ_THE_SKILL = 'Read GET /skill.md for the endpoints and examples';

// A17: a queue_key that is missing or not a string.
const QUEUE_KEY_HINT =
  'Make one queue_key once with `openssl rand -hex 16`, save it, and send the same one on every POST /v1/queue';

// A19: `settings.hands` from before the freezeout format.
const HANDS_HINT =
  'Remove settings.hands: a match now runs until one player has no chips, with blinds doubling every blind_every hands. To cap its length, send settings.max_hands instead';

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

const INPUT_KINDS: Record<string, string> = {
  Params: 'path',
  Query: 'query string',
  Headers: 'headers',
  Payload: 'JSON body',
};

// What Effect answers on its own for a failed request (unknown route, decode
// error, defect), as the contract's error body (casino-api skill: 錯誤格式,
// A4, A15).
const contractError = (cause: Cause.Cause<unknown>, route: string) => {
  const error = Result.getOrUndefined(Cause.findError(cause));
  if (
    HttpServerError.isHttpServerError(error) &&
    error.reason._tag === 'RouteNotFound'
  ) {
    return errorResponse(
      apiError(
        'not_found',
        `There is no endpoint ${route}`,
        `Check the method and path. ${READ_THE_SKILL}`,
      ),
    );
  }

  const defect = Result.getOrUndefined(Cause.findDefect(cause));
  const kind = HttpApiError.HttpApiSchemaError.is(defect)
    ? INPUT_KINDS[defect.kind]
    : undefined;
  if (HttpApiError.HttpApiSchemaError.is(defect) && kind) {
    const { issues } = formatIssue(defect.cause.issue);
    const lines = issues.map(({ path, message }) =>
      path?.length ? `${path.join('.')}: ${message}` : message,
    );
    return errorResponse(
      apiError(
        'invalid_request',
        `Invalid ${kind} for ${route}: ${lines.join('; ')}`,
        issues.some(({ path }) => path?.[0] === 'queue_key')
          ? QUEUE_KEY_HINT
          : issues.some(
                ({ path }) => path?.[0] === 'settings' && path[1] === 'hands',
              )
            ? HANDS_HINT
            : `Fix the ${kind} and resend. ${READ_THE_SKILL}`,
      ),
    );
  }

  return undefined;
};

const ContractErrors = HttpRouter.middleware(
  httpEffect =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const route = `${request.method} ${request.url.split('?')[0]}`;
      const exit = yield* Effect.exit(httpEffect);
      if (Exit.isSuccess(exit)) {
        if (exit.value.status !== 415) return exit.value;
        // Effect's own answer to a body that isn't JSON, e.g. `curl -d`
        // without a Content-Type header.
        return errorResponse(
          apiError(
            'invalid_request',
            `${route} takes a JSON body`,
            "Send the header \"Content-Type: application/json\" with the body (curl -H 'Content-Type: application/json' -d '{...}')",
          ),
        );
      }
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* exit;
      const response = contractError(exit.cause, route);
      if (response) return response;
      yield* Effect.logError(`${route} failed`, exit.cause);
      return errorResponse(
        apiError(
          'internal',
          `The server failed while handling ${route}`,
          'This is a bug on the server, not in your request. Try again later',
        ),
      );
    }),
  { global: true },
);

const ApiLive = HttpApiBuilder.layer(CasinoApi).pipe(
  Layer.provide([
    SkillHandlers,
    LobbyHandlers,
    RoomHandlers,
    ReadHandlers,
    AdminHandlers,
  ]),
  Layer.provide([RoomAuthLive, AdminAuthLive]),
  Layer.provide(ContractErrors),
  Layer.provide(HttpServer.layerServices),
);

type WebHandler = (request: Request) => Promise<Response>;

// One web handler per env: a Worker isolate keeps the same env object, so the
// API is built once and reused across requests.
const handlers = new WeakMap<Bindings, WebHandler>();

const webHandler = (env: Bindings): WebHandler => {
  let handler = handlers.get(env);
  if (!handler) {
    handler = HttpRouter.toWebHandler(
      ApiLive.pipe(Layer.provideMerge(Layer.succeed(WorkerEnv, env))),
      { disableLogger: true },
    ).handler;
    handlers.set(env, handler);
  }
  return handler;
};

export function handle(request: Request, env: Bindings): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === 'GET' && pathname === '/health') {
    return Promise.resolve(Response.json({ ok: true }));
  }
  return webHandler(env)(request);
}
