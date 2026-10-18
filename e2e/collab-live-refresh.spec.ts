import { test, expect, login, seedProjectWithPage } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// WS2 acceptance proof: two independently-authenticated browser contexts (two
// real socket connections, same JWT — mirrors two tabs/devices for the
// bootstrap admin user) prove the change-feed live-refresh + edit-presence
// wiring end-to-end, on the Issues tab (create form at top, table below, row
// click opens IssueEditor modal). Single worker (playwright.config's
// `fullyParallel: false` / workers: 1) — see collab-presence.spec.ts for the
// same two-context pattern used for WS1.

test('live list refresh, edit-presence banner, and foreign-save refresh across two sessions', async ({ browser, request }) => {
  const { token, user } = await login(request);
  const seeded = await seedProjectWithPage(request, token);
  const issuesPath = `/project/${seeded.projectId}/issues`;

  const a = await openAuthedContext(browser, token, user);
  const b = await openAuthedContext(browser, token, user);

  try {
    // --- Scenario 1: live list refresh ---
    // Both contexts land on the Issues tab; A creates an issue via the form
    // and B's table must show it without B navigating or reloading.
    await a.page.goto(issuesPath);
    await b.page.goto(issuesPath);

    const title = `E2E Live Issue ${Date.now()}`;
    await a.page.getByLabel('New issue').fill(title);
    await a.page.getByRole('button', { name: 'Add issue' }).click();

    // A's own create opens the editor for the new issue immediately.
    await expect(a.page.getByRole('heading', { name: /ISS-\d+/ })).toBeVisible();

    await expect(b.page.getByText(title)).toBeVisible({ timeout: 15_000 });

    // --- Scenario 2: edit-presence banner ---
    // B opens the SAME issue's editor (A's is already open from the create).
    // Both are logged in as "admin", so assert on the banner's role text.
    await b.page.getByText(title).click();
    await expect(b.page.getByRole('heading', { name: /ISS-\d+/ })).toBeVisible();

    await expect(a.page.getByText(/is editing this too/)).toBeVisible({ timeout: 15_000 });
    await expect(b.page.getByText(/is editing this too/)).toBeVisible({ timeout: 15_000 });

    // --- Scenario 3: live refresh survives into the editor list ---
    // A saves a title change; B's still-open list must reflect it live.
    const updatedTitle = `${title} (updated)`;
    await a.page.getByLabel('Title').fill(updatedTitle);
    await a.page.getByRole('button', { name: 'Save' }).click();
    await expect(a.page.getByText('Issue saved')).toBeVisible();

    // B's editor is open on the same issue and dirty-free, so useCollabEditing's
    // onFresh silently reloads it; the modal heading stays the ISS-### format,
    // but the title field content refreshes to A's new value.
    await expect(b.page.locator('#iss-title')).toHaveValue(updatedTitle, { timeout: 15_000 });

    // Close B's editor so the underlying Issues list is live again, and
    // confirm the list row itself picked up the new title.
    await b.page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(b.page.getByText(updatedTitle)).toBeVisible({ timeout: 15_000 });
  } finally {
    await a.context.close().catch(() => {});
    await b.context.close().catch(() => {});
  }
});
