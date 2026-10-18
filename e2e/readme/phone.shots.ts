import { test } from '@playwright/test';
import type { DemoManifest } from './demo-data';
import { open, readManifest, settle, shoot, signIn } from './shot';

// Phone, 390x844, light theme: dashboard and a daily report.

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

let m: DemoManifest;
test.beforeAll(() => { m = readManifest(); });
test.beforeEach(async ({ page }) => { await signIn(page, m); });

test('dashboard, phone', async ({ page }) => {
  await open(page, '/dashboard');
  await shoot(page, 'dashboard-phone');
});

test('daily report, phone', async ({ page }) => {
  await open(page, `/project/${m.projects.dental}/daily-reports`);
  await page.getByText('16', { exact: true }).first().click();
  await settle(page);
  await shoot(page, 'daily-report-phone');
});
