import { test, expect, login, seedProjectWithCompareRevisions } from './fixtures/test';
import type { Page } from '@playwright/test';

// Revision compare: full-size sheets, automatic alignment, a coloured
// difference view, takeoffs on changed linework, the ways in (pages list,
// drawing screen, read-only banner), and fixing a wrong sheet match.
//
// The seed's Rev 2 is Rev 1 reprinted 15 pt right / 10 pt lower (30 / 20 sheet
// units), with one wall removed and one added.

/** Counts red (removed) and blue (added) pixels in the difference image. */
async function diffColours(page: Page) {
  return page.locator('[data-testid="compare-diff-image"] canvas').evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let red = 0, blue = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 220 && d[i + 1] === 38 && d[i + 2] === 38) red++;
      else if (d[i] === 37 && d[i + 1] === 99 && d[i + 2] === 235) blue++;
    }
    return { red, blue, area: c.width * c.height };
  });
}

test.describe('Revision compare', () => {
  test('shows full-size sheets lined up, with changes in colour and affected takeoffs', async ({ authedPage: page, request }) => {
    test.setTimeout(90_000);
    const { token } = await login(request);
    const seed = await seedProjectWithCompareRevisions(request, token);

    await page.goto(`/project/${seed.projectId}/takeoff`);
    await page.getByText('Current · Rev 2').first().click();
    await page.getByTestId('revisions-compare').click();
    const dialog = page.getByTestId('compare-dialog');
    await expect(dialog).toBeVisible();

    // Pickers name the revision and its set; older on the left by default.
    await expect(page.getByTestId('compare-left-select').locator('option:checked')).toHaveText(/Rev 1 · Bid set · 2026-01-01/);
    await expect(page.getByTestId('compare-right-select').locator('option:checked')).toHaveText(/Rev 2 · Addendum 1 · 2026-02-01 .*\(current\)/);

    // Lined up automatically, by the amount the drawing moved.
    const status = page.getByTestId('compare-align-status');
    await expect(status).toHaveAttribute('data-state', 'auto', { timeout: 30_000 });
    expect(Math.abs(Number(await status.getAttribute('data-dx')) + seed.shift.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(Number(await status.getAttribute('data-dy')) + seed.shift.y)).toBeLessThanOrEqual(3);

    // Full-size sheets, not the 400 px preview.
    const leftWidth = await page.locator('[data-testid="compare-left-image"] canvas').evaluate((c: HTMLCanvasElement) => c.width);
    expect(leftWidth).toBeGreaterThan(2000);
    await page.screenshot({ path: 'test-results/compare-overlay.png' });

    // Difference: the removed wall in red, the added wall in blue, and little else.
    await page.getByTestId('compare-mode-difference').click();
    await expect(page.locator('[data-testid="compare-diff-image"] canvas')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('compare-legend')).toContainText('Only on Rev 1');
    const colours = await diffColours(page);
    expect(colours.red).toBeGreaterThan(200);
    expect(colours.blue).toBeGreaterThan(200);
    // Everything else moved with the sheet, so once lined up only the two
    // walls and the REV number differ: a sliver of the sheet.
    expect(colours.red + colours.blue).toBeLessThan(colours.area * 0.003);
    await page.screenshot({ path: 'test-results/compare-difference.png' });

    // Takeoffs: the run over the new wall is flagged; the one along an unchanged wall isn't.
    await page.getByTestId('compare-takeoffs-toggle').click();
    const flagged = page.getByTestId('compare-flagged');
    await expect(flagged).toContainText('1 takeoff on Rev 2 sits on changed linework', { timeout: 20_000 });
    await expect(page.getByTestId('compare-flagged-item')).toHaveText(/New wall run/);
    await page.getByTestId('compare-flagged-item').click();
    await expect(page.getByTestId('compare-zoom')).not.toHaveText('100%');
    await page.screenshot({ path: 'test-results/compare-flagged.png' });

    // Side by side pans and zooms together.
    await page.getByTestId('compare-mode-side').click();
    await expect(page.getByTestId('compare-pane-left')).toBeVisible();
    await expect(page.getByTestId('compare-pane-right')).toBeVisible();

    // Swap, and picking the same revision on both sides swaps instead.
    await page.getByTestId('compare-swap').click();
    await expect(page.getByTestId('compare-left-select').locator('option:checked')).toHaveText(/Rev 2/);
    await page.getByTestId('compare-right-select').selectOption({ label: await page.getByTestId('compare-left-select').locator('option:checked').innerText() });
    await expect(page.getByTestId('compare-left-select').locator('option:checked')).toHaveText(/Rev 1/);
    await expect(page.getByTestId('compare-right-select').locator('option:checked')).toHaveText(/Rev 2/);

    // Nudging by hand is remembered as a manual alignment.
    await page.getByTestId('compare-align-toggle').click();
    await expect(page.getByTestId('compare-align-panel')).toBeVisible();
    await page.getByTestId('compare-nudge-right').click();
    await expect(status).toHaveAttribute('data-state', 'manual');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('opens from the drawing screen and from the read-only banner', async ({ authedPage: page, request }) => {
    const { token } = await login(request);
    const seed = await seedProjectWithCompareRevisions(request, token);

    await page.goto(`/project/${seed.projectId}/page/${seed.newPageId}`);
    await page.getByTestId('canvas-compare-revisions').click();
    await expect(page.getByTestId('compare-dialog')).toBeVisible();
    await expect(page.getByTestId('compare-right-select').locator('option:checked')).toHaveText(/Rev 2/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('compare-dialog')).toBeHidden();

    await page.goto(`/project/${seed.projectId}/page/${seed.oldPageId}`);
    await expect(page.getByTestId('canvas-superseded-banner')).toBeVisible();
    await page.getByTestId('banner-compare-revisions').click();
    await expect(page.getByTestId('compare-left-select').locator('option:checked')).toHaveText(/Rev 1/);
    await expect(page.getByTestId('compare-right-select').locator('option:checked')).toHaveText(/Rev 2/);
  });

  test('a page matched to the wrong sheet can be split off and joined to the right one', async ({ authedPage: page, request }) => {
    const { token } = await login(request);
    const seed = await seedProjectWithCompareRevisions(request, token);
    const sheetIds = async () => {
      const res = await request.get(`/api/projects/${seed.projectId}`, { headers: { Authorization: `Bearer ${token}` } });
      const proj = await res.json();
      return Object.fromEntries(proj.pages.map((p: any) => [p.id, { sheetId: p.sheetId, count: p.measurements.length }]));
    };

    await page.goto(`/project/${seed.projectId}/takeoff`);
    await page.getByText('Current · Rev 2').first().click();
    // Rev 2 is the first (newest) row.
    await page.getByTestId('revision-row').first().getByTestId('revision-wrong-sheet').click();
    await page.getByTestId('move-sheet-select').selectOption({ label: 'Its own sheet (not a revision of this one)' });
    await page.getByTestId('move-sheet-confirm').click();
    await expect.poll(async () => {
      const s = await sheetIds();
      return s[seed.newPageId].sheetId !== s[seed.oldPageId].sheetId;
    }).toBe(true);
    // Its takeoffs stay with it.
    expect((await sheetIds())[seed.newPageId].count).toBe(2);

    // Now tie it to A-301 instead (a newer revision of it), copying A-301's (no) takeoffs.
    await page.keyboard.press('Escape');
    await page.goto(`/project/${seed.projectId}/takeoff`);
    await page.getByTestId('page-revisions-button').first().waitFor();
    // Open Revisions from Rev 2's card (the page carrying the two takeoffs).
    await page.locator('a', { hasText: '2 highlights' }).getByTestId('page-revisions-button').click();
    await expect(page.getByRole('dialog', { name: 'Revision history' })).toContainText('Addendum 1');
    await page.getByTestId('revision-wrong-sheet').first().click();
    await page.getByTestId('move-sheet-select').selectOption({ label: 'A revision of A-301 — Floor plan' });
    await expect(page.getByTestId('move-sheet-replace')).toBeVisible();
    await page.getByTestId('move-sheet-replace').check();
    await page.getByTestId('move-sheet-confirm').click();
    await expect.poll(async () => {
      const s = await sheetIds();
      return s[seed.newPageId].sheetId === s[seed.otherPageId].sheetId && s[seed.newPageId].count === 0;
    }).toBe(true);
  });
});
