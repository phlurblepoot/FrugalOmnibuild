import { test, expect, login, seedProjectWithSupersededRevision } from './fixtures/test';
import type { Page, APIRequestContext } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// Plan-set superseded revisions are TRULY read-only.
//
// Bug being characterized: on a superseded plan-set revision the canvas shows a
// "read-only history" banner, but existing measurements could STILL be dragged
// / edited — because measurement shapes were `draggable={currentTool==='pan'}`
// and read-only mode FORCES currentTool='pan'. The fix threads a `readOnly`
// prop into PdfCanvas that gates every measurement-mutation interaction, plus
// early-returns in CanvasView's update/delete/paste/keyboard handlers.
//
// SETUP: seedProjectWithSupersededRevision builds one project with two plan sets
// contributing two revisions of the SAME sheet (shared sheetId). The older page
// is 'superseded' (read-only history), the newer is 'current' (editable). Each
// page carries one 2-point length measurement at image coords (200,200)-(500,200).
//
// PROOF STRATEGY: we drag the FIRST vertex of the measurement on the canvas,
// then read the PERSISTED measurement points back from the API and diff.
//   • Superseded page  → points MUST be unchanged (drag suppressed).
//   • Current page     → points MUST change (editing still works).
// Screenshots of both attempts land in test-results/ for visual confirmation.
// ─────────────────────────────────────────────────────────────────────────────

interface Box { x: number; y: number; width: number; height: number; }

async function surfaceBox(page: Page): Promise<Box> {
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  if (!box) throw new Error('canvas-surface has no bounding box');
  return box;
}

async function gotoCanvas(page: Page, projectId: string, pageId: string) {
  await page.goto(`/project/${projectId}/page/${pageId}`);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('[data-testid="canvas-surface"] canvas').first()).toBeVisible();
  // Let the auto-fit zoom settle so the Konva absolute transform is stable.
  await page.waitForTimeout(600);
}

/**
 * Convert an IMAGE-space point (the coordinate space measurement.points live in)
 * to on-SCREEN pixels, using the live Konva stage's absolute transform plus the
 * canvas-surface bounding box. Measurements are drawn on the stage's first
 * layer, whose absolute transform equals the stage transform (no layer offset).
 */
async function imagePointToScreen(page: Page, box: Box, imgX: number, imgY: number) {
  const local = await page.evaluate(([x, y]) => {
    // Konva injects itself as a global; the canvas mounts exactly one stage.
    const K = (window as any).Konva;
    const stage = K?.stages?.[0];
    if (!stage) throw new Error('no Konva stage found');
    const layer = stage.getLayers()[0];
    const pt = layer.getAbsoluteTransform().point({ x, y });
    return { x: pt.x, y: pt.y };
  }, [imgX, imgY] as const);
  return { x: box.x + local.x, y: box.y + local.y };
}

async function fetchPoints(
  request: APIRequestContext,
  token: string,
  projectId: string,
  measurementId: string,
): Promise<{ x: number; y: number }[]> {
  const res = await request.get(`/api/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) throw new Error(`project fetch failed: ${res.status()} ${await res.text()}`);
  const project = await res.json();
  for (const p of project.pages) {
    const m = p.measurements.find((mm: any) => mm.id === measurementId);
    if (m) return m.points;
  }
  throw new Error(`measurement ${measurementId} not found`);
}

/** Real mouse drag of the vertex at image-space (imgX,imgY) by (dx,dy) screen px. */
async function dragVertex(page: Page, box: Box, imgX: number, imgY: number, dx: number, dy: number) {
  const start = await imagePointToScreen(page, box, imgX, imgY);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Several intermediate moves so Konva registers a genuine drag, not a click.
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(start.x + (dx * i) / 5, start.y + (dy * i) / 5);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test.describe('Plan-set superseded revisions are read-only', () => {
  test('a vertex CANNOT be dragged on a superseded revision, but CAN on the current one', async ({
    authedPage,
    request,
  }) => {
    const { token } = await login(request);
    const seed = await seedProjectWithSupersededRevision(request, token);

    // ── SUPERSEDED PAGE: the read-only history revision ──────────────────────
    await gotoCanvas(authedPage, seed.projectId, seed.supersededPageId);

    // The read-only banner must be visible (proves we're on the frozen revision).
    await expect(authedPage.getByTestId('canvas-superseded-banner')).toBeVisible();

    const supersededBox = await surfaceBox(authedPage);
    const before = await fetchPoints(request, token, seed.projectId, seed.supersededMeasurementId);

    await authedPage.screenshot({ path: 'test-results/plan-set-readonly-superseded-before.png' });

    // Attempt to drag the FIRST vertex (image-space 200,200) far to the right.
    await dragVertex(authedPage, supersededBox, before[0].x, before[0].y, 150, 80);

    await authedPage.screenshot({ path: 'test-results/plan-set-readonly-superseded-after.png' });

    const afterSuperseded = await fetchPoints(request, token, seed.projectId, seed.supersededMeasurementId);
    // The persisted points MUST be byte-identical — the drag did nothing.
    expect(afterSuperseded).toEqual(before);

    // ── CURRENT PAGE (positive control): the same drag DOES move the vertex ───
    await gotoCanvas(authedPage, seed.projectId, seed.currentPageId);

    // No superseded banner on the current revision.
    await expect(authedPage.getByTestId('canvas-superseded-banner')).toHaveCount(0);

    const currentBox = await surfaceBox(authedPage);
    const beforeCurrent = await fetchPoints(request, token, seed.projectId, seed.currentMeasurementId);

    await authedPage.screenshot({ path: 'test-results/plan-set-readonly-current-before.png' });

    // Select the measurement first (a click on the shape), then drag its vertex.
    const v0 = await imagePointToScreen(authedPage, currentBox, beforeCurrent[0].x, beforeCurrent[0].y);
    await authedPage.mouse.move(v0.x, v0.y);
    await authedPage.mouse.click(v0.x, v0.y);
    await authedPage.waitForTimeout(150);

    await dragVertex(authedPage, currentBox, beforeCurrent[0].x, beforeCurrent[0].y, 150, 80);

    await authedPage.screenshot({ path: 'test-results/plan-set-readonly-current-after.png' });

    const afterCurrent = await fetchPoints(request, token, seed.projectId, seed.currentMeasurementId);
    // The persisted first vertex MUST have moved (editing works on current pages).
    expect(afterCurrent).not.toEqual(beforeCurrent);
    // Sanity: the OTHER vertex is untouched — only the dragged one moved.
    expect(afterCurrent[1]).toEqual(beforeCurrent[1]);
    // And the moved vertex is meaningfully displaced (not sub-pixel jitter).
    const moved = Math.hypot(afterCurrent[0].x - beforeCurrent[0].x, afterCurrent[0].y - beforeCurrent[0].y);
    expect(moved).toBeGreaterThan(20);
  });
});
