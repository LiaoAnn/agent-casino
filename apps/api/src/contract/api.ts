// Every endpoint of the platform (casino-api skill: 端點). Handlers live in
// routes/ and the DOs; skill.md and the web client are derived from this.
import { Context, Schema } from 'effect';
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from 'effect/http-api';
import type { RoomTokenClaims, WatchTokenClaims } from '../token/token';
import { apiErrors } from './errors';
import {
  AbortResponse,
  ActionAccepted,
  ActionRequest,
  BanResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRequest,
  JoinResponse,
  Leaderboard,
  MatchDetail,
  MatchList,
  MatchOver,
  QueueRequest,
  QueueResponse,
  RoomStatus,
  WatchResponse,
} from './schemas';

// The verified claims of the caller's room token.
export class RoomSession extends Context.Service<
  RoomSession,
  RoomTokenClaims
>()('agent-casino/RoomSession') {}

// `Authorization: Bearer <room token>`; checked with token/verifyRoomToken.
export class RoomAuth extends HttpApiMiddleware.Service<
  RoomAuth,
  { provides: RoomSession }
>()('agent-casino/RoomAuth', {
  security: { bearer: HttpApiSecurity.bearer },
  error: apiErrors('invalid_token'),
}) {}

// The verified claims of the caller's watch token (A16).
export class WatchSession extends Context.Service<
  WatchSession,
  WatchTokenClaims
>()('agent-casino/WatchSession') {}

// `Authorization: Bearer <watch token>`; checked with token/verifyWatchToken.
// Room tokens are refused here, and watch tokens by RoomAuth.
export class WatchAuth extends HttpApiMiddleware.Service<
  WatchAuth,
  { provides: WatchSession }
>()('agent-casino/WatchAuth', {
  security: { bearer: HttpApiSecurity.bearer },
  error: apiErrors('invalid_token'),
}) {}

// `Authorization: Bearer <ADMIN_KEY>`.
export class AdminAuth extends HttpApiMiddleware.Service<AdminAuth>()(
  'agent-casino/AdminAuth',
  {
    security: { bearer: HttpApiSecurity.bearer },
    error: apiErrors('invalid_token'),
  },
) {}

const roomParams = { room_id: Schema.String };

const SkillGroup = HttpApiGroup.make('skill').add(
  HttpApiEndpoint.get('skill', '/skill.md', {
    success: Schema.String.pipe(
      HttpApiSchema.asText({ contentType: 'text/markdown' }),
    ),
    error: apiErrors('unavailable', 'internal'),
  }),
  // The official script (A23); text/plain so a browser shows it too.
  HttpApiEndpoint.get('casinoSh', '/casino.sh', {
    success: Schema.String.pipe(
      HttpApiSchema.asText({ contentType: 'text/plain; charset=utf-8' }),
    ),
    error: apiErrors('unavailable', 'internal'),
  }),
  // The kit (A24): the llms.txt entry and the files it installs, each at the
  // path it is installed to.
  HttpApiEndpoint.get('llms', '/llms.txt', {
    success: Schema.String.pipe(
      HttpApiSchema.asText({ contentType: 'text/plain; charset=utf-8' }),
    ),
    error: apiErrors('unavailable', 'internal'),
  }),
  HttpApiEndpoint.get('kitCore', '/skills/agent-casino/SKILL.md', {
    success: Schema.String.pipe(
      HttpApiSchema.asText({ contentType: 'text/markdown' }),
    ),
    error: apiErrors('unavailable', 'internal'),
  }),
  HttpApiEndpoint.get('kitScript', '/skills/agent-casino/scripts/casino.sh', {
    success: Schema.String.pipe(
      HttpApiSchema.asText({ contentType: 'text/plain; charset=utf-8' }),
    ),
    error: apiErrors('unavailable', 'internal'),
  }),
  HttpApiEndpoint.get('kitHoldem', '/skills/agent-casino-holdem/SKILL.md', {
    success: Schema.String.pipe(
      HttpApiSchema.asText({ contentType: 'text/markdown' }),
    ),
    error: apiErrors('unavailable', 'internal'),
  }),
);

const LobbyGroup = HttpApiGroup.make('lobby').add(
  HttpApiEndpoint.post('queue', '/v1/queue', {
    payload: QueueRequest,
    success: QueueResponse,
    error: apiErrors(
      'invalid_request',
      'name_invalid',
      'name_banned',
      'name_in_use',
      'unavailable',
      'internal',
    ),
  }),
  HttpApiEndpoint.post('createRoom', '/v1/rooms', {
    payload: CreateRoomRequest,
    success: CreateRoomResponse,
    error: apiErrors(
      'invalid_request',
      'name_invalid',
      'name_banned',
      'unavailable',
      'internal',
    ),
  }),
  HttpApiEndpoint.post('joinRoom', '/v1/rooms/:room_id/join', {
    params: roomParams,
    payload: JoinRequest,
    success: JoinResponse,
    error: apiErrors(
      'invalid_request',
      'name_invalid',
      'name_banned',
      'room_not_found',
      'wrong_invite_code',
      'room_full',
      'match_over',
      'unavailable',
      'internal',
    ),
  }),
);

const RoomGroup = HttpApiGroup.make('room')
  .add(
    HttpApiEndpoint.get('wait', '/v1/rooms/:room_id/wait', {
      params: roomParams,
      success: RoomStatus,
      error: apiErrors('room_not_found', 'unavailable', 'internal'),
    }),
    HttpApiEndpoint.get('state', '/v1/rooms/:room_id/state', {
      params: roomParams,
      success: RoomStatus,
      error: apiErrors('room_not_found', 'unavailable', 'internal'),
    }),
    // T47: `?wait=1` answers what `wait` would after an accepted action.
    HttpApiEndpoint.post('act', '/v1/rooms/:room_id/actions', {
      params: roomParams,
      query: { wait: Schema.optional(Schema.Literal('1')) },
      payload: ActionRequest,
      success: Schema.Union([ActionAccepted, RoomStatus]),
      error: apiErrors(
        'invalid_request',
        'room_not_found',
        'not_your_turn',
        'stale_turn',
        'invalid_action',
        'match_over',
        'unavailable',
        'internal',
      ),
    }),
    HttpApiEndpoint.post('leave', '/v1/rooms/:room_id/leave', {
      params: roomParams,
      success: MatchOver,
      error: apiErrors(
        'room_not_found',
        'match_over',
        'unavailable',
        'internal',
      ),
    }),
  )
  .middleware(RoomAuth);

// The owner's read-only view of one seat; answers at once (A16).
const WatchGroup = HttpApiGroup.make('watch')
  .add(
    HttpApiEndpoint.get('watch', '/v1/rooms/:room_id/watch', {
      params: roomParams,
      success: WatchResponse,
      error: apiErrors('room_not_found', 'unavailable', 'internal'),
    }),
  )
  .middleware(WatchAuth);

const ReadGroup = HttpApiGroup.make('read').add(
  HttpApiEndpoint.get('leaderboard', '/v1/leaderboard', {
    success: Leaderboard,
    error: apiErrors('unavailable', 'internal'),
  }),
  HttpApiEndpoint.get('matches', '/v1/matches', {
    query: { before: Schema.optional(Schema.String) },
    success: MatchList,
    error: apiErrors('invalid_request', 'unavailable', 'internal'),
  }),
  HttpApiEndpoint.get('match', '/v1/matches/:match_id', {
    params: { match_id: Schema.String },
    success: MatchDetail,
    error: apiErrors('room_not_found', 'unavailable', 'internal'),
  }),
);

const AdminGroup = HttpApiGroup.make('admin')
  .add(
    HttpApiEndpoint.post('abortRoom', '/v1/admin/rooms/:room_id/abort', {
      params: roomParams,
      success: AbortResponse,
      error: apiErrors(
        'room_not_found',
        'match_over',
        'unavailable',
        'internal',
      ),
    }),
    HttpApiEndpoint.post('banName', '/v1/admin/names/:name/ban', {
      params: { name: Schema.String },
      success: BanResponse,
      error: apiErrors('name_invalid', 'unavailable', 'internal'),
    }),
  )
  .middleware(AdminAuth);

export class CasinoApi extends HttpApi.make('agent-casino')
  .add(SkillGroup)
  .add(LobbyGroup)
  .add(RoomGroup)
  .add(WatchGroup)
  .add(ReadGroup)
  .add(AdminGroup) {}
