import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, expect, seedProjectWithPage } from './fixtures/test';

// ONLYOFFICE Phase 3 in a real browser: "New document" (Documents page and
// the command palette), Settings → Document Templates (letterhead, uploads,
// company stamps) and User Preferences → My signatures (including signatures
// the old PDF editor left in the browser). The e2e server runs without
// ONLYOFFICE, so a new document lands on the editor's "not set up" screen;
// what matters here is that the file was made and filed correctly.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PNG = readFileSync(join(__dirname, 'fixtures', 'assets', 'test-page.png'));
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The e2e store outlives a run, so a test that counts library items starts
 *  by clearing what an earlier run left. */
async function clearLibrary(request: import('@playwright/test').APIRequestContext, auth: Record<string, string>, list: string) {
  const items = await (await request.get(`/api/${list}`, { headers: auth })).json() as { id: string }[];
  for (const item of items) await request.delete(`/api/${list}/${item.id}`, { headers: auth });
}

test('New document: a blank spreadsheet filed in the chosen project opens in the editor', async ({ authedPage, apiToken, request }) => {
  const { projectId, name: projectName } = await seedProjectWithPage(request, apiToken.token);
  await authedPage.goto('/documents');
  await authedPage.getByTestId('documents-new').click();
  const dialog = authedPage.getByTestId('new-document-modal');
  await dialog.getByRole('radio', { name: /Excel spreadsheet/ }).click();
  await authedPage.getByLabel('Name').fill('Quantities');
  await authedPage.getByLabel('Project').selectOption({ label: projectName });
  await authedPage.getByTestId('new-document-create').click();

  await expect(authedPage).toHaveURL(/\/tools\/edit\?fileId=[^&]+$/);
  await expect(authedPage.getByTestId('document-editor-error')).toContainText("isn't set up yet");
  const fileId = new URL(authedPage.url()).searchParams.get('fileId')!;
  const meta = await (await request.get(`/api/files/${fileId}/meta`, { headers: { Authorization: `Bearer ${apiToken.token}` } })).json();
  expect(meta).toMatchObject({ name: 'Quantities.xlsx', projectId, kind: 'spreadsheet' });
});

test('the command palette opens New document on the type picked, with the project preselected', async ({ authedPage, apiToken, request }) => {
  const { projectId } = await seedProjectWithPage(request, apiToken.token);
  await authedPage.goto(`/project/${projectId}`);
  await authedPage.getByRole('button', { name: /^Search/ }).click();
  await authedPage.getByRole('button', { name: /New PDF form/ }).click();
  await expect(authedPage).toHaveURL(new RegExp(`/documents\\?projectIds=${projectId}$`));
  await expect(authedPage.getByRole('radio', { name: /PDF form/ })).toHaveAttribute('aria-checked', 'true');
  await expect(authedPage.getByLabel('Project')).toHaveValue(projectId);
});

test('Document Templates: add the letterhead and an upload, then start a document from one', async ({ authedPage, apiToken, request }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  await clearLibrary(request, auth, 'document-templates');
  const { projectId, name: projectName } = await seedProjectWithPage(request, apiToken.token);
  await authedPage.goto('/settings?tab=document-templates');
  const tab = authedPage.getByTestId('document-templates-tab');
  await expect(tab).toBeVisible();

  // The letterhead, once.
  await authedPage.getByTestId('templates-add-letterhead').click();
  await expect(tab.getByTestId('template-row').filter({ hasText: 'Letterhead.docx' })).toBeVisible();
  await expect(authedPage.getByTestId('templates-add-letterhead')).toHaveCount(0);

  // An uploaded template, renamed (the extension stays).
  await authedPage.getByTestId('templates-upload-input').setInputFiles({ name: 'Bid.docx', mimeType: DOCX_MIME, buffer: Buffer.from('bid template bytes') });
  const bid = tab.getByTestId('template-row').filter({ hasText: 'Bid.docx' });
  await expect(bid).toBeVisible();
  await bid.getByTestId('template-rename').click();
  // While renaming, the row shows a text box instead of the name.
  await tab.getByTestId('template-name-input').fill('Bid form');
  await tab.getByRole('button', { name: 'Save' }).click();
  await expect(tab.getByText('Bid form.docx')).toBeVisible();

  // Templates never show in Documents.
  const docs = await (await request.get('/api/documents', { headers: auth })).json();
  expect(docs.rows.map((r: { name: string }) => r.name)).not.toContain('Bid form.docx');

  // Starting a document from it copies its bytes.
  await authedPage.goto('/documents');
  await authedPage.getByTestId('documents-new').click();
  await authedPage.getByLabel('Start from').selectOption({ label: 'Bid form.docx' });
  await authedPage.getByLabel('Name').fill('Bid for Maple');
  await authedPage.getByLabel('Project').selectOption({ label: projectName });
  await authedPage.getByTestId('new-document-create').click();
  await expect(authedPage).toHaveURL(/\/tools\/edit\?fileId=/);
  const fileId = new URL(authedPage.url()).searchParams.get('fileId')!;
  const content = await request.get(`/api/files/${fileId}/content`, { headers: auth });
  expect(await content.text()).toBe('bid template bytes');
  const meta = await (await request.get(`/api/files/${fileId}/meta`, { headers: auth })).json();
  expect(meta).toMatchObject({ name: 'Bid for Maple.docx', projectId });
});

test('company stamps: an admin adds one with the background cleared', async ({ authedPage, apiToken, request }) => {
  await clearLibrary(request, { Authorization: `Bearer ${apiToken.token}` }, 'company-stamps');
  await authedPage.goto('/settings?tab=document-templates');
  await authedPage.getByTestId('stamps-add').click();
  await authedPage.getByTestId('stamp-upload-input').setInputFiles({ name: 'approved.png', mimeType: 'image/png', buffer: PNG });
  await expect(authedPage.getByTestId('stamp-upload-preview')).toBeVisible();
  await authedPage.getByRole('dialog').getByLabel('Name', { exact: true }).fill('APPROVED');
  await authedPage.getByTestId('stamp-upload-save').click();
  await expect(authedPage.getByTestId('stamp-row').filter({ hasText: 'APPROVED' })).toBeVisible();
});

test('My signatures: several, named, one default; old-editor signatures come across once', async ({ authedPage, apiToken, request }) => {
  await clearLibrary(request, { Authorization: `Bearer ${apiToken.token}` }, 'signatures');
  // What the old PDF editor left in this browser.
  await authedPage.goto('/dashboard');
  await authedPage.evaluate(png => localStorage.setItem('pdfEditorSignatures', JSON.stringify([
    { id: 'old', name: 'From the old editor', dataUrl: `data:image/png;base64,${png}`, naturalWidth: 10, naturalHeight: 10 },
  ])), PNG.toString('base64'));

  await authedPage.goto('/settings?tab=preferences');
  const section = authedPage.getByTestId('my-signatures');
  await expect(section.getByTestId('signature-row').filter({ hasText: 'From the old editor' })).toBeVisible();
  expect(await authedPage.evaluate(() => localStorage.getItem('pdfEditorSignatures'))).toBeNull();

  await section.getByTestId('signatures-add').click();
  await authedPage.getByTestId('signature-upload-input').setInputFiles({ name: 'initials.png', mimeType: 'image/png', buffer: PNG });
  await expect(authedPage.getByTestId('signature-upload-preview')).toBeVisible();
  await authedPage.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Initials');
  await authedPage.getByTestId('signature-upload-save').click();
  const initials = section.getByTestId('signature-row').filter({ hasText: 'Initials' });
  await expect(initials).toBeVisible();

  await initials.getByRole('button', { name: 'Make default' }).click();
  await expect(initials.getByTestId('signature-default')).toBeVisible();
  const list = await (await request.get('/api/signatures', { headers: { Authorization: `Bearer ${apiToken.token}` } })).json();
  expect(list.find((s: { name: string }) => s.name === 'Initials').isDefault).toBe(true);
});
