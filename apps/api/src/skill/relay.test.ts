// The script owns decoded output and files (casino-sh.test.ts). The manual
// must teach the agent how to relay that output to a human who cannot see it.
import { describe, expect, it } from 'vitest';
import { renderSkill } from './render';

const BEGIN =
  '>>> TELL YOUR OWNER (write this in your reply, in their language) <<<';
const END = '>>> END <<<';

describe.each([undefined, 'https://web.test'])(
  'manual owner relay (%s)',
  webUrl => {
    const md = renderSkill('https://casino.test', webUrl);
    const game = md.split('## Save as a skill')[0] ?? '';
    const top = md.slice(0, md.indexOf('## What this is'));
    it('identifies the exact output markers before the first section', () => {
      expect(top).toContain(BEGIN);
      expect(top).toContain(END);
      expect(top).toContain('tell_owner');
    });
    it.each(['top', 'matched', 'match_over'])(
      '%s explains a full, immediate, separate reply',
      location => {
        // Acquisition and reporting prose may use any heading level or title.
        const chunks = game.split(/(?=^#{2,4} )/m);
        const text =
          location === 'top'
            ? top
            : (chunks.find(chunk =>
                chunk.includes(
                  `sh .casino/casino.sh ${location === 'matched' ? 'queue' : 'report'}`,
                ),
              ) ?? '');
        expect(text).toMatch(/(?:cannot|can't)[\s\S]*command output/i);
        expect(text).toMatch(
          /only[\s\S]*(?:you|agent)[\s\S]*(?:text|writ|words|message|repl)/i,
        );
        expect(text).toMatch(
          /(?:writ|put|send|include)[\s\S]*(?:reply|response|message)/i,
        );
        expect(text).toMatch(
          /(?:whole|full|entire|complete)[\s\S]*(?:tell_owner|sentence|message|block)|tell_owner[\s\S]*(?:whole|full|entire|complete)/i,
        );
        expect(text).toMatch(
          /(?:links?|URLs?)[\s\S]*(?:unchanged|exact|original)|(?:keep|preserv)[\s\S]*(?:links?|URLs?)/i,
        );
        expect(text).toMatch(
          /(?:separate|standalone|stand-alone)[ -](?:message|reply)|(?:its|your|their) own message/i,
        );
        expect(text).toMatch(/immediat|right away|at once/i);
      },
    );
  },
);
