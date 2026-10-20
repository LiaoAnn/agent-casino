import { describe, expect, it } from 'vitest';
import { renderKitSkill, renderLlmsTxt, renderSkill } from './render';

const BASE = 'https://kit.example:8443';
const FILES = [
  'agent-casino/SKILL.md',
  'agent-casino/scripts/casino.sh',
  'agent-casino-holdem/SKILL.md',
];
const DIRS = ['.claude/skills', '.agents/skills', '.casino/kit'];
const blocks = (md: string) =>
  [...md.matchAll(/^```(?:bash|sh|shell)\n([\s\S]*?)^```$/gm)].map(
    m => m[1] ?? '',
  );

describe('A24 kit content', () => {
  it('provides a short llms.txt entry, ordered project installs and direct file links', () => {
    const md = renderLlmsTxt(BASE);
    expect(md.split('\n')[0]).toMatch(/^# /);
    // WebFetch-style tools summarize pages with a small model, so the curl
    // instruction is the first thing after the title, in one short sentence.
    const intro =
      md
        .split('\n')
        .slice(1)
        .find(line => line.trim()) ?? '';
    const first = intro.split(/(?<=\.) /)[0] ?? '';
    expect(first).toMatch(/^> /);
    expect(first).toMatch(/`curl`/);
    expect(first).toMatch(/this file/i);
    expect(first).toMatch(/skill files/i);
    expect(first).toMatch(/summari[sz]e/i);
    expect(first.length).toBeLessThanOrEqual(140);
    // T54: the owner may only say "read llms.txt with curl", so first ask
    // what to do; go ahead when they already said; keep a saved name.
    const ask = md.slice(0, md.indexOf('## Install'));
    expect(ask).toMatch(/only (?:asked|told) you to read this file/i);
    expect(ask).toMatch(/ask[^.]*install[^.]*play[^.]*name/i);
    expect(ask).toMatch(/wait for (?:the|their) answer/i);
    expect(ask).toMatch(/already[^.]*(?:play|name)[^.]*without asking again/i);
    expect(ask).toMatch(/`\.casino\/profile\.json`[^.]*keep/i);
    // The install commands come before the other sections.
    const fences = [...md.matchAll(/^```/gm)].map(m => m.index);
    expect(fences).toHaveLength(6);
    expect(md.indexOf('## Install')).toBeGreaterThan(-1);
    for (const index of fences)
      expect(index).toBeLessThan(md.indexOf('\n## ', md.indexOf('## Install')));
    expect(md.trimEnd().split('\n').length).toBeLessThanOrEqual(40);
    expect(md).toMatch(/no real money/i);
    expect(md).not.toMatch(/heads[- ]up/i);
    expect(md).toMatch(/owner.*watch.*web/i);
    expect(md).toMatch(/no shell/i);
    expect(md).toContain(`](${BASE}/skill.md)`);
    expect(md).toMatch(/read.*agent-casino\/SKILL\.md/i);
    expect(md).toMatch(/right away|immediately/i);
    expect(md).not.toContain('{{');
    const installs = blocks(md);
    expect(installs).toHaveLength(3);
    expect(md.indexOf('Claude Code')).toBeLessThan(md.indexOf('Codex'));
    expect(md).toMatch(/Codex.*pi/);
    for (const [index, block] of installs.entries()) {
      const dir = DIRS[index];
      expect(block).not.toMatch(/\btar\b|\|\s*(?:ba)?sh\b|~\//);
      const commands = block
        .split(/\n|&&/)
        .map(line => line.trim())
        .filter(Boolean);
      expect(commands).toHaveLength(3);
      for (const command of commands) {
        expect(command).toMatch(/^curl\s/);
        expect(command).toContain('--create-dirs');
      }
      for (const file of FILES) {
        expect(block).toContain(`${BASE}/skills/${file}`);
        expect(block).toContain(`${dir}/${file}`);
        expect(md).toContain(`](${BASE}/skills/${file})`);
      }
    }
  });

  it.each(['agent-casino', 'agent-casino-holdem'] as const)(
    '%s has YAML metadata and bounded resolved content',
    name => {
      const md = renderKitSkill(name, BASE);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
        md,
      )?.[1];
      expect(frontmatter).toBeDefined();
      expect(frontmatter).toMatch(new RegExp(`^name: ${name}$`, 'm'));
      // The template uses plain YAML scalars, not a custom metadata format.
      expect(frontmatter).toMatch(/^description: \S.+$/m);
      expect(md.trimEnd().split('\n').length).toBeLessThanOrEqual(160);
      expect(md).toContain('kit.example:8443');
      expect(md).not.toContain('{{');
      expect(md).not.toContain('<!-- part ');
    },
  );

  it('core teaches relay, profile, script locations, watch and final report', () => {
    const md = renderKitSkill('agent-casino', BASE);
    for (const text of [
      'agent-casino-holdem',
      'TELL YOUR OWNER',
      'tell_owner',
      'Traditional and Simplified Chinese',
      'profile',
      'play',
      'start',
      'room create',
      'room join',
      'display_name',
      'watch',
      'report',
      'Next:',
      '.casino/',
    ])
      expect(md).toContain(text);
    expect(md).toMatch(/owner cannot see command output/i);
    expect(md).toMatch(/own reply/);
    expect(md).toMatch(/own message|its own message/);
    expect(md).toMatch(/links? unchanged|link unchanged/);
    expect(md).toMatch(/language and script/);
    expect(md).toMatch(/first turn.*twice|first turn.*60 seconds/);
    expect(md).toMatch(/no questions|ask no questions/);
    expect(md).toMatch(/180 seconds|3 minutes/);
    expect(blocks(md).join('\n')).not.toMatch(/casino\.sh queue\b/);
    expect(md).toMatch(/30 seconds/);
    expect(md).toMatch(
      /house-bot[^\n]*(?:unrated|not rated|no Elo|not count)/i,
    );
    expect(md).toMatch(
      /(?:while|until|before)[^\n]*(?:answer|repl)[^\n]*wait|wait[^\n]*(?:while|until|before)[^\n]*(?:answer|repl)/i,
    );
    expect(md).toMatch(/(?:2|two)[ -]minutes?/i);
    expect(md).toMatch(/match_over/);
    expect(md).toMatch(/(?:eliminat|bust|lost all|runs out)/i);
    expect(md).toMatch(
      /(?:Elo|rating)[^\n]*(?:table|whole|entire)[^\n]*(?:finish|end)|(?:table|whole|entire)[^\n]*(?:finish|end)[^\n]*(?:Elo|rating)/i,
    );
    expect(md).toMatch(/report.*result[\s\S]*chips[\s\S]*Elo[\s\S]*link/);
    for (const dir of DIRS)
      expect(md).toContain(`sh ${dir}/agent-casino/scripts/casino.sh`);
  });

  it.each([
    ['manual', renderSkill(BASE).split('## Save as a skill')[0] ?? ''],
    ['core kit', renderKitSkill('agent-casino', BASE)],
  ])('%s teaches host choices, private tables and elimination', (_name, md) => {
    expect(md).toMatch(/room create[\s\S]*room join/i);
    expect(md).toMatch(/private/i);
    expect(md).toMatch(
      /(?:up to|maximum|max|at most)[^\n]*(?:6|six)|(?:2[-–]6|2 to 6)/i,
    );
    expect(md).toMatch(/host[^\n]*start|start[^\n]*host/i);
    expect(md).toMatch(
      /(?:roster|seats|seated|lineup)[^\n]*(?:chang|different)|(?:chang|different)[^\n]*(?:roster|seats|seated|lineup)/i,
    );
    expect(md).toMatch(
      /start now|start (?:the match|playing)|start immediately/i,
    );
    expect(md).toMatch(
      /house-bot[^\n]*(?:fill|empty|open|seat)|(?:fill|empty|open)[^\n]*house-bot/i,
    );
    expect(md).toMatch(/keep waiting|continue waiting/i);
    expect(md).toMatch(
      /(?:while|until|before)[^\n]*(?:answer|repl)[^\n]*wait|wait[^\n]*(?:while|until|before)[^\n]*(?:answer|repl)/i,
    );
    expect(md).toMatch(/(?:3|three) minutes|180 seconds/i);
    expect(md).toMatch(/leave/i);
    expect(md).toMatch(/match_over[\s\S]*(?:exit[^\n]*3|\|[^\n]*3)/i);
    expect(md).toMatch(
      /(?:Elo|rating|points)[^\n]*(?:table|whole|entire)[^\n]*(?:finish|end)|(?:table|whole|entire)[^\n]*(?:finish|end)[^\n]*(?:Elo|rating|points)/i,
    );
  });

  it.each([
    ['manual', renderSkill(BASE).split('## Appendix: the HTTP API')[0] ?? ''],
    ['holdem kit', renderKitSkill('agent-casino-holdem', BASE)],
  ])(
    '%s teaches table fields, total raises, blinds and 2–6 player rules',
    (_name, md) => {
      // These output labels belong to the dedicated holdem kit.
      if (_name === 'holdem kit') {
        for (const text of [
          'Legal:',
          'Time left:',
          'Your cards',
          'Board',
          'Pot',
          'Since your last move',
          'This hand so far',
          'raise',
          'total',
          'small blind',
          'big blind',
          'button',
          'flop',
          'turn',
          'river',
          'all-in',
        ])
          expect(md).toContain(text);
      }
      expect(md).toMatch(/2\s*[-–]\s*6|two to six/i);
      expect(md).toMatch(/button[^\n]*(?:mov|next)|(?:mov|next)[^\n]*button/i);
      expect(md).toMatch(/(?:3|three)[^\n]*(?:players|more)/i);
      expect(md).toMatch(
        /small blind[^\n]*(?:next|left)[^\n]*button|button[^\n]*(?:next|left)[^\n]*small blind/i,
      );
      expect(md).toMatch(
        /big blind[^\n]*(?:next|left)[^\n]*small blind|small blind[^\n]*(?:next|left)[^\n]*big blind/i,
      );
      expect(md).toMatch(
        /before the flop[^\n]*(?:after|left|next)[^\n]*big blind/i,
      );
      expect(md).toMatch(
        /after the flop[^\n]*(?:after|left|next)[^\n]*button/i,
      );
      expect(md).toMatch(
        /(?:2|two)[^\n]*(?:remain|left)|(?:remain|left)[^\n]*(?:2|two)/i,
      );
      expect(md).toMatch(/button[^\n]*(?:is|=)[^\n]*small blind/i);
      expect(md).toMatch(
        /before the flop[^\n]*button[^\n]*first|button[^\n]*first[^\n]*before the flop/i,
      );
      expect(md).toMatch(
        /after the flop[^\n]*big blind[^\n]*first|big blind[^\n]*first[^\n]*after the flop/i,
      );
      expect(md).toMatch(/side pots?/i);
      expect(md).toMatch(
        /(?:each|every)[^\n]*pot[^\n]*(?:eligib|win)|eligib[^\n]*pot/i,
      );
      expect(md).toMatch(/place|rank/i);
      expect(md).toMatch(
        /(?:same hand|simultaneous)[^\n]*(?:start|before)[^\n]*(?:chips|stack)/i,
      );
      expect(md).toMatch(/max_hands[^\n]*(?:chips|stack|rank|place)/i);
      expect(md).toMatch(/(?:2[-–]3|2 to 3)[^\n]*5/i);
      expect(md).toMatch(/4[^\n]*4[^\n]*hands?/i);
      expect(md).toMatch(/(?:5[-–]6|5 to 6)[^\n]*3/i);
      expect(md).toMatch(/double/);
      expect(md).toMatch(/tie splits|split.*pot/);
      expect(md).toMatch(/before the flop.*blind counts|blind counts.*bet/);
    },
  );
});
