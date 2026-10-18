import { test, expect, loginAsNewUser } from './fixtures/test';

// The e2e server runs with no ONLYOFFICE settings, so this pins what an admin
// sees on a fresh install (what is missing, every check skipped) and that the
// tab and its route are admin-only. The connected and failing states are
// covered against a fake Document Server in server/onlyoffice/routes.test.ts.
test('Document Editor tab: admin sees what is missing; regular users get neither the tab nor the route', async ({ authedPage, apiToken, request, browser }) => {
  await authedPage.goto('/settings?tab=document-editor');
  await expect(authedPage.getByText("ONLYOFFICE isn't set up yet")).toBeVisible();
  await expect(authedPage.getByText('ONLYOFFICE_PUBLIC_URL', { exact: true })).toBeVisible();
  await expect(authedPage.getByText('ONLYOFFICE_JWT_SECRET', { exact: true })).toBeVisible();
  // APP_PUBLIC_URL is set for the e2e server, and ONLYOFFICE falls back to it.
  await expect(authedPage.getByText('APP_INTERNAL_URL', { exact: true })).toHaveCount(0);
  const checks = authedPage.getByTestId('oo-check');
  await expect(checks).toHaveCount(3);
  await expect(checks.getByText('Skipped')).toHaveCount(3);

  const user = await loginAsNewUser(request, apiToken.token);
  const denied = await request.get('/api/onlyoffice/status', { headers: { Authorization: `Bearer ${user.token}` } });
  expect(denied.status()).toBe(403);

  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.addInitScript(([token, u]) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', u);
    }, [user.token, JSON.stringify(user.user)] as const);
    await page.goto('/settings?tab=document-editor');
    // Scoped to the Settings tab list: the sidebar's Document Editor tool
    // shares the name and is for everyone.
    const settingsTabs = page.getByRole('button', { name: 'User Preferences' }).locator('..');
    await expect(settingsTabs.getByRole('button', { name: 'User Preferences' })).toBeVisible();
    await expect(settingsTabs.getByRole('button', { name: 'Document Editor' })).toHaveCount(0);
    await expect(page.getByText('Connection checks')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
