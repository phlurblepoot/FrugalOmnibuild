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
