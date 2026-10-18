import {
  test, expect, seedProjectWithPage, seedProjectWithAreaTakeoffLength, seedProjectWithSupersededRevision,
  seedProjectWithTakeoffMeasurement, login,
} from './fixtures/test';
import type { Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// CanvasView — scale calibration + measurement drawing characterization.
//
// This is a CHARACTERIZATION spec for the drawing engine (PdfCanvas + the
// CanvasView handlers). It locks in the *current* behavior, including the
// quirks discovered while writing it. It does NOT try to fix the app.
//
// DRAW MECHANICS (discovered by reading src/components/PdfCanvas.tsx and
// src/pages/CanvasView.tsx):
//
//   • The canvas is a Konva <Stage> rendered into a <canvas> inside the
//     [data-testid="canvas-surface"] wrapper. It listens for REAL mouse events
//     (onMouseDown/onMouseMove/onMouseUp on the Stage). We drive it with
//     page.mouse, which generates genuine pointer events. Konva reads the
//     pointer position from the last move, so every click must be a real
//     move→down→up at the target screen coords (page.mouse.click does this).
//
//   • TOOL ENABLEMENT: the length/area/count tools are DISABLED unless BOTH
//     (a) page.scaleConfig is set AND (b) something is selected (a takeoff or a
//     measurement). The seed creates a project with NO takeoffs, so we must
//     calibrate the scale first, then create + select a takeoff before drawing.
//     (When a takeoff exists at load, CanvasView auto-selects the first one.)
//
//   • SCALE: pick tool-scale, click P1 then P2. The SECOND click fires
//     onSetScale(pixelDistanceBetweenTheTwoClicks) which opens the
//     ScaleCalibrationModal. Type the real distance into [scale-input] and
//     press [scale-apply]. After that, page.scaleConfig =
//     { pixelDistance: <image-space px between clicks>, realWorldDistance, unit }.
//
//   • LENGTH / AREA: each click on the background adds a vertex
//     (handleMouseDown → setActivePoints). The segment is FINISHED by pressing
//     Enter (finalizeSegment), OR by clicking within ~10px (image space) of the
//     LAST point (not the start). There is NO finish button. We use Enter — the
//     most deterministic. A finished length with NO existing selected
//     measurement that matches the tool creates a NEW measurement and selects
//     it; a selected empty placeholder gets filled instead.
//
//   • COUNT: each click commits a brand-new count Measurement immediately
//     (one measurement per click). No finish step.
//
//   • SELF-REFERENTIAL DETERMINISM: we never rely on the absolute screen→image
//     px ratio. We calibrate "spanPx screen → realDist" then draw using the
//     SAME screen coords. Because calibration and measurement share the screen→
//     image transform, the measured real value is a known fraction of realDist
//     regardless of the auto-fit zoom. A length over half the calibration span
//     reads ~half the real distance; a WxH rectangle reads W*H real area.
//
// VALUE FORMATS (src/utils/math.ts):
//   • length, ft, no takeoff unit → feet-inches e.g.  5' - 0"   or   2 1/2"
//   • area,   ft, no takeoff unit → "50.00 sq ft"
//   • count                       → "1 each" (per row)
// We parse all three robustly below.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a displayed measurement value into a number in its base unit.
 *  - feet/inches like `5' - 0"`, `11"`, `2 1/2"`, `0"` → decimal FEET
 *  - `50.00 sq ft` → 50.0 (sq ft)
 *  - `1 each` → 1 (count) */
function parseValue(text: string): number {
  const t = text.trim();
  // area / generic "<num> <unit>"
  const sqft = t.match(/^([\d.]+)\s*sq/i);
  if (sqft) return parseFloat(sqft[1]);
  const each = t.match(/^(\d+)\s*each/i);
  if (each) return parseInt(each[1], 10);

  // feet-inches:  F' - I FRAC"   |   I FRAC"   |   FRAC"   |   0"
  let feet = 0;
  const feetMatch = t.match(/(\d+)\s*'/);
  if (feetMatch) feet += parseInt(feetMatch[1], 10);
  // strip the feet portion, then parse the inches portion
  const afterFeet = feetMatch ? t.slice(t.indexOf("'") + 1) : t;
  const inchSection = afterFeet.replace(/[-]/g, ' ').replace(/"/g, ' ').trim();
  if (inchSection) {
    // could be "I N/D" or "I" or "N/D"
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
  // Small settle so Konva commits the click before the next gesture.
  await page.waitForTimeout(60);
}

/** Open the canvas for a seeded page and wait for the Konva canvas to mount. */
async function gotoCanvas(page: Page, projectId: string, pageId: string) {
  await page.goto(`/project/${projectId}/page/${pageId}`);
  await expect(page.getByTestId('canvas-surface')).toBeVisible();
  // The Konva <canvas> element must exist (background image fit + listeners up).
  await expect(page.locator('[data-testid="canvas-surface"] canvas').first()).toBeVisible();
  await page.waitForTimeout(400);
}

/** Calibrate: click P1 at (x1,y1) and P2 at (x2,y2) [box-relative], enter
 *  `realDist` ft, apply. After this the page has a real ft/px scale. */
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

/** Create a takeoff of the given type via the sidebar "New" button + modal,
 *  then ensure it's the selected takeoff (creation selects it; we also click it
 *  to be safe). Requires a scale to already be set (the New button is gated on
 *  page.scaleConfig). */
async function createTakeoff(page: Page, name: string, type: 'length' | 'area' | 'count') {
  // The "New" button (Plus) in the sidebar header. exact:true so it doesn't
  // also match the per-card "New Measurement" button once a takeoff exists.
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByTestId('takeoff-name-input')).toBeVisible();
  await page.getByTestId('takeoff-name-input').fill(name);
  // The "Measurement Type" <select> has no testid; locate by its option set.
  const typeSelect = page.locator('select').filter({ has: page.locator('option[value="count"]') }).first();
  await typeSelect.selectOption(type);
  await page.getByTestId('btn-create-takeoff').click();
  await expect(page.getByTestId('takeoff-name-input')).toBeHidden();
}

test.describe('CanvasView drawing engine', () => {
  // 1 + 2: calibrate 400px=10ft, then a 200px length must read ~5 ft.
  test('scale calibration enables tools and a half-span length reads ~half', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    // Before any scale, length tool is disabled — clicking it surfaces the
    // tool-disabled message rather than activating.
    // (We just confirm the tool button exists; enablement is exercised below.)
    await expect(authedPage.getByTestId('tool-length')).toBeVisible();

    // Calibrate: 400px horizontal span = 10 ft. Use a vertical center line.
    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    const x2 = box.width / 2 + 200;
    await calibrate(authedPage, box, [x1, cy], [x2, cy], '10');

    // Now a takeoff can be created (the New button is gated on scaleConfig).
    await createTakeoff(authedPage, 'Linear', 'length');
    await expect(authedPage.getByTestId('tool-length')).toBeEnabled();

    // Draw a 200px length (half the calibration span) → ~5 ft.
    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);
    await authedPage.keyboard.press('Enter');

    const value = authedPage.getByTestId('measurement-value').first();
    await expect(value).toBeVisible();
    const feet = parseValue(await value.innerText());
    expect(feet).toBeGreaterThan(4.7);
    expect(feet).toBeLessThan(5.3);
  });

  // 3: rectangle area. Calibrate 400px=10ft (0.025 ft/screenpx along the
  // calibration axis). Draw a 400px×200px rectangle → 10ft × 5ft = 50 sq ft.
  test('area measurement reads ~expected square feet', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const left = box.width / 2 - 200;
    const right = box.width / 2 + 200; // 400px span = 10 ft
    await calibrate(authedPage, box, [left, cy], [right, cy], '10');

    await createTakeoff(authedPage, 'Surface', 'area');
    await expect(authedPage.getByTestId('tool-area')).toBeEnabled();

    // Rectangle: width 400px (=10ft), height 200px (=5ft) → 50 sq ft.
    const top = cy - 100;
    const bot = cy + 100; // 200px tall
    await authedPage.getByTestId('tool-area').click();
    await clickCanvas(authedPage, box, left, top);
    await clickCanvas(authedPage, box, right, top);
    await clickCanvas(authedPage, box, right, bot);
    await clickCanvas(authedPage, box, left, bot);
    await authedPage.keyboard.press('Enter');

    const value = authedPage.getByTestId('measurement-value').first();
    await expect(value).toBeVisible();
    const sqft = parseValue(await value.innerText());
    // Tolerance ±5 sq ft (~10%) to absorb sub-pixel rounding in the transform.
    expect(sqft).toBeGreaterThan(45);
    expect(sqft).toBeLessThan(55);
  });

  // 4: count tool — each click commits one count measurement. A count takeoff
  // renders a per-page count badge (NOT measurement-row), so we assert the
  // badge reads "3" after three clicks.
  test('count tool commits one measurement per click', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    await calibrate(authedPage, box, [box.width / 2 - 200, cy], [box.width / 2 + 200, cy], '10');

    await createTakeoff(authedPage, 'Fixtures', 'count');
    await expect(authedPage.getByTestId('tool-count')).toBeEnabled();

    await authedPage.getByTestId('tool-count').click();
    await clickCanvas(authedPage, box, box.width / 2 - 100, cy - 80);
    await clickCanvas(authedPage, box, box.width / 2, cy);
    await clickCanvas(authedPage, box, box.width / 2 + 100, cy + 80);

    // The count takeoff card shows a per-page count badge. The takeoff total
    // chip also reads "3 each". Assert the sidebar contains a "3" count.
    const sidebar = authedPage.getByTestId('measurement-sidebar');
    await expect(sidebar.getByText('3 each')).toBeVisible();
  });

  // 5: a drawn length measurement appears as a measurement-row in the sidebar.
  test('drawn measurement appears in the sidebar', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');
    await createTakeoff(authedPage, 'Linear', 'length');

    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);
    await authedPage.keyboard.press('Enter');

    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
    await expect(authedPage.getByTestId('measurement-value').first()).toBeVisible();
  });

  // 6: delete a measurement via its row trash button → confirm dialog → it
  // leaves the sidebar.
  test('deleting a measurement removes its row', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');
    await createTakeoff(authedPage, 'Linear', 'length');

    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);
    await authedPage.keyboard.press('Enter');

    const row = authedPage.getByTestId('measurement-row');
    await expect(row).toHaveCount(1);

    // The row's delete button is the Trash2 button titled "Delete Measurement".
    await row.first().hover();
    await row.first().getByTitle('Delete Measurement').click();
    await authedPage.getByTestId('btn-confirm-delete').click();

    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(0);
  });

  // 7: undo/redo. Characterized real behavior — handleUndo for an "add" action
  // removes the measurement; handleRedo restores it. btn-undo/btn-redo are
  // disabled when the respective stack is empty.
  test('undo removes the drawn measurement and redo restores it', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');
    await createTakeoff(authedPage, 'Linear', 'length');

    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy);
    await clickCanvas(authedPage, box, x1 + 200, cy);
    await authedPage.keyboard.press('Enter');
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);

    await authedPage.getByTestId('btn-undo').click();
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(0);

    await authedPage.getByTestId('btn-redo').click();
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CanvasView — RIGHT-SIDEBAR interaction characterization (Phase 5h Task 2).
//
// Locks in the CURRENT behavior of the measurement-sidebar bits that Task 3 will
// refactor: the measurement filter, the "current page only" toggle, the per-card
// takeoff expand/collapse chevron, the wall-heights modal, and the multi-select
// + merge flow. These are characterization tests — they assert what the app
// ACTUALLY does today (quirks included) and do NOT try to fix it.
//
// Selection mechanics relevant here (read from src/components/PdfCanvas.tsx +
// src/pages/CanvasView.tsx):
//   • Each takeoff card defaults to EXPANDED (expandedTakeoffs[id] !== false).
//   • The per-card chevron is [data-testid="takeoff-expand"]; clicking it
//     toggles only that card's measurement rows.
//   • "Edit Heights" only renders when a measurement is SELECTED *and* it's a
//     LENGTH measurement living under an AREA takeoff (takeoffType==='area',
//     measurement.type==='length'). It opens the "Wall Heights" modal.
//   • Multi-select: the toolbar [data-testid="btn-multi-select-toggle"] flips
//     isMultiSelectMode. In that mode, CLICKING a measurement SHAPE on the Konva
//     canvas toggles it into multiSelectedIds (onMultiSelectToggle). The shapes
//     only `listening` when NO drawing tool is active, so we switch to tool-pan
//     before clicking shapes. The merge banner appears once size>0.
// ─────────────────────────────────────────────────────────────────────────────

/** Calibrate + create ONE takeoff + draw ONE horizontal length under it.
 *  Returns the screen coords of the drawn line so callers can click its shape
 *  (e.g. for multi-select). */
async function drawLengthUnder(
  authedPage: Page, box: Box, name: string,
  x1: number, cy: number, len = 200,
): Promise<{ midX: number; midY: number }> {
  await createTakeoff(authedPage, name, 'length');
  await authedPage.getByTestId('tool-length').click();
  await clickCanvas(authedPage, box, x1, cy);
  await clickCanvas(authedPage, box, x1 + len, cy);
  await authedPage.keyboard.press('Enter');
  return { midX: x1 + len / 2, midY: cy };
}

test.describe('CanvasView right-sidebar interactions', () => {
  // 1: filter narrows the visible takeoffs/measurements; clearing restores all.
  test('measurement filter shows matching takeoff and hides the rest', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');

    // Two differently-named length takeoffs, each with one measurement.
    await drawLengthUnder(authedPage, box, 'Plumbing', x1, cy - 60);
    await drawLengthUnder(authedPage, box, 'Electrical', x1, cy + 60);

    const sidebar = authedPage.getByTestId('measurement-sidebar');
    await expect(sidebar.getByText('Plumbing', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Electrical', { exact: true })).toBeVisible();

    // Filter to "Plumb" → only the Plumbing card remains; Electrical is hidden.
    const filter = authedPage.getByTestId('measurement-filter');
    await filter.fill('Plumb');
    await expect(sidebar.getByText('Plumbing', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Electrical', { exact: true })).toHaveCount(0);

    // Clear → both return.
    await filter.fill('');
    await expect(sidebar.getByText('Plumbing', { exact: true })).toBeVisible();
    await expect(sidebar.getByText('Electrical', { exact: true })).toBeVisible();
  });

  // 2: "current page only" toggle flips state; measurements stay visible.
  // QUIRK: the seed has a single page, so there's no cross-page measurement to
  // hide — we can only assert the toggle flips and the page's rows remain.
  test('current-page-only toggle flips and keeps current-page measurements', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');
    await drawLengthUnder(authedPage, box, 'Linear', x1, cy);
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);

    const toggle = authedPage.getByTestId('toggle-current-page-only');
    // Default: unchecked (shows all pages' measurements).
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
    // The single page's measurement is still present after enabling page-only.
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
  });

  // 3: per-card chevron collapses/expands the takeoff's measurement rows.
  // QUIRK: cards default to EXPANDED, so the row is visible initially.
  test('takeoff chevron collapses and re-expands its measurement rows', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');
    await drawLengthUnder(authedPage, box, 'Linear', x1, cy);
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);

    const chevron = authedPage.getByTestId('takeoff-expand').first();
    // Collapse → rows hide.
    await chevron.click();
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(0);
    // Expand → rows return.
    await chevron.click();
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
  });

  // 4: a LENGTH measurement under an AREA takeoff exposes Edit Heights, which
  // opens the "Wall Heights" modal; setting a height + saving closes it cleanly.
  //
  // QUIRK: there is NO unblocked tool path to create a length-under-area in the
  // UI — the length tool is DISABLED while an area takeoff is selected
  // (activeType lock), and an area takeoff's "New Measurement" forces type
  // 'area'. The only UI route is drag-dropping a length row into an area card
  // (flaky to drive). We therefore SEED the length-under-area shape and
  // characterize the Edit Heights button + modal from there.
  test('edit-heights opens the Wall Heights modal and saves', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithAreaTakeoffLength(request, token);
    await gotoCanvas(authedPage, projectId, pageId);

    const row = authedPage.getByTestId('measurement-row').first();
    await expect(row).toBeVisible();
    // Select the row so the Edit Heights affordance renders.
    await row.click();

    const editHeights = authedPage.getByTestId('btn-edit-heights');
    await expect(editHeights).toBeVisible();
    await editHeights.click();

    // The Wall Heights modal opens.
    await expect(authedPage.getByText('Wall Heights')).toBeVisible();
    // Set a global height and save.
    await authedPage.getByPlaceholder('Height').first().fill('8');
    await authedPage.getByRole('button', { name: 'Save Heights' }).click();
    // Modal closes; no crash; the row survives.
    await expect(authedPage.getByText('Wall Heights')).toHaveCount(0);
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
  });

  // 5: multi-select mode + merge. Enable the mode, click two length SHAPES on
  // the canvas (tool must be pan so shapes `listening`), assert the merge banner
  // counts 2, then Merge → the two rows collapse into one.
  test('multi-select enables banner and merge collapses two measurements', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');

    // Two SEPARATE length measurements under one takeoff. QUIRK: finalizeSegment
    // APPENDS to the currently-selected same-type measurement instead of making a
    // new one (PdfCanvas canAppend path). So after the first line we press Escape
    // to clear the measurement selection (keeps the takeoff selected, so the
    // length tool stays enabled) before drawing the second line.
    await createTakeoff(authedPage, 'Linear', 'length');
    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy - 60);
    await clickCanvas(authedPage, box, x1 + 200, cy - 60);
    await authedPage.keyboard.press('Enter');
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);

    await authedPage.keyboard.press('Escape'); // clear measurement selection
    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy + 60);
    await clickCanvas(authedPage, box, x1 + 200, cy + 60);
    await authedPage.keyboard.press('Enter');
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(2);

    // Switch to pan so measurement shapes start `listening`, then enable
    // multi-select mode.
    await authedPage.getByTestId('tool-pan').click();
    await authedPage.getByTestId('btn-multi-select-toggle').click();

    // Click each line's midpoint on the canvas to add it to the selection.
    await clickCanvas(authedPage, box, x1 + 100, cy - 60);
    await clickCanvas(authedPage, box, x1 + 100, cy + 60);

    // Merge banner shows the count.
    const sidebar = authedPage.getByTestId('measurement-sidebar');
    await expect(sidebar.getByText('2 selected')).toBeVisible();

    // Merge folds the source measurement's segments into the target and then
    // DELETES the source. QUIRK: handleMergeSelected calls deleteMeasurement,
    // which opens the standard delete-CONFIRM dialog rather than deleting
    // outright — so the merge isn't truly done until we confirm.
    await authedPage.getByTestId('btn-merge').click();
    await expect(authedPage.getByTestId('btn-confirm-delete')).toBeVisible();
    await authedPage.getByTestId('btn-confirm-delete').click();

    // After confirming, the two measurements have collapsed into one.
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CanvasView — Subtract (cutout) tool characterization.
//
// The Subtract tool cuts a hole out of a SELECTED area measurement: click
// points to draw an inner polygon, finish with Enter (same finish gesture as
// the area tool), and the measurement's readout + sidebar total reflect the
// NET area (primary − holes). Internally this APPENDS a `{ subtract: true }`
// segment to the existing measurement via updateMeasurement({ segments }) —
// it does NOT create a new measurement — so the row count never changes
// across a cut, and undo is a single 'update' history entry that restores the
// segments array (removing the hole) rather than deleting a row.
//
// tool-subtract lives on the same floating toolbar as tool-area/tool-length/
// tool-count (the only toolbar instance with data-testid hooks), so it's
// selected exactly like those tools above.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('CanvasView subtract (cutout) tool', () => {
  test('cutting a hole reduces the area readout; undo restores it', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const left = box.width / 2 - 200;
    const right = box.width / 2 + 200; // 400px span = 10 ft
    await calibrate(authedPage, box, [left, cy], [right, cy], '10');

    await createTakeoff(authedPage, 'Surface', 'area');
    await expect(authedPage.getByTestId('tool-area')).toBeEnabled();

    // Primary rectangle: 400px x 200px -> 10ft x 5ft = 50 sq ft (same geometry
    // as the 'area measurement reads ~expected square feet' test above).
    const top = cy - 100;
    const bot = cy + 100;
    await authedPage.getByTestId('tool-area').click();
    await clickCanvas(authedPage, box, left, top);
    await clickCanvas(authedPage, box, right, top);
    await clickCanvas(authedPage, box, right, bot);
    await clickCanvas(authedPage, box, left, bot);
    await authedPage.keyboard.press('Enter');

    const value = authedPage.getByTestId('measurement-value').first();
    await expect(value).toBeVisible();
    let sqft = parseValue(await value.innerText());
    expect(sqft).toBeGreaterThan(45);
    expect(sqft).toBeLessThan(55);

    // finalizeSegment auto-selects the just-drawn area measurement, so the
    // Subtract tool is enabled with no extra selection step.
    await expect(authedPage.getByTestId('tool-subtract')).toBeEnabled();
    await authedPage.getByTestId('tool-subtract').click();

    // Inner cutout: 200px x 100px -> 5ft x 2.5ft = 12.5 sq ft hole.
    // Net expected: 50 - 12.5 = 37.5 sq ft.
    const cutTop = cy - 50;
    const cutBot = cy + 50;
    const cutLeft = box.width / 2 - 100;
    const cutRight = box.width / 2 + 100;
    await clickCanvas(authedPage, box, cutLeft, cutTop);
    await clickCanvas(authedPage, box, cutRight, cutTop);
    await clickCanvas(authedPage, box, cutRight, cutBot);
    await clickCanvas(authedPage, box, cutLeft, cutBot);
    await authedPage.keyboard.press('Enter');

    sqft = parseValue(await value.innerText());
    // Same ±5 sq ft tolerance idiom as the area test.
    expect(sqft).toBeGreaterThan(32.5);
    expect(sqft).toBeLessThan(42.5);

    // Sidebar shows the cutout as a negative deduction row under the measurement.
    const sidebar = authedPage.getByTestId('measurement-sidebar');
    await expect(sidebar.getByText('Cutout 1')).toBeVisible();

    // Visual proof of the punch-out for human review (canvas changes need a
    // screenshot, not just a numeric assertion).
    await authedPage.screenshot({ path: 'test-results/subtract-punchout.png' });

    // One undo removes the cutout (an 'update' history entry on the segments
    // array, not a new measurement) and restores the original 50 sq ft value.
    await authedPage.getByTestId('btn-undo').click();
    sqft = parseValue(await value.innerText());
    expect(sqft).toBeGreaterThan(45);
    expect(sqft).toBeLessThan(55);
    await expect(sidebar.getByText('Cutout 1')).toHaveCount(0);
    // Still one row throughout — subtract never creates a second measurement.
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CanvasView — Subtract tool read-only gate (mirrors plan-set-readonly.spec.ts).
//
// On a superseded plan-set revision, readOnly is forced true and
// handlePhoneToolBlocked() fires FIRST in every ToolButton's onDisabledClick,
// regardless of the tool's other enablement criteria — so clicking the
// (soft-disabled) Subtract button always surfaces the "Tool Restricted" modal
// with the superseded-revision message instead of activating the tool.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('CanvasView subtract tool is read-only-gated', () => {
  test('subtract tool cannot cut on a superseded revision', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const seed = await seedProjectWithSupersededRevision(request, token);
    await gotoCanvas(authedPage, seed.projectId, seed.supersededPageId);

    await expect(authedPage.getByTestId('canvas-superseded-banner')).toBeVisible();

    // Select the seeded measurement first. It's a LENGTH measurement, so this
    // does not by itself make Subtract a legal action — readOnly short-circuits
    // every other enablement check anyway. It's here so the click below lands
    // with a selection in place rather than on an empty canvas.
    const row = authedPage.getByTestId('measurement-row').first();
    await expect(row).toBeVisible();
    await row.click();

    // ToolButton's disabled state is SOFT: the button still renders and is
    // clickable, but routes to onDisabledClick (a "Tool Restricted" modal)
    // instead of activating the tool — so we assert the modal, not toBeDisabled().
    await authedPage.getByTestId('tool-subtract').click();
    await expect(authedPage.getByText('Tool Restricted')).toBeVisible();
    // Scope to the modal's <p> — the always-visible superseded BANNER (a
    // <span>) contains an overlapping substring of the same message.
    await expect(authedPage.locator('p', { hasText: /read-only history/i })).toBeVisible();
    await authedPage.getByRole('button', { name: 'Got it' }).click();

    // No drawing happened: still exactly the one seeded measurement/row.
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CanvasView — the selected measurement / segment value (label + info bar).
//
// Selecting a whole measurement shows its total in the fixed info bar at the
// bottom of the canvas; clicking one segment (here a cutout's edge, in Pan)
// adds that segment's own quantity and $ — a cutout as a negative deduction.
// The takeoff is priced at $2 / sq ft, so dollars are 2 × the square feet.
// ─────────────────────────────────────────────────────────────────────────────

/** "−12.50 sq ft · −$25" → { sqft: -12.5, dollars: -25 } */
function parseStat(text: string): { sqft: number; dollars: number } {
  const m = text.match(/(−?)([\d,.]+)\s*sq ft\s*·\s*(−?)\$([\d,]+)/);
  if (!m) throw new Error(`no "<qty> sq ft · $<n>" in: ${text}`);
  const sign = (s: string) => (s === '−' ? -1 : 1);
  return {
    sqft: sign(m[1]) * parseFloat(m[2].replace(/,/g, '')),
    dollars: sign(m[3]) * parseInt(m[4].replace(/,/g, ''), 10),
  };
}

test.describe('CanvasView selected segment value', () => {
  test('info bar shows the measurement total, then a clicked cutout\'s own value', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const left = box.width / 2 - 200;
    const right = box.width / 2 + 200; // 400px span = 10 ft
    await calibrate(authedPage, box, [left, cy], [right, cy], '10');

    // A priced area takeoff (createTakeoff above leaves the cost blank).
    await authedPage.getByRole('button', { name: 'New', exact: true }).click();
    await authedPage.getByTestId('takeoff-name-input').fill('Surface');
    await authedPage.locator('select').filter({ has: authedPage.locator('option[value="count"]') }).first().selectOption('area');
    await authedPage.getByPlaceholder('0.00 or =95*40%').fill('2');
    await authedPage.getByTestId('btn-create-takeoff').click();
    await expect(authedPage.getByTestId('takeoff-name-input')).toBeHidden();

    // 400px x 200px -> 50 sq ft, auto-selected as a whole measurement.
    const top = cy - 100;
    const bot = cy + 100;
    await authedPage.getByTestId('tool-area').click();
    await clickCanvas(authedPage, box, left, top);
    await clickCanvas(authedPage, box, right, top);
    await clickCanvas(authedPage, box, right, bot);
    await clickCanvas(authedPage, box, left, bot);
    await authedPage.keyboard.press('Enter');

    const bar = authedPage.getByTestId('selection-info-bar');
    await expect(bar).toBeVisible();
    await expect(authedPage.getByTestId('selection-info-segment')).toHaveCount(0);
    let total = parseStat(await authedPage.getByTestId('selection-info-total').innerText());
    expect(total.sqft).toBeGreaterThan(45);
    expect(total.sqft).toBeLessThan(55);
    expect(Math.abs(total.dollars - 2 * total.sqft)).toBeLessThanOrEqual(1);

    // 200px x 100px cutout -> 12.5 sq ft; net 37.5 sq ft.
    await authedPage.getByTestId('tool-subtract').click();
    const cutLeft = box.width / 2 - 100;
    const cutRight = box.width / 2 + 100;
    await clickCanvas(authedPage, box, cutLeft, cy - 50);
    await clickCanvas(authedPage, box, cutRight, cy - 50);
    await clickCanvas(authedPage, box, cutRight, cy + 50);
    await clickCanvas(authedPage, box, cutLeft, cy + 50);
    await authedPage.keyboard.press('Enter');

    // Pan, then click the cutout's left edge to select just that segment.
    await authedPage.getByTestId('tool-pan').click();
    await clickCanvas(authedPage, box, cutLeft, cy);

    const segment = authedPage.getByTestId('selection-info-segment');
    await expect(segment).toBeVisible();
    await expect(segment).toContainText(/cutout/i);
    const cut = parseStat(await segment.innerText());
    expect(cut.sqft).toBeLessThan(-10);
    expect(cut.sqft).toBeGreaterThan(-15);
    expect(Math.abs(cut.dollars - 2 * cut.sqft)).toBeLessThanOrEqual(1);
    total = parseStat(await authedPage.getByTestId('selection-info-total').innerText());
    expect(total.sqft).toBeGreaterThan(32.5);
    expect(total.sqft).toBeLessThan(42.5);

    // Visual proof of the amber segment label next to the total label.
    await authedPage.screenshot({ path: 'test-results/selected-segment-value.png' });

    // Escape deselects; the bar goes away with the selection.
    await authedPage.keyboard.press('Escape');
    await expect(bar).toBeHidden();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CanvasView — a measurement's multiplier (× N).
//
// A selected length/area row's action strip has Multiplier, which opens a
// small editor. The measurement then counts N times: its row shows 60 ft with
// the math under it ("30.00 ft × 2 = 60.00 ft") and a ×N badge, and every
// total doubles — the sidebar's takeoff total, the selection bar, and the
// Takeoffs tab (whose measurement row shows the math too). The seed is one
// 30 ft measurement on a $5/ft length takeoff (300 px at 100 px = 10 ft).
// ─────────────────────────────────────────────────────────────────────────────

test.describe('CanvasView measurement multiplier', () => {
  test('×2 shows the math and doubles the sidebar and Takeoffs tab totals', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithTakeoffMeasurement(request, token);
    await gotoCanvas(authedPage, projectId, pageId);

    const sidebar = authedPage.getByTestId('measurement-sidebar');
    const row = authedPage.getByTestId('measurement-row').first();
    await expect(row.getByTestId('measurement-value')).toHaveText('30.00 ft');
    await expect(sidebar.getByTestId('takeoff-total')).toHaveText('30.00 ft');

    await row.click();
    await authedPage.getByTestId('btn-edit-multiplier').click();
    await authedPage.getByTestId('multiplier-input').fill('2');
    await authedPage.getByTestId('btn-save-multiplier').click();
    await expect(authedPage.getByTestId('multiplier-modal')).toHaveCount(0);

    await expect(row.getByTestId('measurement-multiplier-badge')).toHaveText('×2');
    await expect(row.getByTestId('measurement-value')).toHaveText('60.00 ft');
    await expect(row.getByTestId('measurement-multiplier-math')).toHaveText('30.00 ft × 2 = 60.00 ft');
    await expect(sidebar.getByTestId('takeoff-total')).toHaveText('60.00 ft');
    await expect(authedPage.getByTestId('selection-info-total')).toHaveText('Measurement total30.00 ft × 2 = 60.00 ft · $300');
    // Visual proof of the canvas label, sidebar row and selection bar.
    await authedPage.screenshot({ path: 'test-results/measurement-multiplier.png' });

    // It was saved: a reload keeps it.
    await gotoCanvas(authedPage, projectId, pageId);
    await expect(authedPage.getByTestId('measurement-row').first().getByTestId('measurement-multiplier-badge')).toHaveText('×2');

    // Takeoffs tab: the total doubles, and the measurement row shows the math.
    await authedPage.goto(`/project/${projectId}/takeoff?tab=takeoffs`);
    const table = authedPage.getByTestId('takeoffs-table');
    const takeoffRow = table.getByTestId('takeoff-row').first();
    await expect(takeoffRow).toContainText('60.00 ft');
    await expect(takeoffRow).toContainText('$300');
    await takeoffRow.getByText(/Wall Length/).click();
    await table.getByTitle('Show measurements').first().click();
    await expect(table.getByTestId('takeoff-measurement-qty').first()).toHaveText('30.00 ft × 2 = 60.00 ft');
  });

  test('a superseded revision cannot change a multiplier', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const seed = await seedProjectWithSupersededRevision(request, token);
    await gotoCanvas(authedPage, seed.projectId, seed.supersededPageId);
    await expect(authedPage.getByTestId('canvas-superseded-banner')).toBeVisible();

    await authedPage.getByTestId('measurement-row').first().click();
    await authedPage.getByTestId('btn-edit-multiplier').click();
    // The read-only explanation instead of the editor.
    await expect(authedPage.getByText('Tool Restricted')).toBeVisible();
    await expect(authedPage.locator('p', { hasText: /read-only history/i })).toBeVisible();
    await expect(authedPage.getByTestId('multiplier-modal')).toHaveCount(0);
  });

  test('measurements with different multipliers are not merged', async ({ authedPage, request }) => {
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await gotoCanvas(authedPage, projectId, pageId);
    const box = await surfaceBox(authedPage);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    await calibrate(authedPage, box, [x1, cy], [box.width / 2 + 200, cy], '10');

    // Two separate lines (Escape between them, as in the merge test above).
    await createTakeoff(authedPage, 'Linear', 'length');
    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy - 60);
    await clickCanvas(authedPage, box, x1 + 200, cy - 60);
    await authedPage.keyboard.press('Enter');
    await authedPage.keyboard.press('Escape');
    await authedPage.getByTestId('tool-length').click();
    await clickCanvas(authedPage, box, x1, cy + 60);
    await clickCanvas(authedPage, box, x1 + 200, cy + 60);
    await authedPage.keyboard.press('Enter');
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(2);

    // The second (still selected) line counts twice.
    await authedPage.getByTestId('btn-edit-multiplier').click();
    await authedPage.getByTestId('multiplier-input').fill('2');
    await authedPage.getByTestId('btn-save-multiplier').click();
    await expect(authedPage.getByTestId('measurement-multiplier-badge')).toHaveCount(1);

    await authedPage.getByTestId('tool-pan').click();
    await authedPage.getByTestId('btn-multi-select-toggle').click();
    await clickCanvas(authedPage, box, x1 + 100, cy - 60);
    await clickCanvas(authedPage, box, x1 + 100, cy + 60);

    const sidebar = authedPage.getByTestId('measurement-sidebar');
    await expect(sidebar.getByText('2 selected')).toBeVisible();
    await expect(sidebar.getByText('Different multipliers — cannot merge')).toBeVisible();

    await authedPage.getByTestId('btn-merge').click();
    await expect(authedPage.getByText('These measurements have different multipliers', { exact: false })).toBeVisible();
    await expect(authedPage.getByTestId('btn-confirm-delete')).toHaveCount(0);
    await expect(authedPage.getByTestId('measurement-row')).toHaveCount(2);
  });
});
