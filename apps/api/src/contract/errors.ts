// The one error body every endpoint uses (casino-api skill: 錯誤格式, A4).
import { Schema } from 'effect';
import { HttpApiSchema } from 'effect/http-api';
import { RoomStatus } from './schemas';

export const ERROR_CODES = [
  'invalid_request',
  'invalid_token',
  'room_not_found',
  'room_full',
  'wrong_invite_code',
  'name_invalid',
  'name_banned',
  'not_your_turn',
  'stale_turn',
  'invalid_action',
  'match_over',
  'not_found',
  'unavailable',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  invalid_action: 400,
  name_invalid: 400,
  invalid_token: 401,
  name_banned: 403,
  wrong_invite_code: 403,
  room_not_found: 404,
  // An unknown path, or a known path with the wrong method.
  not_found: 404,
  not_your_turn: 409,
  stale_turn: 409,
  room_full: 409,
  match_over: 409,
  internal: 500,
  unavailable: 503,
};

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set([
  'invalid_action',
  'unavailable',
]);

const errorBody = <const C extends ReadonlyArray<ErrorCode>>(codes: C) =>
  Schema.Struct({
    status: Schema.Literal('error'),
    code: Schema.Literals(codes),
    // Says what went wrong and how to fix it, in English.
    message: Schema.String,
    hint: Schema.String,
    retryable: Schema.Boolean,
    // Always sent with not_your_turn, stale_turn and match_over on room
    // endpoints, so the agent can carry on without another call.
    state: Schema.optionalKey(RoomStatus),
  });

const AnyError = errorBody(ERROR_CODES);
// Narrowed to its code, so a handler can fail with it on an endpoint that
// declares only some codes.
export type ApiError<C extends ErrorCode = ErrorCode> = Omit<
  typeof AnyError.Type,
  'code'
> & { readonly code: C };

export function apiError<C extends ErrorCode>(
  code: C,
  message: string,
  hint: string,
  options: { retryable?: boolean; state?: RoomStatus } = {},
): ApiError<C> {
  const { retryable = RETRYABLE_BY_DEFAULT.has(code), state } = options;
  return {
    status: 'error',
    code,
    message,
    hint,
    retryable,
    ...(state === undefined ? {} : { state }),
  };
}

// An endpoint's `error` list: one schema per HTTP status, each accepting only
// the given codes of that status. `unavailable` and `internal` can come from
// any endpoint, so callers list them too.
export function apiErrors<const C extends ReadonlyArray<ErrorCode>>(
  ...codes: C
) {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return [...byStatus].map(([status, group]) =>
    errorBody(group as unknown as C).pipe(HttpApiSchema.status(status)),
  );
}
