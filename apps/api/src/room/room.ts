import { DurableObject } from 'cloudflare:workers';
import type { Seat } from '../holdem/match';
import { type CreateInput, type RoomApi, RoomReferee } from './referee';

// One referee per room: the RPC surface of routes/room.ts. The rules of the
// room live in referee.ts so they can be tested in Node.
export class Room extends DurableObject<Env> implements RoomApi {
  readonly #referee: RoomReferee;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#referee = new RoomReferee(ctx.storage);
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
}
