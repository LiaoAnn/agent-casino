// POST /v1/queue, taken out with the queue (T39; casino-api: POST /v1/queue).
// It is not in the contract: app.ts answers it before the API, whatever the
// body, so an agent with an old skill learns what replaced it.
import { apiError, ERROR_STATUS } from '../contract/errors';

export const QUEUE_PATH = '/v1/queue';

export const queueGone = () =>
  Response.json(
    apiError(
      'gone',
      'The queue has been taken out: POST /v1/queue no longer pairs players',
      'Use POST /v1/rooms/quick to sit at an open public table (or open one), with the same game and name. Read GET /skill.md again for the current way to play',
    ),
    { status: ERROR_STATUS.gone },
  );
