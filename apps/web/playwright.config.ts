import { defineConfig } from '@playwright/test';

const port = 4173;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: true,
  // Not UTC, so a time rendered in the browser's zone would show up.
  use: { baseURL: `http://localhost:${port}`, timezoneId: 'Asia/Taipei' },
  webServer: {
    command: `vite dev --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
