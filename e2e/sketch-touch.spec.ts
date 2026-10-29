import { test, expect } from './fixtures/test';
import type { CDPSession, Page } from '@playwright/test';

// The Sketch editor on an iPad: a finger or the Apple Pencil presses, slides
// to aim and lifts to place a point; a double-tap ends a line; two fingers
// tap to undo and three to redo; Back, Done and Cancel buttons stand in for
// the keys. Once the Pencil is used, fingers move the view instead of drawing.

test.use({ hasTouch: true, viewport: { width: 1180, height: 820 } });

const touch = (cdp: CDPSession) => ({
  /** One finger: down at `from`, through `to` (if given), up. */
  drag: async (from: [number, number], to?: [number, number]) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1], id: 1 }] });
    if (to) {
      for (let i = 1; i <= 5; i++) {
        const x = from[0] + ((to[0] - from[0]) * i) / 5, y = from[1] + ((to[1] - from[1]) * i) / 5;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
      }
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  },
  /** Several fingers tapping together. */
  tapWith: async (fingers: number, at: [number, number]) => {
    const touchPoints = Array.from({ length: fingers }, (_, i) => ({ x: at[0] + i * 40, y: at[1], id: i + 1 }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  },
});

const pencil = (cdp: CDPSession) => ({
  hover: (x: number, y: number) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'pen' }),
  /** Down at `from`, through `to` (if given), up. */
  drag: async (from: [number, number], to?: [number, number]) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1], pointerType: 'pen' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' });
    const end = to ?? from;
    if (to) {
      for (let i = 1; i <= 5; i++) {
        const x = from[0] + ((to[0] - from[0]) * i) / 5, y = from[1] + ((to[1] - from[1]) * i) / 5;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'pen' });
      }
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end[0], y: end[1], button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  },
});

async function newSketch(page: Page, name: string) {
  await page.goto('/tools/sketch?new=1');
  await page.getByLabel('Name').fill(name);
  await page.getByTestId('new-sketch-create').click();
  await expect(page).toHaveURL(/\/tools\/sketch\?fileId=/);
  await expect(page.getByTestId('sketch-tool-rect')).toBeVisible();
  const box = (await page.getByTestId('sketch-view').boundingBox())!;
  return { cx: box.x + box.width / 2 - 150, cy: box.y + box.height / 2 + 60 };
}

test('Sketch on a touch screen: aim and lift to place, double-tap to end a line, finger taps undo and redo, Back and Cancel', async ({ authedPage: page }) => {
  const { cx, cy } = await newSketch(page, 'Finger sketch');
  const cdp = await page.context().newCDPSession(page);
  const finger = touch(cdp);
  const dims = page.locator('.sketch-label-dim');

  // A rectangle: tap the first corner, then press near the other, slide to it and lift.
  await page.getByTestId('sketch-tool-rect').tap();
  await finger.drag([cx, cy]);
  await expect(page.getByTestId('sketch-typed-0')).toBeVisible();
  await finger.drag([cx + 60, cy - 30], [cx + 160, cy - 90]);
  await expect(dims).toHaveCount(4);
  // The touch buttons are there while drawing.
  await page.getByTestId('sketch-tool-line').tap();
  await finger.drag([cx, cy + 80]);
  await expect(page.getByTestId('sketch-cancel')).toBeVisible();
  await finger.drag([cx + 120, cy + 80]);
  await finger.drag([cx + 120, cy + 160]);
  await expect(dims).toHaveCount(4 + 2);
  // Back takes the last point off; Cancel drops the line.
  await page.getByTestId('sketch-back').tap();
  await expect(dims).toHaveCount(4 + 1);
  await page.getByTestId('sketch-cancel').tap();
  await expect(dims).toHaveCount(4);
  await expect(page.getByTestId('sketch-cancel')).toHaveCount(0);

  // A line of two pieces, ended by a double-tap on its last point (it stays open).
  await finger.drag([cx, cy + 80]);
  await finger.drag([cx + 120, cy + 80]);
  await finger.drag([cx + 120, cy + 160]);
  await finger.drag([cx + 120, cy + 160]);
  await expect(page.getByTestId('sketch-cancel')).toHaveCount(0);
  await expect(dims).toHaveCount(6);

  // Two fingers tapped together undo it; three bring it back.
  await finger.tapWith(2, [cx + 300, cy - 200]);
  await expect(dims).toHaveCount(4);
  await finger.tapWith(3, [cx + 300, cy - 200]);
  await expect(dims).toHaveCount(6);
  // While a line is being drawn, two fingers take its last point back instead.
  await finger.drag([cx + 300, cy + 100]);
  await finger.drag([cx + 400, cy + 100]);
  await expect(dims).toHaveCount(7);
  await finger.tapWith(2, [cx + 300, cy - 200]);
  await expect(dims).toHaveCount(6);
  await expect(page.getByTestId('sketch-cancel')).toBeVisible();
});

test('Sketch with the Apple Pencil: it draws (hover shows where), and fingers then move the view; the toggle lets fingers draw again', async ({ authedPage: page }) => {
  const { cx, cy } = await newSketch(page, 'Pencil sketch');
  const cdp = await page.context().newCDPSession(page);
  const pen = pencil(cdp);
  const finger = touch(cdp);
  const dims = page.locator('.sketch-label-dim');

  // The Pencil draws a rectangle: a tap for one corner, a slide to the other.
  await page.getByTestId('sketch-tool-rect').tap();
  await pen.drag([cx, cy]);
  // Hovering shows the size before touching down.
  await pen.hover(cx + 100, cy - 60);
  await expect(page.locator('.sketch-label-readout')).toBeVisible();
  await pen.drag([cx + 90, cy - 50], [cx + 160, cy - 90]);
  await expect(dims).toHaveCount(4);
  await expect(page.getByTestId('sketch-pencil-only')).toHaveAttribute('aria-pressed', 'true');

  // A hand resting on the screen does not get in the Pencil's way.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx + 420, y: cy + 160, id: 9 }] });
  await pen.drag([cx + 250, cy]);
  await expect(page.getByTestId('sketch-typed-0')).toBeVisible();
  await pen.drag([cx + 290, cy - 30], [cx + 330, cy - 60]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(dims).toHaveCount(8);

  // Now a finger slides the view instead of drawing, and a finger tap places nothing.
  const before = (await dims.first().boundingBox())!;
  await finger.drag([cx + 300, cy - 100], [cx + 200, cy]);
  await expect.poll(async () => (await dims.first().boundingBox())!.x).toBeLessThan(before.x - 50);
  await expect(dims).toHaveCount(8);
  await finger.drag([cx + 300, cy - 100]);
  await expect(page.getByTestId('sketch-typed-0')).toHaveCount(0);

  // Turned off, a finger draws again.
  await page.getByTestId('sketch-pencil-only').tap();
  await expect(page.getByTestId('sketch-pencil-only')).toHaveAttribute('aria-pressed', 'false');
  await finger.drag([cx + 300, cy - 100]);
  await expect(page.getByTestId('sketch-typed-0')).toBeVisible();
});
