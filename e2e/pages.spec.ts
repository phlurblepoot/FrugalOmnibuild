import { test, expect, seedProjectWithPage, login } from './fixtures/test';

// Characterization spec for the ProjectView "Pages" tab.
//
// The Pages tab is the DEFAULT tab at /project/:projectId/takeoff (ProjectView
// reads `?tab` from the URL and falls back to 'pages'). The seeded project has
// ONE page named 'Sheet 1' with no pageNumber/description. The default view
// mode is GRID (pagesViewMode defaults to 'grid'); each grid card carries
// data-testid="page-row" and the list container carries data-testid="pages-list".
//
// Each test seeds a FRESH project (random ids) to avoid cross-test bleed since
// the suite shares one server/DB.

async function gotoPagesTab(page: import('@playwright/test').Page, projectId: string) {
  await page.goto(`/project/${projectId}/takeoff`);
  await expect(page.getByTestId('pages-list')).toBeVisible();
}

test('renders the seeded page', async ({ authedPage, request }) => {
  const { token } = await login(request);
  const { projectId } = await seedProjectWithPage(request, token);

  await gotoPagesTab(authedPage, projectId);

  const rows = authedPage.getByTestId('page-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Sheet 1');
});

test('search filters pages by name', async ({ authedPage, request }) => {
  const { token } = await login(request);
  const { projectId } = await seedProjectWithPage(request, token);

  await gotoPagesTab(authedPage, projectId);
  await expect(authedPage.getByTestId('page-row')).toHaveCount(1);

  const search = authedPage.getByTestId('page-search');

  // characterization: filteredPages matches name/pageNumber/description/
  // extractedText. A non-matching term yields zero rows AND the pages-list
  // container is replaced by an empty-state block (so we assert row count, not
  // container visibility).
  await search.fill('zzzznomatch');
  await expect(authedPage.getByTestId('page-row')).toHaveCount(0);
  await expect(authedPage.getByText('No pages found')).toBeVisible();

  // 'Sheet' is a substring of the page name 'Sheet 1' → the row comes back.
  await search.fill('Sheet');
  await expect(authedPage.getByTestId('page-row')).toHaveCount(1);

  // Clearing the box restores the unfiltered list.
  await search.fill('');
  await expect(authedPage.getByTestId('page-row')).toHaveCount(1);
});

test('view toggle keeps the page visible', async ({ authedPage, request }) => {
  const { token } = await login(request);
  const { projectId } = await seedProjectWithPage(request, token);

  await gotoPagesTab(authedPage, projectId);
  await expect(authedPage.getByTestId('page-row')).toHaveCount(1);

  // Switch to list view, then back to grid. The page must survive both toggles.
  await authedPage.getByTestId('view-list').click();
  await expect(authedPage.getByTestId('pages-list')).toBeVisible();
  await expect(authedPage.getByTestId('page-row')).toHaveCount(1);
  await expect(authedPage.getByTestId('page-row').first()).toContainText('Sheet 1');

  await authedPage.getByTestId('view-grid').click();
  await expect(authedPage.getByTestId('pages-list')).toBeVisible();
  await expect(authedPage.getByTestId('page-row')).toHaveCount(1);
  await expect(authedPage.getByTestId('page-row').first()).toContainText('Sheet 1');
});

test('rename round-trips through the API', async ({ authedPage, request }) => {
  const { token } = await login(request);
  const { projectId } = await seedProjectWithPage(request, token);

  await gotoPagesTab(authedPage, projectId);
  const row = authedPage.getByTestId('page-row').first();
  await expect(row).toContainText('Sheet 1');

  // characterization: the rename gesture in grid view is — hover the card to
  // reveal the action buttons (they're opacity-0 until group-hover), then click
  // the Edit2 (pencil) button. It is the LAST action button next to the page's
  // <h3> title. That reveals the inline editor whose Description field carries
  // data-testid="page-rename-input".
  await row.hover();
  // The action buttons live in the div immediately following the title <h3>.
  const renameButton = row.locator('h3 + div button').last();
  await renameButton.click();

  const renameInput = authedPage.getByTestId('page-rename-input');
  await expect(renameInput).toBeVisible();

  // characterization: the seeded page has no pageNumber, so the saved name is
  // computed as `num && desc ? "num - desc" : (num || desc || oldName)`. With an
  // empty number and a typed description, the new name becomes just the
  // description text.
  const newName = 'Renamed Sheet';
  await renameInput.fill(newName);
  await renameInput.press('Enter');

  // The optimistic update should show the new name immediately.
  await expect(row).toContainText(newName);

  // Reload to prove the rename persisted through saveProject → the API.
  await gotoPagesTab(authedPage, projectId);
  const reloadedRow = authedPage.getByTestId('page-row').first();
  await expect(reloadedRow).toContainText(newName);
  await expect(authedPage.getByTestId('page-row')).toHaveCount(1);
});
