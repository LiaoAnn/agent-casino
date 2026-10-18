// Fake data shaped by the contract, for the web (T06, T10) until the real read
// endpoints exist. Deterministic per seed and self-consistent: every hand is
// played by the holdem engine from the match seed, and the leaderboard is the
// Elo result of the rated matches.
import { compareHands, evaluateHand } from '../holdem/hand';
import {
  type Action,
  applyAction,
  legalActions,
  type MatchConfig,
  type MatchState,
  type Street,
  startMatch,
} from '../holdem/match';
import { dealHand, mulberry32 } from '../holdem/shuffle';
import type {
  Leaderboard,
  MatchDetail,
  MatchHand,
  MatchList,
  MatchSummary,
} from './schemas';
import { SETTINGS_DEFAULTS } from './schemas';

const PAGE_SIZE = 20;
const PLAYERS = ['alice', 'Bob', 'carol', 'dave-7', 'eve_x', 'Frank', 'grace'];
const BOT = 'house-bot';
const START_TIME = Date.parse('2026-10-01T00:00:00Z');

function makeRandom(seed: number) {
  const next = mulberry32(seed);
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick };
}
type Random = ReturnType<typeof makeRandom>;

// The only place a match seed is made: 64 hex characters from 8 draws.
const matchSeed = (random: Random): string =>
  Array.from({ length: 8 }, () =>
    random.int(0x1_0000_0000).toString(16).padStart(8, '0'),
  ).join('');

// A seed whose first hand splits the pot at showdown.
function splitSeed(random: Random): string {
  for (;;) {
    const seed = matchSeed(random);
    const { holeCards, board } = dealHand(seed, 1);
    const [a, b] = holeCards.map(hole => evaluateHand([...hole, ...board]));
    if (a && b && compareHands(a, b) === 0) return seed;
  }
}

// How a hand goes, so the data shows every case the match page renders:
// - fold: the button folds the small blind;
// - steal: the button raises to 6 and the big blind folds;
// - bet_fold: checked to `street`, where the big blind bets and the button
//   folds, leaving part of the board shown;
// - show: checked or called down to a showdown;
// - all_in: the button moves all in and the big blind calls or folds.
type Plan =
  | { kind: 'fold' | 'steal' | 'show' }
  | { kind: 'bet_fold'; street: Street }
  | { kind: 'all_in'; call: boolean };

function pickPlan(random: Random): Plan {
  const roll = random.int(20);
  if (roll === 0) return { kind: 'all_in', call: random.int(3) > 0 };
  if (roll < 5) return { kind: 'fold' };
  if (roll < 9) return { kind: 'steal' };
  if (roll < 12) {
    return { kind: 'bet_fold', street: random.pick(['flop', 'turn'] as const) };
  }
  return { kind: 'show' };
}

// The next move of the seat to act. A timeout makes the engine's timeout
// move (check if possible, else fold), so only those are marked as one.
function nextMove(
  state: MatchState,
  plan: Plan,
  random: Random,
): { action: Action; timeout: boolean } {
  const legal = legalActions(state);
  const raise = legal.find(action => action.type === 'raise');
  const facingBet = !legal.some(action => action.type === 'check');
  const passive: Action = facingBet ? { type: 'call' } : { type: 'check' };
  const raised = state.history.some(event => event.type === 'raise');
  const fold = () => ({
    action: { type: 'fold' } as const,
    timeout: random.int(5) === 0,
  });

  switch (plan.kind) {
    case 'fold':
      return facingBet ? fold() : { action: passive, timeout: false };
    case 'steal':
      if (!raised && raise?.type === 'raise') {
        const amount = Math.min(Math.max(6, raise.min), raise.max);
        return { action: { type: 'raise', amount }, timeout: false };
      }
      return facingBet ? fold() : { action: passive, timeout: false };
    case 'bet_fold':
      if (state.street === plan.street) {
        if (facingBet) return fold();
        if (raise?.type === 'raise') {
          return {
            action: { type: 'raise', amount: raise.min },
            timeout: false,
          };
        }
      }
      return { action: passive, timeout: false };
    case 'all_in':
      if (!raised && raise?.type === 'raise') {
        return {
          action: { type: 'raise', amount: raise.max },
          timeout: false,
        };
      }
      if (facingBet && !plan.call)
        return { action: { type: 'fold' }, timeout: false };
      return { action: passive, timeout: false };
    case 'show':
      return {
        action: passive,
        timeout: passive.type === 'check' && random.int(10) === 0,
      };
  }
}

// Plays a whole match with the engine; it stops when the hands run out or a
// player is busted. A quiet match only has button folds; a split match
// shows the first hand down.
function playMatch(
  random: Random,
  config: MatchConfig,
  style: 'quiet' | 'split' | 'mixed',
): MatchHand[] {
  let state = startMatch(config);
  const hands: MatchHand[] = [];
  const nextPlan = (): Plan =>
    style === 'quiet' ? { kind: 'fold' } : pickPlan(random);
  let plan: Plan = style === 'split' ? { kind: 'show' } : nextPlan();
  while (!state.over && state.toAct !== null) {
    const { action, timeout } = nextMove(state, plan, random);
    const result = applyAction(state, state.toAct, action, { timeout });
    if (!result.ok)
      throw new Error(`Fake data broke a rule: ${result.message}`);
    if (result.state.handNumber !== state.handNumber) plan = nextPlan();
    // Every hand shows both players' cards, as the public record does (A13).
    for (const hand of result.finishedHands) {
      hands.push({
        ...hand,
        hole_cards: dealHand(config.seed, hand.hand_number).holeCards,
      });
    }
    state = result.state;
  }
  return hands;
}

function roomId(random: Random): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `r_${Array.from({ length: 10 }, () => random.pick([...chars])).join('')}`;
}

const expected = (a: number, b: number) => 1 / (1 + 10 ** ((b - a) / 400));

export function makeFakeData(
  options: { seed?: number; matches?: number } = {},
) {
  const { seed = 1, matches: count = 30 } = options;
  const random = makeRandom(seed);
  const ratings = new Map<
    string,
    {
      name: string;
      rating: number;
      wins: number;
      losses: number;
      draws: number;
    }
  >();
  const rate = (name: string) => {
    const key = name.toLowerCase();
    const entry = ratings.get(key) ?? {
      name,
      rating: 1500,
      wins: 0,
      losses: 0,
      draws: 0,
    };
    ratings.set(key, entry);
    return entry;
  };

  const details: MatchDetail[] = [];
  for (let i = 0; i < count; i++) {
    const first = random.pick(PLAYERS);
    const vsBot = random.int(6) === 0;
    const second = vsBot ? BOT : random.pick(PLAYERS.filter(p => p !== first));
    // Fixed slots, so every seed has each result the match page shows.
    const cancelled = i % 15 === 3;
    const voided = i % 15 === 8;
    // Every hand a button fold over an even number of hands: a draw.
    const quiet = i % 10 === 6;
    const split = i % 10 === 1;
    const settings = {
      ...SETTINGS_DEFAULTS,
      hands: quiet ? 10 : random.pick([3, 5, 10]),
    };
    const seed = split ? splitSeed(random) : matchSeed(random);
    const hands = cancelled
      ? []
      : playMatch(
          random,
          {
            seed,
            hands: settings.hands,
            startingStack: settings.starting_stack,
          },
          quiet ? 'quiet' : split ? 'split' : 'mixed',
        );
    const stacks = hands.at(-1)?.stacks ?? [
      settings.starting_stack,
      settings.starting_stack,
    ];
    const result = cancelled
      ? 'cancelled'
      : voided
        ? 'void'
        : stacks[0] === stacks[1]
          ? 'draw'
          : stacks[0] > stacks[1]
            ? 'seat0_win'
            : 'seat1_win';
    const rated = !vsBot && !cancelled && !voided;

    let ratingChanges: MatchDetail['rating_changes'] = null;
    if (rated) {
      const a = rate(first);
      const b = rate(second);
      const score = result === 'draw' ? 0.5 : result === 'seat0_win' ? 1 : 0;
      const before = [Math.round(a.rating), Math.round(b.rating)] as const;
      const delta = 32 * (score - expected(a.rating, b.rating));
      a.rating += delta;
      b.rating -= delta;
      if (score === 0.5) {
        a.draws++;
        b.draws++;
      } else {
        (score === 1 ? a : b).wins++;
        (score === 1 ? b : a).losses++;
      }
      ratingChanges = [
        { name: a.name, before: before[0], after: Math.round(a.rating) },
        { name: b.name, before: before[1], after: Math.round(b.rating) },
      ];
    }

    details.push({
      match_id: roomId(random),
      players: [first, second],
      settings,
      seed,
      result,
      rated,
      ended_at: new Date(START_TIME + i * 37 * 60_000).toISOString(),
      final_stacks: [stacks[0], stacks[1]],
      rating_changes: ratingChanges,
      hands,
    });
  }

  const newestFirst: MatchSummary[] = details
    .map(({ match_id, players, result, ended_at, rated }) => ({
      match_id,
      players,
      result,
      ended_at,
      rated,
    }))
    .reverse();
  const leaderboard: Leaderboard = {
    entries: [...ratings.values()]
      .map(r => ({ ...r, rating: Math.round(r.rating) }))
      .sort((x, y) => y.rating - x.rating || x.name.localeCompare(y.name))
      .map((r, i) => ({
        rank: i + 1,
        name: r.name,
        rating: r.rating,
        games: r.wins + r.losses + r.draws,
        wins: r.wins,
        losses: r.losses,
        draws: r.draws,
      })),
  };

  return {
    leaderboard: (): Leaderboard => leaderboard,
    matches: (query: { before?: string } = {}): MatchList => {
      const start =
        query.before === undefined
          ? 0
          : newestFirst.findIndex(m => m.match_id === query.before) + 1;
      const page =
        start === 0 && query.before !== undefined
          ? []
          : newestFirst.slice(start, start + PAGE_SIZE);
      const more = start + PAGE_SIZE < newestFirst.length;
      return {
        matches: page,
        next: more && page.length > 0 ? (page.at(-1)?.match_id ?? null) : null,
      };
    },
    match: (matchId: string): MatchDetail | undefined =>
      details.find(d => d.match_id === matchId),
  };
}
