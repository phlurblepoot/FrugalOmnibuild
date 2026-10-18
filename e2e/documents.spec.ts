import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, seedCustomerWithPortfolio, seedDocumentsPortfolio, seedProjectWithPage } from './fixtures/test';

// Characterization spec for the global Documents page (unified-documents
// spec, docs/superpowers/specs/2026-08-17-unified-documents-design.md) plus
// the row context menu (docs/superpowers/specs/2026-08-17-documents-context-menu-design.md):
// src/pages/documents/{DocumentsPage,DocumentsTable,DocumentsFilterBar,
// DocumentsBulkBar,UploadDocumentsModal,RowContextMenu}.tsx + server/documents.ts.
//
// The suite shares one server/DB across every spec file (playwright.config.ts
// runs workers:1, fullyParallel:false but never resets .e2e-data), so every
// test seeds its own uniquely-named customer/project via
// seedDocumentsPortfolio()/seedCustomerWithPortfolio() and scopes row
// assertions to those seeded ids/names rather than assuming a clean table.
//
// The desktop table (`<table>`, visible at this suite's 1440x900 viewport)
// and the `md:hidden` mobile card list render the SAME data-testid
// ("documents-row"/"doc-row-select") simultaneously in the DOM — CSS
// display:none doesn't remove nodes. Every row locator below is scoped to
// `page.locator('table')` first so counts aren't doubled by the hidden
// mobile duplicate.
const tableRows = (page: Page) => page.locator('table [data-testid="documents-row"]');
const rowFor = (page: Page, name: string) => tableRows(page).filter({ hasText: name });

// Row actions (archive/delete/change-type) moved from always-visible buttons
// to a right-click context menu (RowContextMenu.tsx). This suite drives it
// with a real right-click rather than long-press — Playwright's touch
// emulation doesn't run at this suite's desktop viewport/project, and the
// menu's own contents/gating are identical between the two entry points.
const rowMenu = (page: Page) => page.getByTestId('doc-context-menu');
const openRowMenu = async (page: Page, row: Locator) => {
  await row.click({ button: 'right' });
  await expect(rowMenu(page)).toBeVisible();
};

test('documents page: project + kind multi-select filters, search narrows, real source links, type badges', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedDocumentsPortfolio(request, apiToken.token);

  await authedPage.goto('/documents');
  await expect(authedPage.getByTestId('documents-upload')).toBeVisible();

  // ── Project multi-select: pick both the bidding (0 docs) and in-progress
  // (4 seeded docs) projects — proves the filter is an OR across ids, not an
  // exact single match. ──────────────────────────────────────────────────
  // level:1 + exact — the EmptyState's "No matching documents" h3 also
  // contains the substring "Documents" and would otherwise strict-mode-clash
  // once the bidding-only selection briefly empties the table.
  const heading = authedPage.getByRole('heading', { name: 'Documents', exact: true, level: 1 });
  await authedPage.getByTestId('doc-filter-project').click();
  const projectPanel = authedPage.getByTestId('doc-filter-project').locator('..');
  await projectPanel.getByText(seeded.biddingProjectName, { exact: true }).click();
  // Wait for the first selection's URL write (setSearchParams) to land before
  // firing the second click — both read `prev` searchParams and reapply a
  // patch, so two clicks fired faster than the first commit can race and the
  // second overwrites the first instead of adding to it.
  await expect(authedPage).toHaveURL(new RegExp(`projectIds=${seeded.biddingProjectId}`));
  await projectPanel.getByText(seeded.inProgressProjectName, { exact: true }).click();
  await heading.click(); // outside click — closes the popover (MultiSelectDropdown's mousedown-outside listener)

  const projectIdsParam = new URL(authedPage.url()).searchParams.get('projectIds')?.split(',') ?? [];
  expect(projectIdsParam).toContain(seeded.biddingProjectId);
  expect(projectIdsParam).toContain(seeded.inProgressProjectId);

  await expect(rowFor(authedPage, seeded.invoiceFileName)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.payAppFileName)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.printoutFileName)).toHaveCount(1);
  await expect(tableRows(authedPage).filter({ hasText: 'site-photo-' })).toHaveCount(1);
  await expect(tableRows(authedPage)).toHaveCount(4);

  // Type badges — server-canonical kind -> UI label (docTypes.ts KIND_META).
  await expect(rowFor(authedPage, seeded.invoiceFileName).getByText('Invoice', { exact: true })).toBeVisible();
  await expect(rowFor(authedPage, seeded.payAppFileName).getByText('Pay App Export', { exact: true })).toBeVisible();
  await expect(rowFor(authedPage, seeded.printoutFileName).getByText('Takeoff Print', { exact: true })).toBeVisible();
  await expect(tableRows(authedPage).filter({ hasText: 'site-photo-' }).getByText('Issue Photo', { exact: true })).toBeVisible();

  // Real source links (server/documents.ts SIMPLE_RESOLVERS href templates) —
  // asserted via the anchor's href rather than clicking through, so the test
  // doesn't have to navigate away and back for each row.
  await expect(rowFor(authedPage, seeded.invoiceFileName).locator('a'))
    .toHaveAttribute('href', `/project/${seeded.inProgressProjectId}/billing?tab=invoices`);
  await expect(rowFor(authedPage, seeded.payAppFileName).locator('a'))
    .toHaveAttribute('href', `/project/${seeded.inProgressProjectId}/billing?tab=pay-apps`);
  await expect(rowFor(authedPage, seeded.printoutFileName).locator('a'))
    .toHaveAttribute('href', `/project/${seeded.inProgressProjectId}/takeoff`);
  await expect(tableRows(authedPage).filter({ hasText: 'site-photo-' }).locator('a'))
    .toHaveAttribute('href', `/project/${seeded.inProgressProjectId}/issues`);

  // Screenshot for the owner of a populated, filtered page (spec item f).
  await authedPage.screenshot({ path: 'test-results/documents-page.png', fullPage: true });

  // ── Kind multi-select on top of the still-active project filter: narrow to
  // just Invoice + Printout. ─────────────────────────────────────────────
  await authedPage.getByTestId('doc-filter-type').click();
  const typePanel = authedPage.getByTestId('doc-filter-type').locator('..');
  await typePanel.getByText('Invoice', { exact: true }).click();
  await expect(authedPage).toHaveURL(/kinds=invoice/); // see the project multi-select comment above — same race
  await typePanel.getByText('Takeoff Print', { exact: true }).click();
  await heading.click(); // close the popover
  await expect(tableRows(authedPage)).toHaveCount(2);
  await expect(rowFor(authedPage, seeded.invoiceFileName)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.printoutFileName)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.payAppFileName)).toHaveCount(0);

  // ── Search narrows further, on top of the same filters. ────────────────
  const searchTerm = seeded.invoiceFileName.replace('.pdf', '');
  await authedPage.getByLabel('Search documents', { exact: true }).fill(searchTerm);
  await expect(tableRows(authedPage)).toHaveCount(1);
  await expect(rowFor(authedPage, seeded.invoiceFileName)).toHaveCount(1);

  // Note: "Load more" (>100 rows) is impractical to seed for this suite and
  // is intentionally not exercised here.
});

test('upload popup: batch upload with per-file type override, change-type, delete a direct upload; a sourced row shows archive not delete', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedDocumentsPortfolio(request, apiToken.token);
  const short = randomUUID().slice(0, 8);

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);

  await authedPage.getByTestId('documents-upload').click();
  const modal = authedPage.getByTestId('documents-upload-modal');
  await expect(modal).toBeVisible();

  const fileAName = `upload-a-${short}.txt`;
  const fileBName = `upload-b-${short}.txt`;
  await modal.locator('input[type="file"]').setInputFiles([
    { name: fileAName, mimeType: 'text/plain', buffer: Buffer.from('doc a contents') },
    { name: fileBName, mimeType: 'text/plain', buffer: Buffer.from('doc b contents') },
  ]);

  // Attribute the batch to the seeded project (locks Customer to match).
  await authedPage.getByLabel('Project', { exact: true }).selectOption({ label: seeded.inProgressProjectName });
  await expect(authedPage.getByLabel('Customer', { exact: true })).toHaveValue(seeded.customerId);

  // Per-file type override: shared type stays "Document" for file A; file B
  // gets flipped to "Photo" individually.
  await authedPage.getByLabel('Set type per file', { exact: true }).check();
  await authedPage.getByLabel(`Type for ${fileBName}`, { exact: true }).selectOption({ label: 'Photo' });

  await authedPage.getByRole('button', { name: 'Upload (2)' }).click();
  await expect(modal).toBeHidden();

  await expect(rowFor(authedPage, fileAName).getByText('Document', { exact: true })).toBeVisible();
  await expect(rowFor(authedPage, fileBName).getByText('Photo', { exact: true })).toBeVisible();

  // Change type on file A: Document -> Spreadsheet, via the row's context
  // menu (right-click replaced the always-visible action buttons — spec
  // docs/superpowers/specs/2026-08-17-documents-context-menu-design.md). The
  // "Change type" item expands a nested list of direct-upload kinds inline.
  await openRowMenu(authedPage, rowFor(authedPage, fileAName));
  let menu = rowMenu(authedPage);
  await menu.getByRole('menuitem', { name: 'Change type' }).click();
  await menu.getByRole('menuitem', { name: 'Spreadsheet' }).click();
  await expect(rowFor(authedPage, fileAName).getByText('Spreadsheet', { exact: true })).toBeVisible();

  // Delete file A (direct upload, unsourced — deletable per documentsPolicy.ts)
  // via the menu: the item is present, and clicking it goes through the same
  // confirm dialog as before.
  await openRowMenu(authedPage, rowFor(authedPage, fileAName));
  menu = rowMenu(authedPage);
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await authedPage.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(rowFor(authedPage, fileAName)).toHaveCount(0);

  // A generated/sourced row (the seeded invoice) has no Delete item in its
  // context menu — only Archive (title hints it's "managed by its source")
  // and no Change type item (not a direct-upload kind).
  const invoiceRow = rowFor(authedPage, seeded.invoiceFileName);
  await openRowMenu(authedPage, invoiceRow);
  menu = rowMenu(authedPage);
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Change type' })).toHaveCount(0);
  const archiveItem = menu.getByRole('menuitem', { name: 'Archive' });
  await expect(archiveItem).toHaveAttribute('title', 'Managed by its source — archive here');

  // The affordance actually works, not just renders: archiving a sourced row
  // completes (PATCH archived=true) and it leaves the default view, same as
  // a direct upload's Archive — only the delete tier differs between them.
  await archiveItem.click();
  await expect(rowFor(authedPage, seeded.invoiceFileName)).toHaveCount(0);
});

test('bulk select: archive + delete a subset via the bulk bar', async ({ authedPage, request, apiToken }) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const short = randomUUID().slice(0, 8);

  // Two direct uploads (deletable + archivable) and rely on the base
  // portfolio having nothing else on this project — three-row bulk exercise:
  // select 2 of them, archive one behavior, delete the other.
  const nameA = `bulk-a-${short}.txt`;
  const nameB = `bulk-b-${short}.txt`;
  for (const name of [nameA, nameB]) {
    const fileId = randomUUID();
    const res = await request.post(
      `/api/files/${fileId}?projectId=${seeded.inProgressProjectId}&kind=document&name=${encodeURIComponent(name)}`,
      { headers: { ...auth, 'Content-Type': 'text/plain' }, data: Buffer.from('bulk fixture bytes') },
    );
    if (!res.ok()) throw new Error(`bulk fixture upload failed: ${res.status()} ${await res.text()}`);
  }

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(tableRows(authedPage)).toHaveCount(2);

  // Select-all via the header checkbox, confirm the bulk bar reflects both.
  // .click() + a separate assertion, not .check() — these are React
  // controlled checkboxes whose `checked` prop only reflects after a
  // re-render, and Playwright's .check() samples the DOM property
  // immediately after its own click with no further retry.
  const bulkBar = authedPage.getByTestId('documents-bulkbar');
  const selectAll = authedPage.locator('table thead').getByRole('checkbox', { name: 'Select all documents' });
  await selectAll.click();
  await expect(selectAll).toBeChecked();
  await expect(bulkBar).toContainText('2 selected');

  // Scoped to the bulk bar — per-row Archive buttons share the same
  // accessible name ("Archive") and would otherwise make this a strict-mode
  // violation.
  await bulkBar.getByRole('button', { name: 'Archive' }).click();
  await expect(tableRows(authedPage)).toHaveCount(0);

  // Both rows moved into the Archived view.
  const archivedToggle = authedPage.getByTestId('doc-filter-archived');
  await archivedToggle.click();
  await expect(archivedToggle).toBeChecked();
  await expect(tableRows(authedPage)).toHaveCount(2);

  // Bulk-delete one of the two out of the archived view (deletable rows are
  // still direct uploads regardless of archived state).
  await rowFor(authedPage, nameA).getByLabel(`Select ${nameA}`, { exact: true }).check();
  await expect(bulkBar).toContainText('1 selected');
  await bulkBar.getByRole('button', { name: 'Delete (1 of 1)' }).click();
  await authedPage.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(rowFor(authedPage, nameA)).toHaveCount(0);
  await expect(rowFor(authedPage, nameB)).toHaveCount(1);
});

test('archive: a row leaves the default view, appears under Archived, restore returns it', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const short = randomUUID().slice(0, 8);
  const name = `archive-test-${short}.pdf`;

  const fileId = randomUUID();
  const res = await request.post(
    `/api/files/${fileId}?projectId=${seeded.inProgressProjectId}&kind=document&name=${encodeURIComponent(name)}`,
    { headers: { ...auth, 'Content-Type': 'application/pdf' }, data: Buffer.from('%PDF-1.4 archive fixture') },
  );
  if (!res.ok()) throw new Error(`archive fixture upload failed: ${res.status()} ${await res.text()}`);

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(rowFor(authedPage, name)).toHaveCount(1);

  await openRowMenu(authedPage, rowFor(authedPage, name));
  await rowMenu(authedPage).getByRole('menuitem', { name: 'Archive' }).click();
  await expect(rowFor(authedPage, name)).toHaveCount(0);

  const archivedToggle = authedPage.getByTestId('doc-filter-archived');
  await archivedToggle.click();
  await expect(archivedToggle).toBeChecked();
  await expect(authedPage).toHaveURL(/archived=1/);
  await expect(rowFor(authedPage, name)).toHaveCount(1);

  await openRowMenu(authedPage, rowFor(authedPage, name));
  const restoreItem = rowMenu(authedPage).getByRole('menuitem', { name: 'Restore' });
  await expect(restoreItem).toBeVisible();
  await restoreItem.click();
  await expect(rowFor(authedPage, name)).toHaveCount(0);

  await archivedToggle.click();
  await expect(archivedToggle).not.toBeChecked();
  await expect(rowFor(authedPage, name)).toHaveCount(1);
});

test('project Documents nav lands on the global page pre-filtered to that project', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);

  await authedPage.goto(`/project/${seeded.inProgressProjectId}`);
  // Project sections render as buttons in the horizontal tab bar (rehaul
  // spec §4, ProjectTabBar.tsx), not links — scope to the "Project sections"
  // nav landmark since the global sidebar has its own "Documents" button too.
  await authedPage.getByRole('navigation', { name: 'Project sections' }).getByRole('button', { name: 'Documents' }).click();

  await expect(authedPage).toHaveURL(new RegExp(`/documents\\?projectIds=${seeded.inProgressProjectId}$`));
  // A single selected project shows its own name as the dropdown summary
  // (MultiSelectDropdown.tsx: selected.length === 1 -> option label).
  await expect(authedPage.getByTestId('doc-filter-project')).toContainText(seeded.inProgressProjectName);
});

test('non-admin: billing kinds are absent, printout stays visible, page loads clean', async ({
  page, request, apiToken,
}) => {
  const seeded = await seedDocumentsPortfolio(request, apiToken.token);

  const username = `e2e-nonadmin-docs-${randomUUID().slice(0, 8)}`;
  const password = 'password123';
  const createRes = await request.post('/api/users', {
    headers: { Authorization: `Bearer ${apiToken.token}` },
    data: { username, password, role: 'user' },
  });
  if (!createRes.ok()) throw new Error(`user create failed: ${createRes.status()} ${await createRes.text()}`);
  const loginRes = await request.post('/api/auth/login', { data: { username, password } });
  if (!loginRes.ok()) throw new Error(`non-admin login failed: ${loginRes.status()} ${await loginRes.text()}`);
  const session = await loginRes.json();

  await page.addInitScript(
    ([token, user]) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
    },
    [session.token, JSON.stringify(session.user)] as const,
  );

  await page.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(page.getByTestId('documents-upload')).toBeVisible(); // page loads clean, no crash/blank state

  // Settle the fetch on a POSITIVE count first — `toHaveCount(0)` for the
  // billing rows below would trivially pass against the still-loading
  // skeleton (zero rows rendered yet either way), so a server-side gating
  // regression that actually returned those rows could slip through.
  // Waiting for the real settled count (printout + issue-photo, the two rows
  // this non-admin session should see) forces the fetch to complete before
  // the absence checks run.
  await expect(tableRows(page)).toHaveCount(2);

  await expect(rowFor(page, seeded.invoiceFileName)).toHaveCount(0);
  await expect(rowFor(page, seeded.payAppFileName)).toHaveCount(0);
  await expect(rowFor(page, seeded.printoutFileName)).toHaveCount(1);
  await expect(tableRows(page).filter({ hasText: 'site-photo-' })).toHaveCount(1); // issue-photo: not billing-priced either

  // Note: the Type filter's OPTION LIST (docTypes.ts KIND_OPTIONS) is a
  // static, role-agnostic constant — a non-admin can still pick "Invoice" as
  // a filter kind, it would just always return zero rows since the server
  // excludes those rows regardless of what's asked for. Only row visibility
  // is spec'd as role-gated (spec §Decisions "Role visibility"), so this test
  // doesn't assert on the dropdown's option list.
});

test('Settings Document Types: add, use in an upload, delete blocked while in use, rename reflects in the filter', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);
  const short = randomUUID().slice(0, 8);
  const label = `E2E Warranty ${short}`;
  const renamedLabel = `E2E Warranty Renamed ${short}`;

  await authedPage.goto('/settings');
  await authedPage.getByRole('button', { name: 'General Settings' }).click();

  await authedPage.getByPlaceholder('e.g. Warranty').fill(label);
  await authedPage.getByRole('button', { name: 'Add' }).click();
  await expect(authedPage.getByText(label, { exact: true })).toBeVisible();

  // Use it in an upload.
  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await authedPage.getByTestId('documents-upload').click();
  const modal = authedPage.getByTestId('documents-upload-modal');
  const fileName = `warranty-doc-${short}.txt`;
  await modal.locator('input[type="file"]').setInputFiles([
    { name: fileName, mimeType: 'text/plain', buffer: Buffer.from('warranty doc') },
  ]);
  // Attribute to the seeded project — the row list below is filtered to it.
  await authedPage.getByLabel('Project', { exact: true }).selectOption({ label: seeded.inProgressProjectName });
  await authedPage.getByLabel('Type', { exact: true }).selectOption({ label });
  await authedPage.getByRole('button', { name: 'Upload (1)' }).click();
  await expect(modal).toBeHidden();
  await expect(rowFor(authedPage, fileName).getByText(label, { exact: true })).toBeVisible();

  // Delete is blocked while in use, with a count in the toast.
  await authedPage.goto('/settings');
  await authedPage.getByRole('button', { name: 'General Settings' }).click();
  const typeRow = authedPage.locator('li', { hasText: label });
  await typeRow.getByTitle('Delete').click();
  await expect(authedPage.getByText(`In use by 1 document — can't delete`)).toBeVisible();
  await expect(authedPage.getByText(label, { exact: true })).toBeVisible(); // still there, not removed

  // Rename reflects in the Documents type filter (and the row's own badge).
  // Not `typeRow.locator('input')` — entering edit mode replaces the label
  // <span> with an <input value=...>, and an input's value isn't part of its
  // textContent, so the `hasText: label` filter that found typeRow stops
  // matching the instant edit mode renders, and re-querying through it times
  // out. Only one row can be mid-edit at a time (single editingId state), so
  // a page-scoped query is unambiguous.
  await typeRow.getByTitle('Rename').click();
  await authedPage.locator('li input').fill(renamedLabel);
  // Unscoped — "Save" (exact) only exists while a row is mid-edit; the page's
  // other save action reads "Save Changes", so this stays unambiguous.
  await authedPage.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(authedPage.getByText(renamedLabel, { exact: true })).toBeVisible();

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(rowFor(authedPage, fileName).getByText(renamedLabel, { exact: true })).toBeVisible();
  await authedPage.getByTestId('doc-filter-type').click();
  const typePanel = authedPage.getByTestId('doc-filter-type').locator('..');
  await expect(typePanel.getByText(renamedLabel, { exact: true })).toBeVisible();
  await expect(typePanel.getByText(label, { exact: true })).toHaveCount(0);
});

test('row actions column: version-history toggle only for multi-version rows', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const short = randomUUID().slice(0, 8);

  // A plain v1 upload — every seeded row in this suite is v1, so this stands
  // in for "all seeded rows": no version-history button in either the table
  // row or its (now-menu-only) context menu.
  const v1Name = `v1-only-${short}.txt`;
  const v1Id = randomUUID();
  const v1Res = await request.post(
    `/api/files/${v1Id}?projectId=${seeded.inProgressProjectId}&kind=document&name=${encodeURIComponent(v1Name)}`,
    { headers: { ...auth, 'Content-Type': 'text/plain' }, data: Buffer.from('v1 fixture bytes') },
  );
  if (!v1Res.ok()) throw new Error(`v1 fixture upload failed: ${v1Res.status()} ${await v1Res.text()}`);

  // A v2 row — cheap via the dedicated versions endpoint (server/files.ts
  // saveNewVersion via POST /api/files/:id/versions): post once to create the
  // live row, then post again to the same id's /versions route to bump it.
  const v2Name = `v2-multi-${short}.txt`;
  const v2Id = randomUUID();
  const v2CreateRes = await request.post(
    `/api/files/${v2Id}?projectId=${seeded.inProgressProjectId}&kind=document&name=${encodeURIComponent(v2Name)}`,
    { headers: { ...auth, 'Content-Type': 'text/plain' }, data: Buffer.from('v2 fixture bytes, v1') },
  );
  if (!v2CreateRes.ok()) throw new Error(`v2 fixture upload failed: ${v2CreateRes.status()} ${await v2CreateRes.text()}`);
  const v2BumpRes = await request.post(
    `/api/files/${v2Id}/versions`,
    { headers: { ...auth, 'Content-Type': 'text/plain' }, data: Buffer.from('v2 fixture bytes, v2') },
  );
  if (!v2BumpRes.ok()) throw new Error(`version bump failed: ${v2BumpRes.status()} ${await v2BumpRes.text()}`);

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(rowFor(authedPage, v1Name)).toHaveCount(1);
  await expect(rowFor(authedPage, v2Name)).toHaveCount(1);

  await expect(rowFor(authedPage, v1Name).getByLabel('Version history', { exact: true })).toHaveCount(0);
  await expect(rowFor(authedPage, v2Name).getByLabel('Version history', { exact: true })).toBeVisible();

  // The button still works: expands the same history list as before. Scoped
  // to `table` per the file-header note — the md:hidden mobile card list
  // renders the same "v1" version chip in the DOM simultaneously (shared
  // historyFor state), which would otherwise make this a strict-mode clash.
  await rowFor(authedPage, v2Name).getByLabel('Version history', { exact: true }).click();
  await expect(authedPage.locator('table').getByText('v1', { exact: true })).toBeVisible();
});

test('version history: restore puts an older version back as a new one; delete removes one', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const name = `history-${randomUUID().slice(0, 8)}.txt`;
  const id = randomUUID();
  const create = await request.post(
    `/api/files/${id}?projectId=${seeded.inProgressProjectId}&kind=document&name=${encodeURIComponent(name)}`,
    { headers: { ...auth, 'Content-Type': 'text/plain' }, data: Buffer.from('first') },
  );
  if (!create.ok()) throw new Error(`upload failed: ${create.status()} ${await create.text()}`);
  const bump = await request.post(`/api/files/${id}/versions`, { headers: { ...auth, 'Content-Type': 'text/plain' }, data: Buffer.from('second') });
  if (!bump.ok()) throw new Error(`version bump failed: ${bump.status()} ${await bump.text()}`);

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await rowFor(authedPage, name).getByLabel('Version history', { exact: true }).click();
  // Scoped to the table: the mobile card list renders its own copy.
  const history = authedPage.locator('table').getByTestId('version-history');
  const v1 = history.getByTestId('version-row').filter({ hasText: /^v1/ });
  await expect(v1).toContainText('by ');

  await v1.getByRole('button', { name: /restore/ }).click();
  const confirmDialog = authedPage.getByRole('dialog');
  await expect(confirmDialog).toContainText('Restore version 1?');
  await confirmDialog.getByRole('button', { name: 'Restore' }).click();
  await expect(authedPage.getByText('Version 1 restored as version 3')).toBeVisible();

  const versions = async () => (await (await request.get(`/api/files/${id}/versions`, { headers: auth })).json()) as { id: string; versionNumber: number; versionOrigin: string | null }[];
  expect((await versions()).map(v => v.versionNumber)).toEqual([3, 2, 1]);
  expect((await versions())[0].versionOrigin).toBe('restore');
  const live = await request.get(`/api/files/${id}/content`, { headers: auth });
  expect(await live.text()).toBe('first');

  // The list now shows v2 and v1 under the restored v3; delete v2.
  const v2 = history.getByTestId('version-row').filter({ hasText: /^v2/ });
  await v2.getByRole('button', { name: 'Delete version 2' }).click();
  await authedPage.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(authedPage.getByText('Version 2 deleted')).toBeVisible();
  await expect(history.getByTestId('version-row').filter({ hasText: /^v2/ })).toHaveCount(0);
  expect((await versions()).map(v => v.versionNumber)).toEqual([3, 1]);
});

// Document previews (docs/superpowers/specs/2026-08-17-document-previews-design.md):
// hover card (DocumentHoverPreview.tsx) + viewer modal (DocumentViewerModal.tsx).
// Row click now opens the modal instead of navigating straight to the editor —
// see the file-header note above this suite's other row interactions, none of
// which left-click a row body (they use the right-click context menu or a
// stopPropagation'd nested button), so nothing here needed updating for that
// change.
test('document previews: hover shows a thumbnail card, click opens the viewer modal (image + PDF page nav), Open in editor navigates', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedDocumentsPortfolio(request, apiToken.token);
  const photoRow = tableRows(authedPage).filter({ hasText: 'site-photo-' });
  const pdfRow = rowFor(authedPage, seeded.printoutFileName);
  const hoverCard = authedPage.getByTestId('doc-hover-preview');
  const modal = authedPage.getByTestId('doc-viewer-modal');

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(photoRow).toHaveCount(1);

  // The photo's row shows it shrunk (/api/images/:id/thumb, a WebP the
  // server makes with sharp), not the type icon.
  const rowThumb = photoRow.getByTestId('file-thumb').locator('img');
  await expect(rowThumb).toHaveAttribute('src', new RegExp(`/api/images/${seeded.issuePhotoFileId}/thumb\\?v=`));
  await expect.poll(() => rowThumb.evaluate((img: HTMLImageElement) => img.complete ? img.naturalWidth : 0)).toBeGreaterThan(0);
  const shrunk = await request.get(`/api/images/${seeded.issuePhotoFileId}/thumb`, { headers: { Authorization: `Bearer ${apiToken.token}` } });
  expect(shrunk.headers()['content-type']).toBe('image/webp');

  // (a) Hover the image row: the card appears (past the 350ms delay) showing
  // an <img> (previewEngine's image kind never fetches — the <img> loads the
  // shrunk /api/images/:id/thumb itself), then hides again once the pointer
  // leaves the row for somewhere the row doesn't cover.
  await photoRow.hover();
  await expect(hoverCard).toBeVisible();
  await expect(hoverCard.locator('img')).toBeVisible();
  await authedPage.mouse.move(0, 0);
  await expect(hoverCard).toBeHidden();

  // (b) Click the image row: the viewer modal opens with the image and the
  // Download / Open-in-editor actions. Screenshot here (spec item e) — the
  // image modal, not the PDF one.
  await photoRow.click();
  await expect(modal).toBeVisible();
  await expect(modal.locator('img')).toBeVisible();
  await expect(authedPage.getByTestId('doc-viewer-download')).toBeVisible();
  await expect(authedPage.getByTestId('doc-viewer-open-editor')).toBeVisible();
  await authedPage.screenshot({ path: 'test-results/documents-preview.png', fullPage: true });

  // Esc closes it (Modal.tsx's window keydown listener).
  await authedPage.keyboard.press('Escape');
  await expect(modal).toBeHidden();

  // (c) Click the PDF row (the seeded printout — a real pdf-lib 2-page PDF,
  // see seedDocumentsPortfolio): the modal renders a <canvas> via pdf.js and
  // shows page nav, since the seeded PDF has more than one page.
  await pdfRow.click();
  await expect(modal).toBeVisible();
  await expect(modal.locator('canvas')).toBeVisible();
  const prevBtn = authedPage.getByTestId('doc-viewer-page-prev');
  const nextBtn = authedPage.getByTestId('doc-viewer-page-next');
  await expect(prevBtn).toBeVisible();
  await expect(nextBtn).toBeVisible();
  await expect(authedPage.getByText(`Page 1 / ${seeded.printoutPageCount}`, { exact: true })).toBeVisible();
  await expect(prevBtn).toBeDisabled();
  await expect(nextBtn).toBeEnabled();

  await nextBtn.click();
  await expect(authedPage.getByText(`Page ${seeded.printoutPageCount} / ${seeded.printoutPageCount}`, { exact: true })).toBeVisible();
  await expect(nextBtn).toBeDisabled();
  await expect(prevBtn).toBeEnabled();

  // (e continued) "Open in editor" closes the modal and navigates to the
  // document editor for this file (openTargetFor's edit branch) — last step,
  // since it leaves the Documents page.
  await authedPage.getByTestId('doc-viewer-open-editor').click();
  await expect(authedPage).toHaveURL(new RegExp(`/tools/edit\\?fileId=${seeded.printoutFileId}$`));
});

test('document previews: right-click opens the context menu and dismisses any lingering hover card', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedDocumentsPortfolio(request, apiToken.token);
  const photoRow = tableRows(authedPage).filter({ hasText: 'site-photo-' });

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  await expect(photoRow).toHaveCount(1);

  await photoRow.hover();
  await expect(authedPage.getByTestId('doc-hover-preview')).toBeVisible();

  await photoRow.click({ button: 'right' });
  await expect(rowMenu(authedPage)).toBeVisible();
  await expect(authedPage.getByTestId('doc-hover-preview')).toBeHidden();
});

// Clutter exclusions (docs/superpowers/specs/2026-08-17-documents-clutter-design.md).
test('clutter exclusions: a seeded page-asset image never appears in the default view; admin Unassigned toggle is exclusive with Archived and shows only unassigned rows', async ({
  authedPage, request, apiToken,
}) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };

  // seedProjectWithPage uploads its raster via plain POST /api/images (no
  // kind param) and wires it as pages[0].imageId — this exercises the
  // NOT-EXISTS fallback (label-independent), not the kind='plan' attribution,
  // proving the exclusion is self-healing for pre-existing/differently-kinded
  // page assets too.
  const paged = await seedProjectWithPage(request, apiToken.token);
  await authedPage.goto(`/documents?projectIds=${paged.projectId}`);
  await expect(authedPage.getByTestId('documents-upload')).toBeVisible();
  await expect(tableRows(authedPage)).toHaveCount(0);

  // An unassigned system-leftover row: no projectId, no name.
  const unassignedFileId = randomUUID();
  const unassignedRes = await request.post(`/api/files/${unassignedFileId}`, {
    headers: { ...auth, 'Content-Type': 'text/plain' },
    data: Buffer.from('unassigned fixture bytes'),
  });
  if (!unassignedRes.ok()) throw new Error(`unassigned fixture upload failed: ${unassignedRes.status()} ${await unassignedRes.text()}`);

  // Admin sees the Unassigned toggle; toggling it shows the unassigned
  // fixture (unscoped by project, since it has none) and hides it again on
  // toggle-off. Exclusive with Archived: checking Unassigned unchecks it.
  const unassignedToggle = authedPage.getByTestId('doc-filter-unassigned');
  const archivedToggle = authedPage.getByTestId('doc-filter-archived');
  await authedPage.goto('/documents');
  await expect(unassignedToggle).toBeVisible();
  // .click() + a separate assertion, not .check()/.uncheck() — these are
  // React controlled checkboxes whose `checked` prop only reflects after a
  // re-render (see the bulk-select test above for the same note).
  await archivedToggle.click();
  await expect(archivedToggle).toBeChecked();
  await unassignedToggle.click();
  await expect(unassignedToggle).toBeChecked();
  await expect(archivedToggle).not.toBeChecked();
  await expect(authedPage).toHaveURL(/unassigned=1/);
  await expect(authedPage).not.toHaveURL(/archived=1/);
  // A nameless row falls back to showing its raw id (DocumentsTable: `row.name
  // ?? row.id`) — the unassigned fixture is visible by that id.
  await expect(rowFor(authedPage, unassignedFileId)).toHaveCount(1);
  await unassignedToggle.click();
  await expect(unassignedToggle).not.toBeChecked();
  await expect(authedPage).not.toHaveURL(/unassigned=1/);
  await expect(rowFor(authedPage, unassignedFileId)).toHaveCount(0);
});

test('clutter exclusions: a non-admin gets no Unassigned toggle, and an unassigned=1 param is silently ignored', async ({
  page, request, apiToken,
}) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const unassignedFileId = randomUUID();
  const unassignedRes = await request.post(`/api/files/${unassignedFileId}`, {
    headers: { ...auth, 'Content-Type': 'text/plain' },
    data: Buffer.from('unassigned fixture bytes'),
  });
  if (!unassignedRes.ok()) throw new Error(`unassigned fixture upload failed: ${unassignedRes.status()} ${await unassignedRes.text()}`);

  const username = `e2e-nonadmin-unassigned-${randomUUID().slice(0, 8)}`;
  const password = 'password123';
  const createRes = await request.post('/api/users', {
    headers: { Authorization: `Bearer ${apiToken.token}` },
    data: { username, password, role: 'user' },
  });
  if (!createRes.ok()) throw new Error(`user create failed: ${createRes.status()} ${await createRes.text()}`);
  const loginRes = await request.post('/api/auth/login', { data: { username, password } });
  if (!loginRes.ok()) throw new Error(`non-admin login failed: ${loginRes.status()} ${await loginRes.text()}`);
  const session = await loginRes.json();

  await page.addInitScript(
    ([token, user]) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
    },
    [session.token, JSON.stringify(session.user)] as const,
  );

  // The param is present in the URL but the toggle never renders, and the
  // row list is the normal (non-unassigned) view — proving the server-side
  // ignore, not just a client-side hidden toggle.
  await page.goto('/documents?unassigned=1');
  await expect(page.getByTestId('documents-upload')).toBeVisible();
  await expect(page.getByTestId('doc-filter-unassigned')).toHaveCount(0);
  await expect(rowFor(page, unassignedFileId)).toHaveCount(0);
});
