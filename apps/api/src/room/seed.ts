// The one place a room's seed is made (holdem-rules: 種子與洗牌). Everything
// else stores and passes it on as is, and no response ever shows it during a
// match. T20 swaps this for the 256-bit secret seed.
import type { TestSettings } from '../contract/schemas';

// `test` is null unless ALLOW_TEST_ROOMS=true; then test.seed is used as is.
export function newSeed(test: typeof TestSettings.Type | null): number {
  return test?.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}
