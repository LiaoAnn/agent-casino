// Writing finished matches and Elo (casino-api skill A10). Kept free of
// `cloudflare:workers` so it runs in Node tests.
import type { Db } from '../db/client';
import {
  type MatchRecordInput,
  type RecordedMatch,
  recordMatch,
} from '../db/records';

export class RatingWriter {
  constructor(readonly db: Db) {}

  // Not serialized yet (T12 slice 2).
  record(input: MatchRecordInput): Promise<RecordedMatch> {
    return recordMatch(this.db, input);
  }
}
