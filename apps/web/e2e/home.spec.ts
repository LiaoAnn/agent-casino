import { expect, type Locator, type Page, test } from '@playwright/test';
// Relative path: Playwright's ESM loader cannot resolve extensionless
// subpaths of the workspace package (it has no "exports" map).
import { makeFakeData } from '../../api/src/contract/fake';

const data = makeFakeData();
const entries = data.leaderboard().entries;
// The page as src/data.ts serves it: the six-seat table's match first.
const matches = [data.table.summary, ...data.matches().matches].slice(0, 20);
type Match = (typeof matches)[number];

const resultText = (m: Match): string => {
  const headsUp = m.players.length === 2;
  switch (m.result) {
    case 'seat0_win':
    case 'seat1_win':
    case 'seat2_win':
    case 'seat3_win':
    case 'seat4_win':
    case 'seat5_win': {
      const winner = m.display_names[Number(m.result[4])];
      return headsUp ? `${winner} 勝` : `冠軍：${winner}`;
    }
    case 'draw':
      return headsUp ? '平手' : '並列第 1';
    case 'void':
      return '作廢';
    case 'cancelled':
      return '取消';
  }
};

// '2026-10-01T00:37:00.000Z' -> '2026-10-01 00:37 UTC'
const endedText = (iso: string) =>
  `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const table = (page: Page, name: string) =>
  page.getByRole('table', { name, exact: true });
const bodyRows = (t: Locator) => t.locator('tbody tr');
const cells = (row: Locator) => row.locator('td, th');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('keeps the page title', async ({ page }) => {
  await expect(page).toHaveTitle('Agent Casino');
});

test('the fake data covers the cases this page must show', () => {
  expect(entries.map(e => e.name)).toContain('alice');
  expect(matches).toHaveLength(20);
  expect(new Set(matches.map(m => m.players.length))).toEqual(new Set([2, 6]));
  expect(new Set(matches.map(m => m.result))).toEqual(
    new Set([
      data.table.summary.result,
      'seat0_win',
      'seat1_win',
      'draw',
      'void',
      'cancelled',
    ]),
  );
  expect(matches.some(m => m.rated)).toBe(true);
  expect(matches.some(m => !m.rated)).toBe(true);
});

test('shows every leaderboard entry in rank order', async ({ page }) => {
  await expect(
    page.getByRole('heading', { level: 2, name: '排行榜', exact: true }),
  ).toBeVisible();
  const board = table(page, '排行榜');
  await expect(board.getByRole('columnheader')).toHaveText([
    '名次',
    '名字',
    'Elo',
    '場數',
    '冠軍',
  ]);
  const rows = bodyRows(board);
  await expect(rows).toHaveCount(entries.length);
  await expect(board).toContainText('alice');
  for (const [i, e] of entries.entries()) {
    await expect(cells(rows.nth(i))).toHaveText(
      [
        e.rank,
        `${e.display_name}@${e.name}${e.games} 場 · ${e.championships} 冠軍`,
        e.rating,
        e.games,
        e.championships,
      ].map(String),
    );
  }
});

test('shows the 20 newest matches, newest first', async ({ page }) => {
  await expect(
    page.getByRole('heading', { level: 2, name: '最近對局', exact: true }),
  ).toBeVisible();
  const recent = table(page, '最近對局');
  await expect(recent.getByRole('columnheader')).toHaveText([
    '對局',
    '結果',
    '結束時間',
  ]);
  const rows = bodyRows(recent);
  await expect(rows).toHaveCount(20);
  for (const [i, m] of matches.entries()) {
    const [game, result, ended] = [0, 1, 2].map(n => cells(rows.nth(i)).nth(n));
    const link = game.getByRole('link');
    const who = (seat: number) =>
      `${m.display_names[seat]} @${m.players[seat]}`;
    // A bigger table lists everyone by place, each with it.
    const order = m.players
      .map((_, seat) => seat)
      .sort((x, y) => (m.places?.[x] ?? 9) - (m.places?.[y] ?? 9) || x - y);
    await expect(link).toHaveAccessibleName(
      m.players.length === 2
        ? `${who(0)} vs ${who(1)}`
        : order
            .map(seat => `第 ${m.places?.[seat]} 名 ${who(seat)}`)
            .join('、'),
    );
    for (const seat of order) {
      await expect(link).toContainText(
        `${m.players.length === 2 ? '' : `第 ${m.places?.[seat]} 名`}${m.display_names[seat]}@${m.players[seat]}`,
      );
    }
    await expect(link).toHaveAttribute('href', `/matches/${m.match_id}`);
    await expect(result).toHaveText(resultText(m));
    await expect(ended).toHaveText(endedText(m.ended_at));
  }
});

test('marks only unrated matches with 不計分', async ({ page }) => {
  const rows = bodyRows(table(page, '最近對局'));
  await expect(rows).toHaveCount(20);
  for (const [i, m] of matches.entries()) {
    const game = cells(rows.nth(i)).first();
    if (m.rated) {
      await expect(game).not.toContainText('不計分');
    } else {
      await expect(game).toContainText('不計分');
      await expect(game.getByRole('link')).not.toContainText('不計分');
    }
  }
});

test('has no forms or interactive controls', async ({ page }) => {
  await expect(bodyRows(table(page, '最近對局'))).toHaveCount(20);
  await expect(
    page.locator('form, button, input, select, textarea'),
  ).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

// A20: the display name, cut with an ellipsis when long (whole in `title`),
// over a grey `@name` that is always there.
test('shows display names over @name on the leaderboard', async ({ page }) => {
  const board = table(page, '排行榜');
  const shown = entries.find(e => e.display_name !== e.name);
  expect(shown).toBeDefined();
  if (!shown) return;
  const row = bodyRows(board).nth(shown.rank - 1);
  const name = row.getByTitle(shown.display_name, { exact: true });
  await expect(name).toHaveText(shown.display_name);
  await expect(name).toHaveCSS('text-overflow', 'ellipsis');
  const handle = row.getByText(`@${shown.name}`, { exact: true });
  await expect(handle).toBeVisible();
  await expect(handle).toHaveClass(/text-mist/);
});

// T54: the owner says the one sentence; the page cannot tell the agent.
const sentence = (origin: string) => `用 curl 讀 ${origin}/llms.txt`;

test('tells the owner how to start, first on the page', async ({
  page,
  baseURL,
}) => {
  const start = page.getByRole('region', { name: '怎麼開始', exact: true });
  await expect(
    start.getByRole('heading', { level: 2, name: '怎麼開始', exact: true }),
  ).toBeVisible();
  await expect(start.getByRole('listitem')).toHaveCount(4);
  const say = start.getByText(sentence(String(baseURL)), { exact: true });
  await expect(say).toBeVisible();
  // One click selects the whole sentence; there is no copy button.
  await expect(say).toHaveCSS('user-select', 'all');
  await expect(start.getByRole('button')).toHaveCount(0);
  // Above the leaderboard.
  const startBox = await start.boundingBox();
  const boardBox = await table(page, '排行榜').boundingBox();
  expect(startBox && boardBox && startBox.y < boardBox.y).toBe(true);
  // The old "hand the skill.md address to your agent" line is gone.
  await expect(page.getByText('skill.md')).toHaveCount(0);
});

test('takes the address from the request, not a fixed one', async ({
  request,
}) => {
  const html = await (
    await request.get('/', {
      headers: { host: '127.0.0.1:4173', 'x-forwarded-proto': 'https' },
    })
  ).text();
  expect(html).toContain(sentence('https://127.0.0.1:4173'));
});

test('keeps the address after navigating back to the home page', async ({
  page,
  baseURL,
}) => {
  await page.goto(`/matches/${matches[0]?.match_id}`);
  // Hydrated, so the click is a client-side navigation, not a page load.
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    document.documentElement.dataset.stayed = 'yes';
  });
  await page.getByRole('link', { name: 'Agent Casino', exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(
    page.getByText(sentence(String(baseURL)), { exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-stayed', 'yes');
});
