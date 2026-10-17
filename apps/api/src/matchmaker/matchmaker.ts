import { DurableObject } from 'cloudflare:workers';

// The single queue and Elo writer. Filled in by T12.
export class Matchmaker extends DurableObject<Env> {}
