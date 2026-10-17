import { defineConfig } from '@playwright/test';

const port = 4173;

export default defineConfig({
  testDir: 'e2e',
  forbidOnly: true,
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `vite dev --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
  },
});
