import { describe, expect, it } from 'vitest';
import { handle } from './app';

describe('handle', () => {
  it('answers GET /health with ok', async () => {
    const response = handle(new Request('http://api.test/health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers unknown routes with 404', () => {
    const response = handle(new Request('http://api.test/nope'));
    expect(response.status).toBe(404);
  });

  it('only serves /health over GET', () => {
    const response = handle(
      new Request('http://api.test/health', { method: 'POST' }),
    );
    expect(response.status).toBe(404);
  });
});
