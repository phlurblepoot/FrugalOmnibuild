import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { test, expect, seedProjectWithPage } from './fixtures/test';

// Characterization spec for the shared document-actions rollout (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout): the
// DocumentActionsBar (Generate/Open/Download/Send + status chip) mounted in
// the invoice editor, and the AddFilesButton/FilePickerModal (Upload tab)
// mounted via PhotoDropCard in the issue editor, and the PdfAttachmentsCard
// whose PDFs end the generated issue report.
//
// Regenerating always makes a new version (ONLYOFFICE decision 2026-09-25):
// there is no version-or-overwrite prompt any more.

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PHOTO_PNG = join(__dirname, 'fixtures', 'assets', 'test-page.png');

test('invoice document actions: generate → edit goes out of date → regenerate → /versions has 2 rows', async ({
  authedPage, apiToken, request,
}) => {
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const { projectId } = await seedProjectWithPage(request, token);

  const short = randomUUID().slice(0, 8);
  const invoiceNumber = `INV-${short}`;
  const invRes = await request.post(`/api/projects/${projectId}/invoices`, {
    headers: auth,
    data: {
      number: invoiceNumber,
      date: Date.now(),
      status: 'draft',
      lines: [{ description: 'Work performed', qty: 1, unitPrice: 500 }],
    },
  });
  if (!invRes.ok()) throw new Error(`invoice seed failed: ${invRes.status()} ${await invRes.text()}`);
  const invoice = await invRes.json();

  await authedPage.goto(`/project/${projectId}/billing?tab=invoices`);
  await authedPage.getByRole('row', { name: new RegExp(invoiceNumber) }).click();

  // Only the invoice editor's Modal is open at this point — safe to scope to
  // it for the line-item edit below.
  const editorDialog = authedPage.getByRole('dialog');
  await expect(editorDialog).toBeVisible();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('No PDF yet');
  await expect(authedPage.getByTestId('doc-open')).toHaveCount(0);
  await expect(authedPage.getByTestId('doc-download')).toHaveCount(0);

  await authedPage.getByTestId('doc-generate').click();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('PDF up to date', { timeout: 30_000 });
  await expect(authedPage.getByTestId('doc-open')).toBeVisible();
  await expect(authedPage.getByTestId('doc-download')).toBeVisible();

  // Edit the one line item → dirty → Save invoice → the stored PDF (built
  // from the pre-edit record) is now stale.
  const lineRow = editorDialog.locator('table tbody tr').first();
  await lineRow.getByRole('textbox').first().fill('Work performed - revised');
  await authedPage.getByRole('button', { name: 'Save invoice' }).click();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('PDF out of date');

  // Regenerate: straight into a new version, no prompt; the old PDF stays in
  // the history.
  await authedPage.getByTestId('doc-generate').click();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('PDF up to date', { timeout: 30_000 });
  await expect(authedPage.getByRole('dialog')).toHaveCount(1); // just the invoice editor

  const bySource = await request.get(
    `/api/documents/by-source?sourceType=invoice&sourceId=${invoice.id}&kind=invoice`,
    { headers: auth },
  );
  expect(bySource.ok()).toBeTruthy();
  const doc = await bySource.json();
  const versionsRes = await request.get(`/api/files/${doc.id}/versions`, { headers: auth });
  expect(versionsRes.ok()).toBeTruthy();
  const versions = await versionsRes.json();
  expect(versions).toHaveLength(2);
});

test('issue editor: Add photos opens on the Upload tab; an uploaded image appears on the card', async ({
  authedPage, apiToken, request,
}) => {
  const { token } = apiToken;
  const { projectId } = await seedProjectWithPage(request, token);

  await authedPage.goto(`/project/${projectId}/issues`);
  await authedPage.getByLabel('New issue').fill('E2E photo issue');
  await authedPage.getByRole('button', { name: 'Add issue' }).click();

  const editorDialog = authedPage.getByRole('dialog');
  await expect(editorDialog).toBeVisible();
  await expect(editorDialog.getByTestId('issue-photo-dropzone')).toBeVisible();
  await expect(editorDialog.locator('[data-testid="issue-photo-dropzone"] img')).toHaveCount(0);

  // Scoped to the photo card: the attachments card has its own Add PDFs button.
  await editorDialog.getByTestId('issue-photo-dropzone').getByTestId('add-files-button').click();
  // PhotoDropCard's AddFilesButton passes defaultTab="upload", so the picker
  // (a second, separately-portaled Modal) opens straight on the Upload panel
  // — no "Upload" tab click needed.
  await expect(authedPage.getByTestId('picker-upload-panel')).toBeVisible();

  await authedPage.getByTestId('picker-upload-input').setInputFiles({
    name: 'issue-photo.png',
    mimeType: 'image/png',
    buffer: readFileSync(TEST_PHOTO_PNG),
  });

  // The picker stores the upload immediately, links it to the issue, and
  // closes itself.
  await expect(authedPage.getByTestId('picker-upload-panel')).toBeHidden({ timeout: 15_000 });
  await expect(editorDialog.locator('[data-testid="issue-photo-dropzone"] img')).toHaveCount(1);
});

test('issue editor: an attached PDF ends the generated report; removing it marks the report out of date', async ({
  authedPage, apiToken, request,
}) => {
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const { projectId } = await seedProjectWithPage(request, token);

  await authedPage.goto(`/project/${projectId}/issues`);
  await authedPage.getByLabel('New issue').fill('E2E attachment issue');
  await authedPage.getByRole('button', { name: 'Add issue' }).click();
  const editorDialog = authedPage.getByRole('dialog');
  await expect(editorDialog).toBeVisible();
  await expect(editorDialog.getByText('No attachments.')).toBeVisible();

  // Two pages of an odd size, so they can be told apart from the report's own
  // letter-size pages once merged.
  const attached = await PDFDocument.create();
  attached.addPage([400, 600]);
  attached.addPage([400, 600]);

  await editorDialog.getByRole('button', { name: 'Add PDFs' }).click();
  await expect(authedPage.getByTestId('picker-upload-panel')).toBeVisible();
  await authedPage.getByTestId('picker-upload-input').setInputFiles({
    name: 'spec-sheet.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await attached.save()),
  });
  await expect(authedPage.getByTestId('picker-upload-panel')).toBeHidden({ timeout: 15_000 });
  await expect(editorDialog.getByText('spec-sheet.pdf')).toBeVisible();

  await authedPage.getByTestId('doc-generate').click();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('PDF up to date', { timeout: 30_000 });

  const issues = await (await request.get(`/api/projects/${projectId}/issues`, { headers: auth })).json();
  const issueId = issues.find((i: { title: string }) => i.title === 'E2E attachment issue').id;
  const doc = await (await request.get(
    `/api/documents/by-source?sourceType=issue&sourceId=${issueId}&kind=issue-report`, { headers: auth },
  )).json();
  const content = await request.get(`/api/files/${doc.id}/content`, { headers: auth });
  expect(content.ok()).toBeTruthy();
  const sizes = (await PDFDocument.load(await content.body())).getPages()
    .map(p => `${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`);
  // The issue's own page(s) first, then the attached PDF's two pages, last.
  expect(sizes.length).toBeGreaterThan(2);
  expect(sizes.slice(-2)).toEqual(['400x600', '400x600']);
  expect(sizes.slice(0, -2)).not.toContain('400x600');

  // Taking the attachment off changes what the report would contain.
  await editorDialog.getByRole('button', { name: 'Remove attachment' }).click();
  await expect(editorDialog.getByText('No attachments.')).toBeVisible();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('PDF out of date');
});
