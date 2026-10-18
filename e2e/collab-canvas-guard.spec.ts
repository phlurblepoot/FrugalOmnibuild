import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect, login, seedProjectWithAreaTakeoffLength } from './fixtures/test';
import { openAuthedContext } from './fixtures/collab';

// Task 5 fix round 1 (F1): the mid-gesture guard originally only covered
// new-shape drawing (activePoints/arcMode). But CanvasView's contract-item-6
// entity-changed reload (and the backfill/reconnect path) can equally land
// mid-VERTEX-DRAG — a foreign takeoff rename bumps the project's version and
// broadcasts entity-changed globally; without a widened guard, the debounced
// loadData() mid-drag resets `page.measurements` to the pre-drag geometry
// while the browser's native mouse button is still down, which can desync
// Konva's dragged node from React state and drop the edit when the user
// finally releases the mouse (onDragEnd never fires against the node the
// user thinks they're holding).
//
// This spec proves the fix: A starts dragging an existing measurement's
// vertex and HOLDS (no mouseup) while B renames a takeoff via a direct
// project PUT (a real server-side save — not a synthetic event — so it
// produces a genuine entity-changed broadcast with a bumped project version).
// A then finishes the drag. The dragged vertex must persist at its new
// position (proving the reload was suppressed while draggingPoint was set),
// and the rename must also have landed (proving the foreign event really
// fired and isn't just being swallowed).

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
  await page.waitForTimeout(600);
}

// Same idiom as plan-set-readonly.spec.ts: convert an IMAGE-space point (the
// coordinate space measurement.points live in) to on-SCREEN pixels via the
// live Konva stage's absolute transform.
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

async function fetchPoints(
  request: APIRequestContext, token: string, projectId: string, measurementId: string,
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

// The "B" side of the scenario: a direct, real project PUT (not a synthetic
// window event) so the server emits a genuine entity-changed broadcast with
// a bumped version — no X-Session-Id header, so it's unambiguously foreign.
async function renameTakeoffViaApi(
  request: APIRequestContext, token: string, projectId: string, takeoffId: string, newName: string,
) {
  const auth = { Authorization: `Bearer ${token}` };
  const getRes = await request.get(`/api/projects/${projectId}`, { headers: auth });
  if (!getRes.ok()) throw new Error(`project fetch failed: ${getRes.status()} ${await getRes.text()}`);
  const project = await getRes.json();
  project.takeoffs = project.takeoffs.map((t: any) => (t.id === takeoffId ? { ...t, name: newName } : t));
  const putRes = await request.put(`/api/projects/${projectId}`, { headers: auth, data: project });
  if (!putRes.ok()) throw new Error(`project save failed: ${putRes.status()} ${await putRes.text()}`);
}

test('a foreign project change mid-vertex-drag does not clobber the in-flight drag', async ({ browser, request }) => {
  const { token, user } = await login(request);
  const seeded = await seedProjectWithAreaTakeoffLength(request, token);

  // A real second browser context/socket for realism (mirrors the other
  // collab-* specs), even though the actual mutation goes over `request` —
  // it's what makes B's presence/socket connection plausible as "a colleague".
  const a = await openAuthedContext(browser, token, user);

  try {
    await gotoCanvas(a.page, seeded.projectId, seeded.pageId);

    const box = await surfaceBox(a.page);
    const before = await fetchPoints(request, token, seeded.projectId, seeded.measurementId);
    const start = await imagePointToScreen(a.page, box, before[0].x, before[0].y);

    // Select the measurement first (matches plan-set-readonly.spec.ts — a
    // vertex only renders draggable once its measurement is selected).
    await a.page.mouse.move(start.x, start.y);
    await a.page.mouse.click(start.x, start.y);
    await a.page.waitForTimeout(150);

    // Start the drag and HOLD — no mouseup yet. Several intermediate moves so
    // Konva registers a genuine drag (draggingPoint becomes non-null).
    const dx = 150, dy = 80;
    await a.page.mouse.move(start.x, start.y);
    await a.page.mouse.down();
    for (let i = 1; i <= 3; i++) {
      await a.page.mouse.move(start.x + (dx * i) / 6, start.y + (dy * i) / 6);
      await a.page.waitForTimeout(20);
    }

    // Mid-drag: B renames the takeoff via a direct project PUT. This bumps
    // the project version and broadcasts entity-changed globally; A's socket
    // (connected, on this project's canvas) receives it.
    const newName = `${seeded.takeoffName} (renamed)`;
    await renameTakeoffViaApi(request, token, seeded.projectId, seeded.takeoffId, newName);

    // Long enough for the 300ms debounce to have fired (and, pre-fix, to have
    // reloaded page/project state) while the mouse button is still down.
    await a.page.waitForTimeout(700);

    // Finish the drag.
    for (let i = 4; i <= 6; i++) {
      await a.page.mouse.move(start.x + (dx * i) / 6, start.y + (dy * i) / 6);
      await a.page.waitForTimeout(20);
    }
    await a.page.mouse.up();
    await a.page.waitForTimeout(500);

    // The dragged vertex must have moved to its new position — proving the
    // guard suppressed the reload while draggingPoint was set (had it not,
    // Konva's node would have desynced from the reset geometry and the final
    // mouseup would either land on stale data or never commit at all).
    const after = await fetchPoints(request, token, seeded.projectId, seeded.measurementId);
    expect(after).not.toEqual(before);
    const moved = Math.hypot(after[0].x - before[0].x, after[0].y - before[0].y);
    expect(moved).toBeGreaterThan(20);
    // The OTHER vertex is untouched — only the dragged one moved.
    expect(after[1]).toEqual(before[1]);

    // And B's foreign change really did land — proving entity-changed fired
    // for real, not that it was simply never dispatched.
    const finalRes = await request.get(`/api/projects/${seeded.projectId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const finalProject = await finalRes.json();
    const takeoff = finalProject.takeoffs.find((t: any) => t.id === seeded.takeoffId);
    expect(takeoff?.name).toBe(newName);
  } finally {
    await a.context.close().catch(() => {});
  }
});
