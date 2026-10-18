import { DurableObject } from 'cloudflare:workers';
import type { Seat } from '../holdem/match';
import type { Matchmaker } from '../matchmaker/matchmaker';
import { type CreateInput, type RoomApi, RoomReferee } from './referee';

// One referee per room: the RPC surface of routes/room.ts. The rules of the
// room live in referee.ts so they can be tested in Node.
export class Room extends DurableObject<Env> implements RoomApi {
  readonly #referee: RoomReferee;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Elo goes through the platform's one Matchmaker, which writes one match
    // at a time (A10). Typed as the class: RPC types would turn the tuples
    // of the record into plain arrays.
    const matchmaker = () =>
      env.MATCHMAKER.get(
        env.MATCHMAKER.idFromName('global'),
      ) as unknown as Pick<Matchmaker, 'recordMatch'>;
    this.#referee = new RoomReferee(ctx.storage, {
      record: input => matchmaker().recordMatch(input),
    });
  }

  create(input: CreateInput) {
    return this.#referee.create(input);
  }

  join(input: { name: string; invite_code: string }) {
    return this.#referee.join(input);
  }

  status(seat: Seat, options: { wait: boolean }) {
    return this.#referee.status(seat, options);
  }

  act(seat: Seat, input: Parameters<RoomReferee['act']>[1]) {
    return this.#referee.act(seat, input);
  }

  leave(seat: Seat) {
    return this.#referee.leave(seat);
  }

  abort() {
    return this.#referee.abort();
  }

  watch(seat: Seat) {
    return this.#referee.watch(seat);
  }

  override alarm() {
    return this.#referee.alarm();
  }
}
