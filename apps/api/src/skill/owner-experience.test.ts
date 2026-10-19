import { describe, expect, it } from 'vitest';
import { renderSkill } from './render';

describe.each([undefined, 'https://web.test'])(
  'owner experience in the script manual (%s)',
  webUrl => {
    const md = renderSkill('https://casino.test', webUrl);
    const game = md.split('## Save as a skill')[0] ?? '';
    const top = md.slice(0, md.indexOf('## What this is'));
    it('puts immediate translation in the owner language and script before onboarding', () => {
      expect(top).toMatch(/immediat|at once|right away/i);
      expect(top).toMatch(/translat/i);
      expect(top).toMatch(/language/i);
      expect(top).toMatch(/\bscript\b/i);
      expect(top).toMatch(/Traditional/i);
      expect(top).toMatch(/Simplified/i);
      expect(top).toMatch(
        /links?[^\n]*(?:unchanged|exact|original)|(?:preserv|keep)[^\n]*links?/i,
      );
    });
    it('asks the display name only on the first visit and lets profile generate the identity', () => {
      expect(game.indexOf('sh .casino/casino.sh profile')).toBeGreaterThan(0);
      expect(game).toMatch(
        /(?:first visit|first time|no profile|missing profile)/i,
      );
      expect(game).toMatch(
        /(?:ask|question)[^\n]*(?:display name|call you|name)/i,
      );
      expect(game).toMatch(/public/i);
      expect(game).toMatch(
        /(?:do not|don't|never)[^\n]*ask again|(?:reuse|keep)[^\n]*profile/i,
      );
      expect(game).toMatch(
        /(?:script|profile)[^\n]*(?:generat|random)|(?:generat|random)[^\n]*(?:script|profile)/i,
      );
      expect(game).toContain('display_name');
      expect(game).toMatch(
        /same[^\n]*name[^\n]*(?:rating|record)|(?:rating|record)[^\n]*(?:keep|reuse|same)/i,
      );
      expect(game).not.toContain('openssl rand');
    });
    it('permits queue progress but asks no match questions beyond the first-visit name exception', () => {
      expect(game).toMatch(
        /(?:queu|waiting for an opponent)[^\n]*(?:progress|updates?)/i,
      );
      expect(game).toMatch(
        /(?:during|started|starts|begins)[^\n]*match[^\n]*(?:only|except|no questions)/i,
      );
      expect(game).toMatch(
        /(?:before|start)[^\n]*(?:explain|tell)[^\n]*owner|(?:explain|tell)[^\n]*owner[^\n]*(?:before|start)/i,
      );
      expect(game).toMatch(
        /(?:update|progress)[^\n]*(?:delay|deadline)|(?:delay|deadline)[^\n]*(?:update|progress)/i,
      );
    });
    it('asks after three minutes, offers all choices and respects prior owner instructions', () => {
      expect(game).toMatch(/(?:3|three) minutes|180/);
      expect(game).toMatch(
        /(?:queue_size|queue size|people[^\n]*queue|players[^\n]*queue)/i,
      );
      expect(game).toMatch(/(?:how long|waited|elapsed)/i);
      expect(game).toMatch(/keep waiting|continue waiting/i);
      expect(game).toMatch(/how (?:much )?long|for how long/i);
      expect(game).toMatch(/house-bot/);
      expect(game).toMatch(/unrated/);
      expect(game).toMatch(/stop/);
      expect(game).toMatch(
        /(?:ask|decid|choose)[^\n]*owner|owner[^\n]*(?:ask|decid|choose)/i,
      );
      expect(game).toMatch(
        /(?:don't|do not)[^\n]*decid[^\n]*(?:yourself|own)/i,
      );
      expect(game).toMatch(
        /owner[^\n]*(?:already|advance|beforehand)[^\n]*(?:follow|do|instruct)|(?:follow|respect)[^\n]*owner[^\n]*(?:instructions|decision)/i,
      );
      expect(game).toMatch(
        /(?:pause|stop)[^\n]*queu|(?:queu)[^\n]*(?:pause|stop)/i,
      );
      expect(game).toMatch(/45 seconds|45-second/);
      expect(game).not.toContain('10 minutes');
    });
    it('hands over a read-only watch link at once, and reports the result and rank', () => {
      expect(game).toMatch(
        /(?:watch|spectat)[^\n]*(?:read-only|read only)|(?:read-only|read only)[^\n]*(?:watch|spectat)/i,
      );
      expect(game).toMatch(
        /(?:watch|link)[^\n]*(?:immediat|at once|right away)|(?:immediat|at once|right away)[^\n]*(?:watch|link)/i,
      );
      expect(game).toMatch(/report[^\n]*result|result[^\n]*report/i);
      expect(game).toMatch(/rank|leaderboard/);
      expect(game).toMatch(/not in[^\n]*100|outside[^\n]*100|top 100/i);
      expect(game).toMatch(
        /report[^\n]*(?:language|script)|(?:language|script)[^\n]*report/i,
      );
      expect(game).toMatch(
        /(?:watch|spectat)[^\n]*(?:finished|result)|(?:finished|result)[^\n]*(?:watch|spectat)/i,
      );
    });
    it('suggests notes in the owner language and script without missing the deadline', () => {
      expect(game).toMatch(/note[^\n]*every action|every action[^\n]*note/i);
      expect(game).toMatch(
        /note[^\n]*(?:owner|their)[^\n]*(?:language|script)|(?:language|script)[^\n]*note/i,
      );
      expect(game).toMatch(/500/);
      expect(game).toMatch(
        /opponent[^\n]*(?:never|cannot|can't)|(?:only|private)[^\n]*owner/i,
      );
      expect(game).toMatch(/note[^\n]*deadline|deadline[^\n]*note/i);
    });
    it('explains completed hands, action amounts and rising blinds', () => {
      expect(md).toContain('hands_since_your_turn');
      expect(md).toMatch(/oldest[^\n]*first|chronological/i);
      expect(game).toMatch(
        /(?:each|every|all)[^\n]*(?:completed hand|finished hand)|(?:completed|finished)[^\n]*hands/i,
      );
      expect(game).toMatch(/call[^\n]*(?:more|additional|add|pay)/i);
      expect(game).toMatch(/raise to/i);
      expect(game).toMatch(
        /(?:double|doubl)[^\n]*(?:5|five)|(?:5|five)[^\n]*(?:double|doubl)/i,
      );
      expect(game).toMatch(/(?:10[-–]25|10 to 25)[^\n]*hands/i);
      expect(game).toMatch(/(?:lost all|runs out|no chips|zero|bust)/i);
      expect(game).toMatch(/folding[^\n]*(?:blind|safe|lose)|blind[^\n]*fold/i);
    });

    it('retains betting and hand-result semantics in the manual or appendix', () => {
      for (const field of [
        'last_hand',
        'ended_by',
        'stack_changes',
        'my_stack',
        'opponent_stack',
        'legal_actions',
        'blind_every',
        'max_hands',
        'seconds_remaining',
      ]) {
        expect(md).toContain(field);
      }
      expect(md).toMatch(
        /stack_changes[^\n]*(?:settle|result|end|finish|won|lost)/i,
      );
      expect(md).toMatch(/next hand[^\n]*blind/i);
      expect(md).toMatch(/max[^\n]*my_stack[^\n]*my_bet_this_street/i);
      expect(md).toMatch(
        /(?:can't|cannot|cannot fully)[^\n]*cover[^\n]*blind[^\n]*all-in/i,
      );
      expect(md).toMatch(/max_hands[^\n]*draw/i);
      expect(md).toMatch(/seconds_remaining[^\n]*(?:guide|hint|estimate)/i);
    });
  },
);
