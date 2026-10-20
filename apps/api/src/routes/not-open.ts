// The multiplayer endpoints in the contract (casino-api A25) whose handlers
// come with T38 and T39. Until then they answer this, which an agent should
// not retry.
import { Effect } from 'effect';
import { apiError } from '../contract/errors';

export const notOpenYet = (endpoint: string) =>
  Effect.fail(
    apiError(
      'unavailable',
      `${endpoint} is not open yet: multiplayer tables are still being built`,
      'Do not retry this endpoint. Play heads-up instead as /skill.md describes',
      { retryable: false },
    ),
  );
