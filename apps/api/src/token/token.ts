// Room tokens (casino-api skill: 房間 token, A8):
// base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, first part)).
// The Room DO separately refuses tokens of rooms that ended over an hour ago.
// Watch tokens (A16) look the same without `exp`, and sign "watch." + the
// first part, so neither kind passes for the other.
import { type ApiError, apiError } from '../contract/errors';

export const TOKEN_TTL_SECONDS = 86_400;

export interface WatchTokenClaims {
  room_id: string;
  seat: 0 | 1;
  name: string;
}

export interface RoomTokenClaims extends WatchTokenClaims {
  exp: number;
}

export type TokenRejection =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_room';

type TokenCheck<C> =
  | { ok: true; claims: C }
  | { ok: false; reason: TokenRejection };

const WATCH_PREFIX = 'watch.';

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const hmacKey = (secret: string) =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

const nowSeconds = (nowMs: number) => Math.floor(nowMs / 1000);

// `prefix` goes in front of the payload into the HMAC only.
async function sign(
  claims: object,
  secret: string,
  prefix = '',
): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(prefix + payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export function signRoomToken(
  claims: Omit<RoomTokenClaims, 'exp'>,
  secret: string,
  nowMs: number,
): Promise<string> {
  const full: RoomTokenClaims = {
    room_id: claims.room_id,
    seat: claims.seat,
    name: claims.name,
    exp: nowSeconds(nowMs) + TOKEN_TTL_SECONDS,
  };
  return sign(full, secret);
}

// No exp: the link works as long as TOKEN_SECRET stays the same (A16). The
// same claims always give the same token.
export function signWatchToken(
  claims: WatchTokenClaims,
  secret: string,
): Promise<string> {
  const { room_id, seat, name } = claims;
  return sign({ room_id, seat, name }, secret, WATCH_PREFIX);
}

const isWatchClaims = (value: unknown): value is WatchTokenClaims => {
  if (typeof value !== 'object' || value === null) return false;
  const { room_id, seat, name } = value as Record<string, unknown>;
  return (
    typeof room_id === 'string' &&
    (seat === 0 || seat === 1) &&
    typeof name === 'string'
  );
};

const isClaims = (value: unknown): value is RoomTokenClaims =>
  isWatchClaims(value) && Number.isInteger((value as { exp?: unknown }).exp);

// Checks the signature, the claims' shape, `expired`, then the room.
async function verify<C extends WatchTokenClaims>(
  token: string,
  secret: string,
  roomId: string,
  kind: {
    isShape: (value: unknown) => value is C;
    expired?: (claims: C) => boolean;
    prefix?: string;
  },
): Promise<TokenCheck<C>> {
  const { isShape, expired, prefix = '' } = kind;
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payload = '', signaturePart = ''] = parts;
  const payloadBytes = fromBase64Url(payload);
  const signature = fromBase64Url(signaturePart);
  if (!payloadBytes || !signature) return { ok: false, reason: 'malformed' };

  // Constant-time comparison happens inside crypto.subtle.verify.
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    encoder.encode(prefix + payload),
  );
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isShape(claims)) return { ok: false, reason: 'malformed' };
  if (expired?.(claims)) return { ok: false, reason: 'expired' };
  if (claims.room_id !== roomId) return { ok: false, reason: 'wrong_room' };
  return { ok: true, claims };
}

export function verifyRoomToken(
  token: string,
  secret: string,
  roomId: string,
  nowMs: number,
): Promise<TokenCheck<RoomTokenClaims>> {
  return verify(token, secret, roomId, {
    isShape: isClaims,
    expired: claims => nowSeconds(nowMs) >= claims.exp,
  });
}

export function verifyWatchToken(
  token: string,
  secret: string,
  roomId: string,
): Promise<TokenCheck<WatchTokenClaims>> {
  return verify(token, secret, roomId, {
    isShape: isWatchClaims,
    prefix: WATCH_PREFIX,
  });
}

const JOIN_AGAIN =
  'Get a fresh token from POST /v1/queue, POST /v1/rooms or POST /v1/rooms/{room_id}/join';

const REJECTIONS: Record<TokenRejection, [message: string, hint: string]> = {
  malformed: [
    'Missing or malformed token. Send the header "Authorization: Bearer <token>" with the token you got when you entered this room',
    JOIN_AGAIN,
  ],
  bad_signature: [
    'Token signature is invalid. Send the token exactly as the server gave it to you, without changes',
    JOIN_AGAIN,
  ],
  expired: [
    `Token expired. Tokens last ${TOKEN_TTL_SECONDS / 3600} hours after they are issued`,
    JOIN_AGAIN,
  ],
  wrong_room: [
    'This token belongs to a different room. Use the room_id that came with the token',
    'Call the endpoints of the room_id you were given together with this token',
  ],
};

export function tokenRejectionError(
  reason: TokenRejection,
): ApiError<'invalid_token'> {
  const [message, hint] = REJECTIONS[reason];
  return apiError('invalid_token', message, hint);
}

// For whoever opened the watch link: usually the owner, not the agent.
const WATCH_AGAIN =
  'Open the watch_url exactly as your agent got it from POST /v1/queue, POST /v1/rooms or POST /v1/rooms/{room_id}/join; a room token does not work here';

export function watchRejectionError(
  reason: TokenRejection,
): ApiError<'invalid_token'> {
  return apiError(
    'invalid_token',
    reason === 'wrong_room'
      ? 'This watch token belongs to a different room. Use the room_id of the watch_url it came with'
      : 'Missing or invalid watch token. Send the header "Authorization: Bearer <token>" with the token from the watch_url',
    WATCH_AGAIN,
  );
}
