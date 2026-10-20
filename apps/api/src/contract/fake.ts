// Fake data shaped by the contract, for the web (T06, T10) until the real read
// endpoints exist. Deterministic per seed and self-consistent: every hand is
// played by the holdem engine from the match seed, and the leaderboard is the
// Elo result of the rated matches.
import { compareHands, evaluateHand } from '../holdem/hand';
import {
  type Action,
  applyAction,
  type HandRecord,
  legalActions,
  type MatchConfig,
  type MatchState,
  type Street,
  startMatch,
} from '../holdem/match';
import { dealHand, mulberry32 } from '../holdem/shuffle';
import { headsUpPots, placesOf } from '../room/heads-up';
import { upgradeHand, upgradeMatch } from '../room/legacy';
import { type HandNotes, watchView } from '../room/watch';
import { fakeTable } from './fake-table';
import type {
  Leaderboard,
  MatchDetail,
  MatchHand,
  MatchList,
  MatchSummary,
  WatchResponse,
} from './schemas';
import { SETTINGS_DEFAULTS } from './schemas';

const PAGE_SIZE = 20;
const PLAYERS = ['alice', 'Bob', 'carol', 'dave-7', 'eve_x', 'Frank', 'grace'];
const BOT = 'house-bot';
// What people see of them (A20); the others show their name.
const DISPLAY_NAMES: Record<string, string> = {
  alice: '愛麗絲 Alice',
  Bob: 'Bob 🃏',
  carol: '卡蘿的撲克機器人',
  'dave-7': 'Dave',
  // As long as a display name gets: lists cut it with an ellipsis.
  grace: '葛瑞絲的德州撲克機器人二號專打錦標賽那一隻🃏',
  [BOT]: 'House Bot',
};
const displayName = (name: string) => DISPLAY_NAMES[name] ?? name;
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
// - steal: the button raises to 6 (or the minimum) and the big blind folds;
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
        pots: headsUpPots(hand),
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

// What the watched agent might write with each kind of move (A16).
const NOTES: Record<Action['type'], string> = {
  fold: 'Too weak to continue against this bet; folding.',
  check: 'Nothing to call; checking to see the next card for free.',
  call: 'The price is small next to the pot, so calling.',
  raise: 'Strong enough to bet for value and deny a free card.',
};

// A watched seat-0 match between alice and Bob, played by the engine with a
// note on every move of alice's: `playing` stops on alice's turn after two
// finished hands, `finished` plays to the end. `record` is the public record
// of `finished`, which match() also answers, so its result can link to it.
function fakeWatch(seed: number): {
  playing: WatchResponse;
  finished: WatchResponse;
  record: MatchDetail;
} {
  // Its own stream, apart from the list's, so its room ids differ.
  const random = makeRandom(seed + 0x5eed);
  const names: [string, string] = ['alice', 'Bob'];
  const settings = { ...SETTINGS_DEFAULTS };
  const startedAt = START_TIME + 30 * 24 * 60 * 60_000;
  // `pauseAfter`: stop on alice's turn once that many hands are finished;
  // `null` plays to the end.
  const play = (pauseAfter: number | null) => {
    for (;;) {
      const config = {
        seed: matchSeed(random),
        startingStack: settings.starting_stack,
        blindEvery: settings.blind_every,
        maxHands: settings.max_hands,
      };
      let state = startMatch(config);
      const hands: HandRecord[] = [];
      const notes: Record<number, HandNotes> = {};
      let plan = pickPlan(random);
      while (!state.over && state.toAct !== null) {
        if (
          pauseAfter !== null &&
          hands.length >= pauseAfter &&
          state.toAct === 0
        ) {
          return { config, state, hands, notes };
        }
        const seat = state.toAct;
        const { action, timeout } = nextMove(state, plan, random);
        if (seat === 0 && !timeout) {
          notes[state.handNumber] = {
            ...notes[state.handNumber],
            [state.history.length]: NOTES[action.type],
          };
        }
        const result = applyAction(state, seat, action, { timeout });
        if (!result.ok) {
          throw new Error(`Fake data broke a rule: ${result.message}`);
        }
        if (result.state.handNumber !== state.handNumber)
          plan = pickPlan(random);
        hands.push(...result.finishedHands);
        state = result.state;
      }
      if (pauseAfter === null) return { config, state, hands, notes };
      // Over before the pause: deal another match.
    }
  };
  const watched = (
    room_id: string,
    played: ReturnType<typeof play>,
    ended: Parameters<typeof watchView>[0]['ended'],
  ) =>
    watchView({
      room_id,
      seat: 0,
      names,
      display_names: [displayName(names[0]), displayName(names[1])],
      left: [false, false],
      settings,
      visibility: 'private',
      seats_open: 0,
      seed: played.config.seed,
      table: upgradeMatch(played.state),
      hands: played.hands.map(upgradeHand),
      notes: played.notes,
      deadline: ended ? null : startedAt + settings.turn_seconds * 1000,
      ended,
    });

  const playing = play(2);
  const finished = play(null);
  const [a, b] = finished.state.stacks;
  const change = a === b ? 0 : a > b ? 16 : -16;
  const result = a === b ? 'draw' : a > b ? 'seat0_win' : 'seat1_win';
  const over = watched(roomId(random), finished, {
    result,
    places: placesOf(result),
    final_stacks: [a, b],
    ratings: [
      { name: names[0], rating: 1500 + change, change },
      { name: names[1], rating: 1500 - change, change: -change },
    ],
  });
  return {
    playing: watched(roomId(random), playing, null),
    finished: over,
    record: {
      match_id: over.room_id,
      players: names,
      display_names: [displayName(names[0]), displayName(names[1])],
      settings,
      seed: finished.config.seed,
      result,
      end_reason: a === 0 || b === 0 ? 'bust' : 'max_hands',
      rated: true,
      ended_at: new Date(startedAt + 60 * 60_000).toISOString(),
      final_stacks: [a, b],
      rating_changes: [
        { name: names[0], before: 1500, after: 1500 + change },
        { name: names[1], before: 1500, after: 1500 - change },
      ],
      places: placesOf(result),
      hands: finished.hands.map(hand => ({
        ...hand,
        hole_cards: dealHand(finished.config.seed, hand.hand_number).holeCards,
        pots: headsUpPots(hand),
      })),
    },
  };
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
    // Every hand a button fold, two hands a blind level: a draw.
    const quiet = i % 10 === 6;
    const split = i % 10 === 1;
    // From before T34: a fixed number of hands at blinds 1/2 (A19).
    const legacy = i % 15 === 12;
    const maxHands = quiet ? 10 : random.pick([10, 50]);
    const blindEvery = quiet ? 2 : legacy ? maxHands : random.pick([2, 5]);
    const settings = {
      ...SETTINGS_DEFAULTS,
      blind_every: legacy ? null : blindEvery,
      max_hands: maxHands,
    };
    const seed = split ? splitSeed(random) : matchSeed(random);
    const hands = cancelled
      ? []
      : playMatch(
          random,
          {
            seed,
            startingStack: settings.starting_stack,
            blindEvery,
            maxHands,
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
      // A record from before T35 has none: the names stand in.
      display_names: legacy
        ? [first, second]
        : [displayName(first), displayName(second)],
      settings,
      seed,
      result,
      end_reason: legacy
        ? null
        : result === 'void' || result === 'cancelled'
          ? result
          : stacks.includes(0)
            ? 'bust'
            : 'max_hands',
      rated,
      ended_at: new Date(START_TIME + i * 37 * 60_000).toISOString(),
      final_stacks: [stacks[0], stacks[1]],
      rating_changes: ratingChanges,
      places: placesOf(result),
      hands,
    });
  }

  const watch = fakeWatch(seed);
  const table = fakeTable(seed);
  const newestFirst: MatchSummary[] = details
    .map(
      ({
        match_id,
        players,
        display_names,
        result,
        places,
        ended_at,
        rated,
      }) => ({
        match_id,
        players,
        display_names,
        result,
        places,
        ended_at,
        rated,
      }),
    )
    .reverse();
  const leaderboard: Leaderboard = {
    entries: [...ratings.values()]
      .map(r => ({ ...r, rating: Math.round(r.rating) }))
      .sort((x, y) => y.rating - x.rating || x.name.localeCompare(y.name))
      .map((r, _i, sorted) => ({
        rank: sorted.findIndex(entry => entry.rating === r.rating) + 1,
        name: r.name,
        display_name: displayName(r.name),
        rating: r.rating,
        games: r.wins + r.losses + r.draws,
        wins: r.wins,
        losses: r.losses,
        draws: r.draws,
        // Heads-up only: a title is a win.
        championships: r.wins,
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
      details.find(d => d.match_id === matchId) ??
      (matchId === watch.record.match_id ? watch.record : undefined) ??
      (matchId === table.record.match_id ? table.record : undefined),
    // The owner's watch link of a match in play and of one that is over.
    watch: { playing: watch.playing, finished: watch.finished },
    // A six-seat public table: lobby, the host's and a knocked-out seat's
    // answers, the host's watch link and the record (A25).
    table,
  };
}
