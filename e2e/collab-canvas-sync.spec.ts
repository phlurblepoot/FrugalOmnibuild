import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import type { Page } from '@playwright/test';
import { test, expect, login, seedProjectWithPage, seedProjectWithSupersededRevision } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// ─────────────────────────────────────────────────────────────────────────────
// WS4 acceptance proof: canvas hardening (docs/superpowers/plans/2026-08-25-
// ws4-canvas-hardening.md). Two independently-authenticated browser contexts
// (two real socket connections, same JWT — same idiom as collab-live-refresh
// and collab-follow) prove that drawing now persists via server-applied
// measurement ops (T2/T3), decoupled from the full-project PUT (T5), with
// join-time backfill (T3) and live cross-session sync (measurement-applied)
// — plus the owner-requested scope addition (scenario 4b): foreign, non-
// measurement project changes (scale/takeoff) still live-refresh an open
// canvas via the version-gated entity-changed path (T5 contract item 6).
//
// Scenario 5 (superseded rejection) is proven with a RAW socket.io-client
// connection from the test process straight to the running e2e server —
// bypassing the browser entirely — since the thing being proven
// (`measurement-op` ack `{ ok: false, error: 'page_superseded' }`) is a wire-
// level contract, not a UI behavior. This is NOT a fallback: it's a genuine
// two-context-style proof, backed further by the identical assertion already
// covered at the unit layer (server/realtime/registerRealtime.canvas.test.ts
// case 4, "superseded page — ack page_superseded").
// ─────────────────────────────────────────────────────────────────────────────

interface Box { x: number; y: number; width: number; height: number; }

async function surfaceBox(page: Page): Promise<Box> {
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  if (!box) throw new Error('canvas-surface has no bounding box');
  return box;
}

/** Click at screen coords relative to the canvas-surface box (canvas.spec.ts idiom). */
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

/** Calibrate: click P1 at (x1,y1) and P2 at (x2,y2) [box-relative], enter
 *  `realDist` ft, apply (canvas.spec.ts idiom). */
async function calibrate(
  page: Page, box: Box,
  p1: [number, number], p2: [number, number], realDist: string,
) {
  await page.getByTestId('tool-scale').click();
  await clickCanvas(page, box, p1[0], p1[1]);
  await clickCanvas(page, box, p2[0], p2[1]);
  await expect(page.getByTestId('scale-input')).toBeVisible();
  await page.getByTestId('scale-input').fill(realDist);
  await page.getByTestId('scale-apply').click();
  await expect(page.getByTestId('scale-input')).toBeHidden();
}

/** Create a takeoff via the sidebar "New" button + modal (canvas.spec.ts idiom). */
async function createTakeoff(page: Page, name: string, type: 'length' | 'area' | 'count') {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByTestId('takeoff-name-input')).toBeVisible();
  await page.getByTestId('takeoff-name-input').fill(name);
  const typeSelect = page.locator('select').filter({ has: page.locator('option[value="count"]') }).first();
  await typeSelect.selectOption(type);
  await page.getByTestId('btn-create-takeoff').click();
  await expect(page.getByTestId('takeoff-name-input')).toBeHidden();
}

/** IMAGE-space point (the coordinate space measurement.points live in) to
 *  on-SCREEN pixels, via the live Konva stage's absolute transform plus the
 *  canvas-surface bounding box (plan-set-readonly.spec.ts idiom). */
async function imagePointToScreen(page: Page, box: Box, imgX: number, imgY: number) {
  const local = await page.evaluate(([x, y]) => {
    const K = (window as any).Konva;
    const stage = K?.stages?.[0];
    if (!stage) throw new Error('no Konva stage found');
    const layer = stage.getLayers()[0];
    const pt = layer.getAbsoluteTransform().point({ x, y });
    return { x: pt.x, y: pt.y };
  }, [imgX, imgY] as const);
  return { x: box.x + local.x, y: box.y + local.y };
}

/** Real mouse drag of the vertex at image-space (imgX,imgY) by (dx,dy) screen
 *  px (plan-set-readonly.spec.ts `dragVertex` idiom). */
async function dragVertex(page: Page, box: Box, imgX: number, imgY: number, dx: number, dy: number) {
  const start = await imagePointToScreen(page, box, imgX, imgY);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(start.x + (dx * i) / 5, start.y + (dy * i) / 5);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test.describe('WS4 two-context canvas sync', () => {
  test('live draw, persistence-without-PUT, late-join backfill, drag sync, and foreign scale/takeoff live-refresh', async ({
    browser, request,
  }) => {
    // Six scenarios, three browser contexts (one opened mid-test), several
    // cross-socket waits — comfortably over the 30s default under load. Same
    // idiom as collab-follow.spec.ts.
    test.setTimeout(60_000);
    const { token, user } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    const auth = { Authorization: `Bearer ${token}` };

    const a = await openAuthedContext(browser, token, user);
    const b = await openAuthedContext(browser, token, user);

    try {
      // ── Scenario 1: live draw sync ──────────────────────────────────────
      // A calibrates scale + creates a takeoff (both go through a full
      // project PUT — unconverted, non-measurement project state) BEFORE B
      // ever opens the page, so B's initial REST load already carries them.
      // This scenario is isolated to proving the DRAWN MEASUREMENT itself
      // syncs live over measurement-applied — the foreign-PUT live-refresh
      // path (contract item 6) gets its own dedicated proof in scenario 4b.
      await gotoCanvas(a.page, projectId, pageId);
      const boxA = await surfaceBox(a.page);
      const cy = boxA.height / 2;
      const x1 = boxA.width / 2 - 200;
      const x2 = boxA.width / 2 + 200;
      await calibrate(a.page, boxA, [x1, cy], [x2, cy], '10');
      await createTakeoff(a.page, 'Linear', 'length');

      await gotoCanvas(b.page, projectId, pageId);

      await a.page.getByTestId('tool-length').click();
      await clickCanvas(a.page, boxA, x1, cy);
      await clickCanvas(a.page, boxA, x1 + 200, cy);
      await a.page.keyboard.press('Enter');

      await expect(a.page.getByTestId('measurement-row')).toHaveCount(1);
      // B never reloads or navigates — the row must appear purely via the
      // measurement-applied broadcast.
      await expect(b.page.getByTestId('measurement-row')).toHaveCount(1, { timeout: 15_000 });
      await b.page.screenshot({ path: 'test-results/ws4-live-draw-B.png' });

      // ── Scenario 2: server persistence without a full-project PUT ──────
      // A performed no other action — the only write since the draw is the
      // measurement-op itself. Reloading B's page entirely must still show
      // the measurement: proof the server applied the op durably to the
      // `measurements` table rather than depending on a client PUT to
      // persist it (the pre-T5 code would have lost it here).
      await b.page.reload();
      await expect(b.page.getByTestId('canvas-surface')).toBeVisible();
      await expect(b.page.locator('[data-testid="canvas-surface"] canvas').first()).toBeVisible();
      await expect(b.page.getByTestId('measurement-row')).toHaveCount(1);

      // ── Scenario 3: backfill on late join ───────────────────────────────
      // A fresh context C, connecting AFTER A's draw and never having seen a
      // measurement-applied event for it, must still see the measurement
      // immediately via canvas-join's ack-time hydration.
      const c = await openAuthedContext(browser, token, user);
      try {
        await gotoCanvas(c.page, projectId, pageId);
        await expect(c.page.getByTestId('measurement-row')).toHaveCount(1);
        await c.page.screenshot({ path: 'test-results/ws4-late-join-C.png' });
      } finally {
        await c.context.close().catch(() => {});
      }

      // ── Scenario 4: drag sync ───────────────────────────────────────────
      // The drawn measurement's id is a client-generated uuid unknown to the
      // test, so fetch its persisted points from the server to compute the
      // drag geometry.
      const projRes = await request.get(`/api/projects/${projectId}`, { headers: auth });
      expect(projRes.ok()).toBe(true);
      const projJson = await projRes.json();
      const seededPage = projJson.pages.find((p: { id: string }) => p.id === pageId);
      const beforePoints = seededPage.measurements[0].points as { x: number; y: number }[];

      const beforeValueText = await a.page.getByTestId('measurement-value').first().innerText();

      // B drags the first vertex — select the measurement first (a click on
      // its shape), then a real drag (dragVertex idiom).
      const boxB = await surfaceBox(b.page);
      const v0 = await imagePointToScreen(b.page, boxB, beforePoints[0].x, beforePoints[0].y);
      await b.page.mouse.move(v0.x, v0.y);
      await b.page.mouse.click(v0.x, v0.y);
      await b.page.waitForTimeout(150);
      await dragVertex(b.page, boxB, beforePoints[0].x, beforePoints[0].y, 150, 80);

      // A's sidebar value must change with NO reload/navigation on A's side —
      // Playwright's built-in retrying `expect` is the "polling" the task asks
      // for.
      await expect(a.page.getByTestId('measurement-value').first())
        .not.toHaveText(beforeValueText, { timeout: 15_000 });
      await a.page.screenshot({ path: 'test-results/ws4-drag-sync-A.png' });

      // ── Scenario 4b (owner-requested addition): foreign scale/takeoff
      // live-refresh ──────────────────────────────────────────────────────
      // A non-measurement project change (a takeoff rename here — scale
      // recalibration travels the identical full-project-PUT path) must
      // live-refresh BOTH open canvases via the version-gated entity-changed
      // subscription (contract item 6), with no reload/navigation on either
      // side. The PUT is issued directly via `request` (not through A or B),
      // so it carries no X-Session-Id and is foreign to both sessions.
      const beforeRenameRes = await request.get(`/api/projects/${projectId}`, { headers: auth });
      const beforeRenameProject = await beforeRenameRes.json();
      const takeoffId = beforeRenameProject.takeoffs[0].id;
      const renamedTo = 'Linear (renamed)';
      beforeRenameProject.takeoffs = beforeRenameProject.takeoffs.map(
        (t: { id: string; name: string }) => (t.id === takeoffId ? { ...t, name: renamedTo } : t),
      );
      const renamePutRes = await request.put(`/api/projects/${projectId}`, {
        headers: auth, data: beforeRenameProject,
      });
      expect(renamePutRes.ok()).toBe(true);

      await expect(a.page.getByTestId('measurement-sidebar').getByText(renamedTo, { exact: true }))
        .toBeVisible({ timeout: 15_000 });
      await expect(b.page.getByTestId('measurement-sidebar').getByText(renamedTo, { exact: true }))
        .toBeVisible({ timeout: 15_000 });
    } finally {
      await a.context.close().catch(() => {});
      await b.context.close().catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: server-side superseded rejection, proven over a raw
// socket.io-client connection straight to the running e2e server (no browser
// involved) — the cleanest way to assert a wire-level ack contract without
// contorting a Playwright page interaction around it.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// C1 regression (fix-wave, WS4 final review): a cross-page measurement-applied
// event must splice the drawn measurement into the RECEIVING tab's
// project.pages for the FOREIGN page it landed on — not just adopt the bumped
// version. Before the fix, a tab open on page Y adopted the version for a
// draw that happened on page X without ever updating its local page-X
// measurements; any later full-project PUT from that tab (any of the ~20
// surviving save sites — scale, takeoffs, regions...) then serialized its
// stale (measurement-less) copy of page X, and decomposeProject's
// delete-and-reinsert silently deleted the other user's cross-page work.
// ─────────────────────────────────────────────────────────────────────────────

test('C1 regression: a foreign cross-page draw survives a same-project full-PUT save from another open page', async ({
  browser, request,
}) => {
  test.setTimeout(60_000);
  const { token, user } = await login(request);
  const { projectId, pageId: pageXId } = await seedProjectWithPage(request, token, { withScale: true });
  const auth = { Authorization: `Bearer ${token}` };

  // Add a second page (Y) to the same project, with no scale yet — B will
  // recalibrate it via the canvas UI, exercising the full-project-PUT save
  // path (not a measurement-op) that C1 is about.
  const getRes = await request.get(`/api/projects/${projectId}`, { headers: auth });
  expect(getRes.ok()).toBe(true);
  const proj = await getRes.json();
  const pageX = proj.pages.find((p: { id: string }) => p.id === pageXId);
  const pageYId = randomUUID();
  proj.pages.push({
    id: pageYId,
    name: 'Sheet 2',
    imageId: pageX.imageId,
    imageWidth: pageX.imageWidth,
    imageHeight: pageX.imageHeight,
    measurements: [],
    scaleConfig: null,
  });
  const addPageRes = await request.put(`/api/projects/${projectId}`, { headers: auth, data: proj });
  expect(addPageRes.ok()).toBe(true);

  const a = await openAuthedContext(browser, token, user);
  const b = await openAuthedContext(browser, token, user);

  try {
    // B opens page Y FIRST, before A ever draws — B's initial REST load of
    // the project has zero measurements on page X, matching reality at that
    // moment. B stays on page Y for the rest of the test.
    await gotoCanvas(b.page, projectId, pageYId);

    // A opens page X and draws a length measurement — a cross-page op
    // relative to B's open canvas (same project room, different page).
    await gotoCanvas(a.page, projectId, pageXId);
    await createTakeoff(a.page, 'Linear', 'length');
    const boxA = await surfaceBox(a.page);
    const cyA = boxA.height / 2;
    const xA1 = boxA.width / 2 - 150;
    await a.page.getByTestId('tool-length').click();
    await clickCanvas(a.page, boxA, xA1, cyA);
    await clickCanvas(a.page, boxA, xA1 + 150, cyA);
    await a.page.keyboard.press('Enter');
    await expect(a.page.getByTestId('measurement-row')).toHaveCount(1);

    // Give B's socket time to receive + adopt the cross-page
    // measurement-applied broadcast. The fix requires this to splice A's
    // measurement into B's local project.pages entry for page X, even though
    // B's own canvas/page state (page Y) is untouched.
    await b.page.waitForTimeout(1000);

    // B recalibrates scale on page Y — a full project PUT serialized from
    // B's local project state (the one the fix must have kept in sync).
    const boxB = await surfaceBox(b.page);
    const cyB = boxB.height / 2;
    await calibrate(b.page, boxB, [boxB.width / 2 - 100, cyB], [boxB.width / 2 + 100, cyB], '5');

    // A's page-X measurement must have survived B's save.
    const afterRes = await request.get(`/api/projects/${projectId}`, { headers: auth });
    expect(afterRes.ok()).toBe(true);
    const afterProj = await afterRes.json();
    const afterPageX = afterProj.pages.find((p: { id: string }) => p.id === pageXId);
    expect(afterPageX.measurements).toHaveLength(1);
  } finally {
    await a.context.close().catch(() => {});
    await b.context.close().catch(() => {});
  }
});

test('server rejects a measurement op on a superseded plan-set page', async ({ request, baseURL }) => {
  const { token } = await login(request);
  const seed = await seedProjectWithSupersededRevision(request, token);

  const raw = ioClient(baseURL!, { auth: { token } });
  try {
    await new Promise<void>((resolve, reject) => {
      raw.once('connect', () => resolve());
      raw.once('connect_error', (err) => reject(err));
    });

    // Join the project/page rooms the same way CanvasView does on mount.
    raw.emit('set-location', {
      path: `/project/${seed.projectId}/page/${seed.supersededPageId}`,
      projectId: seed.projectId,
      pageId: seed.supersededPageId,
    });
    await new Promise((r) => setTimeout(r, 150));

    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      raw.emit('measurement-op', {
        pageId: seed.supersededPageId,
        projectId: seed.projectId,
        action: 'add',
        measurement: { id: 'e2e-superseded-reject', type: 'length', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
      }, resolve);
    });

    expect(ack).toEqual({ ok: false, error: 'page_superseded' });
  } finally {
    raw.disconnect();
  }
});
