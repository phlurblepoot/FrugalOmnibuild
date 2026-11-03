import { readFileSync } from 'node:fs';
import { test, expect, loginAsNewUser } from './fixtures/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { RELEASES, type WhatsNewRelease } from '../src/whatsNew/releases';
import { compareVersions, releasesToShow } from '../src/whatsNew/versions';

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

// Built from the releases themselves, so a new tour doesn't break this spec.
const BY_NEWEST = [...RELEASES].sort((a, b) => compareVersions(b.version, a.version));
const NEWEST = BY_NEWEST[0];
/** A version that has seen every release older than `r`, but not `r`. */
const justBefore = (r: WhatsNewRelease) => BY_NEWEST[BY_NEWEST.indexOf(r) + 1]?.version ?? '4.6.9.7';
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('someone who saw every tour but the newest gets it once: page through it, jump around, Done saves it', async ({ page, request, apiToken }) => {
  const me = await asUser(page, request, apiToken.token, justBefore(NEWEST));
  await page.goto('/dashboard');
  const popup = page.getByTestId('whats-new');
  await expect(popup).toBeVisible();
  await expect(page.getByRole('heading', { name: NEWEST.intro.title })).toBeVisible();
  await expect(page.getByTestId('whats-new-contents').getByRole('button')).toHaveCount(NEWEST.pages.length);

  // The first change, with its picture (served with the app).
  const [first, second] = NEWEST.pages;
  await page.getByTestId('whats-new-next').click();
  await expect(page.getByRole('heading', { name: first.title })).toBeVisible();
  if (first.shots.length) {
    const picture = popup.getByRole('img').first();
    await expect.poll(() => picture.evaluate(i => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  if (second) {
    // The arrow keys and the dots page through; Back goes back.
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('heading', { name: second.title })).toBeVisible();
    await page.getByTestId('whats-new-back').click();
    await expect(page.getByRole('heading', { name: first.title })).toBeVisible();
    await page.getByRole('button', { name: 'Page 3' }).click();
    await expect(page.getByRole('heading', { name: second.title })).toBeVisible();
  }
  await expect(page.getByTestId('whats-new-skip')).toHaveCount(0);

  // Done (from the last page): it closes, this version is saved for this
  // person, and it does not come back.
  await page.getByRole('button', { name: `Page ${NEWEST.pages.length + 1}` }).click();
  await expect(page.getByRole('heading', { name: NEWEST.pages.at(-1)!.title })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: NEWEST.intro.title })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
});

test('someone last on 4.6.9.7 gets every tour since, together', async ({ page, request, apiToken }) => {
  const shown = releasesToShow(RELEASES, '4.6.9.7', APP_VERSION);
  expect(shown.length).toBeGreaterThan(1);
  await asUser(page, request, apiToken.token, '4.6.9.7');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'What has changed since you were last here' })).toBeVisible();
  await expect(page.getByText(`Updates ${shown.map(r => r.version).reverse().join(', ')}. Jump to anything below.`)).toBeVisible();
  await expect(page.getByTestId('whats-new-contents').getByRole('button')).toHaveCount(shown.reduce((n, r) => n + r.pages.length, 0));
  // Newest first.
  await page.getByTestId('whats-new-next').click();
  await expect(page.getByRole('heading', { name: shown[0].pages[0].title })).toBeVisible();
});

test('a page\'s button goes there and counts as seen; a phone gets the popup too', async ({ page, request, apiToken }) => {
  // The newest release with a page that has a button; everything since shows.
  const withAction = BY_NEWEST.find(r => r.pages.some(p => p.action))!;
  const lastSeen = justBefore(withAction);
  const shown = releasesToShow(RELEASES, lastSeen, APP_VERSION);
  const pages = shown.flatMap(r => r.pages);
  const target = pages.findIndex(p => p.action);
  const to = pages[target].action!.to;

  await page.setViewportSize({ width: 390, height: 844 });
  const me = await asUser(page, request, apiToken.token, lastSeen);
  await page.goto('/projects');
  await expect(page.getByTestId('whats-new')).toBeVisible();
  // On a phone, "1 of N" stands in for the dots.
  await expect(page.getByTestId('whats-new-count')).toHaveText(`1 of ${pages.length + 1}`);
  for (let i = 0; i <= target; i++) await page.getByTestId('whats-new-next').click();
  await expect(page.getByRole('heading', { name: pages[target].title })).toBeVisible();
  await page.getByTestId('whats-new-action').click();
  await expect(page).toHaveURL(new RegExp(`${escapeRe(to)}$`));
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
