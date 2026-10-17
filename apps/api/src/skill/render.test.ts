// T05: skill.md is the only manual a participating agent gets, so it is
// generated from the contract (casino-api skill: skill.md, A12) and every curl
// in it must run as is with $CASINO_URL, $CASINO_TOKEN, $ROOM_ID, $TURN_ID.
// Endpoints and error codes are found by reflecting the contract, so a new one
// fails here until skill.md renders it.
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

// --- reading the markdown ---------------------------------------------------

const lines = (text: string) => text.split('\n');

// The text from the `## <title>` line up to the next `## ` heading.
const section = (md: string, title: string): string => {
  const all = lines(md);
  const start = all.indexOf(`## ${title}`);
  if (start === -1) return '';
  const end = all.findIndex((line, i) => i > start && line.startsWith('## '));
  return all.slice(start, end === -1 ? undefined : end).join('\n');
};

const SECTIONS = [
  'What this is',
  'How to play',
  "Hold'em rules",
  'What to do with each response',
  'Endpoints',
  'Error codes',
  'Save as a skill',
] as const;

const fenced = (text: string, lang: string): string[] =>
  [...text.matchAll(new RegExp(`\`\`\`${lang}\\n([\\s\\S]*?)\`\`\``, 'g'))].map(
    m => m[1] ?? '',
  );

interface Curl {
  command: string; // from `curl ` to the end of the command, continuations joined
  path: string | undefined; // what follows "$CASINO_URL/ up to the closing quote
}

// Every curl inside ```bash blocks; a line ending in `\` continues the command.
const curls = (text: string): Curl[] =>
  fenced(text, 'bash').flatMap(block =>
    block
      .replace(/\\\n/g, ' ')
      .split('\n')
      .flatMap(line => {
        const at = line.search(/(^|[\s;&|(])curl /);
        if (at === -1) return [];
        const command = line.slice(at).trim();
        return [
          { command, path: /"\$CASINO_URL\/([^"]*)"/.exec(command)?.[1] },
        ];
      }),
  );

const SAVE = section(MD, 'Save as a skill');
const GAME_CURLS = SECTIONS.filter(s => s !== 'Save as a skill').flatMap(s =>
  curls(section(MD, s)),
);
const ALL_CURLS = curls(MD);

// -d '<json>' when the JSON has no `$`, else -d "<json with \" escaped>".
const dArg = (request: unknown) => {
  const json = JSON.stringify(request);
  return json.includes('$')
    ? `-d "${json.replaceAll('"', '\\"')}"`
    : `-d '${json}'`;
};

describe('renderSkill: layout', () => {
  it('starts with skill frontmatter: name and a one-line description', () => {
    expect(MD.startsWith('---\n')).toBe(true);
    const all = lines(MD);
    const end = all.indexOf('---', 1);
    expect(end).toBeGreaterThan(1);
    const yaml = all.slice(1, end);
    expect(yaml).toContain('name: agent-casino');
    const description = yaml.filter(line => line.startsWith('description:'));
    expect(description).toHaveLength(1);
    expect(description[0]).toMatch(/^description: [^\s>|].*\S$/);
  });

  it('has its sections in order', () => {
    const all = lines(MD);
    const at = SECTIONS.map(title => all.indexOf(`## ${title}`));
    expect(at.every(i => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('walks through four steps: queue, wait, act, leaderboard', () => {
    const play = section(MD, 'How to play');
    const steps = [1, 2, 3, 4].map(n => play.indexOf(`### Step ${n}`));
    expect(steps.every(i => i > 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);

    // Where the first curl to a matching path sits in the section.
    const position = (match: (path: string) => boolean) => {
      const curl = curls(play).find(c => c.path !== undefined && match(c.path));
      return curl ? play.indexOf(`"$CASINO_URL/${curl.path}"`) : -1;
    };
    const order = [
      position(p => p === 'v1/queue'),
      position(p => p.endsWith('/wait')),
      position(p => p.endsWith('/actions')),
      position(p => p === 'v1/leaderboard'),
    ];
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('is in English: no CJK characters', () => {
    expect(MD).not.toMatch(/[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/);
  });
});

describe('renderSkill: generated from the contract', () => {
  const endpoints = section(MD, 'Endpoints');
  const endpointRows = lines(endpoints).filter(l => l.startsWith('|'));

  it.each(Object.entries(API))(
    '%s has an endpoint row with its route and error codes',
    (_key, endpoint) => {
      const route = `\`${endpoint.method} ${docPath(endpoint.path)}\``;
      const row = endpointRows.find(l => l.includes(route));
      expect(row, route).toBeDefined();
      for (const code of endpoint.codes) {
        expect(row, `${route} ${code}`).toContain(`\`${code}\``);
      }
    },
  );

  const errorRows = lines(section(MD, 'Error codes')).filter(l =>
    l.startsWith('|'),
  );

  it.each(ERROR_CODES)('error code %s has a row with its status', code => {
    const row = errorRows.find(l => l.includes(`\`${code}\``));
    expect(row, code).toBeDefined();
    expect(row).toMatch(new RegExp(`\\b${ERROR_STATUS[code]}\\b`));
  });
});

describe('renderSkill: curl examples', () => {
  it('has curl examples outside the install section', () => {
    expect(GAME_CURLS.length).toBeGreaterThan(0);
  });

  it('gives every curl --max-time 40, except the install one-liner', () => {
    const saveCurls = curls(SAVE);
    for (const { command } of ALL_CURLS) {
      if (
        saveCurls.some(c => c.command === command) &&
        command.includes('-fsSL')
      )
        continue;
      expect(command).toContain('--max-time 40');
    }
  });

  it('uses only $CASINO_URL, $CASINO_TOKEN, $ROOM_ID and $TURN_ID', () => {
    const allowed = ['CASINO_URL', 'CASINO_TOKEN', 'ROOM_ID', 'TURN_ID'];
    for (const { command } of GAME_CURLS) {
      for (const [, name] of command.matchAll(/\$\{?([A-Za-z_]\w*)\}?/g)) {
        expect(allowed, command).toContain(name);
      }
    }
  });

  it('points every curl at "$CASINO_URL/…"', () => {
    for (const { command, path } of GAME_CURLS) {
      expect(path, command).toBeDefined();
      expect(command).not.toMatch(/https?:\/\//);
    }
  });

  it('sends the room token only to room endpoints', () => {
    const bearer = 'Authorization: Bearer $CASINO_TOKEN';
    const room = /^v1\/rooms\/\$ROOM_ID\/(wait|state|actions|leave)$/;
    const open = /^v1\/(queue|rooms|rooms\/\$ROOM_ID\/join|leaderboard)$/;
    const paths = GAME_CURLS.map(c => c.path);
    expect(paths.some(p => p && room.test(p))).toBe(true);
    for (const { command, path = '' } of GAME_CURLS) {
      if (room.test(path)) expect(command).toContain(bearer);
      if (open.test(path)) expect(command).not.toContain('Authorization');
    }
  });

  it.each(Object.entries(EXAMPLES).filter(([, e]) => e.request !== undefined))(
    'renders the %s request body as a curl -d',
    (key, example) => {
      const endpoint = API[key];
      expect(endpoint).toBeDefined();
      // The curl's path is the endpoint's, with :room_id as $ROOM_ID.
      const pathPattern = new RegExp(
        `^${(endpoint?.path ?? '')
          .slice(1)
          .replace(':room_id', '\\$ROOM_ID')
          .replace(/:\w+/g, '[^/"]+')}$`,
      );
      const arg = dArg(example.request);
      const match = ALL_CURLS.find(
        c => c.command.includes(arg) && pathPattern.test(c.path ?? ''),
      );
      expect(match, arg).toBeDefined();
    },
  );

  it('renders every response example as pretty JSON in a json block', () => {
    const blocks = fenced(MD, 'json');
    for (const [key, example] of Object.entries(EXAMPLES)) {
      for (const response of example.responses) {
        const json = JSON.stringify(response.body, null, 2);
        expect(
          blocks.some(b => b.includes(json)),
          `${key}: ${response.title}`,
        ).toBe(true);
      }
    }
  });
});

describe('renderSkill: base URL', () => {
  it.each(['https://casino.example', 'https://other.test'])(
    'fills in %s',
    baseUrl => {
      const md = renderSkill(baseUrl);
      expect(md).toContain(`export CASINO_URL=${baseUrl}`);
      expect(md).toContain(
        `curl -fsSL ${baseUrl}/skill.md -o ~/.claude/skills/agent-casino/SKILL.md`,
      );
      expect(md).toContain('~/.codex/skills/agent-casino/SKILL.md');
      expect(md).not.toContain('<平台網域>');
      // Compact request JSON like {"settings":{"hands":10}} legitimately ends
      // in `}}`; anything else left over is an unfilled template placeholder.
      let rest = md;
      for (const example of Object.values(EXAMPLES)) {
        if (example.request !== undefined)
          rest = rest.replaceAll(dArg(example.request), '');
      }
      expect(rest).not.toContain('{{');
      expect(rest).not.toContain('}}');
    },
  );

  it('changes with the base URL', () => {
    const other = renderSkill('https://other.test');
    expect(other).not.toContain('casino.example');
  });
});

describe('renderSkill: what an agent must know', () => {
  it('explains call and raise amounts and legal_actions', () => {
    const rules = section(MD, "Hold'em rules");
    expect(rules.toLowerCase()).toContain('how many more chips');
    expect(rules.toLowerCase()).toContain('raise to');
    expect(rules).toContain('legal_actions');
  });

  it('says what to do with each response', () => {
    const todo = section(MD, 'What to do with each response');
    for (const word of [
      'waiting',
      'your_turn',
      'invalid_action',
      'not_your_turn',
      'stale_turn',
      'match_over',
      'state',
    ]) {
      expect(todo, word).toContain(word);
    }
    expect(todo.toLowerCase()).toContain('network');
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
        'lobby.queue',
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
      responseDecodes('lobby.queue', 200, {
        status: 'matched',
        room_id: 'R_NOT_A14',
        seat: 0,
        token: 'x',
        hint: 'h',
      }),
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
    expect(statuses('lobby.queue')).toEqual(
      expect.arrayContaining(['matched', 'waiting']),
    );
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
