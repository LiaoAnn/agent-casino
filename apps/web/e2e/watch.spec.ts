import { expect, type Locator, type Page, test } from '@playwright/test';
// Relative imports work with Playwright's ESM loader (see match.spec.ts).
import { makeFakeData } from '../../api/src/contract/fake';
import type { WatchResponse } from '../../api/src/contract/schemas';

const data = makeFakeData();
const { playing, finished } = data.watch;
type Hand = WatchResponse['hands'][number];
type Event = Hand['events'][number];
const token = 'fake-watch-token';
const path = (roomId: string, value = token) =>
  `/watch/${roomId}?token=${value}`;
const suits: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const cards = (values: readonly string[]) =>
  values
    .map(c => `${c[0] === 'T' ? '10' : c[0]}${suits[c[1] as string]}`)
    .join(' ');
const streets = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '轉牌',
  river: '河牌',
} as const;
const pair = (w: WatchResponse, values: readonly [unknown, unknown]) =>
  `${w.players[0]} ${values[0]} · ${w.players[1]} ${values[1]}`;
const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));

const action = (e: Event) => {
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
const eventText = (w: WatchResponse, e: Event) =>
  `${streets[e.street]} ${w.players[e.seat]} ${action(e)}${e.timeout ? ' 超時代打' : ''}`;
const expectPairs = async (dl: Locator, pairs: [string, string][]) => {
  await expect(dl.locator('dt')).toHaveText(pairs.map(p => p[0]));
  await expect(dl.locator('dd')).toHaveText(pairs.map(p => p[1]));
};
const expectEvents = async (
  section: Locator,
  title: string,
  w: WatchResponse,
  events: readonly Event[],
) => {
  const items = section
    .getByRole('list', { name: `${title}的動作`, exact: true })
    .getByRole('listitem');
  await expect(items).toHaveCount(events.length);
  for (const [i, e] of events.entries()) {
    const item = items.nth(i);
    // Check the entire step, so notes cannot replace or duplicate the action.
    await expect(item).toHaveText(
      new RegExp(
        `^${escapeRegex(eventText(w, e))}\\s*${escapeRegex(e.note ?? '')}$`,
      ),
    );
    if (e.note !== undefined) {
      await expect(item.locator('blockquote')).toHaveCount(1);
      expect(await item.locator('blockquote').textContent()).toBe(e.note);
    } else {
      await expect(item.locator('blockquote')).toHaveCount(0);
    }
  }
};
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const expectTimeline = async (page: Page, w: WatchResponse) => {
  await expect(
    page.getByRole('heading', { level: 3, name: '時間線', exact: true }),
  ).toBeVisible();
  const sections = page.getByRole('region', { name: /^第 \d+ 手$/ });
  await expect(sections).toHaveCount(w.hands.length);
  await expect(sections.locator('h3')).toHaveText(
    w.hands.map(h => `第 ${h.hand_number} 手`),
  );
  for (const h of w.hands) {
    const title = `第 ${h.hand_number} 手`;
    const section = page.getByRole('region', { name: title, exact: true });
    const result =
      h.winner_seat === null
        ? `平分底池 ${h.pot}`
        : `${w.players[h.winner_seat]} 贏得 ${h.pot}（${h.ended_by === 'showdown' ? '攤牌' : '對手棄牌'}）`;
    await expectPairs(section.locator('dl'), [
      ['莊家', w.players[h.button_seat] as string],
      ...(h.board.length > 0
        ? ([['公共牌', cards(h.board)]] as [string, string][])
        : []),
      [
        '底牌',
        pair(w, [
          h.hole_cards[0] === null ? '未亮牌' : cards(h.hole_cards[0]),
          h.hole_cards[1] === null ? '未亮牌' : cards(h.hole_cards[1]),
        ]),
      ],
      ['結果', result],
      ['籌碼', pair(w, h.stacks)],
    ]);
    await expectEvents(section, title, w, h.events);
  }
};

if (playing.deadline === null || playing.view === null)
  throw new Error('playing fixture needs a view and deadline');
const clockTime = new Date(Date.parse(playing.deadline) - 20_000);
const localTime = (time: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(time);
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: clockTime });
  await page.clock.pauseAt(clockTime);
});

const expectWatchInfo = async (
  page: Page,
  w: WatchResponse,
  status: string,
  updatedAt = clockTime,
) => {
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    `${w.players[0]} vs ${w.players[1] ?? '（等待對手）'}`,
  );
  await expectPairs(page.locator('dl[aria-label="觀戰資訊"]'), [
    ['觀看', w.players[w.seat] as string],
    ['狀態', status],
    [
      '設定',
      `${w.settings.hands} 手 · 每步 ${w.settings.turn_seconds} 秒 · 起始籌碼 ${w.settings.starting_stack}`,
    ],
    ['最後更新', localTime(updatedAt)],
  ]);
};
const serverFn = (url: string) =>
  new URL(url).pathname.startsWith('/_serverFn/');
const expectNoPolling = async (page: Page) => {
  // Hydration/initial loading completes before the observation window begins.
  await page.waitForLoadState('networkidle');
  const requests: string[] = [];
  page.on('request', request => {
    if (serverFn(request.url())) requests.push(request.url());
  });
  await page.clock.runFor(10_000);
  await page.waitForLoadState('networkidle');
  expect(requests).toEqual([]);
};

test('playing shows the current hand, countdown, timeline and private notes', async ({
  page,
}) => {
  const w = playing;
  const v = w.view;
  if (v === null) throw new Error('no playing view');
  await page.goto(path(w.room_id));
  const current = page.getByRole('region', { name: '目前這一手', exact: true });
  await expect(current.getByRole('heading', { level: 3 })).toHaveText(
    `目前這一手：第 ${w.hand_number} 手`,
  );
  // Only the hand summary's dl: each seat now has a separate dl below it.
  await expectPairs(current.locator('dl').first(), [
    ['街', streets[v.street]],
    ['莊家', w.players[v.button_seat] as string],
    ['公共牌', v.board.length === 0 ? '尚未發出' : cards(v.board)],
    ['底池', String(v.pot)],
  ]);
  const seats = current.getByRole('region', { name: /^座位：/ });
  await expect(seats).toHaveCount(2);
  for (const seat of [0, 1] as const) {
    const name = w.players[seat] as string;
    const panel = current.getByRole('region', {
      name: `座位：${name}`,
      exact: true,
    });
    await expect(seats.nth(seat)).toHaveAccessibleName(`座位：${name}`);
    await expect(panel.getByRole('heading', { level: 4 })).toHaveText(name);
    const mine = seat === w.seat;
    await expectPairs(panel.locator('dl'), [
      ['籌碼', String(mine ? v.my_stack : v.opponent_stack)],
      [
        '本街下注',
        String(mine ? v.my_bet_this_street : v.opponent_bet_this_street),
      ],
      ['底牌', mine ? cards(v.my_cards) : '未亮牌'],
      ...(seat === w.to_act_seat
        ? ([['行動', '輪到']] as [string, string][])
        : []),
      ...(mine && w.deadline !== null
        ? ([['剩餘時間', '20 秒']] as [string, string][])
        : []),
    ]);
  }
  await expectWatchInfo(page, w, '進行中');
  await expectTimeline(page, w);
  const title = `第 ${w.hand_number} 手（進行中）`;
  const section = page.getByRole('region', { name: title, exact: true });
  await expect(section.getByRole('heading', { level: 3 })).toHaveText(title);
  await expect(section.getByRole('list')).toHaveCount(1);
  await expectEvents(section, title, w, v.history);
  await expect(
    page.getByRole('region', { name: '結果', exact: true }),
  ).toHaveCount(0);
  const remaining = current
    .getByRole('region', { name: `座位：${w.players[w.seat]}`, exact: true })
    .locator('dt')
    .filter({ hasText: /^剩餘時間$/ })
    .locator('xpath=following-sibling::dd[1]');
  await page.clock.runFor(5_000);
  await expect(remaining).toHaveText('15 秒');
  await page.clock.runFor(16_000);
  await expect(remaining).toHaveText('0 秒');
});

test('playing polls at least three times over about ten seconds', async ({
  page,
}) => {
  await page.goto(path(playing.room_id));
  await expectWatchInfo(page, playing, '進行中');
  await page.waitForLoadState('networkidle');
  const requests: string[] = [];
  page.on('request', request => {
    if (serverFn(request.url())) requests.push(request.url());
  });
  // Let each response complete before advancing the next interval: the next
  // poll is allowed to be scheduled only after the preceding response arrives.
  for (let i = 0; i < 3; i++) {
    const response = page.waitForResponse(r => serverFn(r.url()));
    await page.clock.runFor(3_000);
    await (await response).finished();
    await page.waitForLoadState('networkidle');
  }
  expect(requests.length).toBeGreaterThanOrEqual(3);
});

test('playing stops polling after a poll reports the match has finished', async ({
  page,
}) => {
  await page.goto(path(playing.room_id));
  await expectWatchInfo(page, playing, '進行中');
  await page.waitForLoadState('networkidle');
  let polls = 0;
  let releaseResponse = () => {};
  const responseGate = new Promise<void>(resolve => {
    releaseResponse = resolve;
  });
  await page.route('**/_serverFn/**', async route => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    const body = request.postData();
    expect(body).toContain(playing.room_id);
    if (body === null) throw new Error('poll needs a POST body');
    polls++;
    await responseGate;
    await route.continue({
      postData: body.replaceAll(playing.room_id, finished.room_id),
    });
  });
  const response = page.waitForResponse(r => serverFn(r.url()));
  await page.clock.runFor(3_000);
  releaseResponse();
  await (await response).finished();
  expect(polls).toBe(1);
  const updatedAt = new Date(clockTime.getTime() + 3_000);
  await expectWatchInfo(page, finished, '已結束', updatedAt);
  await expect(
    page.getByRole('region', { name: '結果', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: '目前這一手', exact: true }),
  ).toHaveCount(0);
  await expectNoPolling(page);
  await expectWatchInfo(page, finished, '已結束', updatedAt);
  expect(polls).toBe(1);
});

test('playing retries after a temporary connection failure and clears its status on recovery', async ({
  page,
}) => {
  await page.goto(path(playing.room_id));
  await expectWatchInfo(page, playing, '進行中');
  await page.waitForLoadState('networkidle');
  let polls = 0;
  let responseGate = Promise.resolve();
  await page.route('**/_serverFn/**', async route => {
    expect(route.request().method()).toBe('POST');
    polls++;
    if (polls === 1) {
      await route.abort();
    } else {
      await responseGate;
      await route.continue();
    }
  });
  const failure = page.waitForEvent('requestfailed', {
    predicate: request => serverFn(request.url()),
  });
  await page.clock.runFor(3_000);
  await failure;
  const status = page.getByRole('status').filter({
    hasText: '暫時連不上，稍後自動重試。',
  });
  await expect(status).toHaveText('暫時連不上，稍後自動重試。');
  await expectWatchInfo(page, playing, '進行中');
  expect(polls).toBe(1);
  await page.waitForLoadState('networkidle');

  for (let i = 0; i < 2; i++) {
    let releaseResponse = () => {};
    responseGate = new Promise<void>(resolve => {
      releaseResponse = resolve;
    });
    const response = page.waitForResponse(r => serverFn(r.url()));
    await page.clock.runFor(3_000);
    releaseResponse();
    await (await response).finished();
    await expect(status).toHaveCount(0);
    await expectWatchInfo(
      page,
      playing,
      '進行中',
      new Date(clockTime.getTime() + (i + 2) * 3_000),
    );
    await page.waitForLoadState('networkidle');
    expect(polls).toBe(i + 2);
  }
});

test('finished shows results, all hole cards and notes, stops polling and links to its match', async ({
  page,
}) => {
  const w = finished;
  if (!('result' in w)) throw new Error('no finished result');
  await page.goto(path(w.room_id));
  await expectWatchInfo(page, w, '已結束');
  const result = page.getByRole('region', { name: '結果', exact: true });
  await expect(result.getByRole('heading', { level: 3 })).toHaveText('結果');
  const resultLabel = {
    seat0_win: `${w.players[0]} 勝`,
    seat1_win: `${w.players[1]} 勝`,
    draw: '平手',
    void: '作廢',
    cancelled: '取消',
  }[w.result];
  await expectPairs(result.locator('dl'), [
    ['結果', resultLabel],
    ['最終籌碼', pair(w, w.final_stacks)],
    ...(w.ratings === null
      ? []
      : ([
          [
            'Elo',
            w.ratings
              .map(r => `${r.name} ${r.rating} (${signed(r.change)})`)
              .join(' · '),
          ],
        ] as [string, string][])),
  ]);
  await expectTimeline(page, w);
  await expect(
    page.getByRole('region', { name: '目前這一手', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('region', { name: /（進行中）$/ })).toHaveCount(
    0,
  );
  await expectNoPolling(page);
  await expectWatchInfo(page, w, '已結束');
  const link = page.getByRole('link', { name: '完整對局紀錄', exact: true });
  await expect(link).toHaveAttribute('href', `/matches/${w.match_id}`);
  const match = data.match(w.match_id);
  if (match === undefined)
    throw new Error('no public match for finished fixture');
  await link.click();
  await expect(page).toHaveURL(`/matches/${w.match_id}`);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    `${match.players[0]} vs ${match.players[1]}`,
  );
  await expect(page.locator('dl[aria-label="對局資訊"]')).toBeVisible();
});

const invalidMessage =
  '這個觀戰連結無效。請確認網址完整，或向你的 agent 重新要一次 watch_url。';
const errors = [
  {
    name: 'wrong token',
    url: path(playing.room_id, 'wrong-token'),
    message: invalidMessage,
  },
  {
    name: 'missing token',
    url: `/watch/${playing.room_id}`,
    message: invalidMessage,
  },
  {
    name: 'unknown room',
    url: path('r_zzzzzzzzzz'),
    message: '找不到這個房間。',
  },
];
for (const scenario of errors) {
  test(`${scenario.name} explains the error and does not poll`, async ({
    page,
  }) => {
    await page.goto(scenario.url);
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(
      '無法觀看這場對局',
    );
    await expect(
      page.getByText(scenario.message, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: '回首頁', exact: true }),
    ).toHaveAttribute('href', '/');
    await expect(page.locator('dl[aria-label="觀戰資訊"]')).toHaveCount(0);
    await expectNoPolling(page);
  });
}

for (const scenario of [
  { name: 'playing', url: path(playing.room_id) },
  { name: 'finished', url: path(finished.room_id) },
  ...errors,
]) {
  test(`${scenario.name} document protects the referrer and has no controls`, async ({
    page,
  }) => {
    const response = await page.goto(scenario.url);
    expect(response).not.toBeNull();
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    await expect(
      page.locator('form, button, input, select, textarea'),
    ).toHaveCount(0);
  });
}
