import type { Page } from '@playwright/test';
import { test, expect, login, seedProjectWithPage } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// WS2 fix-wave proof (Fix C1): a canvas 409-conflict refresh must not leave a
// stale local copy that a later save would silently overwrite.
//
// Pre-fix bug: A and B both on a project's canvas. A saves -> version bumps.
// B's next save 409s; ProjectConflictListener (mounted app-wide) refetches
// the project over REST, heals `latestVersions`, and dispatches a
// 'project-refreshed' window event — but CanvasView never listened for it,
// so its local `project`/`page` state stayed the stale pre-A snapshot. B's
// NEXT save then passed the (healed) version check and silently erased A's
// work. This spec exercises listener -> refetch -> 'project-refreshed' ->
// CanvasView reload end-to-end, using a synthetic 'project-conflict' dispatch
// as the deterministic stand-in for a real 409 race (same idiom
// collab-live-refresh.spec.ts uses for the non-canvas live-refresh path).
//
// B's browser context blocks the socket.io transport entirely, so the ONLY
// channel through which B's canvas can learn about A's measurement is the
// REST refetch this spec is proving — not the live 'measurement-sync' socket
// channel both contexts would otherwise share by being on the same canvas
// page/room (CanvasView's onMeasurementSync already handles that path; it is
// NOT what Fix C1 is about).

interface Box { x: number; y: number; width: number; height: number; }

async function surfaceBox(page: Page): Promise<Box> {
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  if (!box) throw new Error('canvas-surface has no bounding box');
  return box;
}

/** Click at screen coords relative to the canvas-surface box. Konva needs the
 *  pointer to have MOVED to the spot first; page.mouse.click does move+down+up. */
async function clickCanvas(page: Page, box: Box, dx: number, dy: number) {
  await page.mouse.move(box.x + dx, box.y + dy);
  await page.mouse.click(box.x + dx, box.y + dy);
  await page.waitForTimeout(60);
}

async function gotoCanvas(page: Page, projectId: string, pageId: string) {
  await page.goto(`/project/${projectId}/page/${pageId}`);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  await expect(page.locator('[data-testid="canvas-surface"] canvas').first()).toBeVisible();
  await page.waitForTimeout(400);
}

async function calibrate(
  page: Page, box: Box, p1: [number, number], p2: [number, number], realDist: string,
) {
  await page.getByTestId('tool-scale').click();
  await clickCanvas(page, box, p1[0], p1[1]);
  await clickCanvas(page, box, p2[0], p2[1]);
  await expect(page.getByTestId('scale-input')).toBeVisible();
  await page.getByTestId('scale-input').fill(realDist);
  await page.getByTestId('scale-apply').click();
  await expect(page.getByTestId('scale-input')).toBeHidden();
}

async function createTakeoff(page: Page, name: string, type: 'length' | 'area' | 'count') {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByTestId('takeoff-name-input')).toBeVisible();
  await page.getByTestId('takeoff-name-input').fill(name);
  const typeSelect = page.locator('select').filter({ has: page.locator('option[value="count"]') }).first();
  await typeSelect.selectOption(type);
  await page.getByTestId('btn-create-takeoff').click();
  await expect(page.getByTestId('takeoff-name-input')).toBeHidden();
}

test('a canvas conflict refresh picks up a foreign save instead of leaving a stale local copy', async ({ browser, request }) => {
  const { token, user } = await login(request);
  const seeded = await seedProjectWithPage(request, token, { withScale: false });

  const a = await openAuthedContext(browser, token, user);
  // B never connects a socket — see file header. Isolates the REST refetch
  // path Fix C1 added from the pre-existing live socket sync path.
  const b = await openAuthedContext(browser, token, user, { blockSocket: true });

  try {
    await gotoCanvas(a.page, seeded.projectId, seeded.pageId);
    await gotoCanvas(b.page, seeded.projectId, seeded.pageId);

    // A draws and saves a length measurement (click-drag idiom from
    // e2e/canvas.spec.ts) and waits for it to persist.
    const box = await surfaceBox(a.page);
    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(a.page, box, [x1, cy], [box.width / 2 + 200, cy], '10');
    await createTakeoff(a.page, 'Linear', 'length');
    await a.page.getByTestId('tool-length').click();
    await clickCanvas(a.page, box, x1, cy);
    await clickCanvas(a.page, box, x1 + 200, cy);
    await a.page.keyboard.press('Enter');
    await expect(a.page.getByTestId('measurement-row')).toHaveCount(1);
    // Settle so the savePageUpdates PUT that persists the new measurement
    // has landed before B refetches.
    await a.page.waitForTimeout(500);

    // B's socket is blocked, so its canvas has NOT picked up A's measurement
    // through the live 'measurement-sync' channel.
    await expect(b.page.getByTestId('measurement-row')).toHaveCount(0);

    // Simulate the 409-conflict recovery on B: ProjectConflictListener
    // catches 'project-conflict', refetches the project over REST, and
    // dispatches 'project-refreshed'. CanvasView must be listening for that
    // (Fix C1) and reload its local project/page state from the response.
    await b.page.evaluate((projectId) => {
      window.dispatchEvent(new CustomEvent('project-conflict', { detail: { projectId } }));
    }, seeded.projectId);

    await expect(b.page.getByTestId('measurement-row')).toHaveCount(1, { timeout: 15_000 });
    await expect(b.page.getByTestId('measurement-value').first()).toBeVisible();
  } finally {
    await a.context.close().catch(() => {});
    await b.context.close().catch(() => {});
  }
});
