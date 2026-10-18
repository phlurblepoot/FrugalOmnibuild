import { test, expect, login, seedProjectWithSupersededRevision } from './fixtures/test';
import type { Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// Canvas "Takeoffs & Measurements" sidebar list respects plan-set revisions.
//
// Bug being characterized: the sidebar listed measurements from EVERY revision
// of the viewed sheet (it filtered project.pages by (pageNumber||name), i.e. all
// revisions). So opening the CURRENT revision still showed the SUPERSEDED
// revision's measurement, and vice-versa.
//
// Fix: the default list = the current (latest) revision per sheet, except the
// sheet being viewed shows the revision you actually opened. So:
//   • Current revision open   → sidebar shows the CURRENT measurement, NOT the
//                               superseded one.
//   • Superseded revision open (browsing history) → sidebar shows THAT (older)
//                               revision's measurement, NOT the current one.
//
// SETUP: seedProjectWithSupersededRevision → one sheet (A-101), two revisions.
//   supersededPage carries "Wall Old" (supersededMeasurementId)
//   currentPage    carries "Wall New" (currentMeasurementId)
// Both are ungrouped length measurements → they render as measurement rows in
// the sidebar's Ungrouped card, each with data-measurement-id=<id>.
// Screenshots of both views land in test-results/ for visual confirmation.
// ─────────────────────────────────────────────────────────────────────────────

async function gotoCanvas(page: Page, projectId: string, pageId: string) {
  await page.goto(`/project/${projectId}/page/${pageId}`);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('[data-testid="canvas-surface"] canvas').first()).toBeVisible();
  // The sidebar is open by default on desktop; wait for it to render.
  await expect(page.getByTestId('measurement-sidebar')).toBeVisible();
  await page.waitForTimeout(300);
}

function row(page: Page, measurementId: string) {
  return page.locator(`[data-testid="measurement-row"][data-measurement-id="${measurementId}"]`);
}

test.describe('Canvas sidebar list reflects the viewed plan-set revision', () => {
  test('current revision lists only the current measurement; superseded revision lists only its own', async ({
    authedPage,
    request,
  }) => {
    const { token } = await login(request);
    const seed = await seedProjectWithSupersededRevision(request, token);

    // ── CURRENT REVISION ─────────────────────────────────────────────────────
    await gotoCanvas(authedPage, seed.projectId, seed.currentPageId);
    await authedPage.screenshot({ path: 'test-results/plan-set-sidebar-current.png' });

    // The current sheet's own (current) measurement is listed …
    await expect(row(authedPage, seed.currentMeasurementId)).toHaveCount(1);
    // … and the SUPERSEDED revision's measurement is NOT.
    await expect(row(authedPage, seed.supersededMeasurementId)).toHaveCount(0);

    // ── SUPERSEDED REVISION (browsing history) ───────────────────────────────
    await gotoCanvas(authedPage, seed.projectId, seed.supersededPageId);
    await authedPage.screenshot({ path: 'test-results/plan-set-sidebar-superseded.png' });

    // Viewing the older revision surfaces THAT revision's measurement for the
    // sheet …
    await expect(row(authedPage, seed.supersededMeasurementId)).toHaveCount(1);
    // … and the current revision's measurement is NOT shown (we swapped this
    // sheet's visible revision to the one being viewed).
    await expect(row(authedPage, seed.currentMeasurementId)).toHaveCount(0);
  });

  test('"Current page only" narrows to just the viewed page', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const seed = await seedProjectWithSupersededRevision(request, token);

    await gotoCanvas(authedPage, seed.projectId, seed.currentPageId);

    // Default (off): current measurement present, superseded absent.
    await expect(row(authedPage, seed.currentMeasurementId)).toHaveCount(1);
    await expect(row(authedPage, seed.supersededMeasurementId)).toHaveCount(0);

    // Toggle on: still only the viewed page's measurement (this sheet has a
    // single measurement on the viewed page, so it stays visible; the strict
    // single-page filter never re-introduces other revisions).
    await authedPage.getByTestId('toggle-current-page-only').check();
    await authedPage.waitForTimeout(200);
    await expect(row(authedPage, seed.currentMeasurementId)).toHaveCount(1);
    await expect(row(authedPage, seed.supersededMeasurementId)).toHaveCount(0);
  });
});
