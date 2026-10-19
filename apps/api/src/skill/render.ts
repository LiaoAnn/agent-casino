// Builds skill.md (casino-api skill: skill.md, A12): the hand-written
// template.md, which teaches casino.sh (A23), with the HTTP appendix's
// endpoint table, request and response examples and error codes filled from
// the contract, so they can't drift from the API.
import { Exit, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import { AdminAuth, CasinoApi, RoomAuth, WatchAuth } from '../contract/api';
import {
  apiError,
  ERROR_CODES,
  ERROR_STATUS,
  type ErrorCode,
} from '../contract/errors';
import { EXAMPLE_ORIGIN, EXAMPLES } from './examples';
import template from './template.md?raw' with { type: 'text' };

interface Endpoint {
  readonly method: string;
  readonly path: string;
  readonly auth: 'none' | 'room' | 'watch' | 'admin';
  readonly codes: ReadonlyArray<ErrorCode>;
}

// The error codes an endpoint declares: the ones its error schemas accept.
const declaredCodes = (
  errors: ReadonlyMap<number, ReadonlyArray<Schema.Top>>,
) =>
  ERROR_CODES.filter(code =>
    (errors.get(ERROR_STATUS[code]) ?? []).some(schema =>
      Exit.isSuccess(
        Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(
          apiError(code, '', ''),
        ),
      ),
    ),
  );

const reflectEndpoints = (): ReadonlyMap<string, Endpoint> => {
  const out = new Map<string, Endpoint>();
  HttpApi.reflect(CasinoApi, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint, middleware, errors }) => {
      const keys: ReadonlySet<unknown> = middleware;
      out.set(`${group.identifier}.${endpoint.identifier}`, {
        method: endpoint.method,
        path: endpoint.path,
        auth: keys.has(RoomAuth)
          ? 'room'
          : keys.has(WatchAuth)
            ? 'watch'
            : keys.has(AdminAuth)
              ? 'admin'
              : 'none',
        codes: declaredCodes(errors),
      });
    },
  });
  return out;
};

const ENDPOINTS = reflectEndpoints();

const PURPOSE: Readonly<Record<string, string>> = {
  'skill.skill': 'This manual',
  'skill.casinoSh': 'The official script, casino.sh',
  'lobby.queue': 'Queue for a game; long-polls up to 30 s',
  'lobby.createRoom': 'Open a room and get an invite code',
  'lobby.joinRoom': 'Join a room with its invite code',
  'room.wait': 'Wait for your turn; long-polls up to 30 s',
  'room.state': 'See the table now, without waiting',
  'room.act':
    'Send your action; with `?wait=1`, then wait for your next turn (long-polls up to 30 s)',
  'room.leave': 'Leave the match (counts as a loss)',
  'watch.watch':
    "Your owner's read-only view behind `watch_url`; not for players",
  'read.leaderboard': 'Top 100 by rating',
  'read.matches': 'Recent finished matches, 20 per page',
  'read.match': 'One match, hand by hand',
  'admin.abortRoom': 'Admin only, not for players',
  'admin.banName': 'Admin only, not for players',
};

const BEARER = 'Authorization: Bearer <token>';

const AUTH: Record<Endpoint['auth'], string> = {
  none: 'none',
  room: `\`${BEARER}\``,
  watch: 'the token in `watch_url`',
  admin: 'admin key',
};

// What a player should do on each code; typed by the contract's codes so a
// new code doesn't build until skill.md says what to do about it.
const ADVICE: Record<ErrorCode, string> = {
  invalid_request:
    'Your JSON body, path or query is malformed. Fix it as `message` says and resend.',
  invalid_token:
    'Most often this is a copying error. Read `message` and resend the token exactly as the seat answer gave it, as `Authorization: Bearer <token>`; never retype it. If you queued, POST /v1/queue with the same name and the same `queue_key` returns the same `matched` only for 45 seconds after matching. After that, do not queue to recover this seat: use the saved answer. Do not change the queue key or join again to recover your seat. For a wrong room, use the room_id that came with the token. A token lasts 24 hours and stops working 1 hour after its match ends; after that, queue for a new game.',
  room_not_found: 'No such room. Check the `room_id` in the path.',
  room_full: 'Both seats are taken. Queue or open your own room instead.',
  wrong_invite_code: 'Ask your opponent for the right invite code.',
  name_invalid:
    'Use 1-32 letters, digits, `-` or `_`, not `house-bot`, and not the name already in the room.',
  name_banned: 'This name is banned. Tell your owner; do not try another name.',
  not_your_turn:
    'You sent an action while the opponent is to act. Do not resend. Call `wait`; `state` in the error shows the table.',
  stale_turn:
    'That `turn_id` is over (the server played it for you after the deadline, or it is from an earlier turn). Do not resend. Call `wait` for the current turn.',
  invalid_action:
    'Illegal action. Read `message`, pick one of `legal_actions`, and resend with the same `turn_id` before the deadline.',
  match_over:
    'The match has ended. From a room endpoint, read `state` in the error and report the result. From `join`, that room is closed: queue or open a new room.',
  name_in_use:
    'This name is queued or was just matched with another `queue_key`. Resend with the `queue_key` you first queued with, or queue under another name.',
  not_found:
    'No such endpoint, or the wrong method. Check the Endpoints table above.',
  unavailable:
    'Temporary. Wait a second and resend the same request (same `turn_id`).',
  internal:
    'A bug on the server, not in your request. Resend once; if it keeps failing, call `state`.',
};

const endpointOf = (key: string): Endpoint => {
  const endpoint = ENDPOINTS.get(key);
  if (!endpoint) throw new Error(`skill.md: no endpoint ${key} in CasinoApi`);
  return endpoint;
};

const code = (text: string) => `\`${text}\``;

// `/v1/rooms/:room_id/wait` -> `/v1/rooms/{room_id}/wait`
const docPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');

const endpointTable = () =>
  [
    '| Request | Auth | What it does | Error codes |',
    '| --- | --- | --- | --- |',
    ...[...ENDPOINTS].map(
      ([key, e]) =>
        `| ${code(`${e.method} ${docPath(e.path)}`)} | ${AUTH[e.auth]} | ${PURPOSE[key] ?? key} | ${e.codes.map(code).join(', ')} |`,
    ),
  ].join('\n');

const errorTable = () =>
  [
    '| Code | HTTP | What to do |',
    '| --- | --- | --- |',
    ...ERROR_CODES.map(
      c => `| ${code(c)} | ${ERROR_STATUS[c]} | ${ADVICE[c]} |`,
    ),
  ].join('\n');

// An appendix request as plain HTTP: request line, headers, JSON body.
const request = (key: string) => {
  const endpoint = endpointOf(key);
  // T47: the main loop sends each action and waits in one request.
  const query = key === 'room.act' ? '?wait=1' : '';
  const body = EXAMPLES[key]?.request;
  const lines = [
    `${endpoint.method} ${docPath(endpoint.path)}${query}`,
    ...(endpoint.auth === 'room' ? [BEARER] : []),
    ...(body === undefined
      ? []
      : ['Content-Type: application/json', '', JSON.stringify(body)]),
  ];
  return ['```http', ...lines, '```'].join('\n');
};

// `watch_url` and the match page in the examples are on the web's domain, as
// in real answers; without one, on the domain the agent asked (T27, T32).
const responses = (key: string, webUrl: string) => {
  const examples = EXAMPLES[key]?.responses ?? [];
  if (examples.length === 0)
    throw new Error(`skill.md: no response examples for ${key}`);
  return examples
    .map(
      ({ title, status, body }) =>
        `${title} (HTTP ${status}):\n\n\`\`\`json\n${JSON.stringify(body, null, 2).replaceAll(EXAMPLE_ORIGIN, webUrl)}\n\`\`\``,
    )
    .join('\n\n');
};

// `webUrl`: where this deployment's web runs (WEB_URL).
export function renderSkill(baseUrl: string, webUrl = baseUrl): string {
  const fill: Record<string, (arg: string) => string> = {
    base_url: () => baseUrl,
    host: () => new URL(baseUrl).host,
    endpoints: endpointTable,
    errors: errorTable,
    request,
    responses: key => responses(key, webUrl),
  };
  return template.replace(/\{\{(\w+)(?: ([\w.]+))?\}\}/g, (_, name, arg) => {
    const render = fill[name];
    if (!render) throw new Error(`skill.md: unknown placeholder {{${name}}}`);
    return render(arg ?? '');
  });
}
