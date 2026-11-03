import { test, expect, seedProjectWithPage, login } from './fixtures/test';
import type { Page } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// Canvas segment value in feet + copy/paste of segments.
//
// A length takeoff that totals in YARDS still shows a clicked segment's length
// in feet and inches on the canvas. Ctrl+C copies only the selected segment
// (not the measurement); Ctrl+V asks where it goes: a new measurement in the
// current (active) takeoff, or a new takeoff made on the spot.
//
// Scale: calibrate 400px = 10 ft, so a 200px line = 5 ft = 1.67 yd.
// ─────────────────────────────────────────────────────────────────────────────

interface Box { x: number; y: number; width: number; height: number; }

async function surfaceBox(page: Page): Promise<Box> {
  const surface = page.getByTestId('canvas-surface');
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  if (!box) throw new Error('canvas-surface has no bounding box');
  return box;
}

async function clickCanvas(page: Page, box: Box, dx: number, dy: number, button: 'left' | 'right' = 'left') {
  await page.mouse.move(box.x + dx, box.y + dy);
  await page.mouse.click(box.x + dx, box.y + dy, { button });
  await page.waitForTimeout(60);
}

test.describe('CanvasView segment copy / paste', () => {
  test('a segment reads in feet on a yard takeoff, and Ctrl+C / Ctrl+V pastes it into the current or a new takeoff', async ({ authedPage: page, request }) => {
    test.setTimeout(60_000);
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await page.goto(`/project/${projectId}/page/${pageId}`);
    await expect(page.locator('[data-testid="canvas-surface"] canvas').first()).toBeVisible();
    await page.waitForTimeout(400);
    const box = await surfaceBox(page);

    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;
    // Calibrate 400px = 10 ft.
    await page.getByTestId('tool-scale').click();
    await clickCanvas(page, box, x1, cy);
    await clickCanvas(page, box, x1 + 400, cy);
    await page.getByTestId('scale-input').fill('10');
    await page.getByTestId('scale-apply').click();
    await expect(page.getByTestId('scale-input')).toBeHidden();

    // A length takeoff that totals in yards.
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByTestId('takeoff-name-input').fill('Base');
    await page.locator('select').filter({ has: page.locator('option[value="count"]') }).first().selectOption('length');
    await page.locator('select').filter({ has: page.locator('option[value="yd"]') }).first().selectOption('yd');
    await page.getByTestId('btn-create-takeoff').click();
    await expect(page.getByTestId('takeoff-name-input')).toBeHidden();

    // One measurement, two segments: 400px (10 ft) on top, 200px (5 ft) below.
    await page.getByTestId('tool-length').click();
    await clickCanvas(page, box, x1, cy - 80);
    await clickCanvas(page, box, x1 + 400, cy - 80);
    await page.keyboard.press('Enter');
    await clickCanvas(page, box, x1, cy + 80);
    await clickCanvas(page, box, x1 + 200, cy + 80);
    await page.keyboard.press('Enter');
    const rows = page.getByTestId('measurement-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByTestId('measurement-value')).toContainText('5.00 yd');

    // Click the short segment: its value reads in feet and inches.
    await page.getByTestId('tool-pan').click();
    await clickCanvas(page, box, x1 + 100, cy + 80);
    const segment = page.getByTestId('selection-info-segment');
    await expect(segment).toBeVisible();
    await expect(segment).toContainText(`5' - 0"`);
    await expect(segment).not.toContainText('yd');

    // Ctrl+C copies just that segment.
    await page.keyboard.press('Control+c');
    await expect(page.getByText('Copied 1 segment')).toBeVisible();

    // Ctrl+V → Current takeoff: a new 5 ft (1.67 yd) measurement in Base.
    await page.keyboard.press('Control+v');
    const modal = page.getByTestId('paste-segments-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Paste 1 segment');
    await expect(page.getByTestId('paste-into-active')).toContainText('Base');
    await page.getByTestId('paste-into-active').click();
    await expect(modal).toBeHidden();
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('measurement-value').filter({ hasText: '1.67 yd' })).toHaveCount(1);
    // The selected paste is one segment: no separate segment stat.
    await expect(page.getByTestId('selection-info-total')).toContainText(`5' - 0"`);

    // Undo removes the paste.
    await page.keyboard.press('Control+z');
    await expect(rows).toHaveCount(1);

    // Escape closes the paste choice without pasting.
    await page.keyboard.press('Control+v');
    await expect(modal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(rows).toHaveCount(1);

    // Ctrl+V → New takeoff: the takeoff modal opens set to length; creating
    // it drops the segment in as its measurement.
    await page.keyboard.press('Control+v');
    await page.getByTestId('paste-into-new').click();
    await expect(page.getByText('New Takeoff for Pasted Segments')).toBeVisible();
    await expect(page.locator('select').filter({ has: page.locator('option[value="count"]') }).first()).toHaveValue('length');
    await page.getByTestId('takeoff-name-input').fill('Shoe');
    await page.getByTestId('btn-create-takeoff').click();
    await expect(page.getByTestId('takeoff-name-input')).toBeHidden();
    const sidebar = page.getByTestId('measurement-sidebar');
    await expect(sidebar.getByText('Shoe', { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('selection-info-bar')).toContainText('Shoe');
    await expect(page.getByTestId('selection-info-total')).toContainText(`5' - 0"`);

    // Right-click → Copy works too (the new takeoff left the length tool on).
    await page.getByTestId('tool-pan').click();
    await clickCanvas(page, box, x1 + 300, cy - 80, 'right');
    await page.getByTestId('context-menu-copy').click();
    await expect(page.getByText(/Copied \d segments?/).last()).toBeVisible();
  });
  test('Shift+click selects segments across measurements and takeoffs (one type only); Ctrl+click copies whole measurements', async ({ authedPage: page, request }) => {
    test.setTimeout(60_000);
    const { token } = await login(request);
    const { projectId, pageId } = await seedProjectWithPage(request, token, { withScale: false });
    await page.goto(`/project/${projectId}/page/${pageId}`);
    await expect(page.locator('[data-testid="canvas-surface"] canvas').first()).toBeVisible();
    await page.waitForTimeout(400);
    const box = await surfaceBox(page);
    const cy = box.height / 2;
    const x1 = box.width / 2 - 200;

    await page.getByTestId('tool-scale').click();
    await clickCanvas(page, box, x1, cy);
    await clickCanvas(page, box, x1 + 400, cy);
    await page.getByTestId('scale-input').fill('10');
    await page.getByTestId('scale-apply').click();
    await expect(page.getByTestId('scale-input')).toBeHidden();

    const newTakeoff = async (name: string, type: 'length' | 'area') => {
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByTestId('takeoff-name-input').fill(name);
      await page.locator('select').filter({ has: page.locator('option[value="count"]') }).first().selectOption(type);
      await page.getByTestId('btn-create-takeoff').click();
      await expect(page.getByTestId('takeoff-name-input')).toBeHidden();
    };

    // Base: 10 ft + a 5 ft segment. Shoe: one 5 ft line. Floor: an area.
    await newTakeoff('Base', 'length');
    await page.getByTestId('tool-length').click();
    await clickCanvas(page, box, x1, cy - 120);
    await clickCanvas(page, box, x1 + 400, cy - 120);
    await page.keyboard.press('Enter');
    await clickCanvas(page, box, x1, cy - 60);
    await clickCanvas(page, box, x1 + 200, cy - 60);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    await newTakeoff('Shoe', 'length');
    await page.getByTestId('tool-length').click();
    await clickCanvas(page, box, x1, cy + 20);
    await clickCanvas(page, box, x1 + 200, cy + 20);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');

    await newTakeoff('Floor', 'area');
    await page.getByTestId('tool-area').click();
    await clickCanvas(page, box, x1, cy + 100);
    await clickCanvas(page, box, x1 + 200, cy + 100);
    await clickCanvas(page, box, x1 + 200, cy + 200);
    await clickCanvas(page, box, x1, cy + 200);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    const rows = page.getByTestId('measurement-row');
    await expect(rows).toHaveCount(3);

    // Shift+click Base's short segment and Shoe's line.
    await page.getByTestId('tool-pan').click();
    await page.keyboard.down('Shift');
    await clickCanvas(page, box, x1 + 100, cy - 60);
    await clickCanvas(page, box, x1 + 100, cy + 20);
    const set = page.getByTestId('selection-info-segment-set');
    await expect(set).toContainText('2 segments selected');
    await expect(set).toContainText(`10' - 0"`);
    // An area can't join a length selection.
    await clickCanvas(page, box, x1, cy + 150);
    await page.keyboard.up('Shift');
    await expect(page.getByText(/Can't mix length and area segments/)).toBeVisible();
    await expect(set).toContainText('2 segments selected');

    await page.keyboard.press('Control+c');
    await expect(page.getByText('Copied 2 segments')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(set).toHaveCount(0);

    // Paste both into a new takeoff: one 10 ft measurement.
    await page.keyboard.press('Control+v');
    await expect(page.getByTestId('paste-segments-modal')).toContainText('Paste 2 segments');
    await page.getByTestId('paste-into-new').click();
    await page.getByTestId('takeoff-name-input').fill('Trim');
    await page.getByTestId('btn-create-takeoff').click();
    await expect(page.getByTestId('takeoff-name-input')).toBeHidden();
    await expect(rows).toHaveCount(4);
    await expect(page.getByTestId('selection-info-bar')).toContainText('Trim');
    await expect(page.getByTestId('selection-info-total')).toContainText(`10' - 0"`);

    // Ctrl+click two whole measurements: Ctrl+C copies all their segments.
    await page.keyboard.press('Escape');
    await page.getByTestId('tool-pan').click();
    await page.keyboard.down('Control');
    await clickCanvas(page, box, x1 + 300, cy - 120);
    await clickCanvas(page, box, x1 + 100, cy + 20);
    await page.keyboard.up('Control');
    await expect(page.getByTestId('selection-info-bar')).toContainText('2 selected');
    await page.keyboard.press('Control+c');
    await expect(page.getByText('Copied 3 segments')).toBeVisible();
  });
});
