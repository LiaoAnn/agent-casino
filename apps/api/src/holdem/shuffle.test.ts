/// <reference types="node" />
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Card, newDeck } from './cards';
import {
  dealHand,
  deckStream,
  hmacSha256,
  isSeed,
  mulberry32,
  shuffledDeck,
  uniformBelow,
} from './shuffle';

// Goldens were produced by an independent throwaway node:crypto createHmac
// script following holdem-rules, then cross-checked by a separately written
// Python hmac/hashlib implementation (all five first-9s and the full deck).
// These values must never change: seed + recorded actions must replay exactly.
const ZERO = '0'.repeat(64);
const INVALID_SEEDS = [
  'A'.repeat(64),
  '0'.repeat(63),
  '0'.repeat(65),
  'g'.repeat(64),
  '',
  `${'0'.repeat(63)}G`,
  `${'0'.repeat(64)}\n`,
  ` ${'0'.repeat(63)}`,
];
const INVALID_HANDS = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

describe('mulberry32', () => {
  it('matches the reference outputs for seed 0', () => {
    const rng = mulberry32(0);
    expect([rng(), rng(), rng(), rng()]).toEqual([
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197,
      0.1462021479383111,
    ]);
  });

  it('matches the reference outputs for seed 0xDEADBEEF', () => {
    const rng = mulberry32(0xdeadbeef);
    expect([rng(), rng(), rng(), rng()]).toEqual([
      0.9413696140982211, 0.26719574979506433, 0.772033357527107,
      0.35816076025366783,
    ]);
  });

  it('outputs floats in [0, 1)', () => {
    const rng = mulberry32(123456789);
    for (let i = 0; i < 10_000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

const GOLDEN: { seed: string; hand: number; first9: Card[] }[] = [
  {
    seed: '0000000000000000000000000000000000000000000000000000000000000000',
    hand: 1,
    first9: ['Tc', '6h', 'Jd', 'Js', '2c', 'Ac', 'Qs', 'Jh', '4h'],
  },
  {
    seed: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    hand: 1,
    first9: ['Ah', 'Qs', 'Ad', '5d', '2d', 'Ac', '7d', '7c', 'Kc'],
  },
  {
    seed: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    hand: 3,
    first9: ['8c', '4d', 'Jc', 'Kh', 'Ah', '6c', 'Jh', 'Qc', '2c'],
  },
  {
    seed: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    hand: 200,
    first9: ['As', '2s', '6d', '5s', '2d', '4d', 'Kd', '5d', '8h'],
  },
  {
    seed: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    hand: 2,
    first9: ['7c', '6h', 'Ah', '8h', 'Ks', '6d', '3h', '4h', 'Kd'],
  },
];

describe('hmacSha256', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const vectors = [
    {
      name: 'RFC 4231 case 1',
      key: new Uint8Array(20).fill(0x0b),
      message: bytes('Hi There'),
      expected:
        'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    },
    {
      name: 'RFC 4231 case 2',
      key: bytes('Jefe'),
      message: bytes('what do ya want for nothing?'),
      expected:
        '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    },
    {
      name: 'RFC 4231 case 6, key longer than SHA256 block',
      key: new Uint8Array(131).fill(0xaa),
      message: bytes('Test Using Larger Than Block-Size Key - Hash Key First'),
      expected:
        '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
    },
  ];
  it.each(vectors)('$name', ({ key, message, expected }) => {
    const keyCopy = key.slice();
    const messageCopy = message.slice();
    const digest = hmacSha256(key, message);
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(digest).toString('hex')).toBe(expected);
    expect(key).toEqual(keyCopy);
    expect(message).toEqual(messageCopy);
  });

  it('handles binary keys/messages, padding boundaries and independent calls', () => {
    for (const keySize of [0, 1, 32, 63, 64, 65, 131]) {
      const key = Uint8Array.from({ length: keySize }, (_, i) => i * 17);
      for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128]) {
        const message = Uint8Array.from({ length: size }, (_, i) => i * 29);
        const expected = createHmac('sha256', key).update(message).digest();
        expect(hmacSha256(key, message)).toEqual(new Uint8Array(expected));
      }
    }
  });
});

describe('isSeed', () => {
  it.each([ZERO, 'f'.repeat(64), '0123456789abcdef'.repeat(4)])(
    'accepts exactly 64 lowercase hex characters: %s',
    seed => {
      expect(isSeed(seed)).toBe(true);
    },
  );
  it.each(INVALID_SEEDS)('rejects invalid seed %j', seed => {
    expect(isSeed(seed)).toBe(false);
  });
});

describe('deckStream', () => {
  it('pins all big-endian words of block 0 and block 1 for exact hand messages', () => {
    const expected = [
      [
        1785338534, 701011657, 42929457, 2263965040, 366539016, 1227991479,
        4094195918, 4152264169, 2273387657, 3685829976, 266734615, 3494393606,
        376310114, 3812694378, 2306985651, 3304336113,
      ],
      [
        1974807523, 4074961961, 1553690626, 505491645, 1683846556, 1466159116,
        1182040813, 2280196116, 1736104006, 3625310281, 1161879741, 3856782535,
        548965083, 1403263472, 3528019633, 1915226811,
      ],
    ];
    for (const hand of [1, 2]) {
      const next = deckStream(ZERO, hand);
      expect(Array.from({ length: 16 }, () => next())).toEqual(
        expected[hand - 1],
      );
      for (const k of [0, 1]) {
        const block = createHmac('sha256', Buffer.from(ZERO, 'hex'))
          .update(`agent-casino/deck/v1:${hand}:${k}`)
          .digest();
        expect(expected[hand - 1].slice(k * 8, k * 8 + 8)).toEqual(
          Array.from({ length: 8 }, (_, i) => block.readUInt32BE(i * 4)),
        );
      }
    }
    expect(expected[0]).not.toEqual(expected[1]);
  });

  it('hex-decodes a mixed seed and formats hand 200 without padding', () => {
    const seed = '0123456789abcdef'.repeat(4);
    const expected = createHmac('sha256', Buffer.from(seed, 'hex'))
      .update('agent-casino/deck/v1:200:0')
      .digest();
    const next = deckStream(seed, 200);
    expect(Array.from({ length: 8 }, () => next())).toEqual(
      Array.from({ length: 8 }, (_, i) => expected.readUInt32BE(i * 4)),
    );
  });

  it('each stream owns its cursor even when calls are interleaved', () => {
    const first = deckStream(ZERO, 1);
    const second = deckStream(ZERO, 1);
    const expected = deckStream(ZERO, 1);
    const words = Array.from({ length: 24 }, () => expected());
    expect(Array.from({ length: 9 }, () => first())).toEqual(words.slice(0, 9));
    expect(Array.from({ length: 24 }, () => second())).toEqual(words);
    expect(Array.from({ length: 15 }, () => first())).toEqual(words.slice(9));
  });
});

describe('uniformBelow', () => {
  it.each([
    { m: 3, values: [4294967295, 4294967295, 8], expected: 2, consumed: 3 },
    // 2^32 mod 52 = 48, so the rejection threshold is 4294967248.
    { m: 52, values: [4294967248, 4294967295, 105], expected: 1, consumed: 3 },
    { m: 52, values: [4294967247, 0], expected: 51, consumed: 1 },
    { m: 3, values: [4294967294, 0], expected: 2, consumed: 1 },
    { m: 1, values: [4294967295], expected: 0, consumed: 1 },
    { m: 2 ** 32, values: [4294967295], expected: 4294967295, consumed: 1 },
  ])('m=$m, skips only rejected words', ({ m, values, expected, consumed }) => {
    let used = 0;
    const next = () => {
      const value = values[used++];
      if (value === undefined) throw new Error('scripted stream exhausted');
      return value;
    };
    expect(uniformBelow(next, m)).toBe(expected);
    expect(used).toBe(consumed);
  });
});

describe('shuffledDeck', () => {
  it.each(GOLDEN)(
    'seed $seed hand $hand deals the golden first 9 cards',
    ({ seed, hand, first9 }) => {
      expect(shuffledDeck(seed, hand).slice(0, 9)).toEqual(first9);
    },
  );

  it('rejects and redraws a word >= limit while shuffling', () => {
    // At step i = 45 (m = 46, limit 4294967284) this deal draws 4294967288,
    // discards it and draws again: the only redraw in the deck. Plain
    // `x mod m` without rejection would deal
    // 9s Kc 2s 9d 7s 2d 5c Ts 7d instead.
    const seed = `${'0'.repeat(58)}c579dc`;
    expect(shuffledDeck(seed, 1).slice(0, 9)).toEqual([
      '3d',
      'Qd',
      '9s',
      'Ks',
      '9c',
      'Th',
      '5s',
      'Td',
      'Qs',
    ]);
  });

  it('pins the full 52-card deck for all-zero seed hand 1', () => {
    expect(shuffledDeck(ZERO, 1)).toEqual([
      'Tc',
      '6h',
      'Jd',
      'Js',
      '2c',
      'Ac',
      'Qs',
      'Jh',
      '4h',
      'Qc',
      '7h',
      '9h',
      '5c',
      '2s',
      '3d',
      'Qh',
      '7c',
      '2h',
      'Qd',
      '9d',
      '2d',
      'Th',
      '7s',
      'Jc',
      '3h',
      'Kc',
      '6c',
      'Ad',
      '8h',
      '4d',
      '8d',
      '4c',
      'Ks',
      '9s',
      '7d',
      'Ts',
      '6s',
      '8c',
      '5s',
      'Td',
      '5d',
      'Ah',
      'As',
      'Kd',
      'Kh',
      '3s',
      '5h',
      '8s',
      '4s',
      '3c',
      '9c',
      '6d',
    ]);
  });

  it('shuffles the same seed and hand number identically twice', () => {
    for (const { seed, hand } of GOLDEN) {
      expect(shuffledDeck(seed, hand)).toEqual(shuffledDeck(seed, hand));
    }
  });

  it('gives different hands of the same seed different decks', () => {
    const decks = [1, 2, 3, 4, 5].map(hand => shuffledDeck(ZERO, hand).join());
    expect(new Set(decks).size).toBe(decks.length);
  });

  it('always returns a permutation of the 52 cards', () => {
    const sorted = [...newDeck()].sort();
    for (let i = 0; i < 300; i++) {
      const seed = i.toString(16).padStart(64, '0');
      const deck = shuffledDeck(seed, (i % 7) + 1);
      expect(deck).toHaveLength(52);
      expect([...deck].sort()).toEqual(sorted);
    }
    expect([...shuffledDeck('f'.repeat(64), 1)].sort()).toEqual(sorted);
  });

  it('does not share state between calls', () => {
    const first = shuffledDeck(ZERO, 1);
    const copy = [...first];
    first.reverse();
    first[0] = '2s';
    shuffledDeck('f'.repeat(64), 200);
    expect(shuffledDeck(ZERO, 1)).toEqual(copy);
  });

  it('accepts all-zero and all-f seeds', () => {
    expect(() => shuffledDeck(ZERO, 1)).not.toThrow();
    expect(() => shuffledDeck('f'.repeat(64), 1)).not.toThrow();
  });
});

describe('dealHand', () => {
  it.each(GOLDEN)(
    'seed $seed hand $hand deals hole cards and board in order',
    ({ seed, hand, first9 }) => {
      const [c0, c1, c2, c3, f1, f2, f3, turn, river] = first9;
      expect(dealHand(seed, hand)).toEqual({
        holeCards: [
          [c0, c2],
          [c1, c3],
        ],
        board: [f1, f2, f3, turn, river],
      });
    },
  );

  it('matches the first 9 cards of shuffledDeck', () => {
    for (let hand = 1; hand <= 20; hand++) {
      const deck = shuffledDeck(ZERO, hand);
      const { holeCards, board } = dealHand(ZERO, hand);
      expect([
        holeCards[0][0],
        holeCards[1][0],
        holeCards[0][1],
        holeCards[1][1],
        ...board,
      ]).toEqual(deck.slice(0, 9));
    }
  });
});

describe.each([
  ['deckStream', deckStream],
  ['shuffledDeck', shuffledDeck],
  ['dealHand', dealHand],
] as const)('%s validates inputs', (_name, make) => {
  it.each(INVALID_SEEDS)('throws RangeError for seed %j', seed => {
    expect(() => make(seed, 1)).toThrow(RangeError);
  });
  it.each(INVALID_HANDS)('throws RangeError for hand number %s', hand => {
    expect(() => make(ZERO, hand)).toThrow(RangeError);
  });
});
