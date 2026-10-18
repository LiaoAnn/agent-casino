import { expect, type Locator, type Page, test } from '@playwright/test';
// Relative paths: Playwright's ESM loader cannot resolve extensionless
// subpaths of the workspace package (it has no "exports" map).
import { makeFakeData } from '../../api/src/contract/fake';
import type { MatchDetail, MatchHand } from '../../api/src/contract/schemas';

const data = makeFakeData();

// Every match, not just the first page the home page shows.
const allMatches = (): MatchDetail[] => {
  const ids: string[] = [];
  let before: string | undefined;
  do {
    const page = data.matches(before === undefined ? {} : { before });
    ids.push(...page.matches.map(m => m.match_id));
    before = page.next ?? undefined;
  } while (before !== undefined);
  return ids.map(id => {
    const m = data.match(id);
    if (m === undefined) throw new Error(`no detail for ${id}`);
    return m;
  });
};
const matches = allMatches();
type Event = MatchHand['events'][number];

// --- Expected texts, computed from the contract data ---

const resultText = (m: MatchDetail): string => {
  switch (m.result) {
    case 'seat0_win':
      return `${m.players[0]} 勝`;
    case 'seat1_win':
      return `${m.players[1]} 勝`;
    case 'draw':
      return '平手';
    case 'void':
      return '作廢';
    case 'cancelled':
      return '取消';
  }
};

// '2026-10-01T00:37:00.000Z' -> '2026-10-01 00:37 UTC'
const endedText = (iso: string) =>
  `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const SUITS: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
// 'As' -> 'A♠', 'Td' -> '10♦'
const card = (c: string) =>
  `${c[0] === 'T' ? '10' : c[0]}${SUITS[c[1] as string]}`;

const pairText = (m: MatchDetail, values: readonly [unknown, unknown]) =>
  `${m.players[0]} ${values[0]} · ${m.players[1]} ${values[1]}`;

const signed = (n: number) => (n >= 0 ? `+${n}` : `-${-n}`);

const eloText = (m: MatchDetail) =>
  (m.rating_changes ?? [])
    .map(
      c => `${c.name} ${c.before} → ${c.after} (${signed(c.after - c.before)})`,
    )
    .join(' · ');

const infoPairs = (m: MatchDetail): [string, string][] => [
  ['結果', resultText(m)],
  ['結束時間', endedText(m.ended_at)],
  ['計分', m.rated ? '計分' : '不計分'],
  [
    '設定',
    `${m.settings.hands} 手 · 每步 ${m.settings.turn_seconds} 秒 · 起始籌碼 ${m.settings.starting_stack}`,
  ],
  ['種子', String(m.seed)],
  ['最終籌碼', pairText(m, m.final_stacks)],
  ...(m.rating_changes === null
    ? []
    : [['Elo', eloText(m)] as [string, string]]),
];

const handResult = (m: MatchDetail, h: MatchHand) => {
  if (h.winner_seat === null) return `平分底池 ${h.pot}`;
  const how = h.ended_by === 'showdown' ? '攤牌' : '對手棄牌';
  return `${m.players[h.winner_seat]} 贏得 ${h.pot}（${how}）`;
};

// The middle of the table as the hand ended.
const centerPairs = (m: MatchDetail, h: MatchHand): [string, string][] => [
  ['公共牌', h.board.length > 0 ? h.board.map(card).join(' ') : '沒有發公共牌'],
  ['底池', String(h.pot)],
  ['莊家', m.players[h.button_seat]],
  ['結果', handResult(m, h)],
];

// A seat's plate: hole cards, chips after the hand, Elo before a rated match.
const seatPairs = (
  m: MatchDetail,
  h: MatchHand,
  seat: 0 | 1,
): [string, string][] => {
  const before = m.rating_changes?.[seat].before;
  return [
    ['底牌', h.hole_cards[seat].map(card).join(' ')],
    ['籌碼', String(h.stacks[seat])],
    ...(before === undefined
      ? []
      : ([['Elo', String(before)]] as [string, string][])),
  ];
};

const STREETS = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '轉牌',
  river: '河牌',
} as const;

const actionText = (e: Event) => {
  switch (e.type) {
    case 'post_blind':
      return `下盲注 ${e.amount}`;
    case 'fold':
      return '棄牌';
    case 'check':
      return '過牌';
    case 'call':
      return `跟注 ${e.amount}`;
    case 'raise':
      return `加注到 ${e.amount}`;
  }
};

const eventText = (m: MatchDetail, e: Event) =>
  `${STREETS[e.street]} ${m.players[e.seat]} ${actionText(e)}${e.timeout ? ' 超時代打' : ''}`;

// --- Locators ---

const info = (page: Page) => page.locator('dl[aria-label="對局資訊"]');
const handSections = (page: Page) =>
  page.getByRole('region', { name: /^第 \d+ 手$/ });
const handSection = (page: Page, n: number) =>
  page.getByRole('region', { name: `第 ${n} 手`, exact: true });
const steps = (section: Locator, n: number) =>
  section
    .getByRole('list', { name: `第 ${n} 手的動作`, exact: true })
    .getByRole('listitem');

const expectPairs = async (dl: Locator, pairs: [string, string][]) => {
  await expect(dl.locator('dt')).toHaveText(pairs.map(p => p[0]));
  await expect(dl.locator('dd')).toHaveText(pairs.map(p => p[1]));
};

const seatPanel = (section: Locator, name: string) =>
  section.getByRole('region', { name: `座位：${name}`, exact: true });

const expectHand = async (page: Page, m: MatchDetail, h: MatchHand) => {
  const section = handSection(page, h.hand_number);
  await expect(
    section.getByRole('heading', {
      level: 3,
      name: `第 ${h.hand_number} 手`,
      exact: true,
    }),
  ).toBeVisible();
  await expectPairs(
    section.locator('dl[aria-label="牌桌"]'),
    centerPairs(m, h),
  );
  // Seat 1 at the top edge, seat 0 at the bottom.
  await expect(section.getByRole('region', { name: /^座位：/ })).toHaveText([
    new RegExp(`^${m.players[1]}`),
    new RegExp(`^${m.players[0]}`),
  ]);
  for (const seat of [0, 1] as const) {
    const panel = seatPanel(section, m.players[seat]);
    await expectPairs(panel.locator('dl'), seatPairs(m, h, seat));
    await expect(panel.getByText('莊家', { exact: true })).toHaveCount(
      h.button_seat === seat ? 1 : 0,
    );
    await expect(panel.getByText('勝', { exact: true })).toHaveCount(
      h.winner_seat === seat ? 1 : 0,
    );
  }
  await expect(steps(section, h.hand_number)).toHaveText(
    h.events.map(e => eventText(m, e)),
  );
};

const open = (page: Page, m: MatchDetail) =>
  page.goto(`/matches/${m.match_id}`);

// --- Picking matches by property ---

const hands = matches.flatMap(m => m.hands.map(h => ({ m, h })));
const findHand = (pred: (h: MatchHand) => boolean) => {
  const found = hands.find(({ h }) => pred(h));
  if (found === undefined) throw new Error('fake data lacks this case');
  return found;
};
const showdown = findHand(
  h => h.ended_by === 'showdown' && h.winner_seat !== null,
);
const fold = findHand(h => h.ended_by === 'fold');
const split = findHand(h => h.winner_seat === null);
const timedOut = findHand(h => h.events.some(e => e.timeout === true));
const raised = findHand(h => h.events.some(e => e.type === 'raise'));
const called = findHand(h => h.events.some(e => e.type === 'call'));
const empty = matches.find(m => m.hands.length === 0);
const rated = matches.find(m => m.rating_changes !== null);
const unrated = matches.find(m => m.rating_changes === null);

test('the fake data covers the cases this page must show', () => {
  expect(new Set(matches.map(m => m.result))).toEqual(
    new Set(['seat0_win', 'seat1_win', 'draw', 'void', 'cancelled']),
  );
  expect(empty?.result).toBe('cancelled');
  expect(rated).toBeDefined();
  expect(split.h.ended_by).toBe('showdown');
  expect(hands.some(({ h }) => h.events.some(e => !e.timeout))).toBe(true);
  // Both signs of an Elo change, so the +/- formatting is exercised.
  const deltas = matches.flatMap(m =>
    (m.rating_changes ?? []).map(c => c.after - c.before),
  );
  expect(deltas.some(d => d > 0)).toBe(true);
  expect(deltas.some(d => d < 0)).toBe(true);
});

test('shows a showdown hand step by step', async ({ page }) => {
  const { m, h } = showdown;
  await open(page, m);
  const section = handSection(page, h.hand_number);
  await expectHand(page, m, h);
  await expect(seatPanel(section, m.players[0])).toContainText(
    h.hole_cards[0].map(card).join(' '),
  );
  await expect(section.locator('dl[aria-label="牌桌"]')).toContainText(
    h.board.map(card).join(' '),
  );
  await expect(section).toContainText('（攤牌）');
  // The table on the left, the hand's steps on the right.
  const tableBox = await section.locator('dl[aria-label="牌桌"]').boundingBox();
  const stepsBox = await section
    .getByRole('list', { name: `第 ${h.hand_number} 手的動作`, exact: true })
    .boundingBox();
  if (tableBox === null || stepsBox === null) throw new Error('no layout');
  expect(stepsBox.x).toBeGreaterThanOrEqual(tableBox.x + tableBox.width);
});

test('shows a fold hand step by step with both hole cards', async ({
  page,
}) => {
  const { m, h } = fold;
  await open(page, m);
  const section = handSection(page, h.hand_number);
  await expectHand(page, m, h);
  for (const seat of [0, 1] as const)
    await expect(seatPanel(section, m.players[seat])).toContainText(
      h.hole_cards[seat].map(card).join(' '),
    );
  await expect(section).toContainText('（對手棄牌）');
  await expect(steps(section, h.hand_number).last()).toContainText('棄牌');
});

test('words raises as the total and calls as the chips added', async ({
  page,
}) => {
  for (const { m, h } of [raised, called]) {
    await open(page, m);
    const items = steps(handSection(page, h.hand_number), h.hand_number);
    for (const [i, e] of h.events.entries()) {
      if (e.type === 'raise')
        await expect(items.nth(i)).toContainText(`加注到 ${e.amount}`);
      if (e.type === 'call')
        await expect(items.nth(i)).toContainText(`跟注 ${e.amount}`);
    }
  }
});

test('marks only timed-out steps as 超時代打', async ({ page }) => {
  const { m, h } = timedOut;
  await open(page, m);
  const items = steps(handSection(page, h.hand_number), h.hand_number);
  await expect(items).toHaveCount(h.events.length);
  for (const [i, e] of h.events.entries()) {
    if (e.timeout) await expect(items.nth(i)).toHaveText(/ 超時代打$/);
    else await expect(items.nth(i)).not.toContainText('超時代打');
  }
});

test('shows a split pot', async ({ page }) => {
  const { m, h } = split;
  await open(page, m);
  await expect(handSection(page, h.hand_number).locator('dd')).toContainText([
    `平分底池 ${h.pot}`,
  ]);
});

test('shows the Elo row only for rated matches', async ({ page }) => {
  if (rated === undefined || unrated === undefined) throw new Error('no case');
  await open(page, rated);
  await expect(info(page).locator('dt', { hasText: 'Elo' })).toHaveCount(1);
  await expect(info(page)).toContainText(eloText(rated));
  await open(page, unrated);
  await expect(info(page).locator('dt').first()).toHaveText('結果');
  await expect(info(page).locator('dt', { hasText: 'Elo' })).toHaveCount(0);
});

test('shows a cancelled match with no hands', async ({ page }) => {
  if (empty === undefined) throw new Error('no case');
  await open(page, empty);
  await expectPairs(info(page), infoPairs(empty));
  await expect(page.getByText('這場沒有打任何一手。')).toBeVisible();
  await expect(handSections(page)).toHaveCount(0);
});

test('has no forms or interactive controls', async ({ page }) => {
  await open(page, showdown.m);
  await expect(info(page)).toBeVisible();
  await expect(
    page.locator('form, button, input, select, textarea'),
  ).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('a match link on the home page opens that match', async ({ page }) => {
  const first = data.matches().matches[0];
  if (first === undefined) throw new Error('no matches');
  await page.goto('/');
  await page
    .getByRole('table', { name: '最近對局', exact: true })
    .getByRole('link', { name: `${first.players[0]} vs ${first.players[1]}` })
    .first()
    .click();
  await expect(page).toHaveURL(`/matches/${first.match_id}`);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    `${first.players[0]} vs ${first.players[1]}`,
  );
  await expect(info(page)).toBeVisible();
});

for (const id of ['r_zzzzzzzzzz', 'nope']) {
  test(`an unknown match id ${id} is a not-found page`, async ({ page }) => {
    const response = await page.goto(`/matches/${id}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(
      '找不到這場對局',
    );
    await expect(page.locator('body')).toContainText(id);
    await expect(
      page.getByRole('link', { name: '回首頁', exact: true }),
    ).toHaveAttribute('href', '/');
    await expect(info(page)).toHaveCount(0);
  });
}

// Every hand of every match, in full, both players' hole cards included.
for (const m of matches) {
  test(`renders match ${m.match_id} in full`, async ({ page }) => {
    const response = await open(page, m);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(
      `${m.players[0]} vs ${m.players[1]}`,
    );
    await expectPairs(info(page), infoPairs(m));
    await expect(handSections(page)).toHaveCount(m.hands.length);
    await expect(handSections(page).locator('h3')).toHaveText(
      m.hands.map(h => `第 ${h.hand_number} 手`),
    );
    for (const h of m.hands) {
      await expectHand(page, m, h);
    }
  });
}
