import { test, type Page } from '@playwright/test';
import type { DemoManifest } from './demo-data';
import { open, readManifest, settle, shoot, signIn } from './shot';

// Desktop screenshots at 1440x900, light theme. Each screen is its own test so
// one broken screen does not hide the others.

let m: DemoManifest;
test.beforeAll(() => { m = readManifest(); });
test.beforeEach(async ({ page }) => { await signIn(page, m); });

const dental = () => `/project/${m.projects.dental}`;
const residence = () => `/project/${m.projects.residence}`;

async function click(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  await locator.first().click();
  await settle(page);
}

test('dashboard', async ({ page }) => {
  await open(page, '/dashboard');
  await shoot(page, 'dashboard');
});

test('projects list', async ({ page }) => {
  await open(page, '/projects');
  await shoot(page, 'projects');
});

test('projects favorites', async ({ page }) => {
  await open(page, '/projects');
  await click(page, page.getByTestId('quick-favorites'));
  await shoot(page, 'projects-favorites');
});

test('project overview', async ({ page }) => {
  await open(page, dental());
  await shoot(page, 'project-overview');
});

test('takeoff canvas', async ({ page }) => {
  await open(page, `${residence()}/page/${m.residence.pageFloorPlan}`);
  await page.keyboard.press('Escape');
  await settle(page);
  await shoot(page, 'takeoff-canvas');
});

test('proposal editor', async ({ page }) => {
  await open(page, `${residence()}/proposal/${m.residence.proposalDraftId}`);
  // Opening the draft marks it as changed (price rounding); save so the header is quiet.
  const save = page.getByRole('button', { name: 'Save', exact: true });
  if (await save.isEnabled().catch(() => false)) {
    await click(page, save);
    await page.getByText('Proposal saved').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
  }
  await shoot(page, 'proposal');
});

test('billing', async ({ page }) => {
  await open(page, `${dental()}/billing?tab=invoices`);
  await shoot(page, 'billing-invoices');
  await open(page, `${dental()}/billing?tab=change-orders`);
  await click(page, page.getByRole('row').filter({ hasText: 'CO-001' }));
  await shoot(page, 'billing-change-order');
  await open(page, `${dental()}/billing?tab=pay-apps`);
  await click(page, page.getByRole('row').filter({ hasText: '#3' }).getByText('Open'));
  await shoot(page, 'billing-pay-app');
  await open(page, `${dental()}/billing?tab=lien-releases`);
  await shoot(page, 'billing-lien-releases');
  await click(page, page.getByRole('row').filter({ hasText: 'LR-2' }));
  await shoot(page, 'lien-release');
  await page.getByText('Preview', { exact: true }).first().scrollIntoViewIfNeeded();
  await settle(page);
  await shoot(page, 'lien-release-preview');
  await open(page, `${dental()}/billing?tab=payments`);
  await shoot(page, 'billing-payments');
});

test('documents', async ({ page }) => {
  await open(page, `${dental()}/documents`);
  await shoot(page, 'documents');
  await page.getByRole('row').filter({ hasText: 'Subcontract' }).getByRole('checkbox').check();
  await page.getByRole('row').filter({ hasText: 'Scope of Work' }).getByRole('checkbox').check();
  await click(page, page.getByRole('button', { name: /Merge PDFs/ }));
  await shoot(page, 'documents-merge');
});

test('daily report', async ({ page }) => {
  await open(page, `${dental()}/daily-reports`);
  await click(page, page.getByText('16', { exact: true }));
  await shoot(page, 'daily-report');
});

test('rfis, punch, issues, tasks, reports', async ({ page }) => {
  for (const [name, path] of [
    ['rfis', `${dental()}/rfis`], ['punch', `${dental()}/punch`], ['issues', `${dental()}/issues`],
    ['tasks', '/tasks'], ['reports', '/reports'],
  ]) { await open(page, path); await shoot(page, name); }
});

test('mail', async ({ page }) => {
  await open(page, '/mail');
  await click(page, page.getByText('pay app 2 question'));
  await shoot(page, 'mail-thread');
  await click(page, page.getByText('Spring specials from'));
  await shoot(page, 'mail-remote-images');
});

test('settings', async ({ page }) => {
  await open(page, '/settings');
  await click(page, page.getByRole('button', { name: 'General Settings' }));
  await shoot(page, 'settings');
});
