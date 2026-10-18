import { test, expect, login, seedProjectWithPage } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// WS1 acceptance proof: two independently-authenticated browser contexts
// (two real socket connections, same JWT — mirrors two tabs/devices for the
// bootstrap admin user) land on the same project and see each other via the
// realtime presence protocol (sessions-snapshot / session-joined /
// session-left), not the old full-array `global-users` broadcast.
//
// Presence now lives in ONE place app-wide: the sidebar's SidebarPresence
// popover (`sidebar-presence` trigger / `presence-popover` content), which
// replaced the old floating bottom-right bubble AND the canvas tool-pane's
// own Collaboration block (Task 6, UI rehaul Wave 1). It's reachable the
// same way on every route, including canvas, so there is no more
// "hides on canvas" special case to prove.

test('two live sessions see each other in the presence overlay, and departure is reflected live', async ({ browser, request }) => {
  const { token, user } = await login(request);
  const seeded = await seedProjectWithPage(request, token);
  const projectPath = `/project/${seeded.projectId}/takeoff`;

  const a = await openAuthedContext(browser, token, user);
  const b = await openAuthedContext(browser, token, user);

  try {
    await a.page.goto(projectPath);
    await b.page.goto(projectPath);

    await b.page.getByTestId('sidebar-presence').click();
    const presence = b.page.getByTestId('presence-popover');
    await expect(presence.getByText(/Online now/i)).toBeVisible();
    // B's own row and A's independently-connected session share one userId
    // (same admin JWT), so SidebarPresence folds both into a single self
    // ("you") group — but it must MERGE them, not drop A's session: both
    // sessions' device/location lines render under that one row. Both
    // contexts are on the same seeded project/section and headless
    // Chromium-on-Linux (deviceLabel() -> "Linux · Chrome"), so their lines
    // are text-identical; assert by COUNT rather than by content, so this
    // can't be satisfied by B's own row alone (a real non-vacuous proof that
    // A's session actually showed up).
    const deviceLines = presence.locator('p', { hasText: /Chrome/ });
    await expect(deviceLines).toHaveCount(2);
    await expect(presence.getByText(/\(you\)/)).toHaveCount(1);

    // Close A's context — its socket disconnects, the server broadcasts
    // `session-left`, and B's context should drop the entry live. This is
    // driven by the disconnect handler, not the (much slower) heartbeat
    // sweep, but give it a generous window rather than a fixed sleep.
    await a.context.close();
    // Back down to just B's own line, and still no Follow checkbox for a
    // same-account row.
    await expect(deviceLines).toHaveCount(1, { timeout: 15_000 });
    await expect(presence.getByRole('checkbox')).toHaveCount(0);
  } finally {
    await a.context.close().catch(() => {});
    await b.context.close();
  }
});
