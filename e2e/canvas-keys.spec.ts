import { test, expect, seedProjectWithPage, login } from './fixtures/test';
import type { Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// CanvasView — Backspace vs Delete key ownership.
//
// Two window keydown listeners watch the canvas: PdfCanvas (drawing engine)
// and CanvasView (selection / delete confirm). They used to BOTH react to
// Backspace *and* Delete, so pressing Backspace mid-draw popped the last point
// AND opened the "Delete Measurement" confirm (drawing requires a selected
// takeoff/measurement, so the CanvasView branch fired too).
//
// Contract locked in here (matches KeyboardShortcutsModal + CommandPalette):
//   • Backspace → ONLY removes the last in-progress point. Never opens the
//     delete confirm, whether or not something is selected.
//   • Delete    → ONLY deletes the selected measurement/segment (confirm
//     dialog). Never touches the in-progress points.
//
// Draw mechanics + self-referential coordinates are the same as canvas.spec.ts
// (calibrate 400px = 10ft, then draw in that same screen space).
// ─────────────────────────────────────────────────────────────────────────────

interface Box { x: number; y: number; width: number; height: number; }

/** Parse a feet-inches readout like `2' - 6"` into decimal feet. */
function parseFeet(text: string): number {
  const t = text.trim();
  let feet = 0;
  const feetMatch = t.match(/(\d+)\s*'/);
  if (feetMatch) feet += parseInt(feetMatch[1], 10);
  const afterFeet = feetMatch ? t.slice(t.indexOf("'") + 1) : t;
  const inchSection = afterFeet.replace(/[-]/g, ' ').replace(/"/g, ' ').trim();
  if (inchSection) {
    const fracM = inchSection.match(/(\d+)\s*\/\s*(\d+)/);
    let inches = 0;
    let whole = inchSection;
    if (fracM) {
      inches += parseInt(fracM[1], 10) / parseInt(fracM[2], 10);
      whole = inchSection.replace(fracM[0], '').trim();
    }
    if (whole) {
      const w = parseFloat(whole);
      if (!Number.isNaN(w)) inches += w;
    }
    feet += inches / 12;
  }
  return feet;
}

async function surfaceBox(page: Page): Promise<Box> {
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  if (!box) throw new Error('canvas-surface has no bounding box');
  return box;
}

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

async function createTakeoff(page: Page, name: string, type: 'length' | 'area' | 'count') {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByTestId('takeoff-name-input')).toBeVisible();
  await page.getByTestId('takeoff-name-input').fill(name);
  const typeSelect = page.locator('select').filter({ has: page.locator('option[value="count"]') }).first();
  await typeSelect.selectOption(type);
  await page.getByTestId('btn-create-takeoff').click();
  await expect(page.getByTestId('takeoff-name-input')).toBeHidden();
}

/** Assert the delete-confirm dialog stays hidden for a window of time (a
 *  plain `not.toBeVisible()` would pass instantly before the modal mounts). */
async function expectNoDeleteConfirmFor(page: Page, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await expect(page.getByTestId('btn-confirm-delete')).toHaveCount(0);
    await expect(page.getByText('Delete Measurement', { exact: true })).toHaveCount(0);
    await page.waitForTimeout(50);
  }
}

/** Calibrate 400px = 10 ft along the canvas center line and create + select
 *  a length takeoff. Returns the calibration geometry. */
async function setupLength(page: Page) {
  const box = await surfaceBox(page);
  const cy = box.height / 2;
  const x1 = box.width / 2 - 200;
  await calibrate(page, box, [x1, cy], [box.width / 2 + 200, cy], '10');
  await createTakeoff(page, 'Linear', 'length');
  await expect(page.getByTestId('tool-length')).toBeEnabled();
  return { box, cy, x1 };
}

test.describe('CanvasView Backspace vs Delete', () => {
  // Backspace mid-draw WITH a selected measurement — the exact shape of the
  // reported bug. A brand-new drawing has no selected measurement (only the
  // takeoff), so the CanvasView delete branch never fired there; it fired when
  // drawing CONTINUED after the first segment was finalized (finalizeSegment
  // auto-selects the new measurement and later segments append to it).
  //
  // Flow: segment 1 = 100px (2.5 ft) → Enter (measurement now selected) →
  // segment 2: 3 points at 0/100/200 px → Backspace → Enter. Proof of the pop:
  // the total reads 2.5 + 2.5 = 5 ft (a 3-point second segment would give
  // 7.5 ft) and the persisted appended segment has exactly 2 vertices.
  test('Backspace while drawing removes the last point without opening delete confirm', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const { box, cy, x1 } = await setupLength(authedPage);

    // Segment 1 → the measurement exists and is selected.
    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy - 60);
    await clickCanvas(authedPage, box, x1 + 100, cy - 60);
    await authedPage.keyboard.press('Enter');
    const row = authedPage.getByTestId('measurement-row');
    await expect(row).toHaveCount(1);

    // Segment 2 (appends to the selected measurement): 3 points, then Backspace.
    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy + 60);
    await clickCanvas(authedPage, box, x1 + 100, cy + 60);
    await clickCanvas(authedPage, box, x1 + 200, cy + 60);

    await authedPage.keyboard.press('Backspace');

    // The confirm must not appear at all — poll rather than a one-shot check.
    await expectNoDeleteConfirmFor(authedPage, 500);
    // Still exactly one measurement, nothing deleted.
    await expect(row).toHaveCount(1);

    // Visual proof of the drawing state after Backspace (2-point preview of
    // the second segment, first segment already committed above it).
    await authedPage.screenshot({ path: 'test-results/canvas-keys-backspace-drawing.png' });

    // Drawing continues: Enter finalizes the remaining 2 points of segment 2.
    await authedPage.keyboard.press('Enter');
    await expect(row).toHaveCount(1);
    const value = authedPage.getByTestId('measurement-value').first();
    await expect(value).toBeVisible();
    await expect.poll(async () => parseFeet(await value.innerText())).toBeGreaterThan(4.7);
    expect(parseFeet(await value.innerText())).toBeLessThan(5.3);

    // Persisted shape: primary = 2 vertices, ONE appended segment of exactly
    // 2 vertices (the third was popped).
    await expect.poll(async () => {
      const res = await request.get(`/api/projects/${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const project = await res.json();
      const pg = project.pages.find((p: any) => p.id === pageId);
      const m = (pg?.measurements ?? []).find((x: any) => x.type === 'length');
      if (!m) return 'no-measurement';
      const segs = (m.segments ?? []).map((s: any) => s.points.length);
      return `${m.points.length}|${segs.join(',')}`;
    }).toBe('2|2');
  });

  // Backspace with a saved measurement selected (not drawing): confirm stays
  // hidden and the row survives. Delete: confirm opens, and confirming removes
  // the row.
  test('Backspace on a selected measurement does nothing; Delete opens the confirm', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const { box, cy, x1 } = await setupLength(authedPage);

    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);
    await authedPage.keyboard.press('Enter');

    const row = authedPage.getByTestId('measurement-row');
    await expect(row).toHaveCount(1);
    // finalizeSegment selects the new measurement; click the row too so the
    // selection is unambiguous, then blur any focused control so the keydown
    // reaches the window listeners (they ignore INPUT/TEXTAREA/SELECT).
    await row.first().click();
    await authedPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());

    await authedPage.keyboard.press('Backspace');
    await expectNoDeleteConfirmFor(authedPage, 500);
    await expect(row).toHaveCount(1);

    await authedPage.keyboard.press('Delete');
    await expect(authedPage.getByTestId('btn-confirm-delete')).toBeVisible();
    await authedPage.getByTestId('btn-confirm-delete').click();
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(0);
  });

  // Delete must NOT pop in-progress points: 3 points → Delete → the confirm
  // may open (a measurement/takeoff is selected while drawing); dismiss it →
  // Enter still finalizes all 3 points (200px = 5 ft).
  test('Delete while drawing does not remove the in-progress point', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const { box, cy, x1 } = await setupLength(authedPage);

    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 100, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);

    await authedPage.keyboard.press('Delete');
    // If the confirm opened (something was selected), dismiss it with its
    // Cancel button — NOT Escape, which PdfCanvas also hears and would cancel
    // the in-progress drawing.
    const confirm = authedPage.getByTestId('btn-confirm-delete');
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.locator('xpath=..').getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toHaveCount(0);
    }

    await authedPage.keyboard.press('Enter');
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
    const value = authedPage.getByTestId('measurement-value').first();
    await expect(value).toBeVisible();
    const feet = parseFeet(await value.innerText());
    expect(feet).toBeGreaterThan(4.7);
    expect(feet).toBeLessThan(5.3);
  });
});
