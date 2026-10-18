import { test, expect, login, loginAsNewUser, seedProjectWithPage } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// WS3 acceptance proof: app-wide session-scoped Follow (spec §5 + CollaborationContext
// lines ~159-182) — following a session auto-navigates you to wherever it goes, Stop
// halts that, and any manual navigation of your own clears it silently.
//
// Presence now lives ONLY in the sidebar's SidebarPresence popover (Task 6, UI rehaul
// Wave 1) — the old floating bubble and CanvasView's own "Other Users" tool-pane block
// are both gone. SidebarPresence groups sessions by userId (src/utils/presence.ts
// groupSessionsByUser) and only renders a Follow checkbox for a *single-session,
// different-account* group — same rule the old floating popover enforced (see
// SidebarPresence.test.tsx). CanvasView's deleted pane used to offer Follow purely by
// sessionId (ignoring account), which is how the old version of this spec exercised
// Follow using two sockets on the SAME admin login; that workaround no longer has a
// UI surface, so this spec now uses a genuinely separate second account
// (loginAsNewUser, via the admin-only POST /api/users route) for the two "actually
// follow and navigate" scenarios, and keeps the same-account pairing only for the
// no-checkbox proof below.
//
// SESSION CONTINUITY: once A is following B, B must navigate via in-app clicks, NOT
// `page.goto` — a full navigation tears down B's socket (a fresh reload gets a brand
// new server-assigned sessionId), which reads to CollaborationContext as B's session
// vanishing (`session-left`), clearing the follow relationship instead of moving it.
// A's own navigations are safe to do as `page.goto` throughout, since A is the
// follower, not the followed.
test.describe('app-wide session-scoped Follow', () => {
  test('same-account session list shows no follow checkbox', async ({ browser, request }) => {
    const { token, user } = await login(request);
    const seeded = await seedProjectWithPage(request, token);
    const projectPath = `/project/${seeded.projectId}/takeoff`;

    const a = await openAuthedContext(browser, token, user);
    const b = await openAuthedContext(browser, token, user);

    try {
      await a.page.goto(projectPath);
      await b.page.goto(projectPath);

      // Session list shows BOTH A's own session and B's device line MERGED
      // into one self ("you") row (same admin JWT -> same userId), and
      // offers no Follow checkbox there (own-account gate). Assert by count,
      // not mere presence: A's own session alone would already satisfy a
      // single /Chrome/ match, so this only proves B showed up too if there
      // are two lines.
      await a.page.getByTestId('sidebar-presence').click();
      const presence = a.page.getByTestId('presence-popover');
      await expect(presence.getByText(/Online now/i)).toBeVisible();
      await expect(presence.getByText(/\(you\)/)).toHaveCount(1);
      // headless Chromium on Linux -> deviceLabel() (server/realtime/deviceLabel.ts)
      // produces "Linux · Chrome" for both A and B.
      await expect(presence.locator('p', { hasText: /Chrome/ })).toHaveCount(2);
      await expect(presence.getByRole('checkbox')).toHaveCount(0);
    } finally {
      await a.context.close().catch(() => {});
      await b.context.close().catch(() => {});
    }
  });

  test('cross-account follow-navigation, Stop, and manual-nav-clears-follow', async ({ browser, request }) => {
    // Two contexts, several full-page reloads (each re-establishing a socket)
    // plus a 3s bounded wait for the Stop negative assertion — comfortably
    // over the 30s default under load. Same idiom as printout-email-large.spec.ts.
    test.setTimeout(60_000);
    const admin = await login(request);
    // Admin role: the Billing tab this scenario navigates B through is
    // admin-only (ProjectTabBar), and this test isn't about role gating.
    const second = await loginAsNewUser(request, admin.token, { role: 'admin' });
    const seeded = await seedProjectWithPage(request, admin.token);
    const projectPath = `/project/${seeded.projectId}/takeoff`;

    // A (admin) follows B (the separate second account).
    const a = await openAuthedContext(browser, admin.token, admin.user);
    const b = await openAuthedContext(browser, second.token, second.user);

    try {
      await a.page.goto(projectPath);
      await b.page.goto(projectPath);

      await a.page.getByTestId('sidebar-presence').click();
      const presence = a.page.getByTestId('presence-popover');
      await expect(presence.getByText(/Online now/i)).toBeVisible();
      const followCheckbox = presence.getByRole('checkbox', { name: /Follow/i });
      await expect(followCheckbox).toBeVisible();

      // ── Scenario 1: follow B. B is on the Takeoff tab already — same path
      // as A — so no immediate sync-navigation races the checkbox here.
      await followCheckbox.click();
      await expect(a.page.getByText(/Following/)).toBeVisible();
      // The popover's full-screen backdrop (z-[80]) would otherwise intercept
      // clicks on the rest of the page (FollowPill's Stop, nav buttons) —
      // close it now that the checkbox has been actioned.
      await a.page.keyboard.press('Escape');
      await expect(presence).not.toBeVisible();

      // B then moves (in-app) to Billing — A should follow live too.
      await b.page.getByRole('button', { name: 'Billing' }).click();
      await expect(a.page).toHaveURL(/\/billing$/, { timeout: 15_000 });
      await expect(a.page.getByText(/Following/)).toBeVisible();

      // ── Scenario 2: Stop halts further auto-navigation.
      await a.page.getByRole('button', { name: 'Stop' }).click();
      await expect(a.page.getByText(/Following/)).toHaveCount(0);

      await b.page.getByRole('button', { name: 'Takeoff & Estimate' }).click();
      // Bounded wait for the one allowed negative assertion: prove A did NOT
      // follow B back to the Takeoff tab.
      await a.page.waitForTimeout(3_000);
      await expect(a.page).toHaveURL(/\/billing$/);

      // ── Scenario 3: re-follow, then A's OWN manual navigation clears the pill.
      // B is still on the Takeoff tab, a different path from A's Billing tab,
      // so checking Follow again immediately syncs A there too — assert via
      // URL/pill rather than the checkbox's checked state (the click itself
      // unmounts the popover's content as A navigates away).
      await a.page.getByTestId('sidebar-presence').click();
      await presence.getByRole('checkbox', { name: /Follow/i }).click();
      await expect(a.page).toHaveURL(new RegExp(`/project/${seeded.projectId}/takeoff$`), { timeout: 15_000 });
      await expect(a.page.getByText(/Following/)).toBeVisible();
      await a.page.keyboard.press('Escape');
      await expect(presence).not.toBeVisible();

      await a.page.getByRole('button', { name: 'Projects' }).click();
      await expect(a.page.getByText(/Following/)).toHaveCount(0);
    } finally {
      await a.context.close().catch(() => {});
      await b.context.close().catch(() => {});
    }
  });
});
