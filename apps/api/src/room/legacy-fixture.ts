// Test fixture: a room as stored before T38 (two seats in their own shape).
const LEGACY_ROOM_ID = 'r_abcde12345';
const LEGACY_INVITE_CODE = 'ABCDEF';

// Pre-T38 storage fixture. Keep this literal independent of the new engine and
// referee: config has no players, match has no folded/places/taken, and the
// old completed hand has no pots. Seed ...0005 is the public golden deal.
export const legacyRoom = (finished: boolean) => {
  const hand = {
    hand_number: 1,
    blinds: [1, 2],
    winner_seat: 1,
    pot: 2,
    ended_by: 'fold',
    board: [],
    hole_cards: null,
    stacks: [39, 41],
  };
  const match = {
    config: {
      seed: '5'.padStart(64, '0'),
      startingStack: 40,
      blindEvery: 50,
      maxHands: finished ? 1 : 2,
    },
    handNumber: finished ? 1 : 2,
    button: finished ? 0 : 1,
    street: 'preflop',
    holeCards: finished
      ? [
          ['9c', 'Ks'],
          ['Jh', '9d'],
        ]
      : [
          ['Qc', 'Th'],
          ['Qs', 'Ac'],
        ],
    board: [],
    stacks: finished ? [39, 41] : [37, 40],
    bets: finished ? [0, 0] : [2, 1],
    contributed: finished ? [0, 0] : [2, 1],
    toAct: finished ? null : 1,
    over: finished,
    history: finished
      ? [
          { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
          { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
          { seat: 0, street: 'preflop', type: 'fold' },
        ]
      : [
          { seat: 1, street: 'preflop', type: 'post_blind', amount: 1 },
          { seat: 0, street: 'preflop', type: 'post_blind', amount: 2 },
        ],
    lastHand: hand,
    acted: finished ? [true, false] : [false, false],
    minRaise: 2,
  };
  const at = Date.parse('2026-10-18T00:00:00Z');
  return {
    room: {
      room_id: LEGACY_ROOM_ID,
      invite_code: LEGACY_INVITE_CODE,
      settings: {
        starting_stack: 40,
        blind_every: 50,
        turn_seconds: 5,
        max_hands: finished ? 1 : 2,
      },
      seed: '5'.padStart(64, '0'),
      test: null,
      names: ['alice', 'bob'],
      display_names: ['小愛', '小包'],
      watch_urls: [
        'https://web.test/watch/alice',
        'https://web.test/watch/bob',
      ],
      match,
      turn: finished ? null : { id: 't_2', seat: 1, deadline: at + 10_000 },
      turn_count: finished ? 1 : 2,
      used_turns: { t_1: { seat: 0 } },
      acted_after_hand: [0, 0],
      ended: finished
        ? { reason: 'complete', final_stacks: [39, 41], at }
        : null,
      created_at: at,
      timeouts: [0, 0],
      absent: [false, false],
      chaos_done: {
        rejected: [false, false],
        fake_waits: null,
        requests: [0, 0],
      },
      recorded: finished ? { ratings: null } : null,
    },
    // Old engine HandRecord after a fold; watch reconstructs public cards (A13).
    hand: {
      ...hand,
      button_seat: 0,
      events: [
        { seat: 0, street: 'preflop', type: 'post_blind', amount: 1 },
        { seat: 1, street: 'preflop', type: 'post_blind', amount: 2 },
        { seat: 0, street: 'preflop', type: 'fold' },
      ],
    },
    at,
  };
};
