import { v4 as uuidv4 } from 'uuid';
import type { Page } from '@playwright/test';
import { test, expect, seedCustomerWithPortfolio } from './fixtures/test';

// Layout regression for the Documents table (src/pages/documents/DocumentsTable.tsx).
// A file whose name is one long unbreakable token used to force the Name
// column as wide as the name under automatic table layout: the <table>
// overflowed its `overflow-x-auto` wrapper and everything past the second
// column was pushed off-screen (reported in production). The table is now
// `table-fixed` with explicit widths on every column but Name, so the name
// truncates instead. This asserts the wrapper never scrolls horizontally and
// the last header (Actions) stays inside the viewport — at the suite's
// desktop viewport AND at a tablet width, where the fixed widths shrink and
// the Date column folds into the Name subline.
//
// Same shared-DB caveat as e2e/documents.spec.ts: rows are scoped to the
// seeded project, and the desktop `<table>` is targeted explicitly since the
// md:hidden mobile card list renders the same data-testids in the DOM.

const LONG_NAME = `${'longfilename'.repeat(16)}.pdf`.slice(0, 200); // 200 chars, no spaces

const tableWrapper = (page: Page) => page.locator('table').locator('..');

const assertNoHorizontalOverflow = async (page: Page) => {
  const wrapper = tableWrapper(page);
  const metrics = await wrapper.evaluate(el => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    tableWidth: el.querySelector('table')!.getBoundingClientRect().width,
  }));
  expect(metrics.scrollWidth, `wrapper scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}`)
    .toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.tableWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);

  const actionsHeader = page.locator('table thead th', { hasText: 'Actions' });
  await expect(actionsHeader).toBeVisible();
  const box = (await actionsHeader.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
};

test('documents table: a 200-char unbreakable file name truncates instead of overflowing the table', async ({
  authedPage, request, apiToken,
}) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);
  const auth = { Authorization: `Bearer ${apiToken.token}` };

  const res = await request.post(
    `/api/files/${uuidv4()}?projectId=${seeded.inProgressProjectId}&kind=document&name=${encodeURIComponent(LONG_NAME)}`,
    { headers: { ...auth, 'Content-Type': 'application/pdf' }, data: Buffer.from('%PDF-1.4 layout fixture') },
  );
  if (!res.ok()) throw new Error(`long-name fixture upload failed: ${res.status()} ${await res.text()}`);

  await authedPage.goto(`/documents?projectIds=${seeded.inProgressProjectId}`);
  const row = authedPage.locator('table [data-testid="documents-row"]').filter({ hasText: LONG_NAME.slice(0, 40) });
  await expect(row).toHaveCount(1);

  // The full name survives in the title (hover) even though the visible text
  // is clipped: the span is narrower than its content.
  const nameSpan = row.locator(`span[title="${LONG_NAME}"]`);
  await expect(nameSpan).toBeVisible();
  const truncated = await nameSpan.evaluate(el => el.scrollWidth > el.clientWidth);
  expect(truncated).toBe(true);

  // Desktop (1440x900 per playwright.config.ts): every column, incl. Date, fits.
  await expect(authedPage.locator('table thead th', { hasText: 'Date' })).toBeVisible();
  await assertNoHorizontalOverflow(authedPage);
  await authedPage.screenshot({ path: 'test-results/documents-layout-long-name-desktop.png', fullPage: true });

  // Tablet (md..lg band): the fixed widths shrink, the Date header folds away
  // and the date rides in the Name subline instead — still no overflow.
  await authedPage.setViewportSize({ width: 820, height: 1180 });
  await expect(row).toHaveCount(1);
  await expect(authedPage.locator('table thead th', { hasText: 'Date' })).toBeHidden();
  await assertNoHorizontalOverflow(authedPage);
  await authedPage.screenshot({ path: 'test-results/documents-layout-long-name-tablet.png', fullPage: true });
});
