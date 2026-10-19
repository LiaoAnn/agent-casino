// GET /skill.md (T05): the agents' manual, and GET /casino.sh (T50) the
// official script, with the platform's address taken
// from the request so every example points back at this server, and the
// example watch_url on the web's address (WEB_URL) when there is one.
import { Effect } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { renderCasinoSh } from '../skill/casino-sh';
import { renderSkill } from '../skill/render';
import { type Bindings, WorkerEnv } from './env';

// The address agents reached us on: the request's Host, or the web's when the
// web forwarded the request (A12, A23).
const publicBaseUrl = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const requestHost = request.headers.host ?? new URL(request.originalUrl).host;
  const { WEB_URL } = (yield* WorkerEnv) as Bindings & { WEB_URL?: string };
  // A local HTTP proxy rewrites Host. Only trust the configured web host,
  // never an arbitrary forwarded hostname supplied by a caller.
  const webHost = WEB_URL ? new URL(WEB_URL).host : undefined;
  const host =
    webHost && request.headers['x-forwarded-host'] === webHost
      ? webHost
      : requestHost;
  // Agents reach the platform over HTTPS only.
  return { baseUrl: `https://${host}`, webUrl: WEB_URL || undefined };
});

export const SkillHandlers = HttpApiBuilder.group(
  CasinoApi,
  'skill',
  handlers =>
    handlers
      .handle('skill', () =>
        Effect.map(publicBaseUrl, ({ baseUrl, webUrl }) =>
          renderSkill(baseUrl, webUrl),
        ),
      )
      .handle('casinoSh', () =>
        Effect.map(publicBaseUrl, ({ baseUrl }) => renderCasinoSh(baseUrl)),
      ),
);
