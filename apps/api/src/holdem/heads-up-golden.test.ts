/// <reference types="node" />
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { seatView } from '../room/view';
import { randomAction } from './bot';
import { mulberry32 } from './shuffle';
import {
  type Action,
  applyTableAction,
  replayTable,
  startTable,
  type TableConfig,
  type TableEvent,
  type TableState,
  tableLegalActions,
} from './table';

// Heads-up regression (T36, rule 6): every state, legal action list, seat
// view, hand record, rejection message and replay of these random 2-seat
// tables must stay exactly what the heads-up engine produced before the
// table engine existed. The digests were recorded from that engine (main at
// 9180b42); `GOLDEN_PRINT=1` prints the current ones.

const MATCHES = 120;

const randomInt = (random: () => number, min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));

function pickConfig(random: () => number): Omit<TableConfig, 'players'> {
  const seed = Array.from({ length: 8 }, () =>
    Math.floor(random() * 2 ** 32)
      .toString(16)
      .padStart(8, '0'),
  ).join('');
  const roll = random();
  return {
    seed,
    maxHands: randomInt(random, 1, 100),
    blindEvery: randomInt(random, 1, 50),
    startingStack:
      roll < 0.4
        ? 10
        : roll < 0.8
          ? randomInt(random, 10, 60)
          : randomInt(random, 10, 2000),
  };
}

function badAction(random: () => number): Action {
  const choices: Action[] = [
    { type: 'check' },
    { type: 'call' },
    { type: 'raise', amount: randomInt(random, 0, 3000) },
    { type: 'raise', amount: 2.5 },
  ];
  return choices[Math.floor(random() * choices.length)];
}

// What the table engine added for 2–6 seats; the heads-up engine had none
// of these, so they are left out of the digest (table.test.ts covers them).
const TABLE_ONLY = new Set(['players', 'folded', 'places', 'taken', 'pots']);

/** Plain JSON with sorted keys: key order is not behavior. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner)
            .filter(([key]) => !TABLE_ONLY.has(key))
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );

// A seat's answer as the heads-up engine shaped it (casino-api A6).
const viewFor = (table: TableState, seat: number) => ({
  hand_number: table.handNumber,
  to_act_seat: table.toAct,
  view: seatView(table, seat),
  last_hand: table.lastHand,
});

/** Everything observable about one random match, hashed. */
function traceDigest(matchIndex: number): string {
  const random = mulberry32(20261020 + matchIndex);
  const config = pickConfig(random);
  const trace: unknown[] = [config];
  let state = startTable({ ...config, players: 2 });
  const events: TableEvent[] = [];
  for (let step = 0; step < 100_000; step++) {
    trace.push(
      state,
      tableLegalActions(state),
      viewFor(state, 0),
      viewFor(state, 1),
    );
    if (state.over) {
      trace.push(applyTableAction(state, 0, { type: 'fold' }));
      break;
    }
    const seat = state.toAct as number;
    trace.push(applyTableAction(state, 1 - seat, { type: 'fold' }));
    if (random() < 0.15)
      trace.push(applyTableAction(state, seat, badAction(random)));
    const action = randomAction(tableLegalActions(state), random);
    const result = applyTableAction(state, seat, action, {
      timeout: random() < 0.1,
    });
    trace.push(action, result);
    if (!result.ok) break;
    for (const hand of result.finishedHands) events.push(...hand.events);
    state = result.state;
  }
  trace.push(replayTable({ ...config, players: 2 }, events));
  return bytesToHex(sha256(utf8ToBytes(canonical(trace)))).slice(0, 16);
}

const GOLDEN: string[] = [
  '9434f237dcee254a',
  'b12405ed85721109',
  'db9a6d90fba81dbd',
  '6aa2d530075305ef',
  '85a3a135ba0f7b83',
  'dd4a5e41446b03ba',
  '5fb31c055afbddfc',
  '4b51c9f2d2debcf1',
  '4e1f36818768799d',
  'c63fce5e693cd247',
  '5117beb94356c7d8',
  'afd96a219c28e8cd',
  '0e02c0ff74669e10',
  '871240c92bcecad0',
  '4e389edd33cf86dc',
  '85fce4b3c5fb0ea3',
  '471aa7e5bd8c643d',
  'c31df9baff074420',
  'fcd59bad3e170ef2',
  'abbcf40910fbc730',
  'e76cc693d31fe3a2',
  'f9c6aa876e112d29',
  'd0a6a815121d0aa7',
  'a435f93eb773c95d',
  'e4cf49508a4922d1',
  '6d22c05ced04d7b6',
  '4f5ea3c62a655d28',
  'fbf035751ed799dd',
  'bff38bffd917a7c5',
  'edd26c99ece12bef',
  '27061157649bc4ab',
  'e92ab0eb36000798',
  '90b25603d09e24bc',
  'f378450b505908f9',
  '7d01a96c72db2579',
  '4e5ac25cd0e859cb',
  'fd0bdc4f404e1e31',
  'd32d218507a99a86',
  '1669708ab9c4aad9',
  '91a7a2177d802205',
  '8ff427eb1c8e386a',
  'db7f6bf7d14b1cd8',
  'be21a858fd1cb6cf',
  '4456d92e39c96b2d',
  '20bf9f25011e5774',
  'a220cb5c4f433645',
  'af3c9676332c0702',
  'e7168bdb3c75b8e8',
  'b0896cbc6c9b6778',
  '7d0c4902f1802c92',
  '81ae9cc38810dd1c',
  '8b08e6de7549d584',
  '59c97a848c93b4c1',
  '245b3514d52b0646',
  '9ca558cac9bd7caa',
  'e239633e0ad0afcc',
  '3961226c072a3b63',
  '6f1861e025e0283f',
  'f84f95d7ba4f4d7f',
  '2572f550b3b87503',
  'efd74312b441405e',
  '1d870debb13e74af',
  '9dadb3cb4579ffb2',
  '2ca64018cb4d2278',
  '3198c3f39336d2fd',
  '43c16f7b13309537',
  '434f567716a74deb',
  '24b850684c9adfe9',
  'd901370aca902607',
  'ae952806091c110c',
  '95f8c4e68d38dc98',
  'ccdaffe613d366ca',
  '83afc5afefde9858',
  '83cac2639e9d1b77',
  '7c52ad71c540e433',
  'ac534f7a0087bb36',
  'fd52608dc573c006',
  'ae9809da4abccbfb',
  'e6e7dec7e19fa6bb',
  '728b6b3b0d1180ff',
  '75f2dddaad28de53',
  'afd50df02278f036',
  '65f8ac28005f5e24',
  '454ef1a52e6b108c',
  '3944d41bb3e804ad',
  'b1eeec43774ada88',
  'd172b5f6e231556a',
  'd962ec0212b913c3',
  'eeaab23bed63ff5c',
  'd4601d30b4654619',
  'e46579da24759e77',
  'c22e62095b2e4aac',
  'fc9c30f5fdad8292',
  'd1d845c2b52bc96d',
  'c581a7c573d73c86',
  'c2c7b930128958b0',
  'c69b8f8896e4dae1',
  '022df7c31f9b79e6',
  '82d9dc879f69d058',
  '57482df82111f209',
  '5d132d0cc3750239',
  '70721baa1892a63d',
  '123ba318e36c18f0',
  'ca162eefcd4fb47e',
  '0b1d7c7ba00b6a83',
  'e50e0f8c3f11ea97',
  '0eff53ff4988ffc6',
  '8c262f4fde8160e2',
  '2e5599418a968015',
  'cc7564b47625a51d',
  '9b79202e5241b174',
  'b8e78df5eda59bb5',
  '09c6ee2d9be19a2d',
  '379cdbb9eee0d6a9',
  '4e6370ad0769a061',
  '7d11866fbc03dbbb',
  '8740740090e7db04',
  '3fdb189131d67bea',
  '9f391f94cc58a318',
  'c7972cf943ce0a59',
];

describe('2-seat tables against the pre-table heads-up engine', () => {
  it('replays every recorded match exactly', () => {
    const digests = Array.from({ length: MATCHES }, (_, i) => traceDigest(i));
    if (process.env.GOLDEN_PRINT) console.log(JSON.stringify(digests));
    expect(digests).toEqual(GOLDEN);
  });
});
