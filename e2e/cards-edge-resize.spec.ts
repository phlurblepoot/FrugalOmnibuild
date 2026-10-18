import { test, expect } from './fixtures/test';

// Desktop edge-drag resize (Wave 3 Task 13). Uses a real mouse-driven
// pointer drag (page.mouse) on the card's right-edge separator — Chromium
// dispatches genuine pointerdown/move/up for this, so it exercises the same
// window-bound listener path a real trackpad/mouse drag would.

test('drag-resizing a card via its edge handle snaps to a column width and persists across reload', async ({ authedPage: page }) => {
  await page.goto('/dashboard');
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await page.getByTestId('cards-customize').click();

  // dash-deck supports widths [1, 2] and starts at 1 in the default layout.
  const handle = page.getByTestId('card-resize-dash-deck');
  await expect(handle).toBeVisible();
  const handleBox = (await handle.boundingBox())!;
  const cardBox = (await page.locator('[data-card-id="dash-deck"]').boundingBox())!;
  const gridBox = (await page.getByTestId('card-grid').boundingBox())!;

  // Mirrors CardGrid's own column-width math: 3 columns at the default
  // 1440px viewport, 12px gap (MASONRY_GAP_PX in useMasonrySpan.ts).
  const cols = 3;
  const gap = 12;
  const colWidth = (gridBox.width - (cols - 1) * gap) / cols;

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  // 1.6 columns past the card's left edge snaps to width 2 (only [1, 2] are
  // supported, so anything past ~1.5 columns lands on 2).
  await page.mouse.move(cardBox.x + colWidth * 1.6, handleBox.y + handleBox.height / 2, { steps: 8 });

  await expect
    .poll(() => page.locator('[data-card-id="dash-deck"]').evaluate(el => (el as HTMLElement).style.gridColumn))
    .toBe('span 2');
  await page.screenshot({ path: '.superpowers/t13-edge-resize-preview.png' });

  await page.mouse.up();
  await page.getByTestId('cards-customize').click(); // Done
  await page.screenshot({ path: '.superpowers/t13-edge-resize-done.png' });

  await page.reload();
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await expect
    .poll(() => page.locator('[data-card-id="dash-deck"]').evaluate(el => (el as HTMLElement).style.gridColumn))
    .toBe('span 2');

  // Reset-hygiene: this suite shares one admin account across every spec
  // file — restore the four defaults so later tests aren't poisoned.
  await page.getByTestId('cards-customize').click();
  await page.getByTestId('cards-reset').click();
  await page.getByTestId('cards-customize').click();
});

test('keyboard arrows on the resize handle step through supported widths', async ({ authedPage: page }) => {
  await page.goto('/dashboard');
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await page.getByTestId('cards-customize').click();

  const handle = page.getByTestId('card-resize-dash-deck');
  await expect(handle).toHaveAttribute('aria-valuenow', '1');

  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '2');
  await expect
    .poll(() => page.locator('[data-card-id="dash-deck"]').evaluate(el => (el as HTMLElement).style.gridColumn))
    .toBe('span 2');

  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '1');

  await page.getByTestId('cards-customize').click(); // Done — already back at the default width.
});
