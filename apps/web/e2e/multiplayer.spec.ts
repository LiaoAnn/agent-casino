import { expect, type Locator, type Page, test } from '@playwright/test';
// Relative imports work with Playwright's ESM loader (see match.spec.ts).
import { makeFakeData } from '../../api/src/contract/fake';
import type { WatchResponse } from '../../api/src/contract/schemas';

// T41: the six-seat public table of the contract's fake data (A25), in each
// of its states, and the lobby.
const data = makeFakeData();
const { lobby, watch, record } = data.table;
const room = record.match_id;
const watchPath = (state: 'waiting' | 'playing' | 'finished') =>
  `/watch/${room}?token=fake-table-${state}`;
const shown = record.display_names;

const seatPlate = (page: Page, name: string) =>
  page.getByRole('region', { name: `座位：${name}`, exact: true });
const centre = async (l: Locator) => {
  const box = await l.boundingBox();
  if (!box) throw new Error('not on the page');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const outText = (seat: WatchResponse['seats'][number]) =>
  `第 ${seat.place} 名・${seat.status === 'left' ? '離開' : '出局'}`;
const noControls = async (page: Page) => {
  await expect(
    page.locator('form, button, input, select, textarea'),
  ).toHaveCount(0);
  await expect(page.getByRole('button')).toHaveCount(0);
};

test('the fake table covers the states this ticket must show', () => {
  expect(watch.waiting.seats).toHaveLength(3);
  expect(watch.waiting.seats_open).toBe(3);
  expect(watch.playing.seats).toHaveLength(6);
  const statuses = new Set(watch.playing.seats.map(s => s.status));
  for (const status of ['out', 'left', 'folded', 'all_in'] as const) {
    expect(statuses).toContain(status);
  }
  expect(watch.playing.view?.pots.length).toBeGreaterThanOrEqual(2);
  expect(record.hands.some(h => h.pots.length >= 2)).toBe(true);
  expect(lobby.rooms.map(r => r.seats.length)).toEqual([6, 3, 2, 1]);
  expect(lobby.rooms.some(r => r.visibility === 'private')).toBe(true);
});

test.describe('the lobby', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/lobby');
  });

  test('is linked from every page header', async ({ page }) => {
    await page.goto('/');
    await expect(
      page
        .getByRole('banner')
        .getByRole('navigation')
        .getByRole('link', { name: '大廳', exact: true }),
    ).toHaveAttribute('href', '/lobby');
  });

  test('lists every waiting room, oldest first, with who sits there', async ({
    page,
  }) => {
    await expect(
      page.getByRole('heading', { level: 2, name: '大廳', exact: true }),
    ).toBeVisible();
    const rooms = page
      .getByRole('list', { name: '等待開打的房間', exact: true })
      .getByRole('region');
    await expect(rooms).toHaveCount(lobby.rooms.length);
    for (const [i, r] of lobby.rooms.entries()) {
      const panel = rooms.nth(i);
      await expect(panel).toHaveAccessibleName(`房間 ${r.room_id}`);
      await expect(panel).toContainText(
        r.visibility === 'public' ? '公開' : '私人',
      );
      const seated = panel
        .getByRole('list', { name: '入座的人', exact: true })
        .getByRole('listitem');
      await expect(seated).toHaveText(
        r.seats.map(s => `${s.display_name}@${s.name}`),
      );
      await expect(panel).toContainText(
        r.seats_open === 0 ? '已經坐滿' : `還有 ${r.seats_open} 個`,
      );
    }
  });

  test('shows a private room without any way in', async ({ page }) => {
    const priv = lobby.rooms.find(r => r.visibility === 'private');
    if (!priv) throw new Error('no private room');
    const panel = page.getByRole('region', {
      name: `房間 ${priv.room_id}`,
      exact: true,
    });
    await expect(panel).toContainText('私人');
    await expect(panel.getByRole('link')).toHaveCount(0);
    await expect(panel).not.toContainText('邀請碼');
    await noControls(page);
  });

  test('says when it last updated, and updates by itself', async ({ page }) => {
    const info = page.getByRole('definition').filter({ hasText: /:\d\d$/ });
    await expect(info).toHaveCount(1);
    const first = await info.textContent();
    await expect(info).not.toHaveText(first ?? '', { timeout: 12_000 });
  });
});

test.describe('a six-seat table waiting to start', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(watchPath('waiting'));
  });

  test('seats the three players, the watched one at the bottom', async ({
    page,
  }) => {
    await expect(
      page.getByRole('heading', { level: 2, name: '等待開打', exact: true }),
    ).toBeVisible();
    const table = page.getByRole('region', { name: '等待開打', exact: true });
    await expect(table.getByRole('region', { name: /^座位：/ })).toHaveCount(3);
    await expect(
      table.getByRole('region', { name: '空位', exact: true }),
    ).toHaveCount(3);
    await expect(table).toContainText('還有 3 個空位');
    const me = await centre(seatPlate(page, shown[0] ?? ''));
    for (const seat of watch.waiting.seats.slice(1)) {
      const other = await centre(seatPlate(page, seat.display_name));
      expect(other.y).toBeLessThanOrEqual(me.y);
    }
    // Before the start, the pace goes by the player count.
    await expect(page.getByText('盲注依人數翻倍')).toBeVisible();
    await noControls(page);
  });
});

test.describe('a six-seat table in play', () => {
  const playing = watch.playing;
  const view = playing.view;
  if (!view) throw new Error('no view');

  test.beforeEach(async ({ page }) => {
    await page.goto(watchPath('playing'));
  });

  test('seats everyone clockwise from the watched seat', async ({ page }) => {
    await expect(
      page.getByRole('heading', { level: 2, name: '6 人桌', exact: true }),
    ).toBeVisible();
    const hand = page.getByRole('region', { name: '目前這一手', exact: true });
    await expect(hand.getByRole('region', { name: /^座位：/ })).toHaveCount(6);
    const at = await Promise.all(
      shown.map(name =>
        centre(
          hand.getByRole('region', { name: `座位：${name}`, exact: true }),
        ),
      ),
    );
    const [bottom, bottomLeft, topLeft, top, topRight, bottomRight] = at as [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ];
    // Seat 0 watched: at the bottom, then up the left, across, down the right.
    expect(bottomLeft.x).toBeLessThan(bottom.x);
    expect(bottomRight.x).toBeGreaterThan(bottom.x);
    expect(topLeft.y).toBeLessThan(bottomLeft.y);
    expect(top.y).toBeLessThan(bottom.y);
    expect(topRight.y).toBeLessThan(bottomRight.y);
    expect(topLeft.x).toBeLessThan(top.x);
    expect(topRight.x).toBeGreaterThan(top.x);
  });

  test('marks folded, all-in, out and left seats', async ({ page }) => {
    for (const seat of playing.seats) {
      const plate = seatPlate(page, seat.display_name);
      switch (seat.status) {
        case 'out':
        case 'left':
          await expect(plate).toContainText(outText(seat));
          await expect(plate).toHaveClass(/bg-navy-900/);
          break;
        case 'folded':
          await expect(plate).toContainText('棄牌');
          break;
        case 'all_in':
          await expect(plate).toContainText('ALL-IN');
          break;
        default:
          await expect(plate).not.toContainText('名・');
      }
    }
  });

  test('shows the main pot and the side pots apart', async ({ page }) => {
    const middle = page
      .getByRole('region', { name: '目前這一手', exact: true })
      .locator('dl[aria-label="牌桌"]');
    const names = view.pots.map((_, i) =>
      i === 0 ? '主池' : view.pots.length === 2 ? '邊池' : `邊池 ${i}`,
    );
    await expect(middle.locator('dt').filter({ hasText: /池/ })).toHaveText(
      names,
    );
    for (const [i, amount] of view.pots.entries()) {
      await expect(middle.locator(`dt:text-is("${names[i]}") + dd`)).toHaveText(
        String(amount),
      );
    }
  });
});

test.describe('a six-seat table that is over', () => {
  const finished = watch.finished;
  if (!('places' in finished)) throw new Error('not over');

  test('lists everyone by place and where the watched seat came', async ({
    page,
  }) => {
    await page.goto(watchPath('finished'));
    const result = page.getByRole('region', { name: '結果', exact: true });
    const places = finished.places ?? [];
    const order = places
      .map((place, seat) => ({ place, seat }))
      .sort((a, b) => a.place - b.place || a.seat - b.seat);
    await expect(result.getByRole('listitem')).toHaveText(
      order.map(
        ({ place, seat }) =>
          `第 ${place} 名${shown[seat]}@${record.players[seat]}`,
      ),
    );
    await expect(result).toContainText(`${shown[0]} 第 ${places[0]} 名`);
    const winner = places.indexOf(1);
    await expect(result).toContainText(`冠軍：${shown[winner]}`);
    // The last hand's table keeps the seats out of the match dimmed.
    const last = page.getByRole('region', { name: '最後一手', exact: true });
    for (const seat of finished.seats.filter(
      s => s.status === 'out' || s.status === 'left',
    )) {
      await expect(
        last.getByRole('region', {
          name: `座位：${seat.display_name}`,
          exact: true,
        }),
      ).toContainText(outText(seat));
    }
  });
});

test.describe('a six-seat match record', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/matches/${room}`);
  });

  test('has every hand at a six-seat table, seat 0 at the bottom', async ({
    page,
  }) => {
    await expect(
      page.getByRole('heading', { level: 2, name: '6 人桌', exact: true }),
    ).toBeVisible();
    for (const hand of record.hands) {
      const panel = page.getByRole('region', {
        name: `第 ${hand.hand_number} 手`,
        exact: true,
      });
      await expect(panel.getByRole('region', { name: /^座位：/ })).toHaveCount(
        6,
      );
    }
    const first = page.getByRole('region', { name: '第 1 手', exact: true });
    const me = await centre(
      first.getByRole('region', { name: `座位：${shown[0]}`, exact: true }),
    );
    const across = await centre(
      first.getByRole('region', { name: `座位：${shown[3]}`, exact: true }),
    );
    expect(across.y).toBeLessThan(me.y);
  });

  test('says who won each pot of a hand with side pots', async ({ page }) => {
    const hand = record.hands.find(h => h.pots.length >= 2);
    if (!hand) throw new Error('no side pot');
    const panel = page.getByRole('region', {
      name: `第 ${hand.hand_number} 手`,
      exact: true,
    });
    for (const [i, pot] of hand.pots.entries()) {
      const name =
        i === 0 ? '主池' : hand.pots.length === 2 ? '邊池' : `邊池 ${i}`;
      const winners = pot.winner_seats.map(s => shown[s]).join('、');
      await expect(panel).toContainText(
        `${name} ${pot.amount}：${winners} ${pot.winner_seats.length > 1 ? '平分' : '贏'}`,
      );
    }
  });

  test('dims a seat once it is out, with its place', async ({ page }) => {
    const last = record.hands.at(-1);
    if (!last) throw new Error('no hands');
    const panel = page.getByRole('region', {
      name: `第 ${last.hand_number} 手`,
      exact: true,
    });
    for (const [seat, stack] of last.stacks.entries()) {
      const plate = panel.getByRole('region', {
        name: `座位：${shown[seat]}`,
        exact: true,
      });
      if (stack > 0) {
        await expect(plate).not.toContainText('名・');
      } else {
        await expect(plate).toContainText(`第 ${record.places?.[seat]} 名・`);
      }
    }
  });

  test('lists the players by place', async ({ page }) => {
    const info = page.locator('dl[aria-label="對局資訊"]');
    await expect(info.getByRole('listitem').first()).toContainText(
      `第 1 名${shown[(record.places ?? []).indexOf(1)]}`,
    );
  });
});
