import { test } from '@playwright/test';
import type { DemoManifest } from './demo-data';
import { open, readManifest, settle, shoot, signIn } from './shot';

// Dark theme at 1440x900: dashboard, takeoff canvas and mail.

let m: DemoManifest;
test.beforeAll(() => { m = readManifest(); });
test.beforeEach(async ({ page }) => { await signIn(page, m, 'dark'); });

test('dashboard, dark', async ({ page }) => {
  await open(page, '/dashboard');
  await shoot(page, 'dashboard-dark');
});

test('takeoff canvas, dark', async ({ page }) => {
  await open(page, `/project/${m.projects.residence}/page/${m.residence.pageFloorPlan}`);
  await shoot(page, 'takeoff-canvas-dark');
});

test('mail, dark', async ({ page }) => {
  await open(page, '/mail');
  await page.getByText('pay app 2 question').first().click();
  await settle(page);
  await shoot(page, 'mail-dark');
});
