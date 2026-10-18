import { test, expect, login, loginAsNewUser, seedProjectWithPage } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// Presence click-to-jump: clicking a user in the sidebar's "Online now"
// popover (SidebarPresence) takes you to wherever that user currently is.
//
//   - Single-session user: the whole row is the jump target
//     (`presence-user-jump`).
//   - Multi-session user: the row is inert and EACH session line is its own
//     jump target (`presence-session-jump`), with its own Follow checkbox
//     (`presence-session-follow`) beside it.
//
// Same two-account setup as collab-follow.spec.ts: A (bootstrap admin) is the
// one jumping, B is a genuinely separate account (loginAsNewUser) so B shows
// up as another user rather than being folded into A's own "(you)" row.
// B navigates via `page.goto` here — unlike Follow, a jump is a one-shot
// read of B's current location, so a torn-down/re-established socket on B's
// side is harmless as long as B's session has re-reported its location by
// the time A clicks (the locator auto-waits on the row's text for that).
test.describe('presence click-to-jump', () => {
  test('clicking a single-session user jumps to their page and closes the popover', async ({ browser, request }) => {
    test.setTimeout(60_000);
    const admin = await login(request);
    const second = await loginAsNewUser(request, admin.token);
    const seeded = await seedProjectWithPage(request, admin.token);
    const projectPath = `/project/${seeded.projectId}/takeoff`;

    const a = await openAuthedContext(browser, admin.token, admin.user);
    const b = await openAuthedContext(browser, second.token, second.user);

    try {
      await a.page.goto('/dashboard');
      await b.page.goto(projectPath);

      await a.page.getByTestId('sidebar-presence').click();
      const presence = a.page.getByTestId('presence-popover');
      await expect(presence.getByText(/Online now/i)).toBeVisible();

      // B is the only other user online, so exactly one jump row exists; wait
      // for it to reflect B's Takeoff location (set-location is emitted after
      // B's route mounts) before clicking so the jump reads the right path.
      const row = presence.getByTestId('presence-user-jump');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(/Takeoff/);
      // Multi-session controls must not appear for a single-session user.
      await expect(presence.getByTestId('presence-session-jump')).toHaveCount(0);
      await expect(presence.getByTestId('presence-session-follow')).toHaveCount(0);

      await row.click();
      await expect(a.page).toHaveURL(new RegExp(`${projectPath}$`), { timeout: 15_000 });
      await expect(presence).not.toBeVisible();
      // A jump is a one-shot navigation, not a Follow.
      await expect(a.page.getByText(/Following/)).toHaveCount(0);
    } finally {
      await a.context.close().catch(() => {});
      await b.context.close().catch(() => {});
    }
  });

  test('a multi-session user gets one jump target and one Follow per session', async ({ browser, request }) => {
    test.setTimeout(60_000);
    const admin = await login(request);
    // Admin role so B may open the admin-only Billing tab (ProjectTabBar).
    const second = await loginAsNewUser(request, admin.token, { role: 'admin' });
    const seeded = await seedProjectWithPage(request, admin.token);
    const takeoffPath = `/project/${seeded.projectId}/takeoff`;
    const billingPath = `/project/${seeded.projectId}/billing`;

    const a = await openAuthedContext(browser, admin.token, admin.user);
    // Two independent sockets for B = two sessions under one user row.
    const b1 = await openAuthedContext(browser, second.token, second.user);
    const b2 = await openAuthedContext(browser, second.token, second.user);

    try {
      await a.page.goto('/dashboard');
      await b1.page.goto(takeoffPath);
      await b2.page.goto(billingPath);

      await a.page.getByTestId('sidebar-presence').click();
      const presence = a.page.getByTestId('presence-popover');
      await expect(presence.getByText(/Online now/i)).toBeVisible();

      // Row itself is inert for a multi-session user; each session is a target.
      await expect(presence.getByTestId('presence-user-jump')).toHaveCount(0);
      const jumps = presence.getByTestId('presence-session-jump');
      await expect(jumps).toHaveCount(2);
      const follows = presence.getByTestId('presence-session-follow');
      await expect(follows).toHaveCount(2);
      await expect(presence.getByRole('checkbox')).toHaveCount(2);

      // Jump specifically to B's Billing session (not the Takeoff one).
      const billingJump = jumps.filter({ hasText: /Billing/ });
      await expect(billingJump).toHaveCount(1);
      await billingJump.click();
      await expect(a.page).toHaveURL(new RegExp(`${billingPath}$`), { timeout: 15_000 });
      await expect(presence).not.toBeVisible();
      await expect(a.page.getByText(/Following/)).toHaveCount(0);

      // Per-session Follow: checking the Takeoff session's box follows THAT
      // session — A is synced from Billing over to Takeoff and the pill shows.
      await a.page.getByTestId('sidebar-presence').click();
      // Pick the checkbox that sits on the same line as the Takeoff jump.
      const takeoffLine = presence.locator('p', {
        has: a.page.getByTestId('presence-session-jump').filter({ hasText: /Takeoff/ }),
      });
      await expect(takeoffLine).toHaveCount(1);
      await takeoffLine.getByRole('checkbox').click();
      await expect(a.page).toHaveURL(new RegExp(`${takeoffPath}$`), { timeout: 15_000 });
      await expect(a.page.getByText(/Following/)).toBeVisible();
    } finally {
      await a.context.close().catch(() => {});
      await b1.context.close().catch(() => {});
      await b2.context.close().catch(() => {});
    }
  });
});
