// The multiplayer endpoints in the contract (casino-api A25) whose handlers
// come with T39 (quick seat, lobby). Until then they answer this, which an
// agent should not retry.
import { Effect } from 'effect';
import { apiError } from '../contract/errors';

export const notOpenYet = (endpoint: string) =>
  Effect.fail(
    apiError(
      'unavailable',
      `${endpoint} is not open yet: multiplayer tables are still being built`,
      'This endpoint is not open yet, so do not retry it. Play heads-up instead as /skill.md describes',
      { retryable: false },
    ),
  );
