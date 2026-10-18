// The one place the web gets its data from: GET /v1/leaderboard,
// GET /v1/matches and GET /v1/matches/{match_id} of the api Worker, through
// the contract's typed client. The functions run on the server. Deployed, the
// api is the service binding API (casino-api A13); under `vite dev` it is
// VITE_API_URL, by default the local `wrangler dev` of apps/api. With
// VITE_FAKE_DATA=1 (the Playwright tests) they serve the contract's fake data
// instead.
import { CasinoApi } from '@agent-casino/api/src/contract/api';
import type {
  Leaderboard,
  MatchDetail,
  MatchList,
} from '@agent-casino/api/src/contract/schemas';
import { createServerFn } from '@tanstack/react-start';
import { Effect } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';

const fake = async () =>
  (await import('@agent-casino/api/src/contract/fake')).makeFakeData();

// The base URL only fills in the request; a service binding ignores its host.
const api = async (): Promise<{ fetch: typeof fetch; baseUrl: string }> => {
  if (import.meta.env.DEV) {
    return {
      fetch: globalThis.fetch,
      baseUrl: import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8787',
    };
  }
  const { env } = await import('cloudflare:workers');
  return { fetch: env.API.fetch.bind(env.API), baseUrl: 'https://api' };
};

type ReadClient = HttpApiClient.ForApi<typeof CasinoApi>['read'];

const read = async <A>(
  call: (client: ReadClient) => Effect.Effect<A, unknown>,
): Promise<A> => {
  const { fetch, baseUrl } = await api();
  return Effect.runPromise(
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const client = yield* HttpApiClient.group(CasinoApi, {
        group: 'read',
        httpClient,
        baseUrl,
      });
      return yield* call(client);
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
};

const useFake = import.meta.env.VITE_FAKE_DATA === '1';

export const getLeaderboard = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Leaderboard> =>
    useFake
      ? (await fake()).leaderboard()
      : read(client => client.leaderboard()),
);

// The newest page of finished matches (20).
export const getMatches = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MatchList> =>
    useFake
      ? (await fake()).matches()
      : read(client => client.matches({ query: {} })),
);

// One match with every hand, or null when there is no such match (the API's
// 404).
export const getMatch = createServerFn({ method: 'GET' })
  .validator((matchId: string) => matchId)
  .handler(
    async ({ data: matchId }): Promise<MatchDetail | null> =>
      useFake
        ? ((await fake()).match(matchId) ?? null)
        : read(client =>
            client.match({ params: { match_id: matchId } }).pipe(
              Effect.catchIf(
                error =>
                  (error as { code?: unknown }).code === 'room_not_found',
                () => Effect.succeed(null),
              ),
            ),
          ),
  );
