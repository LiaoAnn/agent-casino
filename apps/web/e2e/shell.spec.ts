import { expect, test } from '@playwright/test';
// Relative imports work with Playwright's ESM loader (see match.spec.ts).
import { makeFakeData } from '../../api/src/contract/fake';

const data = makeFakeData();
const match = data.matches().matches[0];
if (match === undefined) throw new Error('no matches');

// Every page gets the shared frame from __root.tsx, and its fonts from this
// site, not a font CDN.
for (const path of [
  '/',
  `/matches/${match.match_id}`,
  `/watch/${data.watch.playing.room_id}?token=fake-watch-token`,
  '/matches/nope',
]) {
  test(`${path} has the shared frame and self-hosted fonts`, async ({
    page,
  }) => {
    const origins = new Set<string>();
    page.on('request', request => origins.add(new URL(request.url()).origin));
    await page.goto(path);
    const header = page.getByRole('banner');
    await expect(
      header.getByRole('link', { name: 'Agent Casino', exact: true }),
    ).toHaveAttribute('href', '/');
    await expect(
      header
        .getByRole('navigation')
        .getByRole('link', { name: '排行榜', exact: true }),
    ).toHaveAttribute('href', '/');
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      await document.fonts.load('700 24px Cinzel');
      await document.fonts.load('400 16px Inter');
      // `check` alone is true for a family with no faces at all.
      const loaded = (family: string) =>
        [...document.fonts].some(
          face =>
            face.family.replaceAll('"', '') === family &&
            face.status === 'loaded',
        );
      return {
        cinzel: loaded('Cinzel'),
        inter: loaded('Inter'),
        body: getComputedStyle(document.body).fontFamily,
        title: getComputedStyle(document.querySelector('header a') as Element)
          .fontFamily,
      };
    });
    expect(fonts.cinzel).toBe(true);
    expect(fonts.inter).toBe(true);
    expect(fonts.title).toMatch(/^"?Cinzel"?,/);
    expect(fonts.body).toMatch(/^"?Inter"?,/);
    expect([...origins]).toEqual([new URL(page.url()).origin]);
  });
}

// A phone (390px) never scrolls sideways: long values such as the seed wrap.
test.describe('on a 390px phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const path of [
    '/',
    `/matches/${match.match_id}`,
    `/watch/${data.watch.playing.room_id}?token=fake-watch-token`,
    `/watch/${data.watch.finished.room_id}?token=fake-watch-token`,
  ]) {
    test(`${path} is no wider than the screen`, async ({ page }) => {
      await page.goto(path);
      await expect(
        page.getByRole('heading', { level: 2 }).first(),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    });
  }
});
