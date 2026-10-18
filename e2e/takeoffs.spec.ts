import { test, expect, seedProjectWithPage } from './fixtures/test';
import type { Page } from '@playwright/test';

// Characterization spec for the ProjectView "Takeoffs" tab.
//
// The Takeoffs tab lives at /project/:projectId/takeoff?tab=takeoffs.
// ProjectView reads `?tab` from the URL (PROJECT_TAB_VALUES = ['pages',
// 'takeoffs', 'email']) and falls back to 'pages'. The viewport is 1440x900 so
// the DESKTOP `hidden md:block` table renders (data-testid="takeoffs-table");
// each row carries data-testid="takeoff-row". The empty state ("No takeoffs
// created yet.") renders BELOW the always-present table when there are 0
// takeoffs.
//
// NewTakeoffModal only requires a non-empty Takeoff Name to enable
// btn-create-takeoff; Measurement Type defaults to 'length'. No type selection
// is needed to create.
//
// Each test seeds a FRESH project (random ids) to avoid cross-test bleed since
// the suite shares one server/DB.

async function gotoTakeoffsTab(page: Page, projectId: string) {
  await page.goto(`/project/${projectId}/takeoff?tab=takeoffs`);
  await expect(page.getByTestId('takeoffs-table')).toBeVisible();
}

// characterization: BOTH the desktop table (`hidden md:block`) and the mobile
// cards (`md:hidden`) render data-testid="takeoff-row" in the DOM — CSS toggles
// visibility, not presence. So a page-wide getByTestId('takeoff-row') resolves
// to 2 elements per takeoff. Scope row queries to the desktop table.
function takeoffRows(page: Page) {
  return page.getByTestId('takeoffs-table').getByTestId('takeoff-row');
}

test('create a takeoff', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithPage(request, token);

  await gotoTakeoffsTab(authedPage, projectId);
  // Fresh project seeds with takeoffs: [] → no rows yet.
  await expect(takeoffRows(authedPage)).toHaveCount(0);

  await authedPage.getByTestId('btn-new-takeoff').click();
  await authedPage.getByTestId('takeoff-name-input').fill('Drywall');
  // characterization: create is enabled by name alone; type defaults to length.
  await authedPage.getByTestId('btn-create-takeoff').click();

  const rows = takeoffRows(authedPage);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Drywall');
});

test('edit a takeoff name', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithPage(request, token);

  await gotoTakeoffsTab(authedPage, projectId);
  await authedPage.getByTestId('btn-new-takeoff').click();
  await authedPage.getByTestId('takeoff-name-input').fill('Drywall');
  await authedPage.getByTestId('btn-create-takeoff').click();

  const row = takeoffRows(authedPage).first();
  await expect(row).toContainText('Drywall');

  // The edit button is opacity-0 until row hover, but it stays in the DOM and
  // Playwright clicks it (auto-scroll + hover) regardless of opacity.
  await row.getByTestId('btn-edit-takeoff').click();

  const nameInput = authedPage.getByTestId('edit-takeoff-name');
  await expect(nameInput).toBeVisible();
  await nameInput.fill('Drywall Edited');
  await authedPage.getByTestId('btn-save-takeoff').click();

  await expect(authedPage.getByTestId('edit-takeoff-name')).toHaveCount(0);
  await expect(takeoffRows(authedPage).first()).toContainText('Drywall Edited');

  // Reload to prove the rename persisted through saveProject → the API.
  await gotoTakeoffsTab(authedPage, projectId);
  await expect(takeoffRows(authedPage)).toHaveCount(1);
  await expect(takeoffRows(authedPage).first()).toContainText('Drywall Edited');
});

test('advanced cost toggle persists', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithPage(request, token);

  await gotoTakeoffsTab(authedPage, projectId);
  await authedPage.getByTestId('btn-new-takeoff').click();
  await authedPage.getByTestId('takeoff-name-input').fill('Drywall');
  await authedPage.getByTestId('btn-create-takeoff').click();

  const row = takeoffRows(authedPage).first();
  await expect(row).toContainText('Drywall');

  // Open edit, enable advanced costing.
  await row.getByTestId('btn-edit-takeoff').click();
  const toggle = authedPage.getByTestId('toggle-advanced-cost');
  await expect(toggle).not.toBeChecked();
  await toggle.check();

  // characterization: enabling the toggle reveals the Custom Cost Items panel
  // with a "No custom items added." hint and an Add (+) button. The takeoff
  // saves as a valid advanced takeoff even with ZERO custom cost lines —
  // customCosts becomes [] (isEditTakeoffAdvanced ? [].map(...) : undefined),
  // so no cost-row interaction is required to have a valid advanced takeoff.
  await expect(authedPage.getByText('No custom items added. Click + to add.')).toBeVisible();

  await authedPage.getByTestId('btn-save-takeoff').click();
  await expect(authedPage.getByTestId('edit-takeoff-name')).toHaveCount(0);

  // No crash: the row still renders.
  await expect(takeoffRows(authedPage)).toHaveCount(1);
  await expect(takeoffRows(authedPage).first()).toContainText('Drywall');

  // Reopen the edit modal and confirm advanced costing is still on.
  await takeoffRows(authedPage).first().getByTestId('btn-edit-takeoff').click();
  await expect(authedPage.getByTestId('toggle-advanced-cost')).toBeChecked();
});

test('delete a takeoff', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithPage(request, token);

  await gotoTakeoffsTab(authedPage, projectId);
  await authedPage.getByTestId('btn-new-takeoff').click();
  await authedPage.getByTestId('takeoff-name-input').fill('Drywall');
  await authedPage.getByTestId('btn-create-takeoff').click();

  const row = takeoffRows(authedPage).first();
  await expect(row).toContainText('Drywall');

  await row.getByTestId('btn-delete-takeoff').click();

  // Confirm modal appears.
  const confirm = authedPage.getByTestId('btn-confirm-delete');
  await expect(confirm).toBeVisible();
  await confirm.click();

  // characterization: the row disappears and the always-present table now shows
  // the empty state below it.
  await expect(takeoffRows(authedPage)).toHaveCount(0);
  await expect(authedPage.getByText('No takeoffs created yet.')).toBeVisible();
});
