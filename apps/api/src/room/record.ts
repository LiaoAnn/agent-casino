// The room's N-seat match record, handed to today's two-seat
// db/records.ts recordMatch until T40 stores N seats. A table of three or
// more is not stored yet and counts as unrated (E6 keeps main off
// production meanwhile). T38 or T40, whichever merges last, removes this.
import type { MatchRecordInput } from '../db/records';
import type { RecordedMatch, TableRecordInput } from './referee';

export const recordHeadsUp =
  (record: (input: MatchRecordInput) => Promise<RecordedMatch>) =>
  async (input: TableRecordInput): Promise<RecordedMatch> => {
    if (input.players.length !== 2) {
      console.warn(
        `Room ${input.match_id}: ${input.players.length}-seat matches are not stored until T40`,
      );
      return { rated: false, ratings: null };
    }
    const { places: _places, hands, ...match } = input;
    return record({
      ...match,
      result: match.result as MatchRecordInput['result'],
      players: [match.players[0], match.players[1]],
      display_names: [match.display_names[0], match.display_names[1]],
      final_stacks: [match.final_stacks[0], match.final_stacks[1]],
      hands: hands.map(
        ({ pots: _pots, ...hand }) =>
          hand as unknown as MatchRecordInput['hands'][number],
      ),
    });
  };
