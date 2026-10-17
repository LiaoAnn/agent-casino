// Fake data shaped by the contract, for the web (T06, T10) until the real read
// endpoints exist. Deterministic per seed and self-consistent: chips add up,
// cards are not repeated within a hand, and the leaderboard is the Elo result
// of the rated matches. Showdown winners are random, not hand strength.
import type {
  Leaderboard,
  MatchDetail,
  MatchHand,
  MatchList,
  MatchSummary,
} from './schemas';
import { SETTINGS_DEFAULTS } from './schemas';

type Seat = 0 | 1;
type HistoryEntry = MatchHand['events'][number];

const PAGE_SIZE = 20;
const PLAYERS = ['alice', 'Bob', 'carol', 'dave-7', 'eve_x', 'Frank', 'grace'];
const BOT = 'house-bot';
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const START_TIME = Date.parse('2026-10-01T00:00:00Z');

// mulberry32, the same PRNG the dealer uses.
function makeRandom(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  return { next, int, pick };
}
type Random = ReturnType<typeof makeRandom>;

function shuffledDeck(random: Random): string[] {
  const deck = [...RANKS].flatMap(rank => [...SUITS].map(s => rank + s));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    [deck[i], deck[j]] = [deck[j] as string, deck[i] as string];
  }
  return deck;
}

function playHand(
  random: Random,
  handNumber: number,
  stacks: [number, number],
): MatchHand {
  const button = ((handNumber - 1) % 2) as Seat;
  const big = (1 - button) as Seat;
  const deck = shuffledDeck(random);
  const hole: [[string, string], [string, string]] = [
    [deck[0] as string, deck[2] as string],
    [deck[1] as string, deck[3] as string],
  ];
  const events: HistoryEntry[] = [
    { seat: button, street: 'preflop', type: 'post_blind', amount: 1 },
    { seat: big, street: 'preflop', type: 'post_blind', amount: 2 },
  ];
  // Each hand moves at most 2 chips, so nobody runs out within 200 hands of
  // the default 40-chip stacks and no all-in case is needed.
  const scenario = random.pick(['fold', 'steal', 'show', 'show'] as const);
  const paid: [number, number] = [0, 0];
  let winner: Seat | null;
  if (scenario === 'fold') {
    const timeout = random.int(5) === 0 ? { timeout: true as const } : {};
    events.push({ seat: button, street: 'preflop', type: 'fold', ...timeout });
    paid[button] = 1;
    paid[big] = 2;
    winner = big;
  } else if (scenario === 'steal') {
    events.push({ seat: button, street: 'preflop', type: 'raise', amount: 6 });
    events.push({ seat: big, street: 'preflop', type: 'fold' });
    paid[button] = 6;
    paid[big] = 2;
    winner = button;
  } else {
    events.push({ seat: button, street: 'preflop', type: 'call', amount: 1 });
    events.push({ seat: big, street: 'preflop', type: 'check' });
    for (const street of ['flop', 'turn', 'river'] as const) {
      events.push({ seat: big, street, type: 'check' });
      events.push({ seat: button, street, type: 'check' });
    }
    paid[0] = 2;
    paid[1] = 2;
    winner = random.int(10) === 0 ? null : (random.int(2) as Seat);
  }
  const pot = paid[0] + paid[1];
  const showdown = scenario === 'show';
  for (const seat of [0, 1] as const) {
    const won = winner === null ? pot / 2 : winner === seat ? pot : 0;
    stacks[seat] += won - paid[seat];
  }

  return {
    hand_number: handNumber,
    button_seat: button,
    board: showdown ? deck.slice(4, 9) : [],
    hole_cards: showdown ? hole : null,
    events,
    winner_seat: winner,
    pot,
    ended_by: showdown ? 'showdown' : 'fold',
    stacks: [stacks[0], stacks[1]],
  };
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
    const roll = random.int(15);
    const cancelled = roll === 0;
    const voided = roll === 1;
    const settings = {
      ...SETTINGS_DEFAULTS,
      hands: random.pick([3, 5, 10]),
    };
    const stacks: [number, number] = [
      settings.starting_stack,
      settings.starting_stack,
    ];
    const hands: MatchHand[] = [];
    for (
      let n = 1;
      !cancelled && n <= settings.hands && Math.min(...stacks) > 0;
      n++
    ) {
      hands.push(playHand(random, n, stacks));
    }
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
      seed: Math.floor(random.next() * 0x1_0000_0000),
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
