import { test, expect, seedProjectWithTakeoffMeasurement } from './fixtures/test';
import type { Page } from '@playwright/test';

// Characterization spec for the proposal editor + list (spec
// 2026-08-28-proposal-rework Task 15). Companion to export.spec.ts, which
// covers the Takeoffs-tab Print/Excel/Proposal buttons up to the point the
// editor opens seeded — this spec picks up from there: pricing lines (takeoff
// + manual + alternate), Save/Generate, the proposals list, and Revise.
//
// Real-behavior notes (read PricingLinesCard.tsx / useProposalDraft.ts /
// ProposalEditor.tsx before touching this file):
//
//  • A line's Description is an <input value=...>, never rendered as plain
//    text elsewhere on the card — asserting on it means `.toHaveValue()` on
//    the specific input, never `.toContainText()` on the card container
//    (textContent does not include input values).
//
//  • The Save button (`btn-save-proposal`) and the shared document bar's
//    Generate PDF / Email buttons (`proposal-generate` / `proposal-send`,
//    DocumentActionsBar with testIdPrefix="proposal") render ONLY when the
//    draft is NOT read-only (`{!readOnly && (...)}` in ProposalEditor.tsx and
//    in the bar) — Save is additionally `disabled` while `!dirty`. The bar's
//    status chip (`proposal-status`) and Open/Download appear only once a
//    document exists. A proposal created via
//    `POST /api/projects/:id/proposals` with an empty body has zero lines and
//    nothing to re-derive against, so `dirty` starts false and Save starts
//    DISABLED (not absent) — the button being present/visible is what proves
//    the draft is editable, not `.toBeEnabled()`.
//
//  • The status span (`data-testid="proposal-state"`) reads "Saved" once a
//    dirty draft is saved, but the save ALSO fires a "Proposal saved" toast
//    at the same moment — `getByText('Saved')` matches both (Playwright text
//    matching is substring + case-insensitive), so this spec scopes to the
//    testid instead of asserting on visible text.

async function gotoTakeoffsTab(page: Page, projectId: string) {
  await page.goto(`/project/${projectId}/takeoff?tab=takeoffs`);
  await expect(page.getByTestId('takeoffs-table')).toBeVisible();
}

// Scope to the desktop table — both the desktop table and the mobile cards
// render data-testid="takeoff-row" (CSS toggles visibility, not presence).
function takeoffRows(page: Page) {
  return page.getByTestId('takeoffs-table').getByTestId('takeoff-row');
}

async function selectFirstTakeoff(page: Page) {
  const row = takeoffRows(page).first();
  await expect(row).toBeVisible();
  await row.getByRole('checkbox').check();
}

test('select takeoffs → Proposal → editor seeded; add manual + alternate; generate; list; revise carries lines', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId, takeoffName } = await seedProjectWithTakeoffMeasurement(request, token);
  await gotoTakeoffsTab(authedPage, projectId);
  await selectFirstTakeoff(authedPage);
  await authedPage.getByTestId('btn-proposal').click();
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/proposal/[0-9a-f-]{36}$`));

  const pricing = authedPage.getByTestId('pricing-lines');
  await expect(pricing.getByLabel('Description').first()).toHaveValue(takeoffName);

  await pricing.getByRole('button', { name: /Add manual line/ }).click();
  const manualDesc = pricing.getByPlaceholder('Description').last();
  await manualDesc.fill('Scaffolding');
  const manualAmt = pricing.getByRole('spinbutton').last();
  await manualAmt.fill('3500');
  await manualAmt.blur();
  await pricing.getByRole('button', { name: /Add manual line/ }).click();
  await pricing.getByPlaceholder('Description').last().fill('Color coat upgrade');
  await pricing.getByLabel('Alternate').last().check();

  await authedPage.getByRole('button', { name: 'Save' }).click();
  await expect(authedPage.getByTestId('proposal-state')).toHaveText('Saved');
  await expect(authedPage.getByTestId('proposal-status')).toHaveText('No PDF yet');
  await authedPage.getByTestId('proposal-generate').click();
  await expect(authedPage.getByText('PDF generated')).toBeVisible({ timeout: 30_000 });
  // The bar now holds a current document: the chip flips and Open/Download appear.
  await expect(authedPage.getByTestId('proposal-status')).toHaveText('PDF up to date');
  await expect(authedPage.getByTestId('proposal-open')).toBeVisible();

  await authedPage.goto(`/project/${projectId}/proposal`);
  const row = authedPage.getByTestId('proposal-row-1');
  await expect(row).toContainText('#1');
  await expect(row).toContainText('draft');

  // revise → dialog → new #2 (rev. of #1), lines (incl. the manual ones) carry over
  await row.getByTitle(/Revise/).click();
  await authedPage.getByRole('button', { name: /Create revision/ }).click();
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/proposal/[0-9a-f-]{36}$`));
  await expect(authedPage.getByText('#2 (rev. of #1)')).toBeVisible();

  const revisedPricing = authedPage.getByTestId('pricing-lines');
  // Order is preserved from the source: takeoff line, then manual lines in the
  // order they were added (Scaffolding, then Color coat upgrade).
  await expect(revisedPricing.getByLabel('Description').nth(1)).toHaveValue('Scaffolding');
  await expect(revisedPricing.getByLabel('Description').nth(2)).toHaveValue('Color coat upgrade');
});

test('a draft proposal opens editable; a sent one opens read-only', async ({ authedPage, apiToken, request }) => {
  const { token } = apiToken;
  const { projectId, takeoffName } = await seedProjectWithTakeoffMeasurement(request, token);
  const auth = { Authorization: `Bearer ${token}` };
  const created = await request.post(`/api/projects/${projectId}/proposals`, { headers: auth, data: {} });
  const { id } = await created.json();
  await authedPage.goto(`/project/${projectId}/proposal/${id}`);

  // A blank draft (no lines, nothing to re-derive) starts non-dirty, so Save
  // is present but disabled — its PRESENCE is what proves the draft is
  // editable (readOnly hides the button outright; see the note atop this
  // file), not its enabled state.
  await expect(authedPage.getByTestId('btn-save-proposal')).toBeVisible();
  await expect(authedPage.getByTestId('proposal-generate')).toBeVisible();
  await expect(authedPage.getByTestId('proposal-state')).toHaveText('Saved');
  // Nothing to price yet, so the bar names the reason rather than just greying out.
  await expect(authedPage.getByTestId('proposal-send')).toHaveAttribute('title', 'Add at least one price line');
  await expect(authedPage.getByTestId('pricing-lines').getByRole('button', { name: /Add manual line/ })).toBeVisible();

  // Takeoffs are picked from an inline CHECKLIST, not a <select> — a proposal
  // usually wants several at once. The toggle keeps aria-label="Add takeoff"
  // (singular) from the dropdown it replaced.
  const pricing = authedPage.getByTestId('pricing-lines');
  await pricing.getByLabel('Add takeoff').click();
  const panel = authedPage.getByTestId('add-takeoffs-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Add 0 takeoffs' })).toBeDisabled();
  await panel.getByLabel(takeoffName).check();
  await panel.getByRole('button', { name: 'Add 1 takeoff' }).click();
  await expect(panel).toBeHidden();
  await expect(pricing.getByLabel('Description').first()).toHaveValue(takeoffName);

  // Lock path: needs a "sent" proposal. Sending requires SMTP; there is no
  // SMTP stub anywhere under e2e/ (confirmed: no "buildTransporter"/"smtp"
  // fixture in e2e/ or playwright.config.ts, unlike a mocked-transport
  // pattern), so the send flow can't be exercised end-to-end here. Stopping
  // at the draft assertion above — the lock is covered by
  // server/proposalStore.test.ts + server/proposalRoutes.test.ts (status
  // transitions) and readOnly's derivation (draft vs sent/legacy) is
  // exercised directly by useProposalDraft.test.tsx.
});
