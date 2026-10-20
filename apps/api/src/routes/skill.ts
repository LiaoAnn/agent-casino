// GET /skill.md (T05): the agents' manual, GET /casino.sh (T50) the
// official script, and the kit (T51, A24): llms.txt and its skills, with the platform's address taken
// from the request so every example points back at this server, and the
// example watch_url on the web's address (WEB_URL) when there is one.
import { Effect } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { HttpApiBuilder } from 'effect/http-api';
import { CasinoApi } from '../contract/api';
import { renderCasinoSh } from '../skill/casino-sh';
import { renderKitSkill, renderLlmsTxt, renderSkill } from '../skill/render';
import { type Bindings, WorkerEnv } from './env';

// The address agents reached us on: the request's Host, or the web's when the
// web forwarded the request (A12, A23). Also used outside the API (the queue's
// 410), so it takes plain headers.
export const publicBaseUrl = (
  headers: { readonly [key: string]: string | undefined },
  url: string,
  webUrl: string | undefined,
): string => {
  const requestHost = headers.host ?? new URL(url).host;
  // A local HTTP proxy rewrites Host. Only trust the configured web host,
  // never an arbitrary forwarded hostname supplied by a caller.
  const webHost = webUrl ? new URL(webUrl).host : undefined;
  const host =
    webHost && headers['x-forwarded-host'] === webHost ? webHost : requestHost;
  // Agents reach the platform over HTTPS only.
  return `https://${host}`;
};

const requestUrls = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { WEB_URL } = (yield* WorkerEnv) as Bindings & { WEB_URL?: string };
  return {
    baseUrl: publicBaseUrl(request.headers, request.originalUrl, WEB_URL),
    webUrl: WEB_URL || undefined,
  };
});

export const SkillHandlers = HttpApiBuilder.group(
  CasinoApi,
  'skill',
  handlers =>
    handlers
      .handle('skill', () =>
        Effect.map(requestUrls, ({ baseUrl, webUrl }) =>
          renderSkill(baseUrl, webUrl),
        ),
      )
      .handle('casinoSh', () =>
        Effect.map(requestUrls, ({ baseUrl }) => renderCasinoSh(baseUrl)),
      )
      .handle('llms', () =>
        Effect.map(requestUrls, ({ baseUrl }) => renderLlmsTxt(baseUrl)),
      )
      .handle('kitCore', () =>
        Effect.map(requestUrls, ({ baseUrl }) =>
          renderKitSkill('agent-casino', baseUrl),
        ),
      )
      .handle('kitScript', () =>
        Effect.map(requestUrls, ({ baseUrl }) => renderCasinoSh(baseUrl)),
      )
      .handle('kitHoldem', () =>
        Effect.map(requestUrls, ({ baseUrl }) =>
          renderKitSkill('agent-casino-holdem', baseUrl),
        ),
      ),
);
