import {
  type ApplyResult,
  applyAction,
  type HandRecord,
  type HistoryEvent,
  type MatchConfig,
  type MatchState,
  startMatch,
} from './match';

export type ReplayResult =
  | { ok: true; state: MatchState; hands: HandRecord[] }
  | {
      ok: false;
      /** Position in `events` of the first event the engine rejected. */
      index: number;
      code: Extract<ApplyResult, { ok: false }>['code'];
      message: string;
    };

/**
 * Rebuilds a match from its config (seed included) and every event so far,
 * in order: each finished hand's `events`, then the hand in progress.
 * Blinds are skipped because the engine posts them itself. Compare the
 * result with the live match to check it. Throws RangeError on a bad config.
 */
export function replay(
  config: MatchConfig,
  events: HistoryEvent[],
): ReplayResult {
  let state = startMatch(config);
  const hands: HandRecord[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type === 'post_blind') continue;
    const result = applyAction(
      state,
      event.seat,
      event.type === 'raise'
        ? { type: 'raise', amount: event.amount ?? Number.NaN }
        : { type: event.type },
      { timeout: event.timeout },
    );
    if (!result.ok) {
      return {
        ok: false,
        index,
        code: result.code,
        message: result.message,
      };
    }
    state = result.state;
    hands.push(...result.finishedHands);
  }
  return { ok: true, state, hands };
}
