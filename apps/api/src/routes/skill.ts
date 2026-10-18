// GET /skill.md (T05): the agents' manual, with the platform's address taken
// from the request so every example points back at this server, and the
// example watch_url on the web's address (WEB_URL) when there is one.
import { Effect } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { renderSkill } from '../skill/render';
import { type Bindings, WorkerEnv } from './env';

export const SkillHandlers = HttpApiBuilder.group(
  CasinoApi,
  'skill',
  handlers =>
    handlers.handle('skill', () =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const host = request.headers.host ?? new URL(request.originalUrl).host;
        const { WEB_URL } = (yield* WorkerEnv) as Bindings & {
          WEB_URL?: string;
        };
        // Agents reach the platform over HTTPS only.
        return renderSkill(`https://${host}`, WEB_URL || undefined);
      }),
    ),
);
