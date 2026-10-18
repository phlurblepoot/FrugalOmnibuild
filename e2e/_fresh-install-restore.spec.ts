import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect } from './fixtures/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'assets', 'snapshot-fixture.zip');

// Filename is underscore-prefixed so Playwright's default alphabetical file
// ordering (single worker, fullyParallel: false — see playwright.config.ts)
// runs this FIRST, before any other spec file seeds the server: the
// setup-mode screen is only reachable on a genuinely fresh .e2e-data. It
// stops at the confirm — the process exit is proven at unit level (see
// RestorePage.test.tsx). The self-skip below is kept as a safety net in case
// this file is ever run after another spec against the same server.
test.describe.configure({ mode: 'serial' });

test('fresh install: /restore lists sources and an uploaded snapshot zip shows its summary', async ({ page, request }) => {
  const state = await (await request.get('/api/setup/state')).json();
  test.skip(!state.fresh, 'another spec already seeded this server');
  await page.goto('/login');
  await page.getByRole('link', { name: /restore from backup/i }).click();
  await page.getByLabel('Username').fill('admin');
  await page.getByLabel('Password').fill('admin');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.getByTestId('restore-source-upload').click();
  await page.getByTestId('restore-upload-input').setInputFiles(FIXTURE);
  await expect(page.getByText(/1 file/)).toBeVisible();
  await expect(page.getByTestId('restore-confirm')).toBeEnabled();
});
