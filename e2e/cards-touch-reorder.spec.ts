import { test, expect } from './fixtures/test';

// Touch long-press reorder (Wave 3 Task 13, closing spec §5.1 debt). Needs a
// touch-capable browser context — Playwright's high-level `touchscreen` API
// only supports a plain tap, so the long-press-then-drag gesture is driven
// via dispatchEvent with real PointerEvents (pointerType: 'touch', real
// clientX/clientY) on the actual rendered elements; Chromium's own event
// path then carries them through window listeners exactly as a physical
// touchscreen would, and `document.elementFromPoint` does real hit-testing
// against the real layout (unlike the CardGrid.test.tsx unit coverage,
// which has to stub it — jsdom never lays anything out). This is the only
// spec in the suite that needs `hasTouch`, so it's scoped to this file.
test.use({ hasTouch: true });

test('long-press arms move mode (visible lift), drags a card, and drop-before-target persists across reload', async ({ authedPage: page }) => {
  await page.goto('/dashboard');
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await page.getByTestId('cards-customize').click();

  const source = page.locator('[data-card-id="dash-activity"]');
  const target = page.locator('[data-card-id="dash-money"]');
  const srcBox = (await source.boundingBox())!;
  const tgtBox = (await target.boundingBox())!;
  const startX = srcBox.x + srcBox.width / 2;
  const startY = srcBox.y + srcBox.height / 2;
  const endX = tgtBox.x + tgtBox.width / 2;
  const endY = tgtBox.y + tgtBox.height / 2;

  await source.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: startX, clientY: startY, bubbles: true, cancelable: true });

  // Before the long-press threshold, the card hasn't lifted yet.
  await expect(source).not.toHaveClass(/scale-105/);

  // Past ~500ms, move mode arms and the card visibly lifts.
  await page.waitForTimeout(650);
  await expect(source).toHaveClass(/scale-105/);
  await page.screenshot({ path: '.superpowers/t13-touch-reorder-armed.png' });

  // Walk the pointer toward the target in a few steps so intermediate
  // elementFromPoint reads pass over real cards, then drop.
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const x = startX + ((endX - startX) * i) / steps;
    const y = startY + ((endY - startY) * i) / steps;
    await page.locator('body').dispatchEvent('pointermove', { pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true });
  }
  await page.locator('body').dispatchEvent('pointerup', { pointerType: 'touch', clientX: endX, clientY: endY, bubbles: true, cancelable: true });

  // The lift class is gone once the gesture ends.
  await expect(source).not.toHaveClass(/scale-105/);

  const order = () =>
    page.evaluate(() => Array.from(document.querySelectorAll('[data-card-id]')).map(el => el.getAttribute('data-card-id')));

  await expect.poll(async () => {
    const o = await order();
    return o.indexOf('dash-activity') === o.indexOf('dash-money') - 1;
  }).toBe(true);

  await page.getByTestId('cards-customize').click(); // Done
  await page.screenshot({ path: '.superpowers/t13-touch-reorder-dropped.png' });

  await page.reload();
  await expect(page.getByTestId('card-grid')).toBeVisible();
  const afterReload = await order();
  expect(afterReload.indexOf('dash-activity')).toBe(afterReload.indexOf('dash-money') - 1);

  // Reset-hygiene: this suite shares one admin account across every spec
  // file — restore the four defaults so later tests aren't poisoned.
  await page.getByTestId('cards-customize').click();
  await page.getByTestId('cards-reset').click();
  await page.getByTestId('cards-customize').click();
  await expect(page.locator('[data-card-id]')).toHaveCount(4);
});

test('touch-action:none is already in force on a card the instant edit mode is entered, before any long-press arms', async ({ authedPage: page }) => {
  // Fix wave I1: touch-action is honored by the browser from touchSTART, so
  // setting it only once a gesture "arms" (500ms into a press) is too late —
  // the native scroll arbiter has already claimed the touch by then. This
  // can't fully prove the real-device behavior (Playwright's synthetic
  // dispatchEvent('pointerdown', ...) above doesn't route through the
  // compositor's touch-action gate the way a physical touch does — that's
  // why the reorder tests above work even against the old, latent bug), but
  // it does prove our half of the contract: the style is present on the
  // wrapper from render, not gated behind `armed`. Real-device confirmation
  // lands in the owner's phone smoke.
  await page.goto('/dashboard');
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await page.getByTestId('cards-customize').click();

  const source = page.locator('[data-card-id="dash-activity"]');
  await expect(source).toHaveCSS('touch-action', 'none');

  await page.getByTestId('cards-customize').click(); // Done
  await expect(source).not.toHaveCSS('touch-action', 'none');
});

test('a move past tolerance before the long-press fires is treated as a scroll, not a reorder', async ({ authedPage: page }) => {
  await page.goto('/dashboard');
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await page.getByTestId('cards-customize').click();

  const source = page.locator('[data-card-id="dash-activity"]');
  const box = (await source.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await source.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true });
  await page.locator('body').dispatchEvent('pointermove', { pointerType: 'touch', clientX: x + 60, clientY: y, bubbles: true, cancelable: true });
  await page.waitForTimeout(650);

  await expect(source).not.toHaveClass(/scale-105/);
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('[data-card-id]')).map(el => el.getAttribute('data-card-id')));
  expect(order).toEqual(['dash-attention', 'dash-deck', 'dash-money', 'dash-activity']);

  await page.getByTestId('cards-customize').click(); // Done — nothing was mutated.
});
