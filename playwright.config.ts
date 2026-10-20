import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  workers: 1,
  use: {
    channel: 'chrome',
    // Fake capture permission exposes reachable local ICE candidates in tests.
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    baseURL: 'http://127.0.0.1:5173/planning-poker/',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173/planning-poker/',
    reuseExistingServer: !process.env.CI,
  },
});
