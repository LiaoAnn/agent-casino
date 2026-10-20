// Rooms saved before T38 kept two seats in their own shape; they are read
// into the N-seat shape here, so a heads-up room in play when T38 was
// deployed plays on, and an old finished room's watch link still answers.
import { defaultDisplayName, RESERVED_NAMES } from '../contract/schemas';
import type {
  TableHandRecord,
  TableLastHand,
  TableState,
} from '../holdem/table';

type Pair<T> = [T, T];

// A finished hand as stored before T38: one pot, no `pots`.
export interface LegacyHand extends Omit<TableHandRecord, 'pots'> {
  pots?: undefined;
}

interface LegacyMatch
  extends Omit<
    TableState,
    'config' | 'lastHand' | 'folded' | 'places' | 'taken'
  > {
  config: Omit<TableState['config'], 'players'>;
  lastHand: Omit<TableLastHand, 'pots'> | null;
}

export interface LegacyRoom {
  room_id: string;
  invite_code: string;
  settings: {
    starting_stack: number;
    blind_every: number;
    max_hands: number;
    turn_seconds: number;
  };
  seed: string;
  test: unknown;
  names: [string, string | null];
  display_names?: [string, string | null];
  watch_urls?: [string | null, string | null];
  match: LegacyMatch | null;
  turn: { id: string; seat: number; deadline: number } | null;
  turn_count: number;
  used_turns: Record<string, { seat: number; timeout?: true }>;
  acted_after_hand?: Pair<number>;
  ended:
    | ({ final_stacks: Pair<number>; at: number } & (
        | { reason: 'complete' | 'cancelled' | 'void' }
        | { reason: 'left'; loser: number }
      ))
    | null;
  created_at: number;
  timeouts: Pair<number>;
  absent: Pair<boolean>;
  chaos_done: {
    rejected: Pair<boolean>;
    fake_waits: { turn_id: string; count: number } | null;
    requests: Pair<number>;
  };
  recorded: { ratings: unknown } | null;
}

// One pot: the winner's, or both seats' when split.
const onePot = (hand: { pot: number; winner_seat: number | null }) => [
  {
    amount: hand.pot,
    winners: hand.winner_seat === null ? [0, 1] : [hand.winner_seat],
  },
];

export const upgradeHand = (
  hand: TableHandRecord | LegacyHand,
): TableHandRecord =>
  hand.pots ? (hand as TableHandRecord) : { ...hand, pots: onePot(hand) };

// Places from two stacks: more chips is first, equal is shared.
const placesOf = ([a, b]: Pair<number>): Pair<number> =>
  a === b ? [1, 1] : a > b ? [1, 2] : [2, 1];

// Also how contract/fake.ts turns its heads-up matches into tables.
export const upgradeMatch = (match: LegacyMatch): TableState => ({
  ...match,
  config: { ...match.config, players: 2 },
  lastHand: match.lastHand && {
    ...match.lastHand,
    pots: onePot(match.lastHand),
  },
  // Heads-up a fold ends the hand, so nobody is folded between turns.
  folded: [false, false],
  places: match.over ? placesOf(match.stacks as Pair<number>) : [null, null],
  taken: [0, 0],
});

export function upgradeRoom<R>(data: R | LegacyRoom): R {
  if (!('names' in (data as object))) return data as R;
  const old = data as LegacyRoom;
  const { ended } = old;
  const seats = old.names.flatMap((name, seat) =>
    name === null
      ? []
      : [
          {
            name,
            display_name: old.display_names?.[seat] ?? defaultDisplayName(name),
            watch_url: old.watch_urls?.[seat] ?? null,
            bot: name.toLowerCase() === RESERVED_NAMES[0],
            joined_at: old.created_at,
            last_seen: old.created_at,
            timeouts: old.timeouts[seat],
            absent: old.absent[seat],
            left: ended?.reason === 'left' && ended.loser === seat,
            acted_after_hand: old.acted_after_hand?.[seat] ?? 0,
            chaos_rejected: old.chaos_done.rejected[seat],
            chaos_requests: old.chaos_done.requests[seat],
          },
        ],
  );
  return {
    version: 2,
    room_id: old.room_id,
    invite_code: old.invite_code,
    // Every room before T38 is a heads-up room.
    visibility: null,
    settings: old.settings,
    seed: old.seed,
    test: old.test,
    seats,
    table: old.match && upgradeMatch(old.match),
    turn: old.turn,
    turn_count: old.turn_count,
    used_turns: old.used_turns,
    ended: ended && {
      reason: ended.reason,
      final_stacks: ended.final_stacks,
      places:
        ended.reason === 'left'
          ? ended.loser === 0
            ? [2, 1]
            : [1, 2]
          : ended.reason === 'complete'
            ? placesOf(ended.final_stacks)
            : null,
      at: ended.at,
    },
    created_at: old.created_at,
    fake_waits: old.chaos_done.fake_waits,
    recorded: old.recorded,
  } as R;
}
