import { test, expect, seedProjectWithPage } from './fixtures/test';

// The e2e server runs without ONLYOFFICE, so these pin the editor page's own
// wiring: how people get to /tools/edit, that old editor links still land
// there, "Open from computer" filing the upload into a project, and that a
// file which can't open says why and still offers the download. Opening and
// saving against ONLYOFFICE itself is covered by server/onlyoffice/*.test.ts
// and src/pages/DocumentEditor.test.tsx (fake Document Server / fake DocsAPI).
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('opened from Documents, a file that cannot open says why, points an admin at Settings, and still downloads', async ({ authedPage, apiToken, request }) => {
  const upload = await request.post(`/api/files/e2e-editor-scope?kind=document&name=${encodeURIComponent('E2E Editor Scope.docx')}`, {
    headers: { Authorization: `Bearer ${apiToken.token}`, 'Content-Type': DOCX },
    data: Buffer.from('not really a docx'),
  });
  expect(upload.ok()).toBe(true);
  const configCalls: string[] = [];
  authedPage.on('request', r => { if (r.url().includes('/api/onlyoffice/config/')) configCalls.push(r.url()); });

  await authedPage.goto('/documents');
  await authedPage.getByText('E2E Editor Scope.docx').first().click();
  await authedPage.getByTestId('doc-viewer-open-editor').click();
  await expect(authedPage).toHaveURL(/\/tools\/edit\?fileId=e2e-editor-scope$/);

  const error = authedPage.getByTestId('document-editor-error');
  await expect(error).toContainText("Couldn't open this file");
  await expect(error).toContainText("isn't set up yet");
  await expect(error.getByRole('link', { name: 'Settings → Document Editor' })).toHaveAttribute('href', '/settings?tab=document-editor');
  // The page transition renders a newly entered route twice; the editor must
  // only start (ask for its config) in the copy that stays.
  expect(configCalls).toHaveLength(1);

  const [download] = await Promise.all([
    authedPage.waitForEvent('download'),
    error.getByRole('button', { name: /Download instead/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('E2E Editor Scope.docx');
});

test('old PDF and spreadsheet editor links land in the document editor, keeping the file', async ({ authedPage }) => {
  await authedPage.goto('/tools/pdf?fileId=abc');
  await expect(authedPage).toHaveURL(/\/tools\/edit\?fileId=abc$/);
  await authedPage.goto('/tools/sheets?fileId=def');
  await expect(authedPage).toHaveURL(/\/tools\/edit\?fileId=def$/);
  await authedPage.goto('/pdf-editor');
  await expect(authedPage).toHaveURL(/\/tools\/edit$/);
});

test('the sidebar opens the editor landing; "Open from computer" files the upload into a project', async ({ authedPage, apiToken, request }) => {
  const { projectId, name: projectName } = await seedProjectWithPage(request, apiToken.token);

  await authedPage.goto('/dashboard');
  await authedPage.getByRole('button', { name: 'Document Editor' }).click();
  await expect(authedPage).toHaveURL(/\/tools\/edit$/);
  await expect(authedPage.getByTestId('document-editor-landing')).toBeVisible();

  await authedPage.getByRole('button', { name: /Open from computer/ }).click();
  await authedPage.getByTestId('open-computer-input').setInputFiles({ name: 'Letter.docx', mimeType: DOCX, buffer: Buffer.from('docx bytes') });
  await expect(authedPage.getByTestId('open-computer-filename')).toHaveText('Letter.docx');
  await authedPage.getByLabel('Project').selectOption({ label: projectName });
  await authedPage.getByTestId('open-computer-upload').click();

  await expect(authedPage).toHaveURL(/\/tools\/edit\?fileId=[^&]+$/);
  const fileId = new URL(authedPage.url()).searchParams.get('fileId')!;
  const meta = await (await request.get(`/api/files/${fileId}/meta`, {
    headers: { Authorization: `Bearer ${apiToken.token}` },
  })).json();
  expect(meta).toMatchObject({ name: 'Letter.docx', projectId, kind: 'document' });
});
