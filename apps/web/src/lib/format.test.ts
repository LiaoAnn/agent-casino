import { describe, expect, it } from 'vitest';
import { blindsLabel, settingsLabel } from './format';

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
