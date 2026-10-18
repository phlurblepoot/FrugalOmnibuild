import { randomUUID } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { test, expect, login, seedCustomerWithPortfolio } from './fixtures/test';

// Mirrors src/utils/money.ts's formatMoney — used to derive assertion
// strings from seeded cents amounts instead of hand-computing literals.
const fmtCents = (cents: number): string =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

// Characterization spec for the customers split view (src/pages/customers/*)
// introduced by the customers/projects reorg: persistent sidebar + a tabbed
// pane (Overview / Projects / Tasks / Billing / Settings), Billing + money
// figures admin-gated end to end (server omits the fields; the client never
// renders them).
//
// The suite shares one server/DB across every spec file, so each test seeds
// its own uniquely-named customer via seedCustomerWithPortfolio() and scopes
// all assertions to that customer's own rows/text.

test('admin: sidebar select, overview tiles + attention, tasks tab, billing tab, settings edit', async ({ authedPage, request, apiToken }) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token, { withPayApp: true });
  const payApp = seeded.payApp!;
  // The invoice leg is unpaid; the pay-app leg has a partial payment
  // recorded, so its Outstanding contribution is the balance (billed less
  // paid), not the gross billed amount. The combined Outstanding figure and
  // the Overview tile's "contract $X · invoices $Y" sub-line both apply
  // since both legs' outstandingCents are still > 0.
  const combinedOutstandingCents = seeded.invoiceAmountCents + payApp.balanceCents;

  await authedPage.goto('/customers');
  const sidebarRow = authedPage.getByTestId('customer-sidebar-row').filter({ hasText: seeded.customerName });
  await expect(sidebarRow).toBeVisible();
  await sidebarRow.click();

  await expect(authedPage).toHaveURL(new RegExp(`/customers/${seeded.customerId}`));
  await expect(authedPage.getByTestId('customer-pane')).toBeVisible();

  // Overview is the default tab (no ?tab= yet).
  await expect(authedPage.getByTestId('customer-tab-overview')).toHaveClass(/glow-accent/);

  // The old stat tiles (Bidding/In progress/Outstanding/Open tasks) and their
  // CustomerOverviewTab.tsx are gone — Overview is now the customer card grid
  // (src/cards/customer/coreCards.tsx): cu-rollup (Financials, admin-only),
  // cu-projects, cu-attention, cu-correspondence. Same seeded figures, now
  // surfaced through those cards. There's no surviving aggregate "Open tasks"
  // count anywhere on Overview post-refactor (taskCounts is computed
  // server-side but never rendered) — the one overdue task is still visible
  // via its own row in the attention feed asserted below, which is the
  // closest behavior-preserving equivalent.
  const combinedBilledCents = seeded.invoiceAmountCents + payApp.billedCents;
  const combinedPaidCents = payApp.paidCents; // the invoice leg has no payment

  const rollupCard = authedPage.locator('[data-card-id="cu-rollup"]');
  await expect(rollupCard).toBeVisible();
  await expect(rollupCard).toContainText(fmtCents(combinedOutstandingCents));
  await expect(rollupCard).toContainText(fmtCents(combinedBilledCents));
  await expect(rollupCard).toContainText(fmtCents(combinedPaidCents));

  const projectsCard = authedPage.locator('[data-card-id="cu-projects"]');
  await expect(projectsCard).toBeVisible();
  await expect(
    projectsCard.locator('li', { hasText: seeded.biddingProjectName }).getByText('Bidding', { exact: true }),
  ).toBeVisible();
  await expect(
    projectsCard.locator('li', { hasText: seeded.inProgressProjectName }).getByText('In Progress', { exact: true }),
  ).toBeVisible();

  // Needs-attention: the overdue task, the upcoming bid, the outstanding
  // invoice, and the outstanding (finalized, unpaid) pay application.
  const attentionRows = authedPage.getByTestId('customer-attention-row');
  await expect(attentionRows).toHaveCount(4);
  await expect(attentionRows.filter({ hasText: seeded.taskTitle })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: seeded.biddingProjectName })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: `Invoice #${seeded.invoiceNumber}` })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: `Application #${payApp.payAppNumber}` })).toHaveCount(1);

  // Tasks tab shows the seeded task.
  await authedPage.getByTestId('customer-tab-tasks').click();
  await expect(authedPage).toHaveURL(/tab=tasks/);
  await expect(authedPage.getByText(seeded.taskTitle)).toBeVisible();

  // Billing tab: two-row Contract/Invoices summary split + ledger rows for
  // both the sent/unpaid invoice and the finalized/unpaid pay application.
  await authedPage.getByTestId('customer-tab-billing').click();
  await expect(authedPage).toHaveURL(/tab=billing/);

  // "Contract" row (SOV/pay-app leg) — scope label→value lookups to this
  // row's own section so "Paid" (which also appears in the Invoices row and
  // the ledger's column header) resolves to the right element.
  const rowValue = (container: Locator, label: string) =>
    container.getByText(label, { exact: true }).locator('..');
  const contractSection = authedPage.getByTestId('billing-summary-contract');
  await expect(contractSection).toBeVisible();
  await expect(rowValue(contractSection, 'Contract total')).toContainText(fmtCents(payApp.sovAmountCents));
  await expect(rowValue(contractSection, 'Billed')).toContainText(fmtCents(payApp.billedCents));
  await expect(rowValue(contractSection, 'Outstanding')).toContainText(fmtCents(payApp.balanceCents));
  await expect(rowValue(contractSection, 'Paid')).toContainText(fmtCents(payApp.paidCents));

  // "Invoices" row (invoice leg).
  const invoicesSection = authedPage.getByTestId('billing-summary-invoices');
  await expect(invoicesSection).toBeVisible();
  await expect(rowValue(invoicesSection, 'Invoiced')).toContainText(fmtCents(seeded.invoiceAmountCents));
  await expect(rowValue(invoicesSection, 'Paid')).toContainText('$0.00');

  const invoiceLedgerRow = authedPage.getByRole('row', { name: new RegExp(seeded.invoiceNumber) });
  await expect(invoiceLedgerRow).toBeVisible();
  await expect(invoiceLedgerRow).toContainText(seeded.inProgressProjectName);
  await expect(invoiceLedgerRow).toContainText('Invoice');
  await expect(invoiceLedgerRow).toContainText('Sent');
  await expect(invoiceLedgerRow).toContainText('$750.00');

  const payAppLedgerRow = authedPage.getByRole('row').filter({ hasText: 'Pay Application' });
  await expect(payAppLedgerRow).toBeVisible();
  await expect(payAppLedgerRow).toContainText(seeded.inProgressProjectName);
  await expect(payAppLedgerRow).toContainText('Finalized');
  await expect(payAppLedgerRow).toContainText(fmtCents(payApp.billedCents));

  // Pay Applications tab (on the project itself): Amount/Balance columns for
  // the finalized app. A $250.00 payment was recorded against it in this
  // seed, so Amount (billed, gross — $900.00 at 10% retainage on the
  // $1,000.00 SOV line) and Balance (billed less paid — $650.00) differ.
  await authedPage.goto(`/project/${seeded.inProgressProjectId}/billing?tab=pay-apps`);
  const payAppTableRow = authedPage.getByRole('row').filter({ hasText: `#${payApp.payAppNumber}` });
  await expect(payAppTableRow).toBeVisible();
  const payAppCells = payAppTableRow.locator('td');
  await expect(payAppCells.nth(4)).toHaveText(fmtCents(payApp.billedCents)); // Amount
  await expect(payAppCells.nth(5)).toHaveText(fmtCents(payApp.balanceCents)); // Balance
  await authedPage.goto(`/customers/${seeded.customerId}?tab=billing`);

  // Settings tab: edit a field and save.
  await authedPage.getByTestId('customer-tab-settings').click();
  await expect(authedPage).toHaveURL(/tab=settings/);
  const newPhone = `555-${randomUUID().slice(0, 4)}`;
  const phoneInput = authedPage.locator('#cust-phone');
  await phoneInput.fill(newPhone);
  await authedPage.getByRole('button', { name: 'Save' }).click();
  await expect(authedPage.getByText('Customer saved.')).toBeVisible();
  await expect(phoneInput).toHaveValue(newPhone);
});

test('non-admin: no Billing tab, no $ tiles, ?tab=billing falls back to overview', async ({ page, request, apiToken }) => {
  const seeded = await seedCustomerWithPortfolio(request, apiToken.token);

  // Create a fresh non-admin user via the admin token, then log in as them.
  const username = `e2e-nonadmin-${randomUUID().slice(0, 8)}`;
  const password = 'password123';
  const createRes = await request.post('/api/users', {
    headers: { Authorization: `Bearer ${apiToken.token}` },
    data: { username, password, role: 'user' },
  });
  if (!createRes.ok()) throw new Error(`user create failed: ${createRes.status()} ${await createRes.text()}`);

  const loginRes = await request.post('/api/auth/login', { data: { username, password } });
  if (!loginRes.ok()) throw new Error(`non-admin login failed: ${loginRes.status()} ${await loginRes.text()}`);
  const session = await loginRes.json();

  await page.addInitScript(
    ([token, user]) => {
      localStorage.setItem('token', token);
      localStorage.setItem('user', user);
    },
    [session.token, JSON.stringify(session.user)] as const,
  );

  // Deep-link straight into the customer with a stale/bookmarked ?tab=billing —
  // must fall back to overview rather than crash or render nothing.
  await page.goto(`/customers/${seeded.customerId}?tab=billing`);
  await expect(page.getByTestId('customer-pane')).toBeVisible();
  await expect(page.getByTestId('customer-tab-overview')).toHaveClass(/glow-accent/);

  // No Billing tab button at all for a non-admin.
  await expect(page.getByTestId('customer-tab-billing')).toHaveCount(0);

  // Overview is the customer card grid: cu-rollup (Financials, money) is
  // admin-only and absent entirely; cu-projects (not money-gated) still
  // shows both seeded projects with their status pills.
  await expect(page.locator('[data-card-id="cu-rollup"]')).toHaveCount(0);
  const projectsCard = page.locator('[data-card-id="cu-projects"]');
  await expect(projectsCard).toBeVisible();
  await expect(
    projectsCard.locator('li', { hasText: seeded.biddingProjectName }).getByText('Bidding', { exact: true }),
  ).toBeVisible();
  await expect(
    projectsCard.locator('li', { hasText: seeded.inProgressProjectName }).getByText('In Progress', { exact: true }),
  ).toBeVisible();

  // Attention still lists the overdue task and the upcoming bid (non-money
  // items), but never the outstanding invoice (money-gated server-side).
  const attentionRows = page.getByTestId('customer-attention-row');
  await expect(attentionRows).toHaveCount(2);
  await expect(attentionRows.filter({ hasText: seeded.taskTitle })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: seeded.biddingProjectName })).toHaveCount(1);
  await expect(attentionRows.filter({ hasText: 'Invoice #' })).toHaveCount(0);

  // The header's admin-outstanding slot renders nothing for a non-admin.
  await expect(page.getByTestId('customer-outstanding-slot')).toBeEmpty();
});
