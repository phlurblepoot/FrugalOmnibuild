import { test, expect, seedCustomerWithPortfolio } from './fixtures/test';

test('soft-zoom hover never overlaps the sidebar', async ({ authedPage: page }) => {
  await page.goto('/dashboard');
  // Any .soft-zoom element will do once cards adopt it; Wave 1 asserts the law on the presence button:
  const el = page.getByTestId('sidebar-presence');
  const before = await el.boundingBox();
  await el.hover();
  await page.waitForTimeout(400);
  const after = await el.boundingBox();
  expect(after!.width - before!.width).toBeLessThan(11); // < grid gap: the law holds
});

// Wave 2 Task 13: the law (CardShell's .soft-zoom, scale derived from
// rendered width per src/hooks/useSoftZoom.ts) must hold uniformly across
// every card width the grid supports, not just the single element Wave 1
// checked above — a small card's growth must still clear >0 (soft-zoom is
// actually attached) while staying <11px (the grid gap), the same as a
// full-width one.
test('soft-zoom hover law holds at 1-wide, 2-wide, and 3-wide card sizes', async ({ authedPage: page, request, apiToken }) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);

  const measure = async (locator: ReturnType<typeof page.locator>) => {
    await page.mouse.move(0, 0);
    const before = await locator.boundingBox();
    await locator.hover();
    await page.waitForTimeout(400);
    const after = await locator.boundingBox();
    const growth = after!.width - before!.width;
    expect(growth).toBeGreaterThan(0); // soft-zoom is actually attached
    expect(growth).toBeLessThan(11); // and never crosses the grid gap
  };

  await page.goto('/dashboard');
  await expect(page.getByTestId('card-grid')).toBeVisible();
  // dash-deck: 1-wide (only supports widths [1,2], default 1).
  await measure(page.locator('[data-card-id="dash-deck"] section.soft-zoom'));
  // dash-attention: 2-wide default.
  await measure(page.locator('[data-card-id="dash-attention"] section.soft-zoom'));

  // pj-financial-band: admin-only, default width 3 (full row at the 3-col
  // grid this default 1440x900 viewport resolves to).
  await page.goto(`/project/${seeded.inProgressProjectId}`);
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await measure(page.locator('[data-card-id="pj-financial-band"] section.soft-zoom'));
});
