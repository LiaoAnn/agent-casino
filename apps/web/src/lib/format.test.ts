import { describe, expect, it } from 'vitest';
import type { MatchHand } from '../../../api/src/contract/schemas';
import { blindsLabel, eventParts, settingsLabel } from './format';

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
