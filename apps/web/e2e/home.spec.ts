import { expect, type Locator, type Page, test } from '@playwright/test';
// Relative path: Playwright's ESM loader cannot resolve extensionless
// subpaths of the workspace package (it has no "exports" map).
import { makeFakeData } from '../../api/src/contract/fake';

const data = makeFakeData();
const entries = data.leaderboard().entries;
const matches = data.matches().matches;
type Match = (typeof matches)[number];

const resultText = (m: Match): string => {
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
  expect(new Set(matches.map(m => m.result))).toEqual(
    new Set(['seat0_win', 'seat1_win', 'draw', 'void', 'cancelled']),
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
    '勝',
    '敗',
    '平',
  ]);
  const rows = bodyRows(board);
  await expect(rows).toHaveCount(entries.length);
  await expect(board).toContainText('alice');
  for (const [i, e] of entries.entries()) {
    await expect(cells(rows.nth(i))).toHaveText(
      [e.rank, e.name, e.rating, e.games, e.wins, e.losses, e.draws].map(
        String,
      ),
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
    await expect(link).toHaveText(`${m.players[0]} vs ${m.players[1]}`);
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
