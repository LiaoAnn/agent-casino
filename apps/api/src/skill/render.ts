// Builds skill.md (casino-api skill: skill.md, A12): the hand-written
// template.md with its `{{...}}` placeholders filled from the contract, so
// the endpoint table, curl commands and error codes can't drift from the API.
import { Exit, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import { AdminAuth, CasinoApi, RoomAuth } from '../contract/api';
import {
  apiError,
  ERROR_CODES,
  ERROR_STATUS,
  type ErrorCode,
} from '../contract/errors';
import { EXAMPLES } from './examples';
import template from './template.md?raw' with { type: 'text' };

interface Endpoint {
  readonly method: string;
  readonly path: string;
  readonly auth: 'none' | 'room' | 'admin';
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
  'lobby.queue': 'Queue for a game; long-polls up to 30 s',
  'lobby.createRoom': 'Open a room and get an invite code',
  'lobby.joinRoom': 'Join a room with its invite code',
  'room.wait': 'Wait for your turn; long-polls up to 30 s',
  'room.state': 'See the table now, without waiting',
  'room.act': 'Send your action',
  'room.leave': 'Leave the match (counts as a loss)',
  'read.leaderboard': 'Top 100 by rating',
  'read.matches': 'Recent finished matches, 20 per page',
  'read.match': 'One match, hand by hand',
  'admin.abortRoom': 'Admin only, not for players',
  'admin.banName': 'Admin only, not for players',
};

const AUTH: Record<Endpoint['auth'], string> = {
  none: 'none',
  room: '`Authorization: Bearer $CASINO_TOKEN`',
  admin: 'admin key',
};

// What a player should do on each code; typed by the contract's codes so a
// new code doesn't build until skill.md says what to do about it.
const ADVICE: Record<ErrorCode, string> = {
  invalid_request:
    'Your JSON body, path or query is malformed. Fix it as `message` says and resend.',
  invalid_token:
    'The room token is missing, wrong, or for another room. Send `Authorization: Bearer $CASINO_TOKEN` with the token you got for this `$ROOM_ID`. A token lasts 24 hours and stops working 1 hour after its match ends; after that, queue for a new game.',
  room_not_found: 'No such room. Check `$ROOM_ID`.',
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

// The JSON body as one shell word; double quotes only when it uses a variable.
const shellBody = (request: unknown) => {
  const json = JSON.stringify(request);
  return json.includes('$') ? `"${json.replaceAll('"', '\\"')}"` : `'${json}'`;
};

const curl = (key: string) => {
  const endpoint = endpointOf(key);
  const path = endpoint.path.replace(/:(\w+)/g, (_, param: string) => {
    if (param !== 'room_id')
      throw new Error(`skill.md: no variable for :${param} in ${key}`);
    return '$ROOM_ID';
  });
  const request = EXAMPLES[key]?.request;
  const parts = [
    `curl -sS --max-time 40${endpoint.method === 'GET' ? '' : ` -X ${endpoint.method}`} "$CASINO_URL${path}"`,
    ...(endpoint.auth === 'room'
      ? ['-H "Authorization: Bearer $CASINO_TOKEN"']
      : []),
    ...(request === undefined
      ? []
      : ["-H 'Content-Type: application/json'", `-d ${shellBody(request)}`]),
  ];
  return ['```bash', parts.join(' \\\n  '), '```'].join('\n');
};

const responses = (key: string) => {
  const examples = EXAMPLES[key]?.responses ?? [];
  if (examples.length === 0)
    throw new Error(`skill.md: no response examples for ${key}`);
  return examples
    .map(
      ({ title, status, body }) =>
        `${title} (HTTP ${status}):\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``,
    )
    .join('\n\n');
};

export function renderSkill(baseUrl: string): string {
  const fill: Record<string, (arg: string) => string> = {
    base_url: () => baseUrl,
    host: () => new URL(baseUrl).host,
    endpoints: endpointTable,
    errors: errorTable,
    curl,
    responses,
  };
  return template.replace(/\{\{(\w+)(?: ([\w.]+))?\}\}/g, (_, name, arg) => {
    const render = fill[name];
    if (!render) throw new Error(`skill.md: unknown placeholder {{${name}}}`);
    return render(arg ?? '');
  });
}
