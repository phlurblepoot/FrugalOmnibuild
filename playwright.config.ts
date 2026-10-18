import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    // NODE_ENV=production: serve the real build/dist bundle (matches the
    // deployed app) instead of Vite's dev middleware. Without this, the dev
    // server's React StrictMode double-invokes every mount effect (a
    // dev-only artifact), which makes any test asserting "fetched once on
    // mount" flaky/wrong for reasons that have nothing to do with real
    // app behavior — see e2e/canvas-vector-load.spec.ts.
    command: 'npm run build && NODE_ENV=production STORAGE_PATH=.e2e-data PORT=3000 npx tsx server.ts',
    url: 'http://localhost:3000',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      // MAIL_FAKE_PROVIDER=1: mounts the test-only /api/mail/_test/seed and
      // /inject routes (server/mail/routes.ts) and routes every mail account
      // through the in-memory fake provider — e2e/fixtures/mail.ts talks to
      // these instead of a live IMAP/OAuth mailbox.
      MAIL_FAKE_PROVIDER: '1',
      // The OAuth connect flow (and its redirect-URI display) needs a public
      // origin to build against; matches the `url` above.
      APP_PUBLIC_URL: 'http://localhost:3000',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
