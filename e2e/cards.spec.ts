import { randomUUID } from 'node:crypto';
import { test, expect, loginAsNewUser, seedCustomerWithPortfolio } from './fixtures/test';

// Coverage for the card system (Wave 2 Tasks 3-12): per-user customize/
// persist/reset on the Dashboard grid, responsive column clamping, and the
// customer split view's independent scroll regions. Dashboard layout prefs
// are per-user and server-side, and this suite shares one admin account
// across every spec file (workers=1, sequential) — every test here that
// mutates the admin's `cards-dashboard` layout restores it to the four
// defaults before finishing so later tests/specs never inherit a stale
// customization.

test('customize persists across reload: remove a card, resize another', async ({ authedPage: page }) => {
  await page.goto('/dashboard');
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await expect(page.locator('[data-card-id="dash-activity"]')).toHaveCount(1);

  await page.getByTestId('cards-customize').click();
  // force: true — while editing, a card's whole wrapper runs an infinite
  // wiggle animation (`animate-[card-wiggle_.4s_..._infinite_alternate]`),
  // which never satisfies Playwright's "element is stable" actionability
  // check even though a real pointer click lands on it fine.
  await page.getByRole('button', { name: 'Remove Team activity' }).click({ force: true });
  await page
    .getByRole('group', { name: '📅 On deck width', exact: true })
    .getByRole('button', { name: '2', exact: true })
    .click({ force: true });
  await page.getByTestId('cards-customize').click(); // Done

  await page.reload();
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await expect(page.locator('[data-card-id="dash-activity"]')).toHaveCount(0);
  const deckGridColumn = await page
    .locator('[data-card-id="dash-deck"]')
    .evaluate(el => (el as HTMLElement).style.gridColumn);
  expect(deckGridColumn).toBe('span 2');

  // Reset-hygiene: restore the four defaults so later tests aren't poisoned.
  await page.getByTestId('cards-customize').click();
  await page.getByTestId('cards-reset').click();
  await page.getByTestId('cards-customize').click();
  await expect(page.locator('[data-card-id]')).toHaveCount(4);
});

test('clamps card widths and grid columns at three viewports', async ({ authedPage: page }) => {
  await page.goto('/dashboard');
  await expect(page.getByTestId('card-grid')).toBeVisible();

  // Chromium's CSSOM serializes the inline `minmax(0, 1fr)` track back out
  // as `minmax(0px, 1fr)` (unit-normalizes the 0), so match on the column
  // count via regex rather than the exact string CardGrid.tsx wrote.
  const gridColumns = () =>
    page.getByTestId('card-grid').evaluate(el => (el as HTMLElement).style.gridTemplateColumns);
  const colsCount = (v: string) => Number(/^repeat\((\d+),/.exec(v)?.[1]);

  // 1280px: min-width:1024px query matches, min-width:1600px doesn't -> 3 cols.
  // dash-attention defaults to width 2, which fits under 3 unclamped.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(async () => colsCount(await gridColumns())).toBe(3);
  await expect
    .poll(() => page.locator('[data-card-id="dash-attention"]').evaluate(el => (el as HTMLElement).style.gridColumn))
    .toBe('span 2');

  // 800px: only min-width:640px matches -> 2 cols.
  await page.setViewportSize({ width: 800, height: 900 });
  await expect.poll(async () => colsCount(await gridColumns())).toBe(2);

  // 500px: nothing matches -> 1 col, every card clamped to a full-width span.
  await page.setViewportSize({ width: 500, height: 900 });
  await expect.poll(async () => colsCount(await gridColumns())).toBe(1);

  // Read the grid's own width and every card's width in one synchronous
  // browser round-trip — two separate boundingBox() calls each cost their
  // own async round-trip, and at cols=1 the page can be tall enough to
  // straddle a vertical-scrollbar threshold, so a reflow between two
  // separate calls (e.g. a card finishing its data fetch and growing)
  // could shift the container's own width between the two reads and
  // produce a false mismatch that has nothing to do with card clamping.
  const widths = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="card-grid"]') as HTMLElement;
    const cards = Array.from(document.querySelectorAll('[data-card-id]')) as HTMLElement[];
    return {
      gridWidth: grid.getBoundingClientRect().width,
      cards: cards.map(c => ({ id: c.getAttribute('data-card-id'), width: c.getBoundingClientRect().width })),
    };
  });
  expect(widths.cards.length).toBeGreaterThan(0);
  for (const card of widths.cards) {
    expect(Math.abs(card.width - widths.gridWidth)).toBeLessThan(2);
  }

  await page.setViewportSize({ width: 1440, height: 900 }); // restore the project default
});

test('tray re-add and reset-to-default restore all four cards', async ({ authedPage: page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('cards-customize').click();

  // force: true — see the note in the persistence test above re: the
  // infinite wiggle animation editing mode applies to each card wrapper.
  await page.getByRole('button', { name: 'Remove Team activity' }).click({ force: true });
  await expect(page.locator('[data-card-id="dash-activity"]')).toHaveCount(0);

  await page.getByTestId('cards-tray').getByRole('button', { name: '+ Team activity', exact: true }).click();
  await expect(page.locator('[data-card-id="dash-activity"]')).toHaveCount(1);

  // Remove a second card too, so reset-to-default is proven to restore
  // everything rather than just the one card the tray re-added.
  await page.getByRole('button', { name: 'Remove 📅 On deck' }).click({ force: true });
  await expect(page.locator('[data-card-id="dash-deck"]')).toHaveCount(0);

  await page.getByTestId('cards-reset').click();
  await expect(page.locator('[data-card-id]')).toHaveCount(4);
  for (const id of ['dash-attention', 'dash-deck', 'dash-money', 'dash-activity']) {
    await expect(page.locator(`[data-card-id="${id}"]`)).toHaveCount(1);
  }

  await page.getByTestId('cards-customize').click(); // Done — already at defaults, nothing to clean up.
});

test('customer sidebar scroll is independent of the pane', async ({ authedPage: page, request, apiToken }) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);

  // Seed enough filler customers that the persistent sidebar list actually
  // overflows — otherwise "scrollTop unchanged" would hold trivially.
  for (let i = 0; i < 25; i++) {
    const res = await request.post('/api/customers', {
      headers: { Authorization: `Bearer ${apiToken.token}` },
      data: { name: `E2E Scroll Filler ${i}-${randomUUID().slice(0, 6)}` },
    });
    if (!res.ok()) throw new Error(`filler customer create failed: ${res.status()} ${await res.text()}`);
  }

  await page.goto(`/customers/${seeded.customerId}`);
  const pane = page.getByTestId('customer-pane');
  await expect(pane).toBeVisible();

  const sidebarList = page.getByTestId('customer-sidebar-list');
  await expect(sidebarList).toBeVisible();
  const before = await sidebarList.evaluate(el => el.scrollTop);

  const paneBox = await pane.boundingBox();
  await page.mouse.move(paneBox!.x + paneBox!.width / 2, paneBox!.y + paneBox!.height / 2);
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(200);

  const after = await sidebarList.evaluate(el => el.scrollTop);
  expect(after).toBe(before);
});

test('non-admin dashboard has no Money pulse card or tray entry', async ({ page, request, apiToken }) => {
  const nonAdmin = await loginAsNewUser(request, apiToken.token);
  await page.addInitScript(
    ([token, user]) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
    },
    [nonAdmin.token, JSON.stringify(nonAdmin.user)] as const,
  );

  await page.goto('/dashboard');
  await expect(page.getByTestId('card-grid')).toBeVisible();
  await expect(page.locator('[data-card-id="dash-money"]')).toHaveCount(0);

  await page.getByTestId('cards-customize').click();
  await expect(page.getByTestId('cards-tray').getByRole('button', { name: '+ Money pulse', exact: true })).toHaveCount(0);
  await page.getByTestId('cards-customize').click(); // Done — nothing was mutated.
});
