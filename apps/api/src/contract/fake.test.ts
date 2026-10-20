import { Exit, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { compareHands, evaluateHand } from '../holdem/hand';
import { checkHand } from '../holdem/invariants';
import {
  applyAction,
  type HandRecord,
  type HistoryEvent,
  type LegalAction,
  legalActions,
  type MatchConfig,
  type MatchState,
  startMatch,
} from '../holdem/match';
import { replay } from '../holdem/replay';
import { dealHand } from '../holdem/shuffle';
import { makeFakeData } from './fake';
import { Leaderboard, MatchDetail, MatchList, WatchResponse } from './schemas';

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

const configOf = (detail: MatchDetail): MatchConfig => ({
  seed: detail.seed,
  maxHands: detail.settings.max_hands,
  blindEvery: detail.settings.blind_every ?? 50,
  startingStack: detail.settings.starting_stack,
});

const eventsOf = (detail: MatchDetail): HistoryEvent[] =>
  detail.hands.flatMap(hand =>
    hand.events.map(event => {
      expect([0, 1]).toContain(event.seat);
      if (event.type === 'leave')
        throw new Error(
          'Heads-up fake records must not contain table leave events',
        );
      return { ...event, type: event.type, seat: event.seat as 0 | 1 };
    }),
  );

/** Each non-blind event of a match with the engine state it was made in. */
const walk = (detail: MatchDetail) => {
  let state = startMatch(configOf(detail));
  const steps: {
    event: HistoryEvent;
    before: MatchState;
    legal: LegalAction[];
  }[] = [];
  for (const event of eventsOf(detail)) {
    if (event.type === 'post_blind') continue;
    const legal = legalActions(state);
    steps.push({ event, before: state, legal });
    const result = applyAction(
      state,
      event.seat,
      event.type === 'raise'
        ? { type: 'raise', amount: event.amount ?? Number.NaN }
        : { type: event.type },
      { timeout: event.timeout },
    );
    if (!result.ok) {
      throw new Error(`${detail.match_id}: engine rejected ${result.message}`);
    }
    state = result.state;
  }
  return steps;
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

  // The generator seed (`makeFakeData({ seed })`) stays a number; the match
  // seeds it makes are 256-bit seeds, 64 lowercase hex (holdem-rules 種子與洗牌).
  it('gives every match its own 64-lowercase-hex seed, the same per generator seed', () => {
    const seeds = details.map(detail => detail.seed);
    for (const seed of seeds) {
      expect(typeof seed).toBe('string');
      expect(seed).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(seeds).size).toBe(seeds.length);

    const again = makeFakeData({ seed: 1 });
    expect(details.map(d => again.match(d.match_id)?.seed)).toEqual(seeds);

    const other = makeFakeData({ seed: 2 });
    const otherSeeds = allSummaries(other).summaries.map(
      s => other.match(s.match_id)?.seed,
    );
    expect(otherSeeds).toHaveLength(seeds.length);
    for (const seed of otherSeeds) expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(otherSeeds).not.toEqual(seeds);
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
        const deal = dealHand(detail.seed, hand.hand_number);
        expect(hand.hole_cards).toEqual(deal.holeCards);
        if (hand.ended_by !== 'showdown') continue;
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
        expect(hand.hole_cards).not.toBeNull();
      }
    }
  });

  it('derives the leaderboard from rated matches only', () => {
    const { entries } = data.leaderboard();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map(e => e.rank)).toEqual(
      entries.map(
        entry =>
          1 + entries.filter(other => other.rating > entry.rating).length,
      ),
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

  it('replays every match to exactly its hands with the holdem engine', () => {
    for (const detail of details) {
      const result = replay(configOf(detail), eventsOf(detail));
      expect(result, detail.match_id).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(
        result.hands.map(hand => ({
          ...hand,
          pots: [
            {
              amount: hand.pot,
              winner_seats:
                hand.winner_seat === null ? [0, 1] : [hand.winner_seat],
            },
          ],
          hole_cards: dealHand(detail.seed, hand.hand_number).holeCards,
        })),
        detail.match_id,
      ).toEqual(detail.hands);
      expect(detail.final_stacks, detail.match_id).toEqual(
        detail.hands.at(-1)?.stacks ?? [
          detail.settings.starting_stack,
          detail.settings.starting_stack,
        ],
      );
      if (detail.result === 'cancelled') expect(detail.hands).toEqual([]);
      if (
        detail.result === 'seat0_win' ||
        detail.result === 'seat1_win' ||
        detail.result === 'draw'
      ) {
        // A finished match ran every hand or ended when a player busted.
        expect(result.state.over, detail.match_id).toBe(true);
      }
      expect(detail.hands.length).toBeLessThanOrEqual(
        detail.settings.max_hands,
      );
      if (detail.hands.length < detail.settings.max_hands) {
        const last = detail.hands.at(-1);
        if (detail.result !== 'void' && detail.result !== 'cancelled') {
          expect(last?.stacks, detail.match_id).toContain(0);
        }
      }
    }
  });

  it('keeps every hand within the holdem invariants', () => {
    for (const detail of details) {
      for (const hand of detail.hands) {
        const engineHand = {
          ...hand,
          hole_cards: hand.ended_by === 'fold' ? null : hand.hole_cards,
        };
        expect(
          checkHand(engineHand as unknown as HandRecord, configOf(detail)),
          `${detail.match_id} hand ${hand.hand_number}`,
        ).toEqual([]);
      }
    }
  });

  it('times out only to a check, or to a fold when there is a bet to call', () => {
    let timeouts = 0;
    for (const detail of details) {
      for (const { event, legal } of walk(detail)) {
        if (event.timeout !== true) continue;
        timeouts++;
        const canCheck = legal.some(action => action.type === 'check');
        expect(event.type, detail.match_id).toBe(canCheck ? 'check' : 'fold');
      }
    }
    expect(timeouts).toBeGreaterThan(0);
  });

  it('counts only the chips the winner wins as the pot', () => {
    const preflopFolds = details.flatMap(detail =>
      detail.hands
        .filter(hand => hand.ended_by === 'fold' && hand.board.length === 0)
        .map(hand => ({
          hand,
          blinds: hand.events
            .filter(e => e.type === 'post_blind')
            .map(e => e.amount),
          actions: hand.events
            .filter(e => e.type !== 'post_blind')
            .map(e => e.type),
        }))
        .filter(({ blinds }) => blinds.join() === '1,2'),
    );
    // Button raises, big blind folds: the raise beyond 2 goes back.
    const raiseFold = preflopFolds.filter(
      ({ actions }) => actions.join() === 'raise,fold',
    );
    expect(raiseFold.length).toBeGreaterThan(0);
    for (const { hand } of raiseFold) expect(hand.pot).toBe(4);
    // Button folds the small blind: the big blind's extra 1 goes back.
    const buttonFold = preflopFolds.filter(
      ({ actions }) => actions.join() === 'fold',
    );
    expect(buttonFold.length).toBeGreaterThan(0);
    for (const { hand } of buttonFold) expect(hand.pot).toBe(2);
  });

  it('covers a fold after the flop, a timed-out check and an all-in', () => {
    const hands = details.flatMap(detail => detail.hands);
    expect(
      hands.some(
        h =>
          h.ended_by === 'fold' &&
          (h.board.length === 3 || h.board.length === 4),
      ),
    ).toBe(true);
    expect(
      hands.some(h =>
        h.events.some(e => e.timeout === true && e.type === 'check'),
      ),
    ).toBe(true);
    const allIn = details.some(detail =>
      walk(detail).some(({ event, before, legal }) => {
        const stack = before.stacks[event.seat];
        if (event.type === 'call') {
          const call = legal.find(action => action.type === 'call');
          return call?.type === 'call' && call.amount === stack;
        }
        if (event.type === 'raise') {
          return event.amount === before.bets[event.seat] + stack;
        }
        return false;
      }),
    );
    expect(allIn).toBe(true);
  });

  it('covers every case the match page shows', () => {
    const hands = details.flatMap(detail => detail.hands);
    expect(new Set(details.map(d => d.result))).toEqual(
      new Set(['seat0_win', 'seat1_win', 'draw', 'void', 'cancelled']),
    );
    expect(details.find(d => d.hands.length === 0)?.result).toBe('cancelled');
    expect(details.some(d => d.rating_changes !== null)).toBe(true);
    expect(details.some(d => d.rating_changes === null)).toBe(true);
    expect(
      hands.some(h => h.ended_by === 'showdown' && h.winner_seat !== null),
    ).toBe(true);
    expect(hands.some(h => h.ended_by === 'fold')).toBe(true);
    const split = hands.find(h => h.winner_seat === null);
    expect(split?.ended_by).toBe('showdown');
    expect(hands.some(h => h.events.some(e => e.timeout === true))).toBe(true);
    expect(hands.some(h => h.events.some(e => !e.timeout))).toBe(true);
    expect(hands.some(h => h.events.some(e => e.type === 'raise'))).toBe(true);
    expect(hands.some(h => h.events.some(e => e.type === 'call'))).toBe(true);
    const deltas = details.flatMap(d =>
      (d.rating_changes ?? []).map(c => c.after - c.before),
    );
    expect(deltas.some(d => d > 0)).toBe(true);
    expect(deltas.some(d => d < 0)).toBe(true);
  });
});

// --- watch fake data for the web page (A16, T24) ------------------------------

describe('makeFakeData watch responses', () => {
  const watch = () => makeFakeData().watch;
  const decode = (value: unknown) =>
    Schema.decodeUnknownSync(WatchResponse)(value);

  const keysOf = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap(keysOf)
      : value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, inner]) => [
            key,
            ...keysOf(inner),
          ])
        : [];
  const notesOf = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap(notesOf)
      : value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, inner]) =>
            key === 'note' && typeof inner === 'string'
              ? [inner]
              : notesOf(inner),
          )
        : [];

  it('has the two kinds the page needs, and both decode as WatchResponse', () => {
    const { playing, finished } = watch();
    expect(decodes(WatchResponse, playing)).toBe(true);
    expect(decodes(WatchResponse, finished)).toBe(true);
    // Decoding keeps the data as it is (no field is silently dropped).
    expect(JSON.parse(JSON.stringify(decode(playing)))).toEqual(
      JSON.parse(JSON.stringify(playing)),
    );
    expect(JSON.parse(JSON.stringify(decode(finished)))).toEqual(
      JSON.parse(JSON.stringify(finished)),
    );
  });

  it('playing: a room in play with a hand on, finished hands and notes', () => {
    const { playing } = watch();
    expect(playing.room_status).toBe('playing');
    expect(playing.players[0]).toEqual(expect.any(String));
    expect(playing.players[1]).toEqual(expect.any(String));
    expect(playing.view).not.toBeNull();
    expect(playing.hands.length).toBeGreaterThanOrEqual(1);
    expect(playing.hand_number).toBe(playing.hands.length + 1);
    expect(notesOf(playing).length).toBeGreaterThan(0);
    // A note sits on a step of the watched seat only.
    for (const hand of playing.hands) {
      for (const event of hand.events) {
        if (event.note !== undefined) expect(event.seat).toBe(playing.seat);
      }
    }
    for (const event of playing.view?.history ?? []) {
      if (event.note !== undefined) expect(event.seat).toBe(playing.seat);
    }
  });

  it('playing: shows only what the seat knows (own cards, opponent cards at showdown only)', () => {
    const { playing } = watch();
    const opponent = playing.seat === 0 ? 1 : 0;
    for (const hand of playing.hands) {
      expect(hand.hole_cards[playing.seat]).not.toBeNull();
      if (hand.ended_by === 'showdown') {
        expect(hand.hole_cards[opponent]).not.toBeNull();
      } else {
        expect(hand.hole_cards[opponent]).toBeNull();
      }
    }
    expect(playing.view?.my_seat).toBe(playing.seat);
  });

  it('playing: a deadline only when it is the watched seat to act', () => {
    const { playing } = watch();
    if (playing.to_act_seat === playing.seat) {
      expect(playing.deadline).toEqual(expect.any(String));
    } else {
      expect(playing.deadline).toBeNull();
    }
  });

  it('finished: a finished room with the result, every hand and both hole cards', () => {
    const { finished } = watch();
    expect(['finished', 'void']).toContain(finished.room_status);
    if (finished.room_status !== 'finished') return;
    expect(finished.hands.length).toBeGreaterThanOrEqual(1);
    for (const hand of finished.hands) {
      expect(hand.hole_cards[0]).toHaveLength(2);
      expect(hand.hole_cards[1]).toHaveLength(2);
    }
    expect(finished.hands.map(hand => hand.hand_number)).toEqual(
      finished.hands.map((_hand, index) => index + 1),
    );
    expect(finished.final_stacks).toHaveLength(2);
    expect(finished.match_id).toEqual(expect.any(String));
    expect(finished.deadline).toBeNull();
    expect(finished.to_act_seat).toBeNull();
  });

  it.each(['playing', 'finished'] as const)(
    '%s: never carries seed, turn_id or legal_actions',
    kind => {
      const keys = keysOf(watch()[kind]);
      for (const key of ['seed', 'turn_id', 'legal_actions']) {
        expect(keys).not.toContain(key);
      }
    },
  );
});

describe('T34 freezeout fake records', () => {
  it('includes fixed-blind legacy data and consistent blinds in every record', () => {
    const data = makeFakeData();
    const { summaries } = allSummaries(data);
    const details = summaries.map(s => data.match(s.match_id));
    const legacy = details.filter(d => d?.settings.blind_every === null);
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.some(d => (d?.hands.length ?? 0) > 0)).toBe(true);
    for (const detail of details) {
      if (detail === undefined) throw new Error('Missing fake detail');
      expect(decodes(MatchDetail, detail)).toBe(true);
      for (const hand of detail.hands) {
        const interval = detail.settings.blind_every;
        const small =
          interval === null
            ? 1
            : 2 ** Math.floor((hand.hand_number - 1) / interval);
        expect(hand.blinds).toEqual([small, small * 2]);
      }
    }
  });
});

describe('T35 fake display names', () => {
  const data = makeFakeData();
  const { pages, summaries } = allSummaries(data);
  const details = summaries.map(summary => {
    const detail = data.match(summary.match_id);
    if (detail === undefined) throw new Error(`no ${summary.match_id}`);
    return detail;
  });

  it('provides display names on every leaderboard entry, summary, detail and watch response', () => {
    const leaderboard = data.leaderboard();
    expect(Schema.decodeUnknownSync(Leaderboard)(leaderboard)).toEqual(
      leaderboard,
    );
    for (const entry of leaderboard.entries) {
      expect(entry).toHaveProperty('display_name', expect.any(String));
      expect(entry).not.toHaveProperty('display_name', '');
    }
    for (const page of pages) {
      expect(Schema.decodeUnknownSync(MatchList)(page)).toEqual(page);
    }
    summaries.forEach((summary, index) => {
      const detail = details[index];
      expect(summary).toHaveProperty('display_names', [
        expect.any(String),
        expect.any(String),
      ]);
      expect(detail).toHaveProperty('display_names', summary.display_names);
      expect(Schema.decodeUnknownSync(MatchDetail)(detail)).toEqual(detail);
    });
    for (const response of [data.watch.playing, data.watch.finished]) {
      expect(response).toHaveProperty('display_names', [
        expect.any(String),
        expect.any(String),
      ]);
      expect(Schema.decodeUnknownSync(WatchResponse)(response)).toEqual(
        response,
      );
    }
  });

  it('includes Chinese or emoji display names rather than only identity names', () => {
    const names = [
      ...data.leaderboard().entries.map(entry => entry.display_name),
      ...summaries.flatMap(summary => summary.display_names),
      ...details.flatMap(detail => detail.display_names),
      ...(data.watch.playing.display_names ?? []),
      ...(data.watch.finished.display_names ?? []),
    ];
    expect(
      names.some(
        name =>
          typeof name === 'string' &&
          /[\p{Script=Han}\p{Extended_Pictographic}]/u.test(name),
      ),
    ).toBe(true);
  });

  it('falls back to identity names for legacy records with fixed blinds', () => {
    const legacy = details.filter(
      detail => detail.settings.blind_every === null,
    );
    expect(legacy.length).toBeGreaterThan(0);
    for (const detail of legacy) {
      expect(detail).toHaveProperty('display_names', detail.players);
      const summary = summaries.find(s => s.match_id === detail.match_id);
      expect(summary).toHaveProperty('display_names', detail.players);
    }
  });
});
