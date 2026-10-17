/// <reference types="node" />
/**
 * Play heads-up against the random bot in the terminal, no server needed:
 *   pnpm holdem:play [--seed N] [--hands N] [--stack N] [--bot-seed N]
 * You are seat 0. Type `fold`, `check`, `call` or `raise <total>` (or
 * `f`, `k`, `c`, `r <total>`). Input can be piped in, one action per line.
 */
import { registerHooks } from 'node:module';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type {
  Action,
  HandRecord,
  HistoryEvent,
  LegalAction,
  MatchState,
} from '../src/holdem/match';

// The holdem modules use extensionless imports, which Node's own TypeScript
// support can't resolve; add `.ts` before loading them.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { applyAction, legalActions, startMatch } = await import(
  '../src/holdem/match'
);
const { randomAction } = await import('../src/holdem/bot');
const { replay } = await import('../src/holdem/replay');
const { mulberry32 } = await import('../src/holdem/shuffle');
const { viewFor } = await import('../src/holdem/view');

const randomSeed = () => Math.floor(Math.random() * 2 ** 32);
const { values } = parseArgs({
  options: {
    seed: { type: 'string' },
    hands: { type: 'string', default: '10' },
    stack: { type: 'string', default: '40' },
    'bot-seed': { type: 'string' },
  },
});
const config = {
  seed: values.seed === undefined ? randomSeed() : Number(values.seed),
  hands: Number(values.hands),
  startingStack: Number(values.stack),
};
const botSeed =
  values['bot-seed'] === undefined ? randomSeed() : Number(values['bot-seed']);
const botRandom = mulberry32(botSeed);
const piped = !process.stdin.isTTY;
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

const YOU = 0;
const BOT = 1;
const name = (seat: number) => (seat === YOU ? 'You' : 'Bot');

let state: MatchState = startMatch(config);
const events: HistoryEvent[] = [];
const hands: HandRecord[] = [];

console.log(
  `Seed ${config.seed}, bot seed ${botSeed}, ${config.hands} hands, ` +
    `${config.startingStack} chips each. You are seat 0.`,
);
announceHand();

while (!state.over) {
  const legal = legalActions(state);
  const seat = state.toAct === YOU ? YOU : BOT;
  let action: Action;
  if (seat === BOT) {
    action = randomAction(legal, botRandom);
  } else {
    showTable(legal);
    const input = await ask();
    if (input === null) {
      console.log('No more input; stopping.');
      process.exit(0);
    }
    const parsed = parseAction(input);
    if (typeof parsed === 'string') {
      console.log(parsed);
      continue;
    }
    action = parsed;
  }
  const result = applyAction(state, seat, action);
  if (!result.ok) {
    console.log(result.message);
    continue;
  }
  console.log(`[${state.street}] ${name(seat)}: ${describe(action, legal)}`);
  for (const hand of result.finishedHands) {
    showResult(hand);
    hands.push(hand);
    events.push(...hand.events);
  }
  const handChanged = result.state.handNumber !== state.handNumber;
  state = result.state;
  if (handChanged && !state.over) announceHand();
}

const [mine, theirs] = state.stacks;
console.log(
  `Match over: you ${mine}, bot ${theirs}. ` +
    (mine > theirs ? 'You win.' : mine < theirs ? 'Bot wins.' : 'Draw.'),
);
const replayed = replay(config, events);
const same =
  replayed.ok &&
  JSON.stringify(replayed.state) === JSON.stringify(state) &&
  JSON.stringify(replayed.hands) === JSON.stringify(hands);
console.log(
  `Replay from seed + ${events.length} events: ${same ? 'same result' : 'MISMATCH'}`,
);
process.exit(same ? 0 : 1);

async function ask(): Promise<string | null> {
  process.stdout.write('> ');
  const next = await lines.next();
  if (next.done) {
    if (piped) process.stdout.write('\n');
    return null;
  }
  if (piped) process.stdout.write(`${next.value}\n`);
  return next.value;
}

function parseAction(input: string): Action | string {
  const [word = '', amount] = input.trim().toLowerCase().split(/\s+/);
  if (word === 'fold' || word === 'f') return { type: 'fold' };
  if (word === 'check' || word === 'k') return { type: 'check' };
  if (word === 'call' || word === 'c') return { type: 'call' };
  if (word === 'raise' || word === 'r') {
    return { type: 'raise', amount: Number(amount) };
  }
  return 'Type fold, check, call or raise <total> (f, k, c, r <total>)';
}

function describe(action: Action, legal: LegalAction[]): string {
  if (action.type === 'raise') return `raise to ${action.amount}`;
  if (action.type === 'call') {
    const call = legal.find(legal => legal.type === 'call');
    return `call ${call?.type === 'call' ? call.amount : ''}`;
  }
  return action.type;
}

function announceHand(): void {
  const dealer = state.button === YOU ? 'you are' : 'bot is';
  console.log(
    `\n=== Hand ${state.handNumber}/${config.hands} (${dealer} the button) ===`,
  );
}

function showTable(legal: LegalAction[]): void {
  const { view } = viewFor(state, YOU);
  const options = legal.map(legal =>
    legal.type === 'call'
      ? `call ${legal.amount}`
      : legal.type === 'raise'
        ? `raise ${legal.min}-${legal.max}`
        : legal.type,
  );
  console.log(
    `${view.street}: you ${view.my_cards.join(' ')} | board ` +
      `${view.board.join(' ') || '-'} | pot ${view.pot} | ` +
      `bets you ${view.my_bet_this_street}, bot ${view.opponent_bet_this_street}` +
      ` | stacks you ${view.my_stack}, bot ${view.opponent_stack}`,
  );
  console.log(`Your move: ${options.join(', ')}`);
}

function showResult(hand: HandRecord): void {
  if (hand.hole_cards) {
    const [yours, bots] = hand.hole_cards;
    console.log(
      `Showdown: board ${hand.board.join(' ')}, you ${yours.join(' ')}, ` +
        `bot ${bots.join(' ')}`,
    );
  }
  const winner =
    hand.winner_seat === null
      ? `Split pot of ${hand.pot}`
      : `${name(hand.winner_seat)} won ${hand.pot}`;
  console.log(
    `Hand ${hand.hand_number} over: ${winner} (${hand.ended_by}). ` +
      `Stacks: you ${hand.stacks[0]}, bot ${hand.stacks[1]}`,
  );
}
