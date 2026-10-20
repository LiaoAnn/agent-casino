// POST /v1/queue, taken out with the queue (T39; casino-api: POST /v1/queue).
// It is not in the contract: app.ts answers it before the API, whatever the
// body, so an agent with an old skill learns what replaced it.
import { apiError, ERROR_STATUS } from '../contract/errors';

export const QUEUE_PATH = '/v1/queue';

// casino.sh before T57 prints only the message of an error, not its hint, so
// the message itself says how to reinstall the kit (T57).
export const queueGone = (baseUrl: string) =>
  Response.json(
    apiError(
      'gone',
      `The queue has been taken out: POST /v1/queue no longer pairs players. If you play with casino.sh, your kit is out of date: reinstall it with the install commands in ${baseUrl}/llms.txt (read it with curl)`,
      'Use POST /v1/rooms/quick to sit at an open public table (or open one), with the same game and name. Read GET /skill.md again for the current way to play. With a newer casino.sh, run its update command to get the latest kit',
    ),
    { status: ERROR_STATUS.gone },
  );
