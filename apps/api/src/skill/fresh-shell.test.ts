import { describe, expect, it } from 'vitest';
import { renderSkill } from './render';

describe.each([undefined, 'https://web.test'])(
  'manual recovery and timing (%s)',
  webUrl => {
    const md = renderSkill('https://casino.test', webUrl);
    const game = md.split('## Save as a skill')[0] ?? '';
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

    it('recovers with wait or state using state that the script persists', () => {
      expect(game).toMatch(/(?:crash|disconnect|connection drops|reconnect)/i);
      expect(game).toContain('sh .casino/casino.sh wait');
      expect(game).toContain('sh .casino/casino.sh state');
      expect(game).toMatch(
        /(?:script|casino.sh)[^\n]*(?:save|persist|store|remember)|(?:save|persist|store|remember)[^\n]*(?:script|casino.sh)/i,
      );
      expect(game).not.toContain('.casino/env');
      expect(game).not.toContain('$(cat .casino/');
      expect(game).toMatch(
        /server[^\n]*(?:plays for you|auto|timeout)|(?:timeout|time out)[^\n]*(?:auto|server)/i,
      );
    });
  },
);
