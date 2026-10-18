import { DurableObject } from 'cloudflare:workers';
import { openDb } from '../db/client';
import type { MatchRecordInput } from '../db/records';
import type { Bindings } from '../routes/env';
import { MatchQueue, openMatchIn, type QueueInput } from './pairing';
import { RatingWriter } from './ratings';

// The single queue and Elo writer of the platform (casino-api A2, A10),
// reached with idFromName('global'). The work lives in pairing.ts and
// ratings.ts so it can be tested in Node.
export class Matchmaker extends DurableObject<Env> {
  readonly #queue: MatchQueue;
  readonly #ratings: RatingWriter;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The secrets (TOKEN_SECRET) are there at runtime; Env doesn't type them.
    this.#queue = new MatchQueue(openMatchIn(env as Bindings), {
      storage: ctx.storage,
    });
    this.#ratings = new RatingWriter(openDb(env.DB));
  }

  queue(input: QueueInput) {
    return this.#queue.queue(input);
  }

  // For a Room DO when its match ends (T13): stores the match and, when it
  // is rated, both players' Elo, one match at a time. Rejects if D1 fails.
  recordMatch(input: MatchRecordInput) {
    return this.#ratings.record(input);
  }
}
