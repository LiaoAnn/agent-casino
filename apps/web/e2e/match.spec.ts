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
      return `${m.display_names[0]} 勝`;
    case 'seat1_win':
      return `${m.display_names[1]} 勝`;
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
  `${m.display_names[0]} ${values[0]} · ${m.display_names[1]} ${values[1]}`;

const signed = (n: number) => (n >= 0 ? `+${n}` : `-${-n}`);

const eloText = (m: MatchDetail) =>
  (m.rating_changes ?? [])
    .map(
      (c, seat) =>
        `${m.display_names[seat]} ${c.before} → ${c.after} (${signed(c.after - c.before)})`,
    )
    .join(' · ');

// A19: `blind_every: null` is a match from before T34, fixed blinds 1/2.
const settingsText = ({ settings: s }: MatchDetail) =>
  s.blind_every === null
    ? `起始籌碼 ${s.starting_stack} · 固定盲注 1/2 · ${s.max_hands} 手 · 每步 ${s.turn_seconds} 秒`
    : `起始籌碼 ${s.starting_stack} · 盲注每 ${s.blind_every} 手翻倍 · 最多 ${s.max_hands} 手 · 每步 ${s.turn_seconds} 秒`;

// A20: each display name over its grey @name.
const playersText = (m: MatchDetail) =>
  `${m.display_names[0]}@${m.players[0]}vs${m.display_names[1]}@${m.players[1]}`;

const infoPairs = (m: MatchDetail): [string, string][] => [
  ['玩家', playersText(m)],
  ['結果', resultText(m)],
  ['結束時間', endedText(m.ended_at)],
  ['計分', m.rated ? '計分' : '不計分'],
  ['設定', settingsText(m)],
  ['種子', String(m.seed)],
  ['最終籌碼', pairText(m, m.final_stacks)],
  ...(m.rating_changes === null
    ? []
    : [['Elo', eloText(m)] as [string, string]]),
];

const handResult = (m: MatchDetail, h: MatchHand) => {
  if (h.winner_seat === null) return `平分底池 ${h.pot}`;
  const how = h.ended_by === 'showdown' ? '攤牌' : '對手棄牌';
  return `${m.display_names[h.winner_seat]} 贏得 ${h.pot}（${how}）`;
};

// The middle of the table as the hand ended.
const centerPairs = (m: MatchDetail, h: MatchHand): [string, string][] => [
  ['公共牌', h.board.length > 0 ? h.board.map(card).join(' ') : '沒有發公共牌'],
  ['底池', String(h.pot)],
  ['莊家', m.display_names[h.button_seat]],
  ['盲注', `${h.blinds[0]}/${h.blinds[1]}`],
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
  `${STREETS[e.street]} ${m.display_names[e.seat]} ${actionText(e)}${e.timeout ? ' 超時代打' : ''}`;

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
    new RegExp(`^${m.display_names[1]}`),
    new RegExp(`^${m.display_names[0]}`),
  ]);
  for (const seat of [0, 1] as const) {
    const panel = seatPanel(section, m.display_names[seat]);
    // A seat at the table shows the display name only, no @name (A20).
    await expect(panel.getByRole('heading', { level: 4 })).toHaveText(
      m.display_names[seat],
    );
    await expect(panel).not.toContainText(`@${m.players[seat]}`);
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
const risen = findHand(h => h.blinds[0] > 1);
const legacy = matches.find(
  m => m.settings.blind_every === null && m.hands.length > 0,
);
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

// T34: the blinds of each hand, and a match from before the freezeout.
test("shows each hand's blinds, raised ones too", async ({ page }) => {
  const { m, h } = risen;
  await open(page, m);
  await expectHand(page, m, h);
  await expect(
    handSection(page, h.hand_number).locator('dl[aria-label="牌桌"]'),
  ).toContainText(`盲注${h.blinds[0]}/${h.blinds[1]}`);
});

test('shows a match from before T34 as fixed blinds', async ({ page }) => {
  if (legacy === undefined) throw new Error('fake data lacks an old match');
  await open(page, legacy);
  await expectPairs(info(page), infoPairs(legacy));
  await expect(info(page)).toContainText('固定盲注 1/2');
  const first = legacy.hands[0];
  await expect(
    handSection(page, first.hand_number).locator('dl[aria-label="牌桌"]'),
  ).toContainText('盲注1/2');
});

test('shows a showdown hand step by step', async ({ page }) => {
  const { m, h } = showdown;
  await open(page, m);
  const section = handSection(page, h.hand_number);
  await expectHand(page, m, h);
  await expect(seatPanel(section, m.display_names[0])).toContainText(
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
    await expect(seatPanel(section, m.display_names[seat])).toContainText(
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
  await expect(info(page).locator('dt').first()).toHaveText('玩家');
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
    .getByRole('link', {
      name: `${first.display_names[0]} vs ${first.display_names[1]}`,
    })
    .first()
    .click();
  await expect(page).toHaveURL(`/matches/${first.match_id}`);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    `${first.display_names[0]} vs ${first.display_names[1]}`,
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
      `${m.display_names[0]} vs ${m.display_names[1]}`,
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

// A card's middle is drawn by CSS: every pip and face frame shows its suit,
// and none of them touches a corner index, on a desktop and on a phone.
// Every match is opened, so every rank is seen.
for (const width of [1280, 390]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test('card pips are drawn and clear of the corners', async ({ page }) => {
      test.setTimeout(120_000);
      const ranks = new Set<string>();
      const problems: string[] = [];
      for (const m of matches.filter(m => m.hands.length > 0)) {
        await open(page, m);
        await expect(handSections(page).first()).toBeVisible();
        const report = await page.evaluate(() => {
          const overlap = (a: DOMRect, b: DOMRect) =>
            a.left < b.right &&
            b.left < a.right &&
            a.top < b.bottom &&
            b.top < a.bottom;
          const problems: string[] = [];
          const ranks: string[] = [];
          for (const card of document.querySelectorAll('[role="img"]')) {
            const name = card.getAttribute('aria-label') ?? '';
            const middles = card.querySelectorAll('[data-pip], [data-face]');
            if (middles.length > 0) ranks.push(name.split(' ')[1] ?? '');
            const corners = [...card.querySelectorAll('[data-corner]')].map(c =>
              c.getBoundingClientRect(),
            );
            for (const middle of middles) {
              const content = getComputedStyle(middle, '::after').content;
              if (['none', '""', 'normal'].includes(content))
                problems.push(`${name}: no suit drawn`);
              const box = middle.getBoundingClientRect();
              if (box.width === 0 || box.height === 0)
                problems.push(`${name}: empty middle`);
              if (corners.some(c => overlap(c, box)))
                problems.push(`${name}: on a corner`);
            }
          }
          return { problems, ranks };
        });
        for (const r of report.ranks) ranks.add(r);
        problems.push(...report.problems);
      }
      expect([...ranks].sort()).toEqual([
        '10',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
        'A',
        'J',
        'K',
        'Q',
      ]);
      expect([...new Set(problems)]).toEqual([]);
    });
  });
}
