// T43 / A21: only public referee calls; watch supplies the completed-hand oracle.
import { describe, expect, it } from 'vitest';
import type { RoomStatus } from '../contract/schemas';
import { RoomReferee, type RoomStorage } from './referee';

class MemoryStorage implements RoomStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async setAlarm(_time: number): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}

const fixture = async (max_hands = 5, blind_every = 50) => {
  const storage = new MemoryStorage();
  const clock = { ms: Date.parse('2026-10-19T00:00:00Z') };
  const options = {
    now: () => clock.ms,
    waitMs: 1,
    webUrl: 'https://web.test',
  };
  let room = new RoomReferee(storage, options);
  expect(
    await room.create({
      room_id: 'r_owner00001',
      invite_code: 'ABCDEF',
      name: 'alice',
      settings: { starting_stack: 10, blind_every, max_hands, turn_seconds: 5 },
      seed: '0'.repeat(64),
      test: null,
      visibility: null,
    }),
  ).toMatchObject({ ok: true });
  expect(await room.join({ name: 'bob', invite_code: 'ABCDEF' })).toMatchObject(
    { ok: true },
  );
  const status = async (seat: 0 | 1, wait = false) => {
    const answer = await room.status(['alice', 'bob'][seat], { wait });
    if (!answer.ok) throw new Error(JSON.stringify(answer));
    return answer.value;
  };
  const fold = async (seat: 0 | 1) => {
    const turn = await status(seat);
    if (turn.status !== 'your_turn') throw new Error('Expected a turn');
    const action = { turn_id: turn.turn_id, type: 'fold' as const };
    expect(await room.act(['alice', 'bob'][seat], action)).toMatchObject({
      ok: true,
      value: { status: 'accepted' },
    });
    return action;
  };
  return {
    status,
    fold,
    clock,
    get room() {
      return room;
    },
    restart: () => {
      room = new RoomReferee(storage, options);
    },
  };
};

const expectHands = (response: RoomStatus, hands: unknown[]) => {
  expect.soft(response).toHaveProperty('hands_since_your_turn', hands);
  expect.soft(response).toHaveProperty('last_hand', hands.at(-1) ?? null);
};

describe('T43 completed hands since this seat last accepted an action', () => {
  it('reports zero completed hands when another accepted action returns in the same hand', async () => {
    const t = await fixture();
    const turn = await t.status(0);
    if (turn.status !== 'your_turn') throw new Error('Expected first turn');
    expect(
      await t.room.act('alice', { turn_id: turn.turn_id, type: 'call' }),
    ).toMatchObject({ ok: true });
    const bb = await t.status(1);
    if (bb.status !== 'your_turn') throw new Error('Expected big blind turn');
    expectHands(bb, []);
    expect(
      await t.room.act('bob', { turn_id: bb.turn_id, type: 'check' }),
    ).toMatchObject({ ok: true });
    const flop = await t.status(1);
    expect(flop).toMatchObject({ status: 'your_turn', hand_number: 1 });
    expectHands(flop, []);
  });
  it('returns zero initially, one after a fold, and does not consume hands on reads, rejected actions or duplicates', async () => {
    const t = await fixture();
    expectHands(await t.status(0), []);
    const firstAction = await t.fold(0);
    const hand1 = await t.status(1);
    if (hand1.status !== 'your_turn') throw new Error('Expected hand 2');
    expect(hand1.last_hand).toMatchObject({
      hand_number: 1,
      ended_by: 'fold',
      hole_cards: null,
    });
    for (const seat of [0, 1] as const) {
      const status = await t.status(seat);
      if (status.status === 'your_turn') expectHands(status, [hand1.last_hand]);
      else {
        expect(status.status).toBe('waiting');
        expect(status).not.toHaveProperty('hands_since_your_turn');
      }
    }
    for (const wait of [false, true])
      expectHands(await t.status(1, wait), [hand1.last_hand]);
    expect(
      await t.room.act('bob', {
        turn_id: hand1.turn_id,
        type: 'raise',
        amount: -1,
      }),
    ).toMatchObject({ ok: false });
    expectHands(await t.status(1), [hand1.last_hand]);
    await t.fold(1);
    const hand2 = await t.status(0);
    if (hand2.status !== 'your_turn') throw new Error('Expected hand 3');
    expectHands(hand2, [hand1.last_hand, hand2.last_hand]);
    expect(await t.room.act('alice', firstAction)).toMatchObject({
      ok: true,
      value: { duplicate: true },
    });
    t.restart();
    expectHands(await t.status(0, true), [hand1.last_hand, hand2.last_hand]);
    // A real accepted action advances only this seat's watermark.
    await t.fold(0);
    await t.fold(1);
    const hand4 = await t.status(0);
    if (hand4.status !== 'your_turn') throw new Error('Expected hand 5');
    const watch = await t.room.watch('alice');
    if (!watch.ok) throw new Error('Expected watch');
    expect(watch.value.hands).toHaveLength(4);
    const hand3 = watch.value.hands[2];
    if (!hand3) throw new Error('Expected hand 3');
    const { events: _events, button_seat: _button, ...summary } = hand3;
    expectHands(hand4, [
      { ...summary, hole_cards: null, stack_changes: [-1, 1] },
      hand4.last_hand,
    ]);
  });

  it('keeps every timeout-completed hand before a seat has ever acted, oldest first', async () => {
    const t = await fixture(3);
    for (let hand = 0; hand < 3; hand++) {
      t.clock.ms += hand < 2 ? 10_001 : 5_001;
      await t.room.alarm();
    }
    for (const seat of [0, 1] as const) {
      const over = await t.status(seat, true);
      expect(over.status).toBe('match_over');
      expect
        .soft(over)
        .toHaveProperty('hands_since_your_turn', [
          expect.objectContaining({ hand_number: 1 }),
          expect.objectContaining({ hand_number: 2 }),
          expect.objectContaining({ hand_number: 3 }),
        ]);
      expect
        .soft(over)
        .toHaveProperty(
          'last_hand',
          expect.objectContaining({ hand_number: 3 }),
        );
    }
  });

  it('includes an automatically completed big-blind all-in for both seats, with unchanged last_hand', async () => {
    const t = await fixture(50, 1);
    const actedAt = [0, 0];
    for (let step = 0; step < 30; step++) {
      const current = await t.status(0);
      if (current.status === 'match_over') break;
      const seat = current.to_act_seat;
      if (seat !== 0 && seat !== 1)
        throw new Error('Expected a heads-up actor');
      const turn = await t.status(seat);
      if (turn.status !== 'your_turn') throw new Error('Expected turn');
      actedAt[seat] = turn.hand_number ?? 0;
      await t.fold(seat);
    }
    const watch = await t.room.watch('alice');
    if (!watch.ok) throw new Error('Expected watch');
    const hands = watch.value.hands;
    expect(watch.value).not.toHaveProperty('tell_owner');
    expect(watch.value).not.toHaveProperty('hands_since_your_turn');
    const skipped = hands.filter(hand =>
      hand.events.every(event => event.type === 'post_blind'),
    );
    // Hand 4's big blind cannot cover the blind. Neither seat gets an action.
    expect(skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hand_number: 4, ended_by: 'showdown' }),
      ]),
    );
    const summaries = hands.map((hand, index) => {
      const { events: _events, button_seat: _button, ...summary } = hand;
      const previous = hands[index - 1]?.stacks ?? [10, 10];
      return {
        ...summary,
        hole_cards: hand.ended_by === 'showdown' ? hand.hole_cards : null,
        stack_changes: hand.stacks.map(
          (stack, seat) => stack - (previous[seat] ?? 0),
        ),
      };
    });
    for (const seat of [0, 1] as const) {
      const over = await t.status(seat);
      expect(over.status).toBe('match_over');
      // The hand of the accepted action itself completes after that action.
      expectHands(
        over,
        summaries.filter(hand => hand.hand_number >= (actedAt[seat] ?? 0)),
      );
      expect.soft(over).toHaveProperty('last_hand', summaries.at(-1));
    }
  });
});

describe('T43 unrated end messages', () => {
  it.each(['leave', 'draw', 'void'] as const)(
    'includes %s, final stacks and a record URL, explicitly saying unrated',
    async ending => {
      const t = await fixture(ending === 'draw' ? 2 : 5);
      if (ending === 'leave')
        expect(await t.room.leave('alice')).toMatchObject({ ok: true });
      else if (ending === 'void')
        expect(await t.room.abort()).toMatchObject({ ok: true });
      else {
        await t.fold(0);
        await t.fold(1);
      }
      for (const seat of [0, 1] as const) {
        const over = await t.status(seat);
        if (over.status !== 'match_over')
          throw new Error('Expected match_over');
        expect(over.ratings).toBeNull();
        const message =
          (over as unknown as { tell_owner?: string }).tell_owner ?? '';
        expect.soft(over).toHaveProperty('tell_owner', expect.any(String));
        expect.soft(message).toMatch(/unrated/i);
        expect
          .soft(message)
          .toMatch(
            ending === 'draw'
              ? /\b(draw|tie|tied)\b/i
              : ending === 'void'
                ? /void/i
                : seat === 0
                  ? /\b(loss|lost|defeat)\b/i
                  : /\b(win|won|victory)\b/i,
          );
        for (const stack of over.final_stacks)
          expect.soft(message).toContain(String(stack));
        expect.soft(message).toContain('https://web.test/matches/r_owner00001');
      }
    },
  );

  it('does not invent a record URL for a cancelled room that never started', async () => {
    const room = new RoomReferee(new MemoryStorage(), {
      waitMs: 1,
      webUrl: 'https://web.test',
    });
    expect(
      await room.create({
        room_id: 'r_owner00001',
        invite_code: 'ABCDEF',
        name: 'alice',
        settings: {
          starting_stack: 10,
          blind_every: 50,
          max_hands: 5,
          turn_seconds: 5,
        },
        seed: '0'.repeat(64),
        test: null,
        visibility: null,
      }),
    ).toMatchObject({ ok: true });
    const left = await room.leave('alice');
    if (!left.ok) throw new Error('Expected cancelled room');
    expect
      .soft(left.value)
      .toHaveProperty(
        'tell_owner',
        expect.stringMatching(/cancelled|canceled/i),
      );
    expect
      .soft(left.value)
      .toHaveProperty('tell_owner', expect.stringMatching(/unrated/i));
    expect.soft(left.value).toHaveProperty('hands_since_your_turn', []);
    expect(left.value).toHaveProperty('last_hand', null);
    const message =
      (left.value as unknown as { tell_owner?: string }).tell_owner ?? '';
    expect(message).not.toContain('/matches/');
  });
});
