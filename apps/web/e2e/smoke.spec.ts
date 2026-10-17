import { expect, test } from '@playwright/test';

test('the home page renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Agent Casino');
});
