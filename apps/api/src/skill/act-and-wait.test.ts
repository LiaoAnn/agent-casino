import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './examples';
import { renderSkill } from './render';

const MD = renderSkill('https://casino.example');
const game = MD.split('## Save as a skill')[0] ?? '';

describe('script-driven play loop', () => {
  it('acts on each turn, waits when waiting, and reports when finished', () => {
    expect(game).toContain('sh .casino/casino.sh act');
    expect(game).toContain('sh .casino/casino.sh wait');
    expect(game).toContain('sh .casino/casino.sh report');
    expect(game).toMatch(
      /act[^\n]*(?:next|wait|turn)|(?:next|wait|turn)[^\n]*act/i,
    );
    expect(game).toMatch(/(?:first turn|first wait|after[^\n]*seat)/i);
    expect(game).toMatch(/(?:waiting|exit[^\n]*2)[^\n]*(?:Next:|wait|again)/i);
    expect(game).toMatch(/(?:match_over|exit[^\n]*3)[^\n]*report/i);
  });
  it('explains automatic transport retry, turn recovery and rejected actions', () => {
    expect(game).toMatch(
      /(?:script|automatically)[^\n]*retr|retr[^\n]*(?:script|automatically)/i,
    );
    expect(game).toMatch(/(?:stale_turn|stale turn|expired turn)[^\n]*wait/i);
    expect(game).toMatch(
      /(?:invalid_action|invalid action|rejected)[^\n]*(?:legal|correct|again|change)/i,
    );
    expect(game).toMatch(/duplicate[^\n]*(?:not|nothing|no action|again)/i);
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
