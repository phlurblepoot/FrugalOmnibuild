import { test, expect, seedProjectWithPage } from './fixtures/test';

// ONLYOFFICE Phase 4 in a real browser. The e2e server runs without
// ONLYOFFICE, so these pin the app's side: an old-format upload is kept as it
// came and the uploader is told why; the pay app editor has Make PDF (which
// says the editor isn't set up) and Email. Converting against a Document
// Server is covered by server/onlyoffice/conversions.test.ts and the
// stand-in smoke run recorded in the checklist.

test('an old-format upload is kept as it came, and the uploader is told why', async ({ authedPage, apiToken, request }) => {
  const { projectId, name: projectName } = await seedProjectWithPage(request, apiToken.token);
  await authedPage.goto('/documents');
  await authedPage.getByTestId('documents-upload').click();
  const dialog = authedPage.getByRole('dialog');
  await dialog.locator('input[type=file]').first().setInputFiles({ name: 'Budget.xls', mimeType: 'application/vnd.ms-excel', buffer: Buffer.from('old xls') });
  await authedPage.getByLabel('Project').selectOption({ label: projectName });
  await dialog.getByRole('button', { name: /^Upload/ }).last().click();

  await expect(authedPage.getByText(/"Budget\.xls": Kept as \.xls: the document editor isn't set up/)).toBeVisible();
  const docs = await (await request.get(`/api/documents?projectIds=${projectId}`, { headers: { Authorization: `Bearer ${apiToken.token}` } })).json();
  expect(docs.rows.map((r: { name: string }) => r.name)).toContain('Budget.xls');
});

test('the pay app editor offers Make PDF and Email', async ({ authedPage, apiToken, request }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const { projectId } = await seedProjectWithPage(request, apiToken.token);
  const pa = await request.post(`/api/projects/${projectId}/aia/pay-apps`, { headers: auth, data: {} });
  expect(pa.ok()).toBe(true);

  await authedPage.goto(`/project/${projectId}/billing?tab=aia`);
  await authedPage.getByRole('button', { name: 'Pay Applications' }).click();
  await authedPage.getByRole('button', { name: 'Open' }).first().click();
  await expect(authedPage.getByTestId('doc-send')).toBeVisible();

  // Make PDF generates the workbook first, then asks ONLYOFFICE, which this
  // server doesn't have: it says so and keeps what it made.
  await authedPage.getByTestId('payapp-make-pdf').click();
  await expect(authedPage.getByText(/isn't set up, so it can't make PDFs/)).toBeVisible({ timeout: 30_000 });
  await expect(authedPage.getByTestId('doc-status')).toHaveText('Excel up to date');
});
