import { test, expect, seedProjectWithTakeoffMeasurement } from './fixtures/test';
import type { Page } from '@playwright/test';

// Characterization spec for the Takeoffs-tab exports (Print PDF + Excel) and
// the Proposal button (spec 2026-08-28-proposal-rework Task 9).
//
// IMPORTANT real-behavior notes (read handleExportExcel / handlePrint in
// src/pages/ProjectView.tsx):
//
//  • Both export buttons (btn-print, btn-export-excel) are rendered ONLY when
//    `selectedTakeoffIds.size > 0` — the toolbar block is gated behind that
//    condition. So every export test MUST first select at least one takeoff.
//    The per-row select control is a bare <input type="checkbox"> inside the
//    desktop takeoffs-table row (no dedicated testid), so we target it by role.
//
//  • Excel export does NOT trigger a browser download. handleExportExcel
//    streams the workbook to the server as a `takeoff-export` document (named
//    via takeoffPrintName()), then navigates to the filtered Documents view
//    (takeoffPrintsUrl()). The actual file download lives on the Documents
//    page itself. We do NOT assert on a download event, nor on workbook
//    binary content.
//
//  • Print (handlePrint → buildHighlightsPdf) returns null and saves no
//    document unless some CURRENT page carries a measurement whose takeoffId
//    is in the selected set. To exercise the full Print path without slow
//    canvas drawing, we seed a project that already has one takeoff + one
//    length measurement wired to it (seedProjectWithTakeoffMeasurement). On
//    success it saves a `takeoff-print` document and navigates to the
//    filtered Documents view.
//
// Each test seeds a FRESH project to avoid cross-test bleed (shared server/DB).

async function gotoTakeoffsTab(page: Page, projectId: string) {
  await page.goto(`/project/${projectId}/takeoff?tab=takeoffs`);
  await expect(page.getByTestId('takeoffs-table')).toBeVisible();
}

// Scope to the desktop table — both the desktop table and the mobile cards
// render data-testid="takeoff-row" (CSS toggles visibility, not presence).
function takeoffRows(page: Page) {
  return page.getByTestId('takeoffs-table').getByTestId('takeoff-row');
}

// Select the first takeoff by checking its row checkbox (the toolbar with the
// export buttons only appears once a takeoff is selected).
async function selectFirstTakeoff(page: Page) {
  const row = takeoffRows(page).first();
  await expect(row).toBeVisible();
  await row.getByRole('checkbox').check();
}

test('Excel export records an Excel printout in the Proposal section', async ({
  authedPage,
  apiToken,
  request,
}) => {
  const { token } = apiToken;
  const { projectId, takeoffName } = await seedProjectWithTakeoffMeasurement(request, token);

  await gotoTakeoffsTab(authedPage, projectId);
  // The seeded takeoff renders as a row.
  await expect(takeoffRows(authedPage)).toHaveCount(1);
  await expect(takeoffRows(authedPage).first()).toContainText(takeoffName);

  // Export needs a selection: the buttons don't exist until one takeoff is on.
  await expect(authedPage.getByTestId('btn-export-excel')).toHaveCount(0);
  await selectFirstTakeoff(authedPage);

  const excelBtn = authedPage.getByTestId('btn-export-excel');
  await expect(excelBtn).toBeVisible();
  await excelBtn.click();

  // characterization: NO browser download fires. handleExportExcel persists the
  // workbook server-side as a takeoff-export document and navigates to the
  // filtered Documents view, where it now shows up.
  await expect(authedPage).toHaveURL(new RegExp(`/documents\\?projectIds=${projectId}&kinds=takeoff-print(,|%2C)takeoff-export`), { timeout: 30_000 });
  await expect(authedPage.getByText(/^Takeoff Export – /).first()).toBeVisible({ timeout: 15_000 });
});

test('Print records a PDF printout in the Proposal section', async ({
  authedPage,
  apiToken,
  request,
}) => {
  const { token } = apiToken;
  const { projectId, takeoffName } = await seedProjectWithTakeoffMeasurement(request, token);

  await gotoTakeoffsTab(authedPage, projectId);
  await expect(takeoffRows(authedPage)).toHaveCount(1);
  await expect(takeoffRows(authedPage).first()).toContainText(takeoffName);

  await expect(authedPage.getByTestId('btn-print')).toHaveCount(0);
  await selectFirstTakeoff(authedPage);

  const printBtn = authedPage.getByTestId('btn-print');
  await expect(printBtn).toBeVisible();
  await printBtn.click();

  // Print rasterizes/stamps the highlights PDF — it can be slow. The seeded
  // measurement (bound to the selected takeoff) makes the page eligible, so
  // buildHighlightsPdf returns bytes, a takeoff-print document is saved, and
  // handlePrint navigates to the filtered Documents view. Give it a generous
  // timeout.
  await expect(authedPage).toHaveURL(new RegExp(`/documents\\?projectIds=${projectId}&kinds=takeoff-print(,|%2C)takeoff-export`), { timeout: 30_000 });
  await expect(authedPage.getByText(/^Takeoff Print – /).first()).toBeVisible({ timeout: 15_000 });
});

test('Print with Email-ready quality records a printout (pass-through path)', async ({
  authedPage,
  apiToken,
  request,
}) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithTakeoffMeasurement(request, token);

  await gotoTakeoffsTab(authedPage, projectId);
  await selectFirstTakeoff(authedPage);

  await authedPage.getByTestId('print-quality-select').selectOption('email');
  await authedPage.getByTestId('btn-print').click();

  // Small seeded page → shrinkPdfToBudget's result is far under 18MB → the
  // pass-through path (no re-render needed), and a takeoff-print document is
  // still saved.
  await expect(authedPage).toHaveURL(new RegExp(`/documents\\?projectIds=${projectId}&kinds=takeoff-print(,|%2C)takeoff-export`), { timeout: 30_000 });
  await expect(authedPage.getByText(/^Takeoff Print – /).first()).toBeVisible({ timeout: 15_000 });
});

test('Proposal button creates a draft seeded with the selected takeoffs and opens the editor', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId, takeoffName } = await seedProjectWithTakeoffMeasurement(request, token);
  await gotoTakeoffsTab(authedPage, projectId);
  await selectFirstTakeoff(authedPage);
  await authedPage.getByTestId('btn-proposal').click();
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/proposal/[0-9a-f-]{36}$`));
  // The seeded takeoff arrives as a pricing line whose description is an
  // editable input, so its name is a VALUE, not page text.
  await expect(authedPage.getByTestId('pricing-lines').getByLabel('Description').first())
    .toHaveValue(takeoffName);
});

test('Takeoff prints link goes to the filtered Documents view', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithTakeoffMeasurement(request, token);
  await gotoTakeoffsTab(authedPage, projectId);
  await authedPage.getByRole('link', { name: 'Takeoff prints' }).click();
  await expect(authedPage).toHaveURL(new RegExp(`/documents\\?projectIds=${projectId}&kinds=takeoff-print`));
});
