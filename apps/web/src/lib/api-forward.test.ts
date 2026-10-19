import { describe, expect, it, vi } from 'vitest';
import { forwardApi } from './api-forward';

const PUBLIC_ORIGIN = 'https://casino.example';

describe('single-domain API forwarding (T44)', () => {
  it.each([
    '/skill.md',
    '/skill.md?download=1',
    '/casino.sh',
    '/casino.sh?download=1',
    '/v1/leaderboard',
    '/v1/matches?before=r_abcde12345',
    '/v1/rooms/r_abcde12345/wait',
    '/v1/rooms/r_abcde12345/watch?token=watch-token',
    '/v1/not-an-endpoint',
  ])('forwards %s to the API binding', async path => {
    const fetchApi = vi.fn(async () => new Response('API response'));
    const response = await forwardApi(
      new Request(`${PUBLIC_ORIGIN}${path}`),
      fetchApi,
    );
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(response).not.toBeNull();
    expect(await response?.text()).toBe('API response');
  });

  it.each([
    '/',
    '/matches/r_abcde12345',
    '/watch/r_abcde12345?token=watch-token',
    '/assets/site.css',
    '/skill.md/extra',
    '/skill.md.bak',
    '/casino.sh/extra',
    '/casino.sh.bak',
    '/v10/leaderboard',
    '/v1-other',
    '/missing?next=/v1/leaderboard',
  ])('leaves web route %s to the web app without fetching', async path => {
    const fetchApi = vi.fn(async () => new Response('API response'));
    expect(
      await forwardApi(new Request(`${PUBLIC_ORIGIN}${path}`), fetchApi),
    ).toBeNull();
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('preserves the public URL, encoded query, method, headers and exact JSON body', async () => {
    const url = `${PUBLIC_ORIGIN}/v1/rooms/r_abcde12345/actions?note=a%2Bb&tag=one&tag=two`;
    const body = '{ "turn_id": "t_1", "type": "check", "note": "想一下 🃏" }\n';
    const request = new Request(url, {
      method: 'POST',
      headers: {
        host: 'casino.example',
        authorization: 'Bearer room-token.original',
        'content-type': 'application/json',
      },
      body,
    });
    const fetchApi = vi.fn(async (forwarded: Request) => {
      expect(forwarded.url).toBe(url);
      expect(forwarded.method).toBe('POST');
      expect([...forwarded.headers]).toEqual([...request.headers]);
      expect(await forwarded.text()).toBe(body);
      return new Response(null, { status: 204 });
    });
    expect((await forwardApi(request, fetchApi))?.status).toBe(204);
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it('propagates an incoming cancellation to the request being fetched', async () => {
    const controller = new AbortController();
    const request = new Request(`${PUBLIC_ORIGIN}/v1/rooms/r_abcde12345/wait`, {
      signal: controller.signal,
    });
    const fetchApi = vi.fn(async (forwarded: Request) => {
      expect(forwarded.signal.aborted).toBe(false);
      const aborted = vi.fn();
      forwarded.signal.addEventListener('abort', aborted, { once: true });
      controller.abort();
      expect(forwarded.signal.aborted).toBe(true);
      expect(aborted).toHaveBeenCalledTimes(1);
      return new Response(null, { status: 204 });
    });
    await forwardApi(request, fetchApi);
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it.each([200, 401, 404, 503])(
    'preserves status %s, response headers and body bytes without JSON rewriting',
    async status => {
      const body = '{ "status" : "error", "message" : "保留原文" }\n';
      const headers = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '3',
        'referrer-policy': 'no-referrer',
      };
      const upstream = new Response(body, { status, headers });
      const response = await forwardApi(
        new Request(`${PUBLIC_ORIGIN}/v1/rooms/r_abcde12345/wait`),
        async () => upstream,
      );
      expect(response?.status).toBe(status);
      expect([...(response?.headers ?? [])]).toEqual([...upstream.headers]);
      expect(await response?.text()).toBe(body);
    },
  );

  it('returns an open response stream before its later chunks arrive', async () => {
    const encoder = new TextEncoder();
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    const upstream = new Response(stream.readable, {
      headers: { 'content-type': 'text/event-stream' },
    });
    const response = await forwardApi(
      new Request(`${PUBLIC_ORIGIN}/v1/rooms/r_abcde12345/wait`),
      async () => upstream,
    );
    expect(response?.bodyUsed).toBe(false);
    const reader = response?.body?.getReader();
    if (!reader) throw new Error('Forwarded response must retain its stream');
    try {
      const first = reader.read();
      await writer.write(encoder.encode('first chunk\n'));
      expect(await first).toEqual({
        done: false,
        value: encoder.encode('first chunk\n'),
      });
      const second = reader.read();
      await writer.write(encoder.encode('later chunk\n'));
      expect(await second).toEqual({
        done: false,
        value: encoder.encode('later chunk\n'),
      });
      await writer.close();
      expect(await reader.read()).toEqual({ done: true, value: undefined });
    } finally {
      await reader.cancel();
      reader.releaseLock();
      writer.releaseLock();
    }
  });
});
