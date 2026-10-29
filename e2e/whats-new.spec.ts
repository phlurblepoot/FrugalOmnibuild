import { test, expect, loginAsNewUser } from './fixtures/test';
import type { APIRequestContext, Page } from '@playwright/test';

// The "What's new" popup: shown once to someone who last used an older
// version, paged through and marked as seen when closed; never shown to new
// accounts; opened again from Settings › Changelog. Each test uses its own new
// account, so nothing here can leave the popup up for other specs.

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

test('someone last on 4.6.9.7 gets the 4.7 tour once: page through it, jump around, Done saves it', async ({ page, request, apiToken }) => {
  const me = await asUser(page, request, apiToken.token, '4.6.9.7');
  await page.goto('/dashboard');
  const popup = page.getByTestId('whats-new');
  await expect(popup).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Welcome to FrugalOmnibuild 4.7' })).toBeVisible();
  await expect(page.getByTestId('whats-new-contents').getByRole('button')).toHaveCount(12);

  // The first change, with its picture (served with the app).
  await page.getByTestId('whats-new-next').click();
  await expect(page.getByRole('heading', { name: 'Sketch: draw it to size, then pull it into 3D' })).toBeVisible();
  const picture = popup.getByRole('img').first();
  await expect.poll(() => picture.evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  // The arrow keys and the dots page through; Back goes back.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'Put every point where it belongs' })).toBeVisible();
  await page.getByTestId('whats-new-back').click();
  await expect(page.getByRole('heading', { name: 'Sketch: draw it to size, then pull it into 3D' })).toBeVisible();
  await page.getByRole('button', { name: 'Page 13' }).click();
  await expect(page.getByRole('heading', { name: 'Fixes and smaller changes' })).toBeVisible();
  await expect(page.getByTestId('whats-new-skip')).toHaveCount(0);

  // Done: it closes, 4.7.0 is saved for this person, and it does not come back.
  await page.getByTestId('whats-new-next').click();
  await expect(popup).toBeHidden();
  await expect.poll(() => seen(request, me.token)).toBe('4.7.0');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Document Editor', exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(popup).toHaveCount(0);

  // Settings › Changelog opens it again.
  await page.goto('/settings?tab=changelog');
  await page.getByTestId('see-whats-new').click();
  await expect(page.getByRole('heading', { name: 'Welcome to FrugalOmnibuild 4.7' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
});

test('a page\'s button goes there and counts as seen; a phone gets the popup too', async ({ page, request, apiToken }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const me = await asUser(page, request, apiToken.token, '4.6.9.7');
  await page.goto('/projects');
  await expect(page.getByTestId('whats-new')).toBeVisible();
  // On a phone, "1 of 13" stands in for the dots.
  await expect(page.getByTestId('whats-new-count')).toHaveText('1 of 13');
  await page.getByTestId('whats-new-next').click();
  await page.getByTestId('whats-new-action').click();
  await expect(page).toHaveURL(/\/tools\/sketch$/);
  await expect(page.getByTestId('whats-new')).toHaveCount(0);
  await expect.poll(() => seen(request, me.token)).toBe('4.7.0');
});

test('a new account starts on this version: no tour', async ({ page, request, apiToken }) => {
  const me = await asUser(page, request, apiToken.token);
  expect(await seen(request, me.token)).toBe('4.7.0');
  await page.goto('/dashboard');
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('whats-new')).toHaveCount(0);
});
