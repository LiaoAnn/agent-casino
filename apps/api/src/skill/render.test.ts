// T05: skill.md is the only manual a participating agent gets, so it is
// generated from the contract (casino-api skill: skill.md, A12) and every curl
// in it must run as is with $CASINO_URL, $ROOM_ID and $TURN_ID, reading the
// room token and queue_key from the files the agent saved them in (T27).
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

// The endpoint a curl path (`v1/rooms/$ROOM_ID/leave?x=1`) points at, if any.
const endpointOf = (curlPath: string): Reflected | undefined => {
  const path = curlPath.split('?')[0] ?? '';
  return Object.values(API).find(endpoint =>
    new RegExp(
      `^${endpoint.path
        .slice(1)
        .replace(':room_id', '\\$ROOM_ID')
        .replace(/:\w+/g, '[^/"]+')}$`,
    ).test(path),
  );
};

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
  'Quick start',
  'If your program crashes or the connection drops',
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

  // Which credential to send, from the endpoint's middleware: the room token,
  // nothing, or the admin key. The route cell is left out, since admin paths
  // contain `admin` themselves.
  it.each(Object.entries(API))(
    '%s row says which credential to send',
    (_key, endpoint) => {
      const route = `\`${endpoint.method} ${docPath(endpoint.path)}\``;
      const rest = (endpointRows.find(l => l.includes(route)) ?? '').replace(
        route,
        '',
      );
      expect(rest, route).not.toBe('');
      if (endpoint.auth === 'room') {
        expect(rest, route).toContain('Bearer $(cat .casino/$ROOM_ID.token)');
      } else if (endpoint.auth === 'none') {
        expect(rest, route).not.toMatch(/bearer/i);
        expect(rest, route).not.toMatch(/admin/i);
      } else {
        expect(rest, route).toMatch(/admin/i);
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

  // A code missing from the advice list would fall back to the same generic
  // sentence as another one.
  it('gives every error code its own advice in the last cell', () => {
    const advice = ERROR_CODES.map(code => {
      const row = errorRows.find(l => l.includes(`\`${code}\``)) ?? '';
      const cells = row.split('|').map(cell => cell.trim());
      // `| a | b | c |` splits into ['', 'a', 'b', 'c', ''].
      return cells.at(-1) === '' ? (cells.at(-2) ?? '') : (cells.at(-1) ?? '');
    });
    ERROR_CODES.forEach((code, i) => {
      expect(advice[i], code).not.toBe('');
      expect(advice[i], code).not.toMatch(new RegExp(`^\`${code}\`$`));
    });
    const repeated = advice.filter((text, i) => advice.indexOf(text) !== i);
    expect(repeated).toEqual([]);
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

  it('uses only $CASINO_URL, $ROOM_ID and $TURN_ID', () => {
    const allowed = ['CASINO_URL', 'ROOM_ID', 'TURN_ID'];
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
    const bearer = 'Authorization: Bearer $(cat .casino/$ROOM_ID.token)';
    const room = /^v1\/rooms\/\$ROOM_ID\/(wait|state|actions|leave)$/;
    const open = /^v1\/(queue|rooms|rooms\/\$ROOM_ID\/join|leaderboard)$/;
    const paths = GAME_CURLS.map(c => c.path);
    expect(paths.some(p => p && room.test(p))).toBe(true);
    for (const { command, path = '' } of GAME_CURLS) {
      if (room.test(path)) expect(command).toContain(bearer);
      if (open.test(path)) expect(command).not.toContain('Authorization');
    }
  });

  // `curl -d` without -X still POSTs, but a body-less POST like leave needs
  // -X POST, so every POST says it; a GET must not.
  it('uses the contract method in every How to play curl', () => {
    const post = /(^|\s)(-X|--request)\s*POST\b/;
    const checked: string[] = [];
    for (const { command, path } of curls(section(MD, 'How to play'))) {
      const endpoint = path === undefined ? undefined : endpointOf(path);
      if (!endpoint) continue;
      checked.push(`${endpoint.method} ${endpoint.path}`);
      if (endpoint.method === 'POST') expect(command).toMatch(post);
      if (endpoint.method === 'GET') expect(command).not.toMatch(post);
    }
    expect(checked).toEqual(
      expect.arrayContaining([
        'POST /v1/queue',
        'GET /v1/rooms/:room_id/wait',
        'POST /v1/rooms/:room_id/actions',
        'GET /v1/leaderboard',
      ]),
    );
    // leave has no body, so nothing but -X POST makes it a POST.
    const leave = GAME_CURLS.filter(c => c.path?.endsWith('/leave'));
    expect(leave.length).toBeGreaterThan(0);
    for (const { command } of leave) expect(command).toMatch(post);
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

  it('writes the bare host where a host, not a URL, is meant', () => {
    const md = renderSkill('https://other.test:8443');
    const description = lines(md).find(l => l.startsWith('description:'));
    expect(description).toContain('other.test:8443');
    expect(description).not.toContain('https://');

    // Codex's sandbox allow-list takes a host.
    const sandbox = lines(section(md, 'Save as a skill')).filter(
      l => l.includes('Codex') && /allow/i.test(l) && /network/i.test(l),
    );
    expect(sandbox.length).toBeGreaterThan(0);
    for (const line of sandbox) {
      expect(line).toContain('`other.test:8443`');
      expect(line).not.toContain('https://');
    }
  });

  it('changes with the base URL', () => {
    const other = renderSkill('https://other.test');
    expect(other).not.toContain('casino.example');
  });

  // T27 (arena proposal 7): no made-up domain in the examples; watch_url
  // points at the domain the agent reached.
  it('shows watch_url on the requested domain', () => {
    const other = renderSkill('https://other.test');
    const urls = [...other.matchAll(/"watch_url": "([^"]*)"/g)].map(
      m => m[1] ?? '',
    );
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url).toMatch(
        /^https:\/\/other\.test\/watch\/r_[a-z0-9]{10}\?token=\S+$/,
      );
    }
    expect(other).not.toContain('example.net');
  });
});

describe('renderSkill: what an agent must know', () => {
  it('explains call and raise amounts and legal_actions', () => {
    const rules = section(MD, "Hold'em rules");
    expect(rules.toLowerCase()).toContain('how many more chips');
    expect(rules.toLowerCase()).toContain('raise to');
    expect(rules).toContain('legal_actions');
  });

  // T27 (arena proposal 7): Haiku had 47 chips and was offered max 48.
  it("says raise max already counts this street's bet", () => {
    const rules = section(MD, "Hold'em rules");
    expect(rules).toMatch(/`max`[^\n]*`my_stack` \+ `my_bet_this_street`/);
  });

  // T27: the real deadline is Date.toISOString(), with milliseconds.
  it('shows deadline as the server writes it, with milliseconds', () => {
    const play = section(MD, 'How to play');
    const deadlines = [...MD.matchAll(/"deadline": "([^"]*)"/g)].map(
      m => m[1] ?? '',
    );
    expect(deadlines.length).toBeGreaterThan(0);
    for (const deadline of deadlines)
      expect(new Date(deadline).toISOString()).toBe(deadline);
    expect(play).toMatch(/milliseconds/);
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

  // T26 (casino-api A17), saved to a file since T27.
  it('makes one queue_key file before queueing and sends it on every queue call', () => {
    const play = section(MD, 'How to play');
    const make = play.search(
      /openssl rand -hex 16\s*>\s*\.casino\/alice\.queue_key/,
    );
    const queue = play.indexOf(
      '\\"queue_key\\":\\"$(cat .casino/alice.queue_key)\\"',
    );
    expect(make).toBeGreaterThan(0);
    expect(queue).toBeGreaterThan(make);
    // Saved once, never made again for this match.
    expect(play).toMatch(/same `queue_key`/);
    expect(play).toMatch(/do not run `openssl` again/i);
  });

  // T27: no long token pasted into every command, one file set per room so
  // several matches can run at once, deleted after the report.
  it('saves the token and queue_key per room, and deletes them after reporting', () => {
    const play = section(MD, 'How to play');
    const blocks = fenced(play, 'bash');
    const matched = blocks.findIndex(
      b =>
        b.includes('> .casino/$ROOM_ID.token') &&
        b.includes('mv .casino/alice.queue_key .casino/$ROOM_ID.queue_key'),
    );
    const joined = blocks.findIndex(
      (b, i) => i !== matched && b.includes('> .casino/$ROOM_ID.token'),
    );
    const cleanup = blocks.findIndex(b => b.includes('rm .casino/$ROOM_ID.*'));
    const queue = blocks.findIndex(b => b.includes('"$CASINO_URL/v1/queue"'));
    const leaderboard = blocks.findIndex(b =>
      b.includes('"$CASINO_URL/v1/leaderboard"'),
    );
    expect(matched).toBeGreaterThan(queue);
    expect(joined).toBeGreaterThan(matched);
    expect(cleanup).toBeGreaterThan(leaderboard);
    for (const b of [matched, joined])
      expect(blocks[b]).toMatch(/^export ROOM_ID=r_\w+$/m);
    expect(play).toMatch(/several matches/i);
    expect(play).toMatch(/same folder/i);
  });

  it('says how to get the same matched back after a crash, and what name_in_use means', () => {
    const play = section(MD, 'How to play');
    expect(play).toMatch(/crash[^\n]*same name[^\n]*same `queue_key`/);
    const todo = section(MD, 'What to do with each response');
    expect(todo).toMatch(/\| error `name_in_use` [^\n]*`queue_key`/);
    expect(todo).toMatch(/network error[^\n]*`queue_key`/);
  });

  // T23 (casino-api A16).
  it('says to hand watch_url to the owner and explains the new seat fields', () => {
    const play = section(MD, 'How to play');
    expect(play).toMatch(/`watch_url`[^\n]*owner/);
    expect(play).toMatch(/read-only/);
    expect(play).toContain('`opponent_name`');
    expect(play).toContain('`settings`');
  });

  it('offers an optional note of at most 500 characters that only the owner sees', () => {
    const play = section(MD, 'How to play');
    expect(play).toMatch(/`note`/);
    expect(play).toContain('500 characters');
    expect(play).toMatch(/opponent never/);
    expect(play).toMatch(/never let writing it make you miss the deadline/);
  });

  // T27: arena players skipped the note, or wrote it in English to an owner
  // who spoke another language.
  it('suggests a note on every action, in the language the owner uses', () => {
    const play = section(MD, 'How to play');
    expect(play).toMatch(/note[^\n]*every action/i);
    expect(play).toMatch(/language your owner/i);
  });

  // T27 (arena proposal 1): what "a game" is and the whole flow, up front.
  it('starts with a quick start: one match of 10 hands, and the whole flow', () => {
    const quick = section(MD, 'Quick start');
    expect(quick).toMatch(/one match/i);
    expect(quick).toMatch(/10 hands/);
    expect(quick).toContain('`settings.hands`');
    const order = [
      quick.indexOf('POST /v1/queue'),
      quick.indexOf('`watch_url`'),
      quick.indexOf('wait'),
      quick.indexOf('actions'),
      quick.indexOf('match_over'),
    ];
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(quick).toMatch(/report/i);
  });

  // T27 (arena proposal 1): names are public and not accounts.
  it('says how to pick a name when none was given, and that names are shared', () => {
    const quick = section(MD, 'Quick start');
    expect(quick).toMatch(/no name/i);
    expect(quick).toContain('<model>-<4 random');
    expect(quick).toMatch(/public/i);
    expect(quick).toMatch(/same name[^\n]*rating[^\n]*record/i);
  });

  // T27 (arena proposal 8, casino-api A17).
  it('says what to do after a crash, near the top', () => {
    const crash = section(
      MD,
      'If your program crashes or the connection drops',
    );
    expect(crash).toContain('.casino/$ROOM_ID.token');
    expect(crash).toMatch(/`wait`[^\n]*`state`/);
    expect(crash).toMatch(/plays for you/);
    expect(crash).toMatch(/same name[^\n]*same `queue_key`[^\n]*`matched`/);
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
