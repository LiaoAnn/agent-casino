import { describe, expect, it, vi } from 'vitest';
import {
  signRoomToken,
  signWatchToken,
  TOKEN_TTL_SECONDS,
  tokenRejectionError,
  verifyRoomToken,
  verifyWatchToken,
} from './token';

const SECRET = 'test-secret-not-real';
const ISSUED_MS = Date.UTC(2026, 9, 17, 12, 0, 0, 250);
const ISSUED_S = Math.floor(ISSUED_MS / 1000);
const ROOM = 'r_abcde12345';
const CLAIMS = { room_id: ROOM, seat: 1, name: 'alice' } as const;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const encodeJson = (value: unknown): string =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

const hmac = async (secret: string, data: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(data),
  );
  return toBase64Url(new Uint8Array(sig));
};

/** Builds a token exactly the way the spec describes, with any payload. */
const craft = async (payload: unknown, secret = SECRET): Promise<string> => {
  const body = encodeJson(payload);
  return `${body}.${await hmac(secret, body)}`;
};

const issue = () => signRoomToken(CLAIMS, SECRET, ISSUED_MS);

describe('signRoomToken / verifyRoomToken', () => {
  it('round-trips the claims with exp = issue time + 24h', async () => {
    const token = await issue();
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const result = await verifyRoomToken(token, SECRET, ROOM, ISSUED_MS);
    expect(result).toEqual({
      ok: true,
      claims: { ...CLAIMS, exp: ISSUED_S + TOKEN_TTL_SECONDS },
    });
    expect(TOKEN_TTL_SECONDS).toBe(86_400);
  });

  it('is deterministic for the same input and time', async () => {
    expect(await issue()).toBe(await issue());
  });

  it('uses base64url(payload).base64url(HMAC-SHA256) without padding', async () => {
    const [payload, sig] = (await issue()).split('.');
    expect(sig).toBe(await hmac(SECRET, payload ?? ''));
    const decoded = JSON.parse(
      atob((payload ?? '').replaceAll('-', '+').replaceAll('_', '/')),
    );
    expect(decoded).toEqual({ ...CLAIMS, exp: ISSUED_S + TOKEN_TTL_SECONDS });
  });

  it('accepts a token until one second before 24h have passed', async () => {
    const lastValidMs = (ISSUED_S + TOKEN_TTL_SECONDS - 1) * 1000 + 999;
    const result = await verifyRoomToken(
      await issue(),
      SECRET,
      ROOM,
      lastValidMs,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a token exactly 24h after issue as expired', async () => {
    const expiryMs = (ISSUED_S + TOKEN_TTL_SECONDS) * 1000;
    const result = await verifyRoomToken(await issue(), SECRET, ROOM, expiryMs);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token issued for another room', async () => {
    const result = await verifyRoomToken(
      await issue(),
      SECRET,
      'r_zzzzz99999',
      ISSUED_MS,
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_room' });
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await craft(
      { ...CLAIMS, exp: ISSUED_S + TOKEN_TTL_SECONDS },
      'attacker-secret',
    );
    const result = await verifyRoomToken(forged, SECRET, ROOM, ISSUED_MS);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects edited claims that keep the original signature', async () => {
    const [, sig] = (await issue()).split('.');
    const edited = encodeJson({
      ...CLAIMS,
      seat: 0,
      exp: ISSUED_S + TOKEN_TTL_SECONDS,
    });
    const result = await verifyRoomToken(
      `${edited}.${sig}`,
      SECRET,
      ROOM,
      ISSUED_MS,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a tampered signature', async () => {
    const token = await issue();
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    const result = await verifyRoomToken(
      token.slice(0, -1) + last,
      SECRET,
      ROOM,
      ISSUED_MS,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('checks the signature before expiry and room', async () => {
    const forged = await craft(
      { room_id: 'r_other00000', seat: 0, name: 'eve', exp: 1 },
      'attacker-secret',
    );
    const result = await verifyRoomToken(forged, SECRET, ROOM, ISSUED_MS);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('checks expiry before room', async () => {
    const token = await signRoomToken(
      { ...CLAIMS, room_id: 'r_other00000' },
      SECRET,
      ISSUED_MS,
    );
    const later = (ISSUED_S + TOKEN_TTL_SECONDS + 10) * 1000;
    const result = await verifyRoomToken(token, SECRET, ROOM, later);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it.each([
    ['empty', ''],
    ['no dot', 'abc'],
    ['three parts', 'a.b.c'],
    ['not base64', '!!!.???'],
  ])('rejects a malformed token (%s)', async (_label, token) => {
    const result = await verifyRoomToken(token, SECRET, ROOM, ISSUED_MS);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a validly signed payload that is not JSON', async () => {
    const payload = toBase64Url(new TextEncoder().encode('not json'));
    const token = `${payload}.${await hmac(SECRET, payload)}`;
    const result = await verifyRoomToken(token, SECRET, ROOM, ISSUED_MS);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a valid token with an extra segment appended', async () => {
    const token = await signRoomToken(CLAIMS, SECRET, ISSUED_MS);
    const result = await verifyRoomToken(
      `${token}.${token.split('.')[1]}`,
      SECRET,
      ROOM,
      ISSUED_MS,
    );
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['seat 2', { ...CLAIMS, seat: 2, exp: ISSUED_S + 100 }],
    ['missing name', { room_id: ROOM, seat: 0, exp: ISSUED_S + 100 }],
    ['exp not a number', { ...CLAIMS, exp: 'tomorrow' }],
    ['not an object', [ROOM, 0, 'alice']],
  ])(
    'rejects validly signed but wrong-shaped claims (%s)',
    async (_label, payload) => {
      const token = await craft(payload);
      const result = await verifyRoomToken(token, SECRET, ROOM, ISSUED_MS);
      expect(result).toEqual({ ok: false, reason: 'malformed' });
    },
  );
});

describe('tokenRejectionError', () => {
  it.each(['malformed', 'bad_signature', 'expired', 'wrong_room'] as const)(
    'maps %s to a non-retryable invalid_token error',
    reason => {
      const error = tokenRejectionError(reason);
      expect(error).toMatchObject({
        status: 'error',
        code: 'invalid_token',
        retryable: false,
      });
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.hint.length).toBeGreaterThan(0);
      expect(error).not.toHaveProperty('state');
    },
  );

  it.each(['malformed', 'bad_signature'] as const)(
    'T45 %s hint explains copy errors and recovery of the same matched seat',
    reason => {
      const { hint } = tokenRejectionError(reason);
      expect.soft(hint).toMatch(/cop(?:y|ied|ying)|transcri/i);
      expect.soft(hint).toMatch(/same[^.\n]*name/i);
      expect.soft(hint).toMatch(/same[^.\n]*queue_key/i);
      expect.soft(hint).toMatch(/queue/i);
      expect.soft(hint).toMatch(/same[^.\n]*matched/i);
    },
  );

  it('tells the agent what went wrong for each reason', () => {
    expect(tokenRejectionError('malformed').message).toMatch(/Bearer/);
    expect(tokenRejectionError('bad_signature').message).toMatch(/signature/);
    expect(tokenRejectionError('expired').message).toMatch(/expired/);
    expect(tokenRejectionError('expired').message).toContain(
      `${TOKEN_TTL_SECONDS / 3600} hours`,
    );
    expect(tokenRejectionError('wrong_room').message).toMatch(/different room/);
  });
});

// --- Watch tokens (casino-api A16) -------------------------------------------

const WATCH_CLAIMS = { room_id: ROOM, seat: 1, name: 'alice' } as const;

/** A watch token built the way A16 describes: HMAC input is "watch." + payload. */
const craftWatch = async (
  payload: unknown,
  secret = SECRET,
): Promise<string> => {
  const body = encodeJson(payload);
  return `${body}.${await hmac(secret, `watch.${body}`)}`;
};

describe('signWatchToken / verifyWatchToken', () => {
  it('round-trips the claims, with no exp', async () => {
    const token = await signWatchToken(WATCH_CLAIMS, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const result = await verifyWatchToken(token, SECRET, ROOM);
    expect(result).toEqual({ ok: true, claims: WATCH_CLAIMS });
  });

  it('is deterministic: the same claims and secret always give the same token', async () => {
    expect(await signWatchToken(WATCH_CLAIMS, SECRET)).toBe(
      await signWatchToken(WATCH_CLAIMS, SECRET),
    );
    expect(await signWatchToken({ ...WATCH_CLAIMS, seat: 0 }, SECRET)).not.toBe(
      await signWatchToken(WATCH_CLAIMS, SECRET),
    );
  });

  it('puts only room_id, seat and name in the payload and signs "watch." + payload', async () => {
    const [payload, sig] = (await signWatchToken(WATCH_CLAIMS, SECRET)).split(
      '.',
    );
    expect(sig).toBe(await hmac(SECRET, `watch.${payload ?? ''}`));
    expect(sig).not.toBe(await hmac(SECRET, payload ?? ''));
    const decoded = JSON.parse(
      atob((payload ?? '').replaceAll('-', '+').replaceAll('_', '/')),
    );
    expect(decoded).toEqual(WATCH_CLAIMS);
    expect(decoded).not.toHaveProperty('exp');
  });

  it('never expires', async () => {
    const token = await signWatchToken(WATCH_CLAIMS, SECRET);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2100, 0, 1));
      expect(await verifyWatchToken(token, SECRET, ROOM)).toEqual({
        ok: true,
        claims: WATCH_CLAIMS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a token issued for another room', async () => {
    const result = await verifyWatchToken(
      await signWatchToken(WATCH_CLAIMS, SECRET),
      SECRET,
      'r_zzzzz99999',
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_room' });
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await craftWatch(WATCH_CLAIMS, 'attacker-secret');
    const result = await verifyWatchToken(forged, SECRET, ROOM);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects edited claims that keep the original signature', async () => {
    const [, sig] = (await signWatchToken(WATCH_CLAIMS, SECRET)).split('.');
    const edited = encodeJson({ ...WATCH_CLAIMS, seat: 0 });
    const result = await verifyWatchToken(`${edited}.${sig}`, SECRET, ROOM);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('checks the signature before the room', async () => {
    const forged = await craftWatch(
      { room_id: 'r_other00000', seat: 0, name: 'eve' },
      'attacker-secret',
    );
    const result = await verifyWatchToken(forged, SECRET, ROOM);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['empty', ''],
    ['no dot', 'abc'],
    ['three parts', 'a.b.c'],
    ['not base64', '!!!.???'],
  ])('rejects a malformed token (%s)', async (_label, token) => {
    const result = await verifyWatchToken(token, SECRET, ROOM);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['seat 2', { ...WATCH_CLAIMS, seat: 2 }],
    ['missing name', { room_id: ROOM, seat: 0 }],
    ['not an object', [ROOM, 0, 'alice']],
  ])(
    'rejects validly signed but wrong-shaped claims (%s)',
    async (_label, payload) => {
      const result = await verifyWatchToken(
        await craftWatch(payload),
        SECRET,
        ROOM,
      );
      expect(result).toEqual({ ok: false, reason: 'malformed' });
    },
  );

  it('does not accept a seat token', async () => {
    const seatToken = await signRoomToken(CLAIMS, SECRET, ISSUED_MS);
    const result = await verifyWatchToken(seatToken, SECRET, ROOM);
    expect(result.ok).toBe(false);
  });

  it('does not accept a payload signed without the "watch." prefix', async () => {
    const result = await verifyWatchToken(
      await craft(WATCH_CLAIMS),
      SECRET,
      ROOM,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('is not accepted as a seat token', async () => {
    const watchToken = await signWatchToken(WATCH_CLAIMS, SECRET);
    const result = await verifyRoomToken(watchToken, SECRET, ROOM, ISSUED_MS);
    expect(result.ok).toBe(false);
  });

  it('is not accepted as a seat token even if exp is added to the payload', async () => {
    // Same payload shape as a seat token, but the signature still carries
    // the "watch." prefix, so it cannot pass as one.
    const forged = await craftWatch({
      ...WATCH_CLAIMS,
      exp: ISSUED_S + TOKEN_TTL_SECONDS,
    });
    const result = await verifyRoomToken(forged, SECRET, ROOM, ISSUED_MS);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
