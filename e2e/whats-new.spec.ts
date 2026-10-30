import { readFileSync } from 'node:fs';
import { test, expect, loginAsNewUser } from './fixtures/test';
import type { APIRequestContext, Page } from '@playwright/test';

// The "What's new" popup: shown once to someone who last used an older
// version, paged through and marked as seen when closed; never shown to new
// accounts; opened again from Settings › Changelog. Each test uses its own new
// account, so nothing here can leave the popup up for other specs.

/** The version the server runs: what closing the popup saves. */
const APP_VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string;

const asUser = async (page: Page, request: APIRequestContext, adminToken: string, lastSeen?: string) => {
  const me = await loginAsNewUser(request, adminToken);
  if (lastSeen) {
    const res = await request.put('/api/me/whats-new', { headers: { Authorization: `Bearer ${me.token}` }, data: { lastSeenVersion: lastSeen } });
    expect(res.ok()).toBe(true);
  }
  await page.addInitScript(([token, user]) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', user);
  }, [me.token, JSON.stringify(me.user)] as const);
  return me;
};

const seen = async (request: APIRequestContext, token: string) =>
  (await (await request.get('/api/me/whats-new', { headers: { Authorization: `Bearer ${token}` } })).json()).lastSeenVersion;

test('someone last on 4.7.0 gets the 4.8 tour once: page through it, jump around, Done saves it', async ({ page, request, apiToken }) => {
  const me = await asUser(page, request, apiToken.token, '4.7.0');
  await page.goto('/dashboard');
  const popup = page.getByTestId('whats-new');
  await expect(popup).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to FrugalOmnibuild 4.8' })).toBeVisible();
  await expect(page.getByTestId('whats-new-contents').getByRole('button')).toHaveCount(2);

  // The first change, with its picture (served with the app).
  await page.getByTestId('whats-new-next').click();
  await expect(page.getByRole('heading', { name: 'Claude reads your plan sheets' })).toBeVisible();
  const picture = popup.getByRole('img').first();
  await expect.poll(() => picture.evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  // The arrow keys and the dots page through; Back goes back.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'Connect Claude once, in Settings' })).toBeVisible();
  await page.getByTestId('whats-new-back').click();
  await expect(page.getByRole('heading', { name: 'Claude reads your plan sheets' })).toBeVisible();
  await page.getByRole('button', { name: 'Page 3' }).click();
  await expect(page.getByRole('heading', { name: 'Connect Claude once, in Settings' })).toBeVisible();
  await expect(page.getByTestId('whats-new-skip')).toHaveCount(0);

  // Done: it closes, this version is saved for this person, and it does not come back.
  await page.getByTestId('whats-new-next').click();
  await expect(popup).toBeHidden();
  await expect.poll(() => seen(request, me.token)).toBe(APP_VERSION);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Document Editor', exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(popup).toHaveCount(0);

  // Settings › Changelog opens it again.
  await page.goto('/settings?tab=changelog');
  await page.getByTestId('see-whats-new').click();
  await expect(page.getByRole('heading', { name: 'Welcome to FrugalOmnibuild 4.8' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
});

test('someone last on 4.6.9.7 gets 4.8 and 4.7 together', async ({ page, request, apiToken }) => {
  await asUser(page, request, apiToken.token, '4.6.9.7');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'What has changed since you were last here' })).toBeVisible();
  await expect(page.getByText('Updates 4.7, 4.8. Jump to anything below.')).toBeVisible();
  await expect(page.getByTestId('whats-new-contents').getByRole('button')).toHaveCount(14);
  await page.getByTestId('whats-new-next').click();
  await expect(page.getByRole('heading', { name: 'Claude reads your plan sheets' })).toBeVisible();
});

test('a page\'s button goes there and counts as seen; a phone gets the popup too', async ({ page, request, apiToken }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const me = await asUser(page, request, apiToken.token, '4.7.0');
  await page.goto('/projects');
  await expect(page.getByTestId('whats-new')).toBeVisible();
  // On a phone, "1 of 3" stands in for the dots.
  await expect(page.getByTestId('whats-new-count')).toHaveText('1 of 3');
  await page.getByTestId('whats-new-next').click();
  await page.getByTestId('whats-new-next').click();
  await page.getByTestId('whats-new-action').click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByTestId('whats-new')).toHaveCount(0);
  await expect.poll(() => seen(request, me.token)).toBe(APP_VERSION);
});

test('a new account starts on this version: no tour', async ({ page, request, apiToken }) => {
  const me = await asUser(page, request, apiToken.token);
  expect(await seen(request, me.token)).toBe(APP_VERSION);
  await page.goto('/dashboard');
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('whats-new')).toHaveCount(0);
});
