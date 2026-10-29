import { test, expect } from './fixtures/test';
import type { Page } from '@playwright/test';

// The Sketch tool (stage 1): the sidebar link, a new sketch filed in
// Documents, a rectangle drawn with typed sizes on the Front plane, pulled
// into a solid by OpenCascade, saved as a new version and reopened.

async function viewBox(page: Page) {
  const box = await page.getByTestId('sketch-view').boundingBox();
  if (!box) throw new Error('sketch view has no box');
  return box;
}

test('Sketch: draw a rectangle with typed sizes, pull it into 3D, save and reopen', async ({ authedPage: page, apiToken, request }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };

  // The sidebar's Sketch link sits right below Document Editor.
  await page.goto('/dashboard');
  const editorLink = await page.getByRole('button', { name: 'Document Editor', exact: true }).boundingBox();
  const sketchButton = page.getByRole('button', { name: 'Sketch', exact: true });
  const sketchLink = await sketchButton.boundingBox();
  expect(sketchLink!.x).toBeCloseTo(editorLink!.x, 0);
  expect(sketchLink!.y).toBeGreaterThan(editorLink!.y);
  expect(sketchLink!.y - editorLink!.y).toBeLessThan(editorLink!.height * 1.6);
  await sketchButton.click();
  await expect(page).toHaveURL(/\/tools\/sketch$/);

  await page.getByTestId('sketch-new').click();
  await page.getByLabel('Name').fill('Cornice test');
  await page.getByTestId('new-sketch-create').click();
  await expect(page).toHaveURL(/\/tools\/sketch\?fileId=/);
  const fileId = new URL(page.url()).searchParams.get('fileId')!;
  await expect(page.getByTestId('sketch-title')).toHaveText('Cornice test');
  // It opens looking straight at the Front plane, ready to draw on.
  await expect(page.getByTestId('sketch-view-front')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('sketch-plane-front')).toHaveAttribute('aria-pressed', 'true');

  // Rectangle on the Front plane: one corner by clicking, the size typed.
  await page.getByTestId('sketch-plane-front').click();
  await page.getByTestId('sketch-tool-rect').click();
  const box = await viewBox(page);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await page.mouse.move(cx + 80, cy - 40);
  await page.getByTestId('sketch-typed-0').fill(`2'`);
  await page.getByTestId('sketch-typed-1').fill('3 1/2');
  await page.getByTestId('sketch-typed-1').press('Enter');
  await expect(page.locator('.sketch-label-dim', { hasText: `2' - 0"` }).first()).toBeVisible();
  await expect(page.locator('.sketch-label-dim', { hasText: `3 1/2"` }).first()).toBeVisible();

  // Pull it: pick the shape, type the distance.
  await page.getByTestId('sketch-tool-pull').click();
  await page.mouse.move(cx + 10, cy - 3);
  await page.mouse.click(cx + 10, cy - 3);
  await expect(page.getByTestId('sketch-typed-0')).toBeVisible();
  await page.getByTestId('sketch-typed-0').fill('6');
  await page.getByTestId('sketch-typed-0').press('Enter');
  // OpenCascade builds the solid; its pull is labelled.
  await expect(page.locator('.sketch-label-pull', { hasText: '6"' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/could not/)).toHaveCount(0);

  // Save makes version 2 of the file.
  await page.getByTestId('sketch-save').click();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  const versions = await (await request.get(`/api/files/${fileId}/versions`, { headers: auth })).json();
  expect(versions).toHaveLength(2);
  const saved = JSON.parse(await (await request.get(`/api/files/${fileId}/content`, { headers: auth })).text());
  expect(saved.shapes).toHaveLength(1);
  expect(saved.shapes[0]).toMatchObject({ plane: 'front', closed: true });
  expect(saved.features).toEqual([expect.objectContaining({ type: 'pull', distance: expect.any(Number) })]);
  expect(Math.abs(saved.features[0].distance)).toBeCloseTo(152.4, 3);

  // Reopened, it is all there.
  await page.reload();
  await expect(page.locator('.sketch-label-pull', { hasText: '6"' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.sketch-label-dim', { hasText: `2' - 0"` }).first()).toBeVisible();

  // Documents lists it as a Sketch that opens in the sketch editor.
  const docs = await (await request.get('/api/documents?kinds=sketch', { headers: auth })).json();
  expect(docs.rows.map((r: { id: string }) => r.id)).toContain(fileId);
});

test('Sketch: Backspace steps back after typed lengths; draw on a face and cut into the solid; perspective', async ({ authedPage: page, apiToken, request }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  await page.goto('/tools/sketch?new=1');
  await page.getByLabel('Name').fill('Face test');
  await page.getByTestId('new-sketch-create').click();
  await expect(page).toHaveURL(/\/tools\/sketch\?fileId=/);
  const fileId = new URL(page.url()).searchParams.get('fileId')!;
  await expect(page.getByTestId('sketch-view-front')).toHaveAttribute('aria-pressed', 'true');

  const box = await viewBox(page);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const typeLine = async (length: string, angle: string, toward: [number, number]) => {
    // The angle is measured from level, toward the side the pointer is on.
    await page.mouse.move(cx + toward[0], cy + toward[1]);
    await page.getByTestId('sketch-typed-0').fill(length);
    await page.getByTestId('sketch-typed-1').fill(angle);
    await page.getByTestId('sketch-typed-1').press('Enter');
  };

  // A 6" × 4" outline with typed sides; one wrong side taken back with Backspace.
  await page.getByTestId('sketch-tool-line').click();
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await typeLine('6', '0', [300, 0]);
  await typeLine('3', '90', [150, -250]);
  // The size boxes stay focused, now empty: Backspace takes the 3" side back.
  await expect(page.getByTestId('sketch-typed-1')).toBeFocused();
  await page.getByTestId('sketch-typed-1').press('Backspace');
  await typeLine('4', '90', [150, -250]);
  await typeLine('6', '0', [-300, -150]);
  await typeLine('4', '90', [-100, 180]); // down, back to the start: closes it
  await expect(page.getByTestId('sketch-vcb')).toContainText('Click to start');

  // Pull it out 12".
  await page.getByTestId('sketch-tool-pull').click();
  await page.mouse.move(cx + 40, cy - 30);
  await page.mouse.click(cx + 40, cy - 30);
  await page.getByTestId('sketch-typed-0').fill('12');
  await page.getByTestId('sketch-typed-0').press('Enter');
  await expect(page.locator('.sketch-label-pull', { hasText: `1' - 0"` })).toBeVisible({ timeout: 60_000 });

  // Draw on its near end: from Front, Face, then click the face.
  await page.getByTestId('sketch-view-front').click();
  await expect(page.getByTestId('sketch-plane-face')).toBeEnabled();
  await page.getByTestId('sketch-plane-face').click();
  await expect(page.getByTestId('sketch-vcb')).toContainText('Click a flat face');
  await page.mouse.click(cx + 40, cy - 30);
  await expect(page.getByTestId('sketch-plane-face')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('sketch-tool-line')).toHaveAttribute('aria-pressed', 'true');

  // A 2" × 1" rectangle on the face, pulled in 1": a cut.
  await page.getByTestId('sketch-tool-rect').click();
  await page.mouse.move(cx + 30, cy - 20);
  await page.mouse.click(cx + 30, cy - 20);
  await page.mouse.move(cx + 90, cy - 60);
  await page.getByTestId('sketch-typed-0').fill('2');
  await page.getByTestId('sketch-typed-1').fill('1');
  await page.getByTestId('sketch-typed-1').press('Enter');
  await page.getByTestId('sketch-tool-pull').click();
  await page.mouse.move(cx + 40, cy - 25);
  await page.mouse.click(cx + 40, cy - 25);
  await page.getByTestId('sketch-typed-0').fill('-1');
  await page.getByTestId('sketch-typed-0').press('Enter');
  await expect(page.locator('.sketch-label-cut', { hasText: 'Cut 1"' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/could not/)).toHaveCount(0);

  // Perspective for the 3D view, and back.
  await page.getByTestId('sketch-perspective').click();
  await expect(page.getByTestId('sketch-perspective')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('sketch-view-iso')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sketch-label-cut', { hasText: 'Cut 1"' })).toBeVisible();
  await page.getByTestId('sketch-perspective').click();
  await expect(page.getByTestId('sketch-perspective')).toHaveAttribute('aria-pressed', 'false');

  await page.getByTestId('sketch-save').click();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  const saved = JSON.parse(await (await request.get(`/api/files/${fileId}/content`, { headers: auth })).text());
  const [outline, slot] = saved.shapes;
  // The outline: 6" right, 4" up, 6" left, 4" down (the 3" side was taken back).
  const inch = 25.4;
  const rel = outline.segments.map((g: { to: { x: number; y: number } }) => [Math.round((g.to.x - outline.start.x) / inch), Math.round((g.to.y - outline.start.y) / inch)]);
  expect(rel).toEqual([[6, 0], [6, 4], [0, 4], [0, 0]]);
  expect(outline.closed).toBe(true);
  // The slot sits on the block's end nearest the Front view (facing you) and cuts 1" in.
  // (A typed pull goes the way the pointer was pulling: toward you or away.)
  expect(Math.abs(saved.features[0].distance)).toBeCloseTo(12 * inch, 3);
  expect(slot.plane.normal).toEqual([0, -1, 0]);
  expect(slot.plane.origin[1]).toBeCloseTo(Math.min(0, -saved.features[0].distance), 3);
  expect(slot.onFeatureId).toBe(saved.features[0].id);
  expect(saved.features[1].distance).toBeCloseTo(-inch, 3);
});

test('Sketch: spin a profile round a line, run a profile along a path, and change and delete steps in the list', async ({ authedPage: page, apiToken, request }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  await page.goto('/tools/sketch?new=1');
  await page.getByLabel('Name').fill('Spin and run');
  await page.getByTestId('new-sketch-create').click();
  await expect(page).toHaveURL(/\/tools\/sketch\?fileId=/);
  const fileId = new URL(page.url()).searchParams.get('fileId')!;
  const box = await viewBox(page);
  const cx = box.x + box.width / 2 - 100, cy = box.y + box.height / 2 + 120;

  // A 1" × 6" upright rectangle on Front, spun round its left edge.
  await page.getByTestId('sketch-tool-rect').click();
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await page.mouse.move(cx + 60, cy - 60);
  await page.getByTestId('sketch-typed-0').fill('1');
  await page.getByTestId('sketch-typed-1').fill('6');
  await page.getByTestId('sketch-typed-1').press('Enter');
  await page.getByTestId('sketch-tool-spin').click();
  await page.mouse.click(cx + 12, cy - 40);
  await expect(page.getByTestId('sketch-vcb')).toContainText('first point of the line');
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await page.mouse.move(cx, cy - 120);
  await page.mouse.click(cx, cy - 120);
  await expect(page.locator('.sketch-label-pull', { hasText: '⟳ 360°' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/could not/)).toHaveCount(0);

  // The step list shows it; a quarter turn instead.
  const steps = page.getByTestId('sketch-steps');
  await expect(steps).toBeVisible();
  await expect(page.getByTestId('sketch-step-0')).toContainText('Spin 360°');
  await expect(page.getByTestId('sketch-step-0')).toContainText('Rectangle 1" × 6"');
  await page.getByTestId('sketch-step-0').getByRole('button').first().click();
  await page.getByTestId('sketch-step-value').fill('90');
  await page.getByTestId('sketch-step-value').press('Enter');
  await expect(page.locator('.sketch-label-pull', { hasText: '⟳ 90°' })).toBeVisible({ timeout: 60_000 });

  // A path on Front: up 24", then right 12". A 2" square profile on Ground, across its start.
  await page.getByTestId('sketch-view-front').click();
  await page.getByTestId('sketch-plane-front').click();
  await page.getByTestId('sketch-tool-line').click();
  const px = cx + 250;
  await page.mouse.move(px, cy);
  await page.mouse.click(px, cy);
  for (const [len, ang, toward] of [['24', '90', [px - cx, -200]], ['12', '0', [px - cx + 200, -100]]] as const) {
    await page.mouse.move(cx + toward[0], cy + toward[1]);
    await page.getByTestId('sketch-typed-0').fill(len);
    await page.getByTestId('sketch-typed-1').fill(ang);
    await page.getByTestId('sketch-typed-1').press('Enter');
  }
  await page.keyboard.press('Escape'); // leave the size box
  await page.mouse.move(px + 300, cy - 300);
  await page.keyboard.press('Enter'); // keep it as an open path
  await page.getByTestId('sketch-plane-ground').click();
  await page.getByTestId('sketch-tool-rect').click();
  await expect(page.getByTestId('sketch-view-top')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(px, cy);
  await page.mouse.click(px, cy);
  await page.mouse.move(px + 60, cy - 60);
  await page.getByTestId('sketch-typed-0').fill('2');
  await page.getByTestId('sketch-typed-1').fill('2');
  await page.getByTestId('sketch-typed-1').press('Enter');

  // Run: the profile (seen from the top), then the path (seen from the front).
  await page.getByTestId('sketch-tool-run').click();
  await page.mouse.click(px + 15, cy - 15);
  await expect(page.getByTestId('sketch-vcb')).toContainText('click the path');
  await page.getByTestId('sketch-view-front').click();
  await page.mouse.click(px, cy - 80);
  await expect(page.getByTestId('sketch-step-1')).toContainText('Run along a path');
  await expect(page.getByTestId('sketch-step-1')).toContainText('Rectangle 2" × 2"');
  await expect(page.locator('.sketch-label-pull', { hasText: '⟳ 90°' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/could not/)).toHaveCount(0);

  await page.getByTestId('sketch-save').click();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  let saved = JSON.parse(await (await request.get(`/api/files/${fileId}/content`, { headers: auth })).text());
  expect(saved.features.map((f: { type: string }) => f.type)).toEqual(['spin', 'run']);
  expect(saved.features[0].angle).toBe(90);

  // Deleting the run in the list leaves its profile and path as outlines.
  await page.getByTestId('sketch-step-1').getByTestId('sketch-step-delete').click();
  await expect(page.getByTestId('sketch-step-1')).toHaveCount(0);
  await page.getByTestId('sketch-save').click();
  await expect(page.getByText('Saved as version 3')).toBeVisible();
  saved = JSON.parse(await (await request.get(`/api/files/${fileId}/content`, { headers: auth })).text());
  expect(saved.features.map((f: { type: string }) => f.type)).toEqual(['spin']);
  expect(saved.shapes).toHaveLength(3);
});
