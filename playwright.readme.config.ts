import { defineConfig, devices } from '@playwright/test';

// The README screenshot run. Separate from playwright.config.ts (the e2e
// suite): its own port (3100), its own throwaway data folder (.demo-data) and
// its own tests (e2e/readme). `npm run test:e2e` never sees any of it.
//
//   npm run demo:seed     build, start on an empty folder, fill the demo company
//   npm run screenshots   the same, then take every screenshot
//   npm run demo:serve    browse the seeded demo by hand (no wipe)
const PORT = 3100;
const DATA_DIR = '.demo-data';

export default defineConfig({
  testDir: './e2e/readme',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    // An empty data folder and a production build (prepare.mjs), then the production server
    // with the fake mail provider (the same way the e2e suite runs).
    command: 'node e2e/readme/prepare.mjs && npx tsx server.ts',
    url: `http://localhost:${PORT}`,
    timeout: 240_000,
    // Never reuse a running server: the run wipes and refills the data folder.
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'production',
      STORAGE_PATH: DATA_DIR,
      DEMO_DATA_DIR: DATA_DIR,
      PORT: String(PORT),
      MAIL_FAKE_PROVIDER: '1',
      APP_PUBLIC_URL: `http://localhost:${PORT}`,
    },
  },
  projects: [
    { name: 'seed', testMatch: /seed\.setup\.ts/ },
    {
      name: 'shots',
      testMatch: /.*\.shots\.ts/,
      dependencies: ['seed'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
