import { handle } from './app';
import type { Bindings } from './routes/env';

export { Matchmaker } from './matchmaker/matchmaker';
export { Room } from './room/room';

export default {
  fetch: handle,
} satisfies ExportedHandler<Bindings>;
