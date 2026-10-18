import { request as apiRequest } from '@playwright/test';
import { test, expect, seedProjectWithPage } from './fixtures/test';

test('authed user reaches the dashboard without redirect to login', async ({ authedPage }) => {
  await authedPage.goto('/dashboard');
  // Should stay on /dashboard (not bounce to /login) and render the dashboard.
  await expect(authedPage).toHaveURL(/\/dashboard/);
  await expect(authedPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('seeded project loads under an authed session', async ({ authedPage, apiToken, request }) => {
  const { projectId, name } = await seedProjectWithPage(request, apiToken.token);

  await authedPage.goto(`/project/${projectId}`);
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}`));
  // The project overview renders the project name once the summary loads.
  // Scope to the page <h1> heading: the same name also appears in the sidebar
  // "recent projects" list (a <p title=name>) once recordRecentProject runs,
  // so a bare getByText(name) intermittently trips strict mode (2 matches).
  await expect(authedPage.getByRole('heading', { name })).toBeVisible();
});

// Photo and file links (spec docs/superpowers/specs/2026-10-07-file-link-security-design.md)
// need a sign-in. An <img> or pdf.js can't send the Authorization header, so
// signing in also gives the browser an HttpOnly media cookie, and Logout
// takes it away.
test('photo links need a sign-in: the media cookie comes with signing in and goes with Logout', async ({ page, request, apiToken }) => {
  const { imageId } = await seedProjectWithPage(request, apiToken.token);
  const raw = `/api/images/${imageId}/raw`;
  expect((await request.get(raw)).status()).toBe(401);

  await page.goto('/login');
  expect((await page.request.get(raw)).status()).toBe(401);
  await page.getByPlaceholder('Enter your username').fill('admin');
  await page.getByPlaceholder('Enter your password').fill('admin');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  const cookie = (await page.context().cookies()).find(c => c.name === 'ft_media');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api' });
  expect((await page.request.get(raw)).status()).toBe(200);

  await page.getByRole('button', { name: /Logout/ }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect.poll(async () => (await page.request.get(raw)).status()).toBe(401);
});

// Someone signed in before the media cookie existed has only the token in
// localStorage (authedPage is exactly that): the app trades it for the cookie
// as it starts, so their photos never show broken.
test('a session from before the media cookie gets one as the app starts, before its photos load', async ({ authedPage, request, apiToken }) => {
  const { projectId } = await seedProjectWithPage(request, apiToken.token);
  expect((await authedPage.context().cookies()).find(c => c.name === 'ft_media')).toBeUndefined();
  const imageStatuses: number[] = [];
  authedPage.on('response', r => { if (r.url().includes('/api/images/')) imageStatuses.push(r.status()); });

  await authedPage.goto(`/project/${projectId}/takeoff`);
  const thumb = authedPage.getByTestId('page-row').first().getByRole('img', { name: 'Sheet 1' });
  await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
  expect(imageStatuses.length).toBeGreaterThan(0);
  expect(imageStatuses.filter(s => s === 401)).toEqual([]);
});

// The app's name and logo are what the login page can show before anyone
// signs in. The logo is kept as a data: URL in the public settings — never a
// file link — so it needs no exception to the sign-in rule.
test('the company name and logo stay readable without signing in', async ({ request, apiToken, baseURL }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const before = await (await request.get('/api/settings')).json();
  const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  try {
    expect((await request.post('/api/settings', { headers: auth, data: { logoUrl: logo } })).ok()).toBe(true);
    const signedOut = await apiRequest.newContext({ baseURL });
    try {
      const settings = await (await signedOut.get('/api/settings')).json();
      expect(settings.logoUrl).toBe(logo);
      expect(settings.appName).toBe(before.appName);
    } finally {
      await signedOut.dispose();
    }
  } finally {
    await request.post('/api/settings', { headers: auth, data: { logoUrl: before.logoUrl ?? '' } });
  }
});
