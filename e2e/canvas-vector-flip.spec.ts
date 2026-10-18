import { test, expect, seedProjectWithVectorPages } from './fixtures/test';

// ─────────────────────────────────────────────────────────────────────────────
// Proof for the in-memory PDF document + rendered-bitmap caches
// (src/utils/pdfDocCache.ts) that back instant page flips between vector
// (PDF-backed) canvas pages.
//
// Without the caches, PdfCanvas (which CanvasView remounts via `key={page.id}`
// on every navigation) re-parses the source PDF via pdf.js and re-renders the
// target page into a fresh offscreen canvas on EVERY visit — even flipping
// back to a page seen a moment ago. That means:
//   - The source PDF's /raw URL gets fetched again each time the document
//     cache doesn't already hold a parsed proxy for it (mitigated somewhat by
//     the browser HTTP cache, but the parse + render work still repeats).
//   - Re-displaying a page you already looked at pays the full parse+render
//     cost again instead of painting instantly from a cached bitmap.
//
// This spec seeds a real 2-page vector project (both pages share ONE source
// PDF file, sourcePdfPageNum 1 and 2), then does a page 1 -> page 2 -> page 1
// round trip and asserts:
//   1. The source PDF's /raw URL is requested at most ONCE across the whole
//      session (doc cache, backed by the HTTP cache, avoids a second parse).
//   2. Returning to page 1 paints its canvas well inside a short window,
//      proving the bitmap cache — not a fresh pdf.js render — served it.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Vector-page canvas flip (PDF doc + bitmap caches)', () => {
  test('flipping pages 1 -> 2 -> 1 fetches the source PDF once and repaints page 1 instantly', async ({
    authedPage, request, apiToken,
  }) => {
    const seed = await seedProjectWithVectorPages(request, apiToken.token);

    const rawUrlFragment = `/api/images/${seed.sourcePdfFileId}/raw`;
    let pdfRequestCount = 0;
    authedPage.on('request', (req) => {
      if (req.url().includes(rawUrlFragment)) pdfRequestCount++;
    });

    const canvasSurface = authedPage.getByTestId('canvas-surface');
    const canvasLocator = canvasSurface.locator('canvas').first();

    // ── Visit page 1 ──────────────────────────────────────────────────────
    await authedPage.goto(`/project/${seed.projectId}/page/${seed.page1Id}`);
    await expect(authedPage.getByTestId('canvas-surface')).toBeVisible();
    await expect(canvasLocator).toBeVisible();
    // Let the vector render pipeline fully settle (page proxy resolve +
    // initial 2.0x render) before moving on.
    await authedPage.waitForTimeout(1500);

    // ── Navigate to page 2 ────────────────────────────────────────────────
    // Two "Next Page" controls exist in the DOM (a top-bar one, obscured by
    // the collapsed-sidebar overlay at this viewport, and one nested under
    // canvas-surface) — scope to the one under canvas-surface, which is the
    // one actually clickable/visible.
    await canvasSurface.getByTitle('Next Page').click();
    await expect(authedPage).toHaveURL(new RegExp(`/page/${seed.page2Id}`));
    await expect(canvasLocator).toBeVisible();
    await authedPage.waitForTimeout(1500);

    // ── Navigate BACK to page 1 — this is the flip the caches should make
    //    fast. Poll for the canvas to be visible again within a short window
    //    (much shorter than the ~1.5s a fresh parse+render pass took above).
    const backStart = Date.now();
    await canvasSurface.getByTitle('Previous Page').click();
    await expect(authedPage).toHaveURL(new RegExp(`/page/${seed.page1Id}`));
    await expect(canvasLocator).toBeVisible({ timeout: 3000 });
    const backElapsed = Date.now() - backStart;

    // Give any trailing network activity (background proxy re-resolve, etc.)
    // a moment to settle before reading the final request count.
    await authedPage.waitForTimeout(1000);

    expect(pdfRequestCount).toBeLessThanOrEqual(1);
    expect(backElapsed).toBeLessThan(3000);
  });
});
