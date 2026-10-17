// The Worker's bindings, given to handlers as a service. Handlers read D1, the
// DOs and secrets with `yield* WorkerEnv`; tests pass a fake env to handle().
import { Context } from 'effect';

export type Bindings = Env & {
  // Worker secrets (`wrangler secret put`; locally `.dev.vars`).
  TOKEN_SECRET: string;
  ADMIN_KEY: string;
};

export class WorkerEnv extends Context.Service<WorkerEnv, Bindings>()(
  'agent-casino/WorkerEnv',
) {}
