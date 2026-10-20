import { describe, expect, it } from 'vitest';
import type { MatchHand } from '../../../api/src/contract/schemas';
import {
  blindsLabel,
  eventParts,
  handResult,
  outLabel,
  potNames,
  resultLabel,
  settingsLabel,
} from './format';

describe('settingsLabel (T34)', () => {
  it('describes a freezeout: stack, rising blinds, the cap, the clock', () => {
    expect(
      settingsLabel({
        starting_stack: 40,
        blind_every: 5,
        max_hands: 50,
        turn_seconds: 30,
      }),
    ).toBe('起始籌碼 40 · 盲注每 5 手翻倍 · 最多 50 手 · 每步 30 秒');
  });

  it('describes a match from before T34 as fixed blinds over its hands', () => {
    expect(
      settingsLabel({
        starting_stack: 200,
        blind_every: null,
        max_hands: 10,
        turn_seconds: 30,
      }),
    ).toBe('起始籌碼 200 · 固定盲注 1/2 · 10 手 · 每步 30 秒');
  });
});

describe('blindsLabel (T34)', () => {
  it('reads small/big', () => {
    expect(blindsLabel([1, 2])).toBe('1/2');
    expect(blindsLabel([16, 32])).toBe('16/32');
  });
});

describe('eventParts betting labels (T44)', () => {
  type Event = MatchHand['events'][number];
  const players = ['Alice', 'Bob'] as const;
  const opening: Event = { seat: 0, street: 'flop', type: 'raise', amount: 8 };
  const blind: Event = {
    seat: 1,
    street: 'preflop',
    type: 'post_blind',
    amount: 2,
  };
  const label = (event: Event, previousEvents: readonly Event[] = []) =>
    eventParts(event, players, previousEvents).action;

  it('calls a first voluntary bet 下注, including with the default history', () => {
    expect(eventParts(opening, players).action).toBe('下注');
    expect(label(opening)).not.toBe('加注到');
  });

  it('checks do not turn the opening bet into a raise', () => {
    expect(label(opening, [{ seat: 1, street: 'flop', type: 'check' }])).toBe(
      '下注',
    );
  });

  it('earlier streets do not count as bets on the current street', () => {
    expect(label(opening, [blind, { ...opening, street: 'preflop' }])).toBe(
      '下注',
    );
    expect(label({ ...opening, street: 'turn' }, [opening])).toBe('下注');
    expect(label({ ...opening, street: 'river' }, [opening])).toBe('下注');
  });

  it('a preflop raise follows a posted blind', () => {
    expect(label({ ...opening, street: 'preflop' }, [blind])).toContain(
      '加注到',
    );
  });

  it('a second voluntary raise on the same street is 加注到', () => {
    expect(label({ ...opening, seat: 1, amount: 16 }, [opening])).toContain(
      '加注到',
    );
  });

  it('formats a complete sequence using only events preceding each action', () => {
    const events: Event[] = [
      blind,
      { ...opening, street: 'preflop' },
      { seat: 1, street: 'flop', type: 'check' },
      opening,
      { ...opening, seat: 1, amount: 16 },
    ];
    const labels = events.map((event, index) =>
      label(event, events.slice(0, index)),
    );
    expect(labels[1]).toBe('加注到');
    expect(labels[3]).toBe('下注');
    expect(labels[4]).toBe('加注到');
  });
});

describe('eventParts leave (A15)', () => {
  it('labels leaving and preserves the chips taken off the table', () => {
    expect(
      eventParts({ seat: 1, street: 'turn', type: 'leave', amount: 17 }, [
        'Alice',
        'Bob',
      ]),
    ).toMatchObject({ action: '離開', amount: 17 });
  });
});

describe('multiplayer labels (T41)', () => {
  const six = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

  it('names the winner of any seat; heads-up says 勝, a bigger table 冠軍', () => {
    expect(resultLabel({ players: ['A', 'B'], result: 'seat1_win' })).toBe(
      'B 勝',
    );
    expect(resultLabel({ players: six, result: 'seat4_win' })).toBe('冠軍：E');
    expect(resultLabel({ players: six, result: 'draw' })).toBe('並列第 1');
    expect(resultLabel({ players: ['A', 'B'], result: 'draw' })).toBe('平手');
  });

  it('says blinds go by player count for a table not started yet', () => {
    expect(
      settingsLabel(
        {
          starting_stack: 40,
          blind_every: null,
          max_hands: 100,
          turn_seconds: 30,
        },
        { started: false },
      ),
    ).toBe('起始籌碼 40 · 盲注依人數翻倍 · 最多 100 手 · 每步 30 秒');
  });

  it('names the pots: one is 底池, then 主池 and 邊池 (numbered past one)', () => {
    expect(potNames(1)).toEqual(['底池']);
    expect(potNames(2)).toEqual(['主池', '邊池']);
    expect(potNames(3)).toEqual(['主池', '邊池 1', '邊池 2']);
  });

  type Hand = Parameters<typeof handResult>[0];
  const hand = (over: Partial<Hand>): Hand => ({
    winner_seat: null,
    pot: 0,
    pots: [],
    ended_by: 'showdown',
    ...over,
  });

  it('keeps the heads-up wording for one pot', () => {
    const players = ['A', 'B'] as const;
    expect(
      handResult(
        hand({
          winner_seat: 1,
          pot: 8,
          pots: [{ amount: 8, winner_seats: [1] }],
          ended_by: 'fold',
        }),
        players,
      ),
    ).toBe('B 贏得 8（對手棄牌）');
    expect(
      handResult(
        hand({ pot: 8, pots: [{ amount: 8, winner_seats: [0, 1] }] }),
        players,
      ),
    ).toBe('平分底池 8');
  });

  it('at a bigger table, says who won each pot', () => {
    expect(
      handResult(
        hand({
          winner_seat: 2,
          pot: 9,
          pots: [{ amount: 9, winner_seats: [2] }],
          ended_by: 'fold',
        }),
        six,
      ),
    ).toBe('C 贏得 9（其他人棄牌）');
    expect(
      handResult(
        hand({ pot: 12, pots: [{ amount: 12, winner_seats: [0, 3] }] }),
        six,
      ),
    ).toBe('A、D 平分底池 12（攤牌）');
    expect(
      handResult(
        hand({
          winner_seat: null,
          pot: 42,
          pots: [
            { amount: 30, winner_seats: [1] },
            { amount: 12, winner_seats: [0, 3] },
          ],
        }),
        six,
      ),
    ).toBe('主池 30：B 贏；邊池 12：A、D 平分（攤牌）');
  });

  it('marks a seat out of the match with its place', () => {
    expect(outLabel({ place: 4, left: false })).toBe('第 4 名・出局');
    expect(outLabel({ place: 6, left: true })).toBe('第 6 名・離開');
    expect(outLabel({ place: null, left: false })).toBe('出局');
  });
});
