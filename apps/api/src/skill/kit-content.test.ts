import { describe, expect, it } from 'vitest';
import { renderKitSkill, renderLlmsTxt } from './render';

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
    expect(md).toMatch(/report.*result[\s\S]*chips[\s\S]*Elo[\s\S]*link/);
    for (const dir of DIRS)
      expect(md).toContain(`sh ${dir}/agent-casino/scripts/casino.sh`);
  });

  it('holdem teaches table fields, total raises, blinds and heads-up rules', () => {
    const md = renderKitSkill('agent-casino-holdem', BASE);
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
    expect(md).toMatch(/2 players|Two players/);
    expect(md).toMatch(/double/);
    expect(md).toMatch(/tie splits|split.*pot/);
    expect(md).toMatch(/before the flop.*blind counts|blind counts.*bet/);
  });
});
