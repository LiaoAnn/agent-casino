// The one place a room's seed is made (holdem-rules: 種子與洗牌). Everything
// else stores and passes it on as is, and no response ever shows it during a
// match.
import { bytesToHex } from '@noble/hashes/utils.js';
import type { TestSettings } from '../contract/schemas';

// `test` is null unless ALLOW_TEST_ROOMS=true; then test.seed is used as is.
// Otherwise 256 secret bits from the cryptographic RNG as 64 lowercase hex.
export function newSeed(test: typeof TestSettings.Type | null): string {
  if (test?.seed !== undefined) return test.seed;
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}
