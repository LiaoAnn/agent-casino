// Writing finished matches and Elo (casino-api skill A10). Kept free of
// `cloudflare:workers` so it runs in Node tests.
import type { Db } from '../db/client';
import {
  type MatchRecordInput,
  type RecordedMatch,
  recordMatch,
} from '../db/records';

// recordMatch reads the ratings, then writes them. A DO lets the next RPC in
// while it awaits D1, so two matches sharing a name would both read the old
// rating and the later write would undo the earlier one: one at a time here.
export class RatingWriter {
  readonly #db: Db;
  #last: Promise<unknown> = Promise.resolve();

  constructor(db: Db) {
    this.#db = db;
  }

  // Runs after every earlier call has settled; a failed call rejects on its
  // own and doesn't hold up the next.
  record(input: MatchRecordInput): Promise<RecordedMatch> {
    const run = this.#last.then(() => recordMatch(this.#db, input));
    this.#last = run.catch(() => {});
    return run;
  }
}
