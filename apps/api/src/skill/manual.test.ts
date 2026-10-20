import { describe, expect, it } from 'vitest';
import { renderSkill } from './render';

describe.each([undefined, 'https://web.test'])(
  'casino.sh-first manual (%s)',
  webUrl => {
    const md = renderSkill('https://casino.test', webUrl);
    const game = md.split('## Save as a skill')[0] ?? '';
    const blocks = [...game.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(m =>
      (m[1] ?? '').trim(),
    );

    it('downloads the script first, then uses only single-line script commands', () => {
      expect(blocks[0]).toBe(
        'mkdir -p .casino && curl -fsS https://casino.test/casino.sh -o .casino/casino.sh && sh .casino/casino.sh help',
      );
      expect(blocks.length).toBeGreaterThan(3);
      expect(blocks.join('\n')).not.toMatch(/casino\.sh queue\b/);
      for (const block of blocks.slice(1)) {
        expect
          .soft(block)
          .toMatch(/^sh \.casino\/casino\.sh [a-z]+(?: [^\n]+)?$/);
        expect
          .soft(block)
          .not.toMatch(
            /\$|\b(?:curl|sed|jq|openssl|node|python|export)\b|\.casino\/env|&&|;/,
          );
      }
    });

    it('orders onboarding, play, recovery, rules, installation and the final HTTP appendix', () => {
      const positions = [
        game.indexOf('## What this is'),
        game.search(/^#{2,3} Step 1[^\n]*download/im),
        game.indexOf('sh .casino/casino.sh profile'),
        game.indexOf('sh .casino/casino.sh play'),
        game.indexOf('sh .casino/casino.sh wait'),
        game.indexOf('sh .casino/casino.sh act'),
        game.indexOf('sh .casino/casino.sh report'),
        game.search(
          /^#{2,3} [^\n]*(?:troubleshoot|connection drops|crash|wrong)/im,
        ),
        game.indexOf("## Hold'em rules"),
        md.indexOf('## Save as a skill'),
        md.indexOf('## Appendix: the HTTP API'),
      ];
      expect(
        positions.every(p => p >= 0),
        positions.join(', '),
      ).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(md.match(/^## .+$/gm)?.at(-1)).toBe('## Appendix: the HTTP API');
    });

    it.each([
      'help',
      'version',
      'profile',
      'play',
      'start',
      'bot',
      'room create',
      'room join',
      'wait',
      'act',
      'state',
      'leave',
      'report',
    ])('explains %s in the play part', command => {
      expect(game).toContain(`sh .casino/casino.sh ${command}`);
    });

    it('uses exit codes and Next to explain how to continue', () => {
      expect(game).toContain('Next:');
      for (const [code, meaning] of [
        [0, 'success|your turn'],
        [1, 'error'],
        [2, 'wait'],
        [3, 'finish|over|end|report'],
      ] as const) {
        expect(game).toMatch(
          new RegExp(
            `(?:exit(?: code)?[ :\\x60]*|\\|[ \\x60]*)${code}[^\\n]*(?:${meaning})`,
            'i',
          ),
        );
      }
      expect(game).toMatch(/(?:exit[^\n]*3|\b3\b)[^\n]*report/i);
      expect(game).toMatch(
        /(?:exit[^\n]*2|\b2\b)[^\n]*(?:Next:|again|repeat)/i,
      );
      expect(game).toMatch(/check[^\n]*fold|fold[^\n]*check/i);
      expect(game).toMatch(/40 seconds|40 s\b/i);
    });

    it('explains multiplayer seating, elimination and deadlines', () => {
      expect(game).toMatch(/(?:2|two)\s*[-–]\s*(?:6|six)/i);
      expect(game).toMatch(/room create[\s\S]*private/i);
      expect(game).toMatch(/(?:host[^\n]*start|start[^\n]*host)/i);
      expect(game).toMatch(
        /start[^\n]*(?:bots|house-bot)|house-bot[^\n]*start/i,
      );
      expect(game).toMatch(/casino\.sh start (?:[1-5]\b|N\b|<bots>|\[bots\])/i);
      expect(game).toMatch(/30\s*(?:seconds|s\b)/i);
      expect(game).toMatch(/first[^\n]*(?:60\s*seconds|twice)/i);
      expect(game).toMatch(
        /(?:bust|eliminat|lost all|runs out|zero)[\s\S]*match_over/i,
      );
      expect(game).toMatch(
        /(?:match_over|eliminat)[\s\S]*exit[^\n]*3[\s\S]*report/i,
      );
      expect(game).toMatch(
        /(?:Elo|rating|points)[^\n]*(?:whole|entire|table)[^\n]*(?:end|finish)|(?:whole|entire|table)[^\n]*(?:end|finish)[^\n]*(?:Elo|rating|points)/i,
      );
    });

    it('explains persistent state without requiring the agent to edit it', () => {
      expect(game).toContain('.casino/');
      expect(game).toMatch(
        /(?:do not|don't|never|no need to)[^\n]*(?:edit|touch|read|manage)[^\n]*(?:files|\.casino)/i,
      );
      expect(game).toMatch(
        /one[^\n]*(?:active|ongoing|progress)[^\n]*room|one[^\n]*room[^\n]*(?:time|folder)/i,
      );
      expect(game).toMatch(
        /profile[^\n]*(?:keep|retain|preserv)|(?:keep|retain|preserv)[^\n]*profile/i,
      );
      expect(game).toMatch(
        /report[^\n]*(?:clean|delet|remov)|(?:clean|delet|remov)[^\n]*report/i,
      );
    });

    it('explains play alternatives and private-room inactivity', () => {
      expect(game).toMatch(/bot[^\n]*(?:unrated|not rated|no Elo|not count)/i);
      expect(game).toMatch(
        /(?:2|two)[ -]minutes?[^\n]*(?:cancel|expir|clos)|(?:cancel|expir|clos)[^\n]*(?:2|two)[ -]minutes?/i,
      );
      expect(game).toMatch(
        /room join[^\n]*(?:invite|code)|(?:invite|code)[^\n]*room join/i,
      );
      expect(game).toMatch(
        /leave[^\n]*(?:loss|lose|forfeit)|(?:loss|lose|forfeit)[^\n]*leave/i,
      );
    });
  },
);
