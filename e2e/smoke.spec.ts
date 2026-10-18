import { test, expect } from '@playwright/test';
test('app boots and unauthenticated user reaches login', async ({ page }) => {
  await page.goto('/');
  // unauthenticated → app should land on /login (or show the login form)
  await expect(page).toHaveURL(/\/login/);
});
