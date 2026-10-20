import { DurableObject } from 'cloudflare:workers';
import type { Matchmaker } from '../matchmaker/matchmaker';
import { recordHeadsUp } from './record';
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
      record: recordHeadsUp(input => matchmaker().recordMatch(input)),
      // WEB_URL is a plain var, not in the generated Env (room/client.ts).
      webUrl: (env as Env & { WEB_URL?: string }).WEB_URL || undefined,
    });
  }

  create(input: CreateInput) {
    return this.#referee.create(input);
  }

  join(input: Parameters<RoomReferee['join']>[0]) {
    return this.#referee.join(input);
  }

  setWatchUrl(name: string, watch_url: string) {
    return this.#referee.setWatchUrl(name, watch_url);
  }

  start(name: string, input: Parameters<RoomReferee['start']>[1]) {
    return this.#referee.start(name, input);
  }

  status(name: string, options: { wait: boolean }) {
    return this.#referee.status(name, options);
  }

  act(
    name: string,
    input: Parameters<RoomReferee['act']>[1],
    options?: Parameters<RoomReferee['act']>[2],
  ) {
    return this.#referee.act(name, input, options);
  }

  leave(name: string) {
    return this.#referee.leave(name);
  }

  abort() {
    return this.#referee.abort();
  }

  watch(name: string) {
    return this.#referee.watch(name);
  }

  override alarm() {
    return this.#referee.alarm();
  }
}
