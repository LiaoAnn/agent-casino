import { Exit, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { compareHands, evaluateHand } from '../holdem/hand';
import { dealHand } from '../holdem/shuffle';
import { makeFakeData } from './fake';
import { Leaderboard, MatchDetail, MatchList } from './schemas';

const decodes = (schema: Schema.Top, value: unknown): boolean =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(value),
  );

const allSummaries = (data: ReturnType<typeof makeFakeData>) => {
  const pages = [data.matches()];
  for (let i = 0; i < 100; i++) {
    const next = pages.at(-1)?.next;
    if (next == null) break;
    pages.push(data.matches({ before: next }));
  }
  return { pages, summaries: pages.flatMap(page => page.matches) };
};

describe('makeFakeData', () => {
  const data = makeFakeData();
  const { pages, summaries } = allSummaries(data);
  const details = summaries.map(summary => {
    const detail = data.match(summary.match_id);
    if (detail === undefined) throw new Error(`no ${summary.match_id}`);
    return detail;
  });

  it('produces values that decode with the contract schemas', () => {
    expect(decodes(Leaderboard, data.leaderboard())).toBe(true);
    for (const page of pages) expect(decodes(MatchList, page)).toBe(true);
    for (const detail of details)
      expect(decodes(MatchDetail, detail)).toBe(true);
  });

  it('is deterministic per seed', () => {
    const again = makeFakeData({ seed: 1 });
    expect(again.leaderboard()).toEqual(data.leaderboard());
    expect(again.matches()).toEqual(data.matches());
    const first = summaries[0]?.match_id ?? '';
    expect(again.match(first)).toEqual(data.match(first));
    expect(makeFakeData({ seed: 2 }).matches()).not.toEqual(data.matches());
  });

  it('pages 20 matches at a time, newest first, 30 by default', () => {
    expect(pages.map(page => page.matches.length)).toEqual([20, 10]);
    expect(pages[0]?.next).toBe(pages[0]?.matches.at(-1)?.match_id);
    expect(pages.at(-1)?.next).toBeNull();
    const ids = summaries.map(s => s.match_id);
    expect(new Set(ids).size).toBe(30);
    const times = summaries.map(s => s.ended_at);
    expect(times).toEqual([...times].sort().reverse());
    expect(makeFakeData({ matches: 5 }).matches()).toMatchObject({
      next: null,
    });
    expect(makeFakeData({ matches: 5 }).matches().matches).toHaveLength(5);
  });

  it('ends paging exactly at the last match', () => {
    const twenty = makeFakeData({ matches: 20 });
    expect(twenty.matches().matches).toHaveLength(20);
    expect(twenty.matches().next).toBeNull();
    expect(data.matches({ before: 'r_0000000000' })).toEqual({
      matches: [],
      next: null,
    });
  });

  it('deals every hand from the match seed and pays the better hand', () => {
    for (const detail of details) {
      for (const hand of detail.hands) {
        if (hand.hole_cards === null) continue;
        const deal = dealHand(detail.seed, hand.hand_number);
        expect(hand.hole_cards).toEqual(deal.holeCards);
        expect(hand.board).toEqual(deal.board);
        const [a, b] = deal.holeCards.map(hole =>
          evaluateHand([...hole, ...deal.board]),
        );
        const order = a && b ? compareHands(a, b) : Number.NaN;
        expect(hand.winner_seat).toBe(order === 0 ? null : order > 0 ? 0 : 1);
      }
    }
  });

  it('matches results, stacks and rating changes', () => {
    for (const detail of details) {
      const [s0, s1] = detail.final_stacks;
      if (detail.result === 'seat0_win') expect(s0).toBeGreaterThan(s1);
      if (detail.result === 'seat1_win') expect(s1).toBeGreaterThan(s0);
      if (detail.result === 'draw') expect(s0).toBe(s1);
      expect(detail.rating_changes !== null).toBe(detail.rated);
      const [c0, c1] = detail.rating_changes ?? [];
      if (c0 && c1 && detail.result !== 'draw') {
        const winner = detail.result === 'seat0_win' ? c0 : c1;
        expect(winner.after).toBeGreaterThan(winner.before);
      }
    }
  });

  it('returns undefined for an unknown match', () => {
    expect(data.match('r_0000000000')).toBeUndefined();
  });

  it('keeps every summary consistent with its detail', () => {
    summaries.forEach((summary, i) => {
      const detail = details[i];
      expect(detail).toMatchObject({
        match_id: summary.match_id,
        players: summary.players,
        result: summary.result,
        rated: summary.rated,
        ended_at: summary.ended_at,
      });
    });
  });

  it('keeps chips, cards and showdowns coherent', () => {
    for (const detail of details) {
      const [s0, s1] = detail.final_stacks;
      expect(s0 + s1).toBe(2 * detail.settings.starting_stack);
      for (const hand of detail.hands) {
        expect(hand.stacks[0] + hand.stacks[1]).toBe(
          2 * detail.settings.starting_stack,
        );
        const cards = [...hand.board, ...(hand.hole_cards?.flat() ?? [])];
        expect(new Set(cards).size).toBe(cards.length);
        expect(hand.hole_cards !== null).toBe(hand.ended_by === 'showdown');
      }
    }
  });

  it('derives the leaderboard from rated matches only', () => {
    const { entries } = data.leaderboard();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map(e => e.rank)).toEqual(
      entries.map((_, index) => index + 1),
    );
    const ratings = entries.map(e => e.rating);
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a));

    const games = new Map<string, number>();
    for (const s of summaries.filter(s => s.rated)) {
      for (const name of s.players) {
        games.set(name.toLowerCase(), (games.get(name.toLowerCase()) ?? 0) + 1);
      }
    }
    for (const entry of entries) {
      expect(entry.name.toLowerCase()).not.toBe('house-bot');
      expect(entry.games).toBe(entry.wins + entry.losses + entry.draws);
      expect(entry.games).toBe(games.get(entry.name.toLowerCase()));
    }
    expect(entries).toHaveLength(games.size);
  });

  it('never rates a match against house-bot', () => {
    for (const summary of summaries) {
      if (summary.players.includes('house-bot')) {
        expect(summary.rated).toBe(false);
      }
    }
  });
});
