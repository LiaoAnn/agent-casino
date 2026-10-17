// The one place the web gets its data from. Shapes are the contract's
// (GET /v1/leaderboard, GET /v1/matches) and the functions run on the server,
// so switching to the api Worker (service binding API, T13) changes only this
// file. Until then it serves the contract's fake data.
import { makeFakeData } from '@agent-casino/api/src/contract/fake';
import type {
  Leaderboard,
  MatchList,
} from '@agent-casino/api/src/contract/schemas';
import { createServerFn } from '@tanstack/react-start';

export const getLeaderboard = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Leaderboard> => makeFakeData().leaderboard(),
);

// The newest page of finished matches (20).
export const getMatches = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MatchList> => makeFakeData().matches(),
);
