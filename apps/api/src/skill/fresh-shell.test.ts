// T48 / A12, A21, A22: the rendered manual is the player's public interface.
import { describe, expect, it } from 'vitest';
import { renderSkill } from './render';

const blocks = (text: string) =>
  [...text.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map(m => m[1] ?? '');

const step = (md: string, number: number) => {
  const rest = md.slice(md.indexOf(`### Step ${number}`));
  return rest.split(/\n#{2,3} /)[0] ?? '';
};

describe.each([undefined, 'https://web.test'])(
  'T48 manual with fresh shells (web URL %s)',
  webUrl => {
    const md = renderSkill('https://casino.test', webUrl);
    const game = md.split('## Save as a skill')[0] ?? '';

    it('creates env once, then sources it at the start of every game bash block', () => {
      const gameBlocks = blocks(game);
      const setup =
        "mkdir -p .casino && echo 'export CASINO_URL=https://casino.test' > .casino/env";
      expect(gameBlocks[0]?.trim()).toBe(setup);
      expect(gameBlocks.length).toBeGreaterThan(1);
      for (const block of gameBlocks.slice(1)) {
        expect
          .soft(block, 'every copied block must restore its own environment')
          .toMatch(/^\. \.casino\/env && /);
      }
    });

    it('persists the supplied room id before join, and overwrites env after each seat acquisition', () => {
      const gameBlocks = blocks(game);
      const joinAt = gameBlocks.findIndex(b => b.includes('/join"'));
      expect(joinAt).toBeGreaterThan(0);
      const suppliedRoom = gameBlocks
        .slice(0, joinAt)
        .find(
          b =>
            b.includes('export ROOM_ID=r_8f2k1x9q0a') &&
            b.includes('>> .casino/env'),
        );
      expect(
        suppliedRoom,
        'join must first persist the supplied room id',
      ).toBeDefined();
      expect(suppliedRoom ?? '').toMatch(/^\. \.casino\/env && /);
      const saves = gameBlocks.filter(b => /ROOM_ID=[^\n]*sed/.test(b));
      expect(saves).toHaveLength(3);
      for (const save of saves) {
        expect.soft(save).toContain('export CASINO_URL=');
        expect.soft(save).toContain('export ROOM_ID=');
        expect.soft(save).toMatch(/(?:^|[^>])> \.casino\/env/);
        expect.soft(save).not.toContain('>> .casino/env');
      }
    });

    it.each([2, 3])(
      'Step %s saves turn_id with sed for the next shell',
      number => {
        const extract = blocks(step(md, number)).find(b =>
          b.includes('> .casino/$ROOM_ID.turn_id'),
        );
        expect(extract).toBeDefined();
        expect(extract).toMatch(/\bsed -n [^\n]*["']turn_id["']/);
        expect(extract).toContain('.casino/$ROOM_ID.state.json');
        expect(extract).not.toMatch(/export TURN_ID|\bjq\b/);
      },
    );

    it('restores both game variables from env when reconnecting', () => {
      const recovery =
        md
          .split('## If your program crashes or the connection drops')[1]
          ?.split(/\n## /)[0] ?? '';
      expect(recovery).toContain('. .casino/env');
      expect(recovery).toContain('CASINO_URL');
      expect(recovery).toContain('ROOM_ID');
    });

    it('explains the first doubled turn and subsequent ordinary turns', () => {
      expect(md).toMatch(
        /first[^\n]*turn[^\n]*(?:twice|double|2\s*[×x*])[^\n]*turn_seconds|first[^\n]*turn[^\n]*turn_seconds[^\n]*(?:twice|double|2\s*[×x*])/i,
      );
      expect(md).toMatch(/first[^.\n]*turn[^.\n]*60\s*(?:seconds|s\b)/i);
      expect(md).toMatch(
        /(?:after|subsequent|later|following|then)[^\n]*(?:turn|30)[^\n]*turn_seconds|(?:after|subsequent|later|following|then)[^\n]*turn_seconds[^\n]*(?:turn|30)/i,
      );
      expect(md).toMatch(
        /(?:after|subsequent|later|following|then)[^.\n]*30\s*(?:seconds|s\b)/i,
      );
    });

    it('Step 2 explains your_turn relay until the first accepted action', () => {
      const text = step(md, 2);
      expect(text).toContain('your_turn');
      expect(text).toContain('tell_owner');
      expect(text).toMatch(
        /(?:before|until)[\s\S]*first[\s\S]*(?:accepted|accepts)|first[\s\S]*(?:accepted|accepts)[\s\S]*(?:before|until)/i,
      );
    });

    it.each(['top', 'matched', 'match_over'])(
      '%s tells the agent to immediately write the full relay in a separate reply',
      location => {
        const text =
          location === 'top'
            ? md.slice(0, md.indexOf('## What this is'))
            : step(md, location === 'matched' ? 1 : 4);
        expect.soft(text).toContain('tell_owner');
        expect.soft(text).toMatch(/(?:cannot|can't)[\s\S]*command output/i);
        expect
          .soft(text)
          .toMatch(
            /only[\s\S]*(?:you|agent)[\s\S]*(?:text|writ|words|messages?|repl|responses?)/i,
          );
        expect
          .soft(text)
          .toMatch(
            /(?:writ|put|send|say|include)[\s\S]*(?:reply|response|message)/i,
          );
        expect
          .soft(text)
          .toMatch(
            /(?:whole|full|entire|complete)[\s\S]*(?:tell_owner|sentence|message)|tell_owner[\s\S]*(?:whole|full|entire|complete)/i,
          );
        expect
          .soft(text)
          .toMatch(
            /(?:full|complete|unchanged|exact|original)[\s\S]*(?:links?|URLs?)|(?:links?|URLs?)[\s\S]*(?:full|complete|unchanged|exact|original)/i,
          );
        expect
          .soft(text)
          .toMatch(
            /(?:its|your|their) own message|message of (?:its|your|their) own|(?:separate|standalone|stand-alone)[ -]message/i,
          );
        expect.soft(text).toMatch(/immediat|right away|at once/i);
      },
    );
  },
);
