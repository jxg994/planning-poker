import { defineConfig } from '@playwright/test';

const FAKE_NTFY_URL = 'http://127.0.0.1:5175';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  use: {
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5173/planning-poker/',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node tests/support/fake-ntfy.ts 5175',
      url: `${FAKE_NTFY_URL}/__control/stats`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev -- --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173/planning-poker/',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
