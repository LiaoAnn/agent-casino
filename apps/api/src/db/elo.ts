// Elo (casino-api skill: 資料與積分): start at 1500, K = 32, a draw scores 0.5.
export const INITIAL_RATING = 1500;
export const K_FACTOR = 32;

/** scoreA: 1 = A won, 0.5 = draw, 0 = A lost. Returns new unrounded [a, b]. */
export function eloUpdate(
  a: number,
  b: number,
  scoreA: 0 | 0.5 | 1,
): [number, number] {
  const delta = pairDelta(a, b, scoreA, K_FACTOR);
  return [a + delta, b - delta];
}

const pairDelta = (a: number, b: number, scoreA: number, k: number) =>
  k * (scoreA - 1 / (1 + 10 ** ((b - a) / 400)));

/**
 * A table of N as every pair of seats playing once (T40): the better place
 * wins, a shared place draws, K = 32 / (N − 1), all from the ratings before
 * the match. Two seats give exactly `eloUpdate`. Takes and returns unrounded
 * ratings by seat; `places` start at 1.
 */
export function placesEloUpdate(
  ratings: readonly number[],
  places: readonly number[],
): number[] {
  const n = ratings.length;
  if (n !== places.length || n < 2 || n > 6) {
    throw new RangeError(
      `Need 2 to 6 seats with a place each: ${n} ratings, ${places.length} places`,
    );
  }
  const k = K_FACTOR / (n - 1);
  const deltas = ratings.map(() => 0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const score = places[i] < places[j] ? 1 : places[i] > places[j] ? 0 : 0.5;
      const delta = pairDelta(ratings[i], ratings[j], score, k);
      deltas[i] += delta;
      deltas[j] -= delta;
    }
  }
  return ratings.map((rating, seat) => rating + deltas[seat]);
}
