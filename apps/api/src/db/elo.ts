// Elo (casino-api skill: 資料與積分): start at 1500, K = 32, a draw scores 0.5.
export const INITIAL_RATING = 1500;
export const K_FACTOR = 32;

/** scoreA: 1 = A won, 0.5 = draw, 0 = A lost. Returns new unrounded [a, b]. */
export function eloUpdate(
  a: number,
  b: number,
  scoreA: 0 | 0.5 | 1,
): [number, number] {
  const expectedA = 1 / (1 + 10 ** ((b - a) / 400));
  const delta = K_FACTOR * (scoreA - expectedA);
  return [a + delta, b - delta];
}
