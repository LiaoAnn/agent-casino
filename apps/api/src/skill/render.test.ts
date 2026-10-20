import { Exit, Schema } from 'effect';
import { HttpApi } from 'effect/http-api';
import { describe, expect, it } from 'vitest';
import { AdminAuth, CasinoApi, RoomAuth } from '../contract/api';
import { ERROR_CODES, ERROR_STATUS, type ErrorCode } from '../contract/errors';
import { EXAMPLES } from './examples';
import { renderSkill } from './render';

const BASE_URL = 'https://casino.example';
const MD = renderSkill(BASE_URL);

const decodes = (schema: Schema.Top, value: unknown): boolean =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(value),
  );

const errorBody = (code: ErrorCode) => ({
  status: 'error',
  code,
  message: 'Something went wrong; do this instead',
  hint: 'Try again later',
  retryable: false,
});

// --- the contract, reflected -----------------------------------------------

type Schemas = ReadonlyArray<Schema.Top>;

interface Reflected {
  method: string;
  path: string;
  auth: 'none' | 'room' | 'admin';
  codes: ErrorCode[];
  payloads: Schemas;
  successes: ReadonlyMap<number, Schemas>;
  errors: ReadonlyMap<number, Schemas>;
}

const reflectApi = (): Record<string, Reflected> => {
  const out: Record<string, Reflected> = {};
  HttpApi.reflect(CasinoApi, {
    onGroup: () => {},
    onEndpoint: ({ group, endpoint, middleware, successes, errors }) => {
      const keys: ReadonlySet<unknown> = middleware;
      const codes = ERROR_CODES.filter(code =>
        (errors.get(ERROR_STATUS[code]) ?? []).some(schema =>
          decodes(schema, errorBody(code)),
        ),
      );
      out[`${group.identifier}.${endpoint.identifier}`] = {
        method: endpoint.method,
        path: endpoint.path,
        auth: keys.has(RoomAuth)
          ? 'room'
          : keys.has(AdminAuth)
            ? 'admin'
            : 'none',
        codes,
        payloads: [...endpoint.payload.values()].flatMap(p => p.schemas),
        successes,
        errors,
      };
    },
  });
  return out;
};

const API = reflectApi();

// `/v1/rooms/:room_id/wait` -> `/v1/rooms/{room_id}/wait`
const docPath = (path: string) => path.replace(/:(\w+)/g, '{$1}');

// A23 moves HTTP details to the final appendix. The contract remains the oracle.
const fenced = (text: string, lang: string): string[] =>
  [
    ...text.matchAll(
      new RegExp(`\x60\x60\x60${lang}\\n([\\s\\S]*?)\x60\x60\x60`, 'g'),
    ),
  ].map(m => (m[1] ?? '').trim());
const appendix = (md: string) => md.split('## Appendix: the HTTP API')[1] ?? '';
const APPENDIX = appendix(MD);

describe('renderSkill: layout and URLs', () => {
  it('starts with skill frontmatter and a one-line description', () => {
    expect(MD.startsWith('---\n')).toBe(true);
    const closing = MD.indexOf('\n---\n', 4);
    expect(closing).toBeGreaterThan(4);
    const firstHeading = MD.search(/^#{1,6} /m);
    expect(firstHeading).toBeGreaterThan(closing + '\n---\n'.length);
    const frontmatter = MD.slice(4, closing);
    expect(frontmatter.split('\n')).toContain('name: agent-casino');
    expect(frontmatter.match(/^description: [^\s>|].*\S$/gm)).toHaveLength(1);
    expect(MD).not.toMatch(/[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/);
  });
  it('tells a crashed player to recover with state and give the owner the watch link again', () => {
    const game = MD.split('## Save as a skill')[0] ?? '';
    const recovery = game
      .split(/(?=^#{2,3} )/m)
      .find(section =>
        /^#{2,3} [^\n]*(?:troubleshoot|wrong|crash|connection drops|reconnect)/i.test(
          section,
        ),
      );
    expect(recovery, 'crash/reconnect section').toBeDefined();
    expect(recovery).toMatch(/crash|disconnect|connection drops|reconnect/i);
    expect(recovery).toContain('sh .casino/casino.sh state');
    expect(recovery).toMatch(
      /(?:watch|spectat)[^\n]*link|link[^\n]*(?:watch|spectat)/i,
    );
    expect(recovery).toMatch(/owner/i);
  });
  it.each(['https://casino.example', 'https://other.test:8443'])(
    'fills the download and saved skills with %s',
    base => {
      const md = renderSkill(base);
      expect(md).toContain(`curl -fsS ${base}/casino.sh -o .casino/casino.sh`);
      for (const folder of [
        '.claude/skills/agent-casino',
        '.agents/skills/agent-casino',
      ]) {
        expect(md).toContain(`mkdir -p ${folder}`);
        expect(md).toContain(
          `curl -fsSL ${base}/skill.md -o ${folder}/SKILL.md`,
        );
      }
      expect(
        md.split('\n').find(line => line.startsWith('description:')),
      ).toContain(new URL(base).host);
      expect(md).not.toContain('<平台網域>');
      expect(md).not.toMatch(/\{\{[A-Z_]+\}\}/);
    },
  );
  it('uses WEB_URL for watch and match links, with baseUrl as its default', () => {
    const base = 'https://api.test:8443';
    const web = 'https://web.test';
    const md = renderSkill(base, web);
    const urls = [...md.matchAll(/"watch_url": "([^"\n]+)"/g)].map(
      m => m[1] ?? '',
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls)
      expect(url).toMatch(
        /^https:\/\/web\.test\/watch\/r_[a-z0-9]{10}\?token=\S+$/,
      );
    expect(
      md
        .replaceAll(`${web}/watch/`, `${base}/watch/`)
        .replaceAll(`${web}/matches/`, `${base}/matches/`),
    ).toBe(renderSkill(base));
    expect(renderSkill(base, undefined)).toBe(renderSkill(base));
  });
});

describe('renderSkill: contract-generated HTTP appendix', () => {
  it.each(Object.entries(API))(
    '%s has its route, auth and applicable error codes',
    (_key, endpoint) => {
      const route = `\x60${endpoint.method} ${docPath(endpoint.path)}\x60`;
      const row = APPENDIX.split('\n').find(
        line => line.startsWith('|') && line.includes(route),
      );
      expect(row, route).toBeDefined();
      for (const code of endpoint.codes)
        expect(row).toContain(`\x60${code}\x60`);
      const rest = (row ?? '').replace(route, '');
      if (endpoint.auth === 'room') expect(rest).toContain('Bearer <token>');
      else if (endpoint.auth === 'admin') expect(rest).toMatch(/admin/i);
      else expect(rest).not.toMatch(/bearer|admin/i);
    },
  );
  it.each(ERROR_CODES)(
    'error %s has its HTTP status and specific advice',
    code => {
      const row = APPENDIX.split('\n').find(
        line =>
          line.startsWith('|') &&
          line.includes(`\x60${code}\x60`) &&
          new RegExp(`\\b${ERROR_STATUS[code]}\\b`).test(line),
      );
      expect(row, code).toBeDefined();
      expect(row?.split('|').at(-2)?.trim()).not.toMatch(
        /^$|^\x60[^\x60]+\x60$/,
      );
    },
  );
  it('gives each error different advice', () => {
    const advice = ERROR_CODES.map(code =>
      APPENDIX.split('\n')
        .find(
          line =>
            line.startsWith('|') &&
            line.includes(`\x60${code}\x60`) &&
            new RegExp(`\\b${ERROR_STATUS[code]}\\b`).test(line),
        )
        ?.split('|')
        .at(-2)
        ?.trim(),
    );
    expect(new Set(advice).size).toBe(ERROR_CODES.length);
  });
  it.each(Object.entries(EXAMPLES))(
    '%s renders its request as HTTP and every response as contract JSON',
    (key, example) => {
      const endpoint = API[key];
      expect(endpoint).toBeDefined();
      if (!endpoint) throw new Error(`Missing contract endpoint ${key}`);
      const requests = fenced(APPENDIX, 'http');
      const request = requests.find(
        block =>
          block.split('\n')[0]?.split('?')[0] ===
          `${endpoint.method} ${docPath(endpoint.path)}`,
      );
      expect(request, key).toBeDefined();
      if (endpoint.auth === 'room')
        expect(request).toContain('Authorization: Bearer <token>');
      else expect(request).not.toContain('Authorization: Bearer <token>');
      if (example.request !== undefined) {
        expect(request).toContain('Content-Type: application/json');
        expect(request).toContain(`\n\n${JSON.stringify(example.request)}`);
        const body = JSON.parse(request?.split('\n\n')[1] ?? 'null');
        expect(endpoint.payloads.some(schema => decodes(schema, body))).toBe(
          true,
        );
      }
      for (const response of example.responses) {
        expect(
          fenced(APPENDIX, 'json').some(
            block => block === JSON.stringify(response.body, null, 2),
          ),
          `${key}: ${response.title}`,
        ).toBe(true);
      }
    },
  );
  it('all HTTP request examples resolve to a real contract endpoint', () => {
    const requests = fenced(APPENDIX, 'http');
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const [method, target] = (request.split('\n')[0] ?? '').split(' ');
      expect(
        Object.values(API).some(
          endpoint =>
            endpoint.method === method &&
            docPath(endpoint.path) === target?.split('?')[0],
        ),
        request,
      ).toBe(true);
    }
  });
  it('keeps protocol details in the appendix', () => {
    for (const field of [
      'turn_id',
      'queue_key',
      '?wait=1',
      'duplicate',
      'hands_since_your_turn',
    ])
      expect(APPENDIX).toContain(field);
    expect(
      fenced(APPENDIX, 'http').some(block =>
        block.startsWith('POST /v1/rooms/{room_id}/actions?wait=1\n'),
      ),
    ).toBe(true);
    const responses = fenced(APPENDIX, 'json').map(
      block => JSON.parse(block) as Record<string, unknown>,
    );
    for (const response of responses.filter(
      body => typeof body.deadline === 'string',
    ))
      expect(new Date(String(response.deadline)).toISOString()).toBe(
        response.deadline,
      );
    expect(responses.some(body => typeof body.deadline === 'string')).toBe(
      true,
    );
    // Open a room and join: T39 took the queue's `matched` out.
    const seats = responses.filter(body => typeof body.token === 'string');
    expect(seats).toHaveLength(2);
    for (const seat of seats)
      expect(String(seat.hint)).toMatch(
        /watch_url[\s\S]*owner[\s\S]*GET \/v1\/rooms\/r_8f2k1x9q0a\/wait/i,
      );
    const finished = responses.filter(body => body.status === 'match_over');
    expect(finished).toHaveLength(3);
    for (const body of finished)
      expect(String(body.hint)).toContain(`${BASE_URL}/matches/r_8f2k1x9q0a`);
  });

  it('retains same-seat queue recovery and credential advice', () => {
    expect(APPENDIX).toMatch(/invalid_token[\s\S]*(?:cop|saved)/i);
    expect(APPENDIX).toMatch(/same[^\n]*name[^\n]*same[^\n]*queue_key/i);
    expect(APPENDIX).toMatch(/same[^\n]*matched/i);
    expect(APPENDIX).toMatch(/(?:do not|don't|never)[^\n]*join/i);
  });
});

// --- the hand-written examples ----------------------------------------------

describe('EXAMPLES', () => {
  const statusOf = (body: unknown) => (body as { status?: unknown }).status;
  const codeOf = (body: unknown) => (body as { code?: unknown }).code;

  it('covers the endpoints a player uses, and only real endpoints', () => {
    const keys = Object.keys(EXAMPLES);
    expect(keys).toEqual(
      expect.arrayContaining([
        'lobby.createRoom',
        'lobby.joinRoom',
        'room.wait',
        'room.state',
        'room.act',
        'room.leave',
        'read.leaderboard',
      ]),
    );
    for (const key of keys) expect(Object.keys(API), key).toContain(key);
  });

  // The endpoint's own schemas decide; status 200 is the success body.
  const requestDecodes = (key: string, request: unknown) =>
    (API[key]?.payloads ?? []).some(schema => decodes(schema, request));
  const responseDecodes = (key: string, status: number, body: unknown) => {
    const endpoint = API[key];
    const schemas =
      status === 200
        ? endpoint?.successes.get(200)
        : endpoint?.errors.get(status);
    return (schemas ?? []).some(schema => decodes(schema, body));
  };

  it.each(Object.entries(EXAMPLES))(
    '%s matches the contract',
    (key, example) => {
      const endpoint = API[key];
      expect(endpoint).toBeDefined();
      if ((endpoint?.payloads.length ?? 0) > 0) {
        expect(example.request, 'request').toBeDefined();
        expect(requestDecodes(key, example.request), 'request').toBe(true);
      } else {
        expect(example.request, 'request').toBeUndefined();
      }
      expect(example.responses.length).toBeGreaterThan(0);
      for (const { title, status, body } of example.responses) {
        expect(title.length, 'title').toBeGreaterThan(0);
        expect(responseDecodes(key, status, body), title).toBe(true);
      }
    },
  );

  it('rejects a wrong example (real schema decoding)', () => {
    expect(
      requestDecodes('room.act', { turn_id: 't_1', type: 'bet', amount: 8 }),
    ).toBe(false);
    expect(
      responseDecodes('room.act', 400, { ...errorBody('stale_turn') }),
    ).toBe(false);
  });

  it('shows each situation a player meets', () => {
    const statuses = (key: string) =>
      (EXAMPLES[key]?.responses ?? [])
        .filter(r => r.status === 200)
        .map(r => statusOf(r.body));
    expect(statuses('room.wait')).toEqual(
      expect.arrayContaining(['your_turn', 'waiting', 'match_over']),
    );
    expect(statuses('room.act')).toContain('accepted');

    const actErrors = (EXAMPLES['room.act']?.responses ?? []).filter(
      r => r.status !== 200,
    );
    expect(actErrors.map(r => codeOf(r.body))).toEqual(
      expect.arrayContaining(['invalid_action', 'stale_turn']),
    );
    const stale = actErrors.find(r => codeOf(r.body) === 'stale_turn');
    expect(stale).toBeDefined();
    expect(
      (stale?.body as { state?: unknown } | undefined)?.state,
    ).toBeDefined();
  });
});
