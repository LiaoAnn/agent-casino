// The one place the web gets its data from: GET /v1/lobby,
// GET /v1/leaderboard, GET /v1/matches, GET /v1/matches/{match_id} and
// GET /v1/rooms/{room_id}/watch of the api Worker, through
// the contract's typed client. The functions run on the server. Deployed, the
// api is the service binding API (casino-api A13); under `vite dev` it is
// VITE_API_URL, by default the local `wrangler dev` of apps/api. With
// VITE_FAKE_DATA=1 (the Playwright tests) they serve the contract's fake data
// instead.
import { CasinoApi } from '@agent-casino/api/src/contract/api';
import type {
  Leaderboard,
  Lobby,
  MatchDetail,
  MatchList,
  WatchResponse,
} from '@agent-casino/api/src/contract/schemas';
import { createServerFn } from '@tanstack/react-start';
import { getRequestUrl } from '@tanstack/react-start/server';
import { Effect } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
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

// Runs `call` against the api Worker with an HttpClient to it.
const run = async <A>(
  call: (baseUrl: string) => Effect.Effect<A, unknown, HttpClient.HttpClient>,
): Promise<A> => {
  const { fetch, baseUrl } = await api();
  return Effect.runPromise(
    call(baseUrl).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
};

type Client = HttpApiClient.ForApi<typeof CasinoApi>;

const read = <A>(call: (client: Client['read']) => Effect.Effect<A, unknown>) =>
  run(baseUrl =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const client = yield* HttpApiClient.group(CasinoApi, {
        group: 'read',
        httpClient,
        baseUrl,
      });
      return yield* call(client);
    }),
  );

// The watch group, with `Authorization: Bearer <watch token>`.
const watch = <A>(
  token: string,
  call: (client: Client['watch']) => Effect.Effect<A, unknown>,
) =>
  run(baseUrl =>
    Effect.gen(function* () {
      const httpClient = HttpClient.mapRequest(
        yield* HttpClient.HttpClient,
        HttpClientRequest.bearerToken(token),
      );
      const client = yield* HttpApiClient.group(CasinoApi, {
        group: 'watch',
        httpClient,
        baseUrl,
      });
      return yield* call(client);
    }),
  );

const useFake = import.meta.env.VITE_FAKE_DATA === '1';

export const getLeaderboard = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Leaderboard> =>
    useFake
      ? (await fake()).leaderboard()
      : read(client => client.leaderboard()),
);

// The rooms waiting to start, or null while the api has no lobby open
// (its `unavailable`, before T39). The fake lobby is closed for a page
// loaded with `?fake-lobby=closed`.
export const getLobby = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Lobby | null> =>
    useFake
      ? new URL(getRequestUrl()).searchParams.get('fake-lobby') === 'closed'
        ? null
        : (await fake()).table.lobby
      : read(client =>
          client.lobby().pipe(
            Effect.catchIf(
              error => (error as { code?: unknown }).code === 'unavailable',
              () => Effect.succeed(null),
            ),
          ),
        ),
);

// The newest page of finished matches (20). The fake page starts with the
// six-seat table's match.
export const getMatches = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MatchList> => {
    if (!useFake) return read(client => client.matches({ query: {} }));
    const data = await fake();
    const page = data.matches();
    return {
      ...page,
      matches: [data.table.summary, ...page.matches].slice(0, 20),
    };
  },
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

// The test token of the fake heads-up watch links (VITE_FAKE_DATA=1).
const FAKE_WATCH_TOKEN = 'fake-watch-token';
// The six-seat table's room is one room in three states: its token picks
// which, `fake-table-waiting`, `fake-table-playing` or `fake-table-finished`;
// `fake-table-out` is the link of a seat already out while it plays on, and
// `fake-table-cancelled` the host's once it left before anyone joined.
const FAKE_TABLE_TOKEN = 'fake-table-';

// The table in play as the first seat out of it would watch it: no hand of
// its own, and none of the watched seat's notes.
function outSeatWatch(playing: WatchResponse): WatchResponse | undefined {
  const out = playing.seats.find(seat => seat.status === 'out');
  if (out === undefined) return undefined;
  return {
    ...playing,
    seat: out.seat,
    deadline: null,
    view: null,
    hands: playing.hands.map(hand => ({
      ...hand,
      events: hand.events.map(({ note: _, ...event }) => event),
    })),
  };
}

// The waiting table once its host left alone: cancelled, one seat.
function cancelledWatch(waiting: WatchResponse): WatchResponse {
  const host = waiting.seats.slice(0, 1);
  return {
    ...waiting,
    players: waiting.players.slice(0, 1),
    display_names: waiting.display_names.slice(0, 1),
    seats: host,
    seats_open: 5,
    room_status: 'finished',
    match_id: waiting.room_id,
    result: 'cancelled',
    places: null,
    final_stacks: host.map(seat => seat.stack),
    ratings: null,
  };
}

export type WatchData =
  | WatchResponse
  | { error: 'invalid_token' | 'room_not_found' };

// The owner's view of one seat (A16), or why the link shows nothing. POST, so
// the token stays out of the server function's URL.
export const getWatch = createServerFn({ method: 'POST' })
  .validator((input: { roomId: string; token: string }) => input)
  .handler(async ({ data: { roomId, token } }): Promise<WatchData> => {
    // No token, no request: it could only be refused.
    if (token === '') return { error: 'invalid_token' };
    if (useFake) {
      const data = await fake();
      const { playing, finished } = data.watch;
      if (token.startsWith(FAKE_TABLE_TOKEN)) {
        const state = token.slice(FAKE_TABLE_TOKEN.length);
        const table =
          state === 'out'
            ? outSeatWatch(data.table.watch.playing)
            : state === 'cancelled'
              ? cancelledWatch(data.table.watch.waiting)
              : Object.entries(data.table.watch).find(
                  ([key]) => key === state,
                )?.[1];
        if (table === undefined) return { error: 'invalid_token' };
        return table.room_id === roomId ? table : { error: 'room_not_found' };
      }
      if (token !== FAKE_WATCH_TOKEN) return { error: 'invalid_token' };
      return (
        [playing, finished].find(w => w.room_id === roomId) ?? {
          error: 'room_not_found',
        }
      );
    }
    return watch(token, client =>
      client.watch({ params: { room_id: roomId } }).pipe(
        // The refusals the page explains; anything else is an outage.
        Effect.catch(error =>
          'code' in error &&
          (error.code === 'invalid_token' || error.code === 'room_not_found')
            ? Effect.succeed({ error: error.code })
            : Effect.fail(error),
        ),
      ),
    );
  });
