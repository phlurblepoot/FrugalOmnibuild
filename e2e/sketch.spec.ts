import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/test';
import type { Page } from '@playwright/test';

const TEST_PNG = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'assets', 'test-page.png');

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

test('Sketch: join two solids, copy along, mirror and rotate, then delete a step', async ({ authedPage: page, apiToken, request }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  await page.goto('/tools/sketch?new=1');
  await page.getByLabel('Name').fill('Solids');
  await page.getByTestId('new-sketch-create').click();
  await expect(page).toHaveURL(/\/tools\/sketch\?fileId=/);
  const fileId = new URL(page.url()).searchParams.get('fileId')!;
  const box = await viewBox(page);
  const cx = box.x + box.width / 2 - 150, cy = box.y + box.height / 2 + 60;
  const rect = async (x: number, y: number, w: string, h: string) => {
    await page.getByTestId('sketch-tool-rect').click();
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
    await page.mouse.move(x + 60, y - 60);
    await page.getByTestId('sketch-typed-0').fill(w);
    await page.getByTestId('sketch-typed-1').fill(h);
    await page.getByTestId('sketch-typed-1').press('Enter');
  };
  const pull = async (x: number, y: number, d: string) => {
    await page.getByTestId('sketch-view-front').click();
    await page.getByTestId('sketch-tool-pull').click();
    await page.mouse.click(x, y);
    await page.getByTestId('sketch-typed-0').fill(d);
    await page.getByTestId('sketch-typed-0').press('Enter');
  };

  // Two overlapping blocks, A (4" × 2") and B (2" × 4"), pulled into solids.
  await rect(cx, cy, '4', '2');
  await rect(cx + 100, cy, '2', '4');
  await pull(cx + 40, cy - 30, '2');
  await pull(cx + 150, cy - 100, '3');
  await expect(page.getByTestId('sketch-step-1')).toContainText('Pull 3"');

  // Join them (seen from the front).
  await page.getByTestId('sketch-view-front').click();
  await page.getByTestId('sketch-tool-combine').click();
  await expect(page.getByTestId('sketch-combine-join')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(cx + 40, cy - 30);
  await expect(page.getByTestId('sketch-vcb')).toContainText('click the solid to join');
  await page.mouse.click(cx + 150, cy - 100);
  await expect(page.getByTestId('sketch-step-2')).toContainText('Join two solids');

  // Two copies, 6" apart to the right.
  await page.getByTestId('sketch-tool-move').click();
  await page.getByTestId('sketch-copies').fill('2');
  await page.mouse.click(cx + 40, cy - 30);
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await page.mouse.move(cx + 250, cy - 10);
  await page.getByTestId('sketch-typed-0').fill('6');
  await page.getByTestId('sketch-typed-1').fill('0');
  await page.getByTestId('sketch-typed-1').press('Enter');
  await expect(page.getByTestId('sketch-step-3')).toContainText('Copy ×2, 6" apart');

  // A mirrored copy across a plumb line to the left.
  await page.getByTestId('sketch-tool-mirror').click();
  await expect(page.getByTestId('sketch-mirror-keep')).toBeChecked();
  await page.mouse.click(cx + 40, cy - 30);
  await page.mouse.move(cx - 60, cy);
  await page.mouse.click(cx - 60, cy);
  await page.mouse.move(cx - 60, cy - 120);
  await page.mouse.click(cx - 60, cy - 120);
  await expect(page.getByTestId('sketch-step-4')).toContainText('Mirror copy');

  // The original turned a quarter round its corner.
  await page.getByTestId('sketch-tool-rotate').click();
  await page.getByTestId('sketch-copies').fill('0');
  await page.mouse.click(cx + 40, cy - 30);
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await page.getByTestId('sketch-typed-0').fill('90');
  await page.getByTestId('sketch-typed-0').press('Enter');
  await expect(page.getByTestId('sketch-step-5')).toContainText('Rotate 90°');
  await expect(page.getByText(/could not/)).toHaveCount(0);

  await page.getByTestId('sketch-save').click();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  const saved = JSON.parse(await (await request.get(`/api/files/${fileId}/content`, { headers: auth })).text());
  expect(saved.features.map((f: { type: string }) => f.type)).toEqual(['pull', 'pull', 'combine', 'move', 'move', 'move']);
  expect(saved.features[3]).toMatchObject({ copies: 2, transform: { kind: 'move' } });
  expect(Math.hypot(...saved.features[3].transform.by)).toBeCloseTo(6 * 25.4, 3);
  expect(saved.features[4]).toMatchObject({ copies: 1, transform: { kind: 'mirror' } });
  expect(saved.features[5]).toMatchObject({ copies: 0, transform: { kind: 'rotate', angle: 90 } });

  // The copies' step, picked in the list, can have its count changed, then be deleted with the Delete key.
  await page.getByTestId('sketch-step-3').getByRole('button').first().click();
  await page.getByTestId('sketch-step-copies').fill('3');
  await page.getByTestId('sketch-step-copies').press('Enter');
  await expect(page.getByTestId('sketch-step-3')).toContainText('Copy ×3, 6" apart');
  // (Delete in the box edits the box; out of it, it deletes the picked step.)
  await page.getByTestId('sketch-step-copies').evaluate(el => (el as HTMLElement).blur());
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('sketch-step-5')).toHaveCount(0);
  await expect(page.getByTestId('sketch-step-3')).toContainText('Mirror');
});

test('Sketch: reference photos are laid on the plane, scaled from a known length, faded, turned, moved, hidden and taken off', async ({ authedPage: page, apiToken, request }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const png = readFileSync(TEST_PNG);
  await page.goto('/tools/sketch?new=1');
  await page.getByLabel('Name').fill('Traced detail');
  await page.getByTestId('new-sketch-create').click();
  await expect(page).toHaveURL(/\/tools\/sketch\?fileId=/);
  const fileId = new URL(page.url()).searchParams.get('fileId')!;
  const box = await viewBox(page);
  const cx = box.x + box.width / 2 - 150, cy = box.y + box.height / 2;

  // Two photos (the second must not replace the first).
  for (const name of ['old-drawing.png', 'print-snippet.png']) {
    await page.getByTestId('sketch-add-photo').click();
    await expect(page.getByTestId('picker-upload-panel')).toBeVisible();
    await page.getByTestId('picker-upload-input').setInputFiles({ name, mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('picker-upload-panel')).toBeHidden({ timeout: 15_000 });
  }
  await expect(page.getByTestId('sketch-ref-0')).toContainText('old-drawing.png');
  await expect(page.getByTestId('sketch-ref-1')).toContainText('print-snippet.png');

  // Scale the second from a length known to be 2' (the two clicks are 200 px apart).
  await page.getByTestId('sketch-ref-scale').click();
  await expect(page.getByTestId('sketch-vcb')).toContainText('Click one end of a length you know');
  await page.mouse.click(cx - 100, cy);
  await page.mouse.click(cx + 100, cy);
  await expect(page.getByTestId('sketch-vcb')).toContainText('How long is that really?');
  await page.getByTestId('sketch-typed-0').fill(`2'`);
  await page.getByTestId('sketch-typed-0').press('Enter');
  await expect(page.getByText(`Scaled: that length is now 2' - 0"`)).toBeVisible();

  // Fade it, turn it a little, and move it 50 px right.
  await page.getByTestId('sketch-ref-opacity').fill('30');
  await page.getByTestId('sketch-ref-opacity').blur();
  await page.getByTestId('sketch-ref-turn').fill('15');
  await page.getByTestId('sketch-ref-turn').press('Enter');
  await page.getByTestId('sketch-ref-move').click();
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx + 50, cy);

  await page.getByTestId('sketch-save').click();
  await expect(page.getByText('Saved as version 2')).toBeVisible();
  let saved = JSON.parse(await (await request.get(`/api/files/${fileId}/content`, { headers: auth })).text());
  expect(saved.refs).toHaveLength(2);
  const [first, second] = saved.refs;
  expect(first.fileId).not.toBe(second.fileId);
  expect(second).toMatchObject({ name: 'print-snippet.png', plane: 'front', opacity: 0.3, rotation: 15 });
  // The 2' was measured across 200 px of the view: the photo grew or shrank to match, and moved right.
  expect(second.width).not.toBeCloseTo(first.width, 0);
  expect(second.center.x).toBeGreaterThan(first.center.x);
  // The pictures are filed in Documents as sketch references.
  const docs = await (await request.get('/api/documents?kinds=sketch-photo', { headers: auth })).json();
  expect(docs.rows.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([first.fileId, second.fileId]));

  // Hide the first, take the second off.
  await page.getByTestId('sketch-ref-0').getByTestId('sketch-ref-visible').click();
  await page.getByTestId('sketch-ref-1').getByTestId('sketch-ref-delete').click();
  await expect(page.getByTestId('sketch-ref-1')).toHaveCount(0);
  await page.getByTestId('sketch-save').click();
  await expect(page.getByText('Saved as version 3')).toBeVisible();
  saved = JSON.parse(await (await request.get(`/api/files/${fileId}/content`, { headers: auth })).text());
  expect(saved.refs).toHaveLength(1);
  expect(saved.refs[0]).toMatchObject({ name: 'old-drawing.png', hidden: true });
});

test('Sketch: arc mode turns itself off after one arc; a drawing sheet exports to Documents and downloads', async ({ authedPage: page, apiToken, request }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  await page.goto('/tools/sketch?new=1');
  await page.getByLabel('Name').fill('Cornice C-3');
  await page.getByTestId('new-sketch-create').click();
  await expect(page).toHaveURL(/\/tools\/sketch\?fileId=/);
  const box = await viewBox(page);
  const cx = box.x + box.width / 2 - 150, cy = box.y + box.height / 2 + 80;
  const typeLine = async (length: string, angle: string, toward: [number, number]) => {
    await page.mouse.move(cx + toward[0], cy + toward[1]);
    await page.getByTestId('sketch-typed-0').fill(length);
    await page.getByTestId('sketch-typed-1').fill(angle);
    await page.getByTestId('sketch-typed-1').press('Enter');
  };

  // A profile: 6" along the bottom, 2" up, an arc up and back, then straight lines home.
  await page.getByTestId('sketch-tool-line').click();
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await typeLine('6', '0', [300, 0]);
  await typeLine('2', '90', [250, -250]);
  await page.getByTestId('sketch-arc').click();
  await expect(page.getByTestId('sketch-arc')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(cx + 150, cy - 140);
  await page.mouse.click(cx + 100, cy - 170);
  await expect(page.getByTestId('sketch-arc')).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.move(cx, cy - 170);
  await page.mouse.click(cx, cy - 170);
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await expect(page.getByTestId('sketch-vcb')).toContainText('Click to start');

  // Pull it out a foot.
  await page.getByTestId('sketch-tool-pull').click();
  await page.mouse.click(cx + 40, cy - 30);
  await page.getByTestId('sketch-typed-0').fill('12');
  await page.getByTestId('sketch-typed-0').press('Enter');
  await expect(page.locator('.sketch-label-pull', { hasText: `1' - 0"` })).toBeVisible({ timeout: 60_000 });

  // Export: Save to Documents, then Download.
  await page.getByTestId('sketch-export').click();
  await expect(page.getByTestId('sketch-export-modal')).toBeVisible();
  await page.getByTestId('sketch-export-notes').fill('Run on site. Check against the existing.');
  await page.getByTestId('sketch-export-save').click();
  await expect(page.getByText('Saved to Documents as "Cornice C-3 - drawing.pdf".')).toBeVisible({ timeout: 60_000 });
  const docs = await (await request.get('/api/documents?kinds=sketch-export', { headers: auth })).json();
  const row = docs.rows.find((r: { name: string }) => r.name === 'Cornice C-3 - drawing.pdf');
  expect(row).toBeTruthy();
  const pdf = await (await request.get(`/api/files/${row.id}/content`, { headers: auth })).text();
  expect(pdf.startsWith('%PDF')).toBe(true);
  for (const s of ['FRONT', 'TOP', 'RIGHT SIDE', '3D VIEW', 'Cornice C-3', 'Run on site.', '6"', '2"']) expect(pdf).toContain(s);

  await page.getByTestId('sketch-export').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('sketch-export-download').click()]);
  expect(download.suggestedFilename()).toBe('Cornice C-3 - drawing.pdf');
});
