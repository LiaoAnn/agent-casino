import { describe, expect, it } from 'vitest';
import { aroundTable, outAfter, SLOTS_BY_COUNT } from './seats';

describe('seat layout (web-design 牌桌版面, T41)', () => {
  it('places 2-6 seats clockwise from the bottom', () => {
    expect(SLOTS_BY_COUNT[2]).toEqual(['bottom', 'top']);
    expect(SLOTS_BY_COUNT[3]).toEqual(['bottom', 'topLeft', 'topRight']);
    expect(SLOTS_BY_COUNT[4]).toEqual([
      'bottom',
      'bottomLeft',
      'top',
      'bottomRight',
    ]);
    expect(SLOTS_BY_COUNT[5]).toEqual([
      'bottom',
      'bottomLeft',
      'topLeft',
      'topRight',
      'bottomRight',
    ]);
    expect(SLOTS_BY_COUNT[6]).toEqual([
      'bottom',
      'bottomLeft',
      'topLeft',
      'top',
      'topRight',
      'bottomRight',
    ]);
  });

  it('starts from the bottom seat and goes up the seat numbers', () => {
    expect(aroundTable(6, 0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(aroundTable(6, 4)).toEqual([4, 5, 0, 1, 2, 3]);
    expect(aroundTable(3, 2)).toEqual([2, 0, 1]);
    expect(aroundTable(2, 1)).toEqual([1, 0]);
  });
});

describe('outAfter (T41)', () => {
  type Hand = Parameters<typeof outAfter>[0][number];
  const hand = (stacks: number[], leaves: number[] = []): Hand => ({
    stacks,
    events: leaves.map(seat => ({
      seat: seat as 0,
      street: 'flop',
      type: 'leave',
      amount: 5,
    })),
  });

  it('marks the seats with no chips after a hand, with their places', () => {
    const hands = [hand([10, 0, 20]), hand([0, 0, 30], [0])];
    const places = [2, 3, 1];
    expect(outAfter(hands, 0, places)).toEqual([
      null,
      { place: 3, left: false },
      null,
    ]);
    expect(outAfter(hands, 1, places)).toEqual([
      { place: 2, left: true },
      { place: 3, left: false },
      null,
    ]);
  });

  it('leaves a heads-up hand alone: its plates say 出局 already', () => {
    expect(outAfter([hand([0, 40])], 0, [2, 1])).toEqual([null, null]);
  });

  it('gives no place when it is not known yet', () => {
    expect(outAfter([hand([0, 5, 5])], 0, null)).toEqual([
      { place: null, left: false },
      null,
      null,
    ]);
  });
});
