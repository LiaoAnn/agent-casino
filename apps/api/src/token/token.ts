// Room tokens (casino-api skill: 房間 token, A8):
// base64url(JSON claims) + "." + base64url(HMAC-SHA256(secret, first part)).
// The Room DO separately refuses tokens of rooms that ended over an hour ago.
import { type ApiError, apiError } from '../contract/errors';

export const TOKEN_TTL_SECONDS = 86_400;

export interface RoomTokenClaims {
  room_id: string;
  seat: 0 | 1;
  name: string;
  exp: number;
}

export type TokenRejection =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_room';

type TokenCheck =
  | { ok: true; claims: RoomTokenClaims }
  | { ok: false; reason: TokenRejection };

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const fromBase64Url = (text: string): Uint8Array | undefined => {
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

export async function signRoomToken(
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
  const payload = toBase64Url(encoder.encode(JSON.stringify(full)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(payload),
  );
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

const isClaims = (value: unknown): value is RoomTokenClaims => {
  if (typeof value !== 'object' || value === null) return false;
  const { room_id, seat, name, exp } = value as Record<string, unknown>;
  return (
    typeof room_id === 'string' &&
    (seat === 0 || seat === 1) &&
    typeof name === 'string' &&
    Number.isInteger(exp)
  );
};

export async function verifyRoomToken(
  token: string,
  secret: string,
  roomId: string,
  nowMs: number,
): Promise<TokenCheck> {
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
    encoder.encode(payload),
  );
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isClaims(claims)) return { ok: false, reason: 'malformed' };
  if (nowSeconds(nowMs) >= claims.exp) return { ok: false, reason: 'expired' };
  if (claims.room_id !== roomId) return { ok: false, reason: 'wrong_room' };
  return { ok: true, claims };
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
    'Token expired. Tokens last 24 hours after they are issued',
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
