// T47: the main loop sends each action with `?wait=1`, which answers the
// next your_turn or match_over like `wait` does; `GET /wait` stays for the
// first turn and for getting back in. The answer is saved and read with
// `sed`, as every other step does (T45, T46).
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './examples';
import { renderSkill } from './render';

const MD = renderSkill('https://casino.example');

// The text from the `### <title>` line up to the next `##`/`###` heading.
const step = (title: string) => {
  const start = MD.indexOf(`### ${title}`);
  if (start === -1) return '';
  const rest = MD.slice(start + 4);
  const end = rest.search(/\n##/);
  return end === -1 ? rest : rest.slice(0, end);
};

const bashBlocks = (text: string) =>
  [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1] ?? '');

const STEP_2 = step('Step 2');
const STEP_3 = step('Step 3');
const STEP_4 = step('Step 4');

describe('T47 skill.md: send the action and wait in one request', () => {
  it('Step 3 sends the action with ?wait=1 and saves the answer where Step 2 does', () => {
    const [send] = bashBlocks(STEP_3).filter(b => b.includes('curl'));
    expect(send).toContain('"$CASINO_URL/v1/rooms/$ROOM_ID/actions?wait=1"');
    expect(send).toContain('-o .casino/$ROOM_ID.state.json');
    expect(send).toContain('$TURN_ID');
  });

  it('Step 3 extracts the next turn_id from the saved answer with sed, not jq', () => {
    const extract = bashBlocks(STEP_3).find(
      b => !b.includes('curl') && b.includes('TURN_ID'),
    );
    expect(extract).toBeDefined();
    expect(extract).toMatch(/export TURN_ID=\$\(sed -n /);
    expect(extract).toContain('.casino/$ROOM_ID.state.json');
    for (const block of bashBlocks(MD)) expect(block).not.toMatch(/\bjq\b/);
  });

  it('Step 3 says what the answer is and loops back to Step 3, not Step 2', () => {
    expect(STEP_3).toMatch(/same as `wait`|like `wait`/);
    expect(STEP_3).toMatch(/`your_turn`[^\n]*(again|Step 3)/);
    expect(STEP_3).toMatch(/`waiting`[^\n]*`wait`/);
    expect(STEP_3).toMatch(/`match_over`[^\n]*Step 4/);
    expect(STEP_3).toMatch(/`tell_owner`/);
  });

  it('Step 3 says what to do when the action is refused', () => {
    expect(STEP_3).toMatch(
      /`invalid_action`[^\n]*same `turn_id`[^\n]*before the deadline/,
    );
    expect(STEP_3).toMatch(
      /`not_your_turn`[^\n]*`stale_turn`[^\n]*(?:don't|do not) resend[^\n]*Step 2/i,
    );
    expect(STEP_3).toMatch(/refused[^\n]*(at once|right away)/i);
  });

  it('Step 3 says a dropped connection is recovered by resending the same request', () => {
    expect(STEP_3).toMatch(
      /connection drops[^\n]*resend the same request[^\n]*same `turn_id`[^\n]*can't count twice/i,
    );
  });

  it('Step 2 uses wait only for the first turn and to get back in', () => {
    expect(STEP_2).toMatch(/first turn/);
    expect(STEP_2).toMatch(/get back in|reconnect/);
  });

  it('Step 4 loops Step 3 until match_over and prints tell_owner from the saved answer', () => {
    expect(STEP_4).toMatch(/Loop Step 3/);
    expect(STEP_4).toContain('.casino/$ROOM_ID.state.json');
    expect(STEP_4).toContain('tell_owner');
  });

  it('the table and the endpoint list point to ?wait=1', () => {
    expect(MD).toMatch(/\| `your_turn` \|[^\n]*\?wait=1/);
    expect(MD).toMatch(
      /\| `POST \/v1\/rooms\/\{room_id\}\/actions` \|[^\n]*\?wait=1[^\n]*30 s/,
    );
  });

  it('the action examples show what ?wait=1 answers, and accepted without it', () => {
    const answers = (EXAMPLES['room.act']?.responses ?? []).map(
      r => [r.status, (r.body as { status: string }).status, r.title] as const,
    );
    expect(answers.map(([status, body]) => [status, body])).toEqual(
      expect.arrayContaining([
        [200, 'your_turn'],
        [200, 'waiting'],
        [200, 'match_over'],
        [200, 'accepted'],
      ]),
    );
    expect(answers.find(([, body]) => body === 'accepted')?.[2]).toMatch(
      /without `\?wait=1`/,
    );
  });
});
