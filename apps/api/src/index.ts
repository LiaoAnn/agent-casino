import { handle } from './app';

export { Matchmaker } from './matchmaker/matchmaker';
export { Room } from './room/room';

export default {
  fetch: handle,
} satisfies ExportedHandler<Env>;
