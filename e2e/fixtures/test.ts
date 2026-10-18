import { test as base, expect, request as apiRequest, type Page } from '@playwright/test';
import {
  login,
  loginAsNewUser,
  seedProjectWithPage,
  seedProjectWithVectorPage,
  seedProjectWithVectorPages,
  seedProjectWithTakeoffMeasurement,
  seedProjectWithAreaTakeoffLength,
  seedProjectWithSupersededRevision,
  seedCustomerWithPortfolio,
  seedDocumentsPortfolio,
  type LoginResult,
} from './seed';

interface Fixtures {
  /** A logged-in session `{ token, user }` obtained via the API. */
  apiToken: LoginResult;
  /**
   * A `page` whose localStorage already carries a valid `token` + `user` so it
   * loads authed routes without bouncing to /login. The init script runs before
   * any navigation.
   */
  authedPage: Page;
}

export const test = base.extend<Fixtures>({
  apiToken: async ({ baseURL }, use) => {
    // Use a standalone request context so this works regardless of the
    // per-test `request` fixture lifecycle.
    const ctx = await apiRequest.newContext({ baseURL });
    try {
      const session = await login(ctx);
      await use(session);
    } finally {
      await ctx.dispose();
    }
  },

  authedPage: async ({ page, apiToken }, use) => {
    // Seed localStorage BEFORE any document loads so the SPA sees the token on
    // first paint and never fires the 401 → /login redirect.
    await page.addInitScript(
      ([token, user]) => {
        localStorage.setItem('token', token);
        localStorage.setItem('user', user);
      },
      [apiToken.token, JSON.stringify(apiToken.user)] as const,
    );
    await use(page);
  },
});

export {
  expect,
  login,
  loginAsNewUser,
  seedProjectWithPage,
  seedProjectWithVectorPage,
  seedProjectWithVectorPages,
  seedProjectWithTakeoffMeasurement,
  seedProjectWithAreaTakeoffLength,
  seedProjectWithSupersededRevision,
  seedCustomerWithPortfolio,
  seedDocumentsPortfolio,
};
