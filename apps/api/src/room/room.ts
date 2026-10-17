import { DurableObject } from 'cloudflare:workers';

// One referee per room. Filled in by T09.
export class Room extends DurableObject<Env> {}
