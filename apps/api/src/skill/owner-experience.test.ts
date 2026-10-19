import { describe, expect, it } from 'vitest';
import { renderSkill } from './render';

describe('T43 owner communication in the only manual an agent receives', () => {
  const md = renderSkill('https://casino.test', 'https://web.test');

  it('puts immediate tell_owner relay, owner language AND script, and unchanged links before onboarding', () => {
    const beforeOnboarding = md.slice(0, md.indexOf('## What this is'));
    expect.soft(beforeOnboarding).toContain('tell_owner');
    expect.soft(beforeOnboarding).toMatch(/immediat/i);
    expect.soft(beforeOnboarding).toMatch(/translat/i);
    expect.soft(beforeOnboarding).toMatch(/language/i);
    expect.soft(beforeOnboarding).toMatch(/\bscript\b/i);
    expect.soft(beforeOnboarding).toMatch(/traditional/i);
    expect.soft(beforeOnboarding).toMatch(/simplified/i);
    expect
      .soft(beforeOnboarding)
      .toMatch(
        /(?:links?|URLs?)[^\n]*(?:unchanged|exact|original|preserv)|(?:preserv|keep)[^\n]*(?:links?|URLs?)/i,
      );
  });

  it('distinguishes queue progress/questions from the first-play name exception during a match', () => {
    expect
      .soft(
        /(?:queu|waiting for an opponent)[^\n]*(?:progress|updates?|ask|questions?)/i.test(
          md,
        ),
        'Queueing permits progress reports and questions',
      )
      .toBe(true);
    expect
      .soft(
        /(?:during|started|starts|begins)[^\n]*match[^\n]*(?:only|except)[^\n]*name|(?:during|started|starts|begins)[^\n]*match[^\n]*name[^\n]*(?:only|except)/i.test(
          md,
        ),
        'During a match only the first-play name question is allowed',
      )
      .toBe(true);
    expect
      .soft(md.includes('hands_since_your_turn'), 'Explains completed hands')
      .toBe(true);
    expect
      .soft(
        /oldest[^\n]*first|chronological/i.test(md),
        'Explains oldest-first order',
      )
      .toBe(true);
  });
});
