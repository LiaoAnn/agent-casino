import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';

test.use({ javaScriptEnabled: false });

async function stopProcessGroup(pid: number | undefined) {
  if (pid === undefined) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    if (signal === 'SIGTERM') await delay(500);
  }
}

test('T44 SSR loader failure explains the error before hydration', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const rawError = 'The database did not answer';
  const requests: string[] = [];
  const api = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        status: 'error',
        code: 'unavailable',
        message: rawError,
        hint: 'Retry',
        retryable: true,
      }),
    );
  });
  api.listen(0, '0.0.0.0');
  await once(api, 'listening');
  const address = api.address();
  if (address === null || typeof address === 'string')
    throw new Error('missing API stub port');

  // Isolate real API mode from the suite's fake-data server and parent servers.
  const origin = 'http://127.0.0.1:4174';
  const vite = spawn(
    process.execPath,
    [
      resolve('node_modules/vite/bin/vite.js'),
      'dev',
      '--host',
      '0.0.0.0',
      '--port',
      '4174',
      '--strictPort',
    ],
    {
      detached: true,
      env: {
        ...process.env,
        VITE_FAKE_DATA: '0',
        VITE_API_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let logs = '';
  const capture = (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-8000);
  };
  vite.stdout.on('data', capture);
  vite.stderr.on('data', capture);
  try {
    await expect
      .poll(
        async () => {
          if (vite.exitCode !== null)
            throw new Error(`SSR test Vite exited: ${logs}`);
          return fetch(`${origin}/@vite/client`, {
            signal: AbortSignal.timeout(1000),
          })
            .then(response => response.ok)
            .catch(() => false);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const response = await page.goto(origin);
    expect(response, 'SSR document response').not.toBeNull();
    expect(requests.some(url => url.startsWith('/v1/leaderboard'))).toBe(true);

    // JavaScript is disabled: these assertions see only server-rendered HTML.
    const main = page.locator('main');
    await expect
      .soft(main)
      .toContainText(/發生錯誤|無法載入|暫時無法|出了問題/);
    await expect
      .soft(main)
      .not.toContainText(/Something went wrong|Hide Error|Show Error/);
    await expect.soft(main).not.toContainText(rawError);
    await expect.soft(page.locator('button, form, input')).toHaveCount(0);
  } finally {
    // Kill the detached group, including workerd, rather than just Vite's PID.
    await stopProcessGroup(vite.pid);
    api.closeAllConnections();
    await new Promise<void>((done, reject) =>
      api.close(error => (error ? reject(error) : done())),
    );
  }
});
