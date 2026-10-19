import { expect, test } from '@playwright/test';
import { makeFakeData } from '../../api/src/contract/fake';
import type { MatchDetail } from '../../api/src/contract/schemas';

const data = makeFakeData();
const matches: MatchDetail[] = [];
let before: string | undefined;
do {
  const batch = data.matches(before === undefined ? {} : { before });
  for (const summary of batch.matches) {
    const match = data.match(summary.match_id);
    if (match !== undefined) matches.push(match);
  }
  before = batch.next ?? undefined;
} while (before !== undefined);

const withReason = (reason: MatchDetail['end_reason']) => {
  const match = matches.find(m => m.end_reason === reason);
  if (match === undefined) throw new Error(`fixture lacks ${reason}`);
  return match;
};

test('T44 root not found is Chinese and links home without framework controls', async ({
  page,
}) => {
  await page.goto('/t44-page-does-not-exist');
  await expect(page.locator('main')).toContainText(/找不到|不存在/);
  await expect(
    page.getByRole('link', { name: '回首頁', exact: true }),
  ).toHaveAttribute('href', '/');
  await expect(page.locator('main')).not.toContainText(
    /Not Found|Something went wrong|Hide Error|Show Error/,
  );
  await expect(page.locator('button, form, input')).toHaveCount(0);
});

for (const reason of ['bust', 'max_hands', 'void', 'cancelled'] as const) {
  test(`T44 match explains ${reason} from its recorded end reason`, async ({
    page,
  }) => {
    const m = withReason(reason);
    await page.goto(`/matches/${m.match_id}`);
    const label = {
      bust: '一方輸光',
      max_hands: `打滿 ${m.settings.max_hands} 手，比籌碼`,
      void: '作廢',
      cancelled: '取消',
    }[reason];
    const info = page.locator('dl[aria-label="對局資訊"]');
    const reasonValue = info
      .locator('dt')
      .filter({ hasText: /^結束原因$/ })
      .locator('xpath=following-sibling::dd[1]');
    await expect(reasonValue).toHaveText(label);
  });
}

test('T44 legacy null end reason does not invent a cause', async ({ page }) => {
  const m = withReason(null);
  await page.goto(`/matches/${m.match_id}`);
  const info = page.locator('dl[aria-label="對局資訊"]');
  await expect(info).toBeVisible();
  await expect(info).not.toContainText(/一方輸光|打滿 \d+ 手，比籌碼|離席/);
});

test('T44 a busted completed hand seat says 出局 instead of ALL-IN', async ({
  page,
}) => {
  const m = withReason('bust');
  const hand = m.hands.find(h => h.stacks.includes(0));
  if (hand === undefined)
    throw new Error('bust fixture lacks a zero stack hand');
  const seat = hand.stacks[0] === 0 ? 0 : 1;
  await page.goto(`/matches/${m.match_id}`);
  const panel = page
    .getByRole('region', { name: `第 ${hand.hand_number} 手`, exact: true })
    .getByRole('region', {
      name: `座位：${m.display_names[seat]}`,
      exact: true,
    });
  await expect(panel.getByText('出局', { exact: true })).toBeVisible();
  await expect(panel.getByText('ALL-IN', { exact: true })).toHaveCount(0);
});

// Inspect the server HTML: hydration can hide split SSR text nodes.
test('T44 SSR emits each @name as one complete text node', async ({ page }) => {
  const response = await page.goto('/');
  if (response === null) throw new Error('missing document response');
  const html = await response.text();
  for (const player of data.leaderboard().entries) {
    expect(html).toContain(`@${player.name}`);
    expect(html).not.toMatch(new RegExp(`@(?:<!--[^>]*-->)+${player.name}`));
  }
});
