import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures/test';

// Mirrors src/utils/money.ts's formatMoney.
const fmtCents = (cents: number): string =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

// The Reports page (spec docs/superpowers/specs/2026-10-06-reports-design.md)
// and invoices marking themselves paid. The suite shares one server/DB, so the
// test seeds its own customer and narrows the report to it.
test('Reports: an open invoice shows with its balance and aging; paying the rest marks it paid and drops it', async ({ authedPage: page, request, apiToken }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const short = randomUUID().slice(0, 8);

  const customerName = `E2E Reports Customer ${short}`;
  const customer = await (await request.post('/api/customers', { headers: auth, data: { name: customerName } })).json();
  const projectId = randomUUID();
  const projectName = `E2E Reports Job ${short}`;
  const projRes = await request.post('/api/projects', {
    headers: auth,
    data: { id: projectId, name: projectName, createdAt: Date.now(), customerId: customer.id, status: 'in_progress', pages: [], takeoffs: [], version: 1 },
  });
  expect(projRes.ok()).toBeTruthy();

  // A $1,200 invoice sent 40 days ago (31–60 days), $200 paid so far.
  const invoiceNumber = `R-${short}`;
  const invRes = await request.post(`/api/projects/${projectId}/invoices`, {
    headers: auth,
    data: { number: invoiceNumber, status: 'sent', date: Date.now() - 40 * 86400000, lines: [{ description: 'Stucco', qty: 1, unitPrice: 1200 }] },
  });
  expect(invRes.ok()).toBeTruthy();
  const invoice = await invRes.json();
  const payRes = await request.post(`/api/projects/${projectId}/payments`, {
    headers: auth,
    data: { targetType: 'invoice', targetId: invoice.id, amount: 200, method: 'check', note: `Deposit ${short}` },
  });
  expect(payRes.ok()).toBeTruthy();

  // Reports is in the sidebar for an admin.
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/reports/);
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();

  // Open invoices (the default report), narrowed to this customer.
  await page.getByLabel('Customer').selectOption({ label: customerName });
  const row = page.getByTestId('report-row').filter({ hasText: `Invoice ${invoiceNumber}` });
  await expect(row).toBeVisible();
  await expect(row).toContainText(projectName);
  await expect(row).toContainText('31–60 days');
  await expect(row).toContainText(fmtCents(100000));
  await expect(page.getByTestId('report-row')).toHaveCount(1);
  await expect(page.getByTestId('report-total')).toContainText(fmtCents(100000));

  // Payments received (this month) lists the deposit.
  await page.getByTestId('report-tab-payments').click();
  await expect(page.getByTestId('report-row').filter({ hasText: `Deposit ${short}` })).toContainText(fmtCents(20000));

  // Record the rest on the project's Billing → Payments tab.
  await page.goto(`/project/${projectId}/billing?tab=payments`);
  await page.getByLabel('Applied to').selectOption({ label: `Invoice ${invoiceNumber}` });
  await page.getByLabel('Amount').fill('1000');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('Payment recorded')).toBeVisible();

  // The invoice marked itself paid.
  await page.goto(`/project/${projectId}/billing?tab=invoices`);
  const invoiceRow = page.getByRole('row').filter({ hasText: invoiceNumber });
  await expect(invoiceRow.getByText('Paid', { exact: true })).toBeVisible();

  // …and is no longer an open invoice.
  await page.goto('/reports?tab=open-invoices');
  await page.getByLabel('Customer').selectOption({ label: customerName });
  await expect(page.getByText('Nothing outstanding')).toBeVisible();
  await expect(page.getByTestId('report-row')).toHaveCount(0);
});
