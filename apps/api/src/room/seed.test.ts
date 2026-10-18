// newSeed: the one place a room's seed is made (holdem-rules: 種子與洗牌).
// A 256-bit secret seed from the cryptographic RNG, written as 64 lowercase
// hex characters; a test room's test.seed is used as is.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newSeed } from './seed';

const HEX_64 = /^[0-9a-f]{64}$/;
const SEED = 'df8d15e60f92a61bdf85b01a4424129de138488006fbee6493bff146e37de76e';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('newSeed', () => {
  it('returns test.seed unchanged when given', () => {
    expect(newSeed({ seed: SEED })).toBe(SEED);
    expect(newSeed({ seed: SEED, chaos: { reject_first_action: true } })).toBe(
      SEED,
    );
    expect(newSeed({ seed: '0'.repeat(64) })).toBe('0'.repeat(64));
  });

  it.each([
    { case: 'no test settings', test: null },
    { case: 'test settings without a seed', test: {} },
    { case: 'only chaos settings', test: { chaos: { extra_waiting: 2 } } },
  ])('with $case, returns 64 lowercase hex characters', ({ test }) => {
    const seed = newSeed(test);
    expect(typeof seed).toBe('string');
    expect(seed).toMatch(HEX_64);
  });

  it('returns a different seed each time', () => {
    const seeds = Array.from({ length: 20 }, () => newSeed(null));
    expect(new Set(seeds).size).toBe(20);
  });

  // The randomness is all 256 bits from crypto.getRandomValues: fill every
  // byte asked for with one value and the seed is that byte 32 times (two
  // hex digits each, zero-padded, lowercase), whatever typed array is used.
  it.each([
    { byte: 0xab, hex: 'ab' },
    { byte: 0x0f, hex: '0f' },
    { byte: 0x00, hex: '00' },
  ])(
    'takes 32 bytes from crypto.getRandomValues (all 0x$hex)',
    ({ byte, hex }) => {
      let bytesAsked = 0;
      const getRandomValues: Crypto['getRandomValues'] = array => {
        new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(
          byte,
        );
        bytesAsked += array.byteLength;
        return array;
      };
      const spy = vi
        .spyOn(crypto, 'getRandomValues')
        .mockImplementation(getRandomValues);
      expect(newSeed(null)).toBe(hex.repeat(32));
      expect(spy).toHaveBeenCalled();
      expect(bytesAsked).toBe(32);
    },
  );

  it('does not use the RNG when test.seed is given', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    newSeed({ seed: SEED });
    expect(spy).not.toHaveBeenCalled();
  });
});
