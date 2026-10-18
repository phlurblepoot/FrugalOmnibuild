import { randomUUID } from 'node:crypto';
import { test, expect, seedProjectWithPage } from './fixtures/test';
import { connectFakeAccount, resetMailAccounts } from './fixtures/mail';

// ONLYOFFICE as a viewer (Phase 6) in a real browser. The e2e server runs
// without ONLYOFFICE, so these pin the app's side: a Word attachment opens the
// viewer page in a new tab, which says why it can't show it and offers the
// download; a share link keeps its own preview. The viewer itself, and the
// Document Server fetching through the one-attachment link, are covered by
// server/onlyoffice/viewers.test.ts and the stand-in smoke run in the checklist.

test('a Word attachment opens the viewer in a new tab, with the download to fall back on', async ({ authedPage, apiToken, request, context }) => {
  const token = apiToken.token;
  const short = randomUUID().slice(0, 8);
  const subject = `E2E Revised scope ${short}`;
  await resetMailAccounts(request, token);
  const { accountId } = await connectFakeAccount(request, token, {
    emailAddress: `viewer-${short}@e2e.test`,
    threads: [{
      subject,
      from: { addr: 'mike@tidewater.test', name: 'Mike Torres' },
      messages: [{
        text: 'Revised scope attached.',
        attachments: [{ name: 'Scope.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytesBase64: Buffer.from('docx').toString('base64') }],
      }],
    }],
  });

  await authedPage.goto(`/mail/${accountId}`);
  await authedPage.getByTestId('mail-thread-row').filter({ hasText: subject }).click();
  const chip = authedPage.getByTestId('mail-thread-slot').getByTestId('mail-attachment-chip').filter({ hasText: 'Scope.docx' });
  await expect(chip).toHaveAttribute('data-opens', 'viewer');

  const [tab] = await Promise.all([context.waitForEvent('page'), chip.click()]);
  await tab.waitForLoadState();
  await expect(tab).toHaveURL(/\/tools\/view\?message=.+&att=.+&name=Scope\.docx$/);
  await expect(tab.getByTestId('attachment-viewer-error')).toContainText("Can't show Scope.docx here");
  await expect(tab.getByTestId('attachment-viewer-error')).toContainText("isn't set up");
  const download = tab.getByRole('link', { name: /Download it instead/ });
  await expect(download).toHaveAttribute('href', /\/api\/mail\/messages\/.+\/attachments\/.+\?token=/);
  const res = await tab.request.get(await download.getAttribute('href') as string);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe('docx');
});

test('a shared PDF keeps its own preview while the viewer is not set up', async ({ page, apiToken, request }) => {
  const auth = { Authorization: `Bearer ${apiToken.token}` };
  const { projectId } = await seedProjectWithPage(request, apiToken.token);
  const fileId = randomUUID();
  await request.post(`/api/files/${fileId}?kind=takeoff-print&projectId=${projectId}&name=Bid%20set.pdf`, { headers: { ...auth, 'Content-Type': 'application/pdf' }, data: Buffer.from('%PDF-1.4\n%%EOF') });
  const share = await (await request.post('/api/shares', { headers: auth, data: { type: 'printout', resourceId: fileId, name: 'Bid set' } })).json();
  const info = await (await request.get(`/api/share/${share.id}/info`)).json();
  expect(info).toMatchObject({ type: 'printout', viewer: false });
  expect((await request.get(`/api/share/${share.id}/viewer`)).status()).toBe(503);

  await page.goto(`/share/${share.id}`);
  await expect(page.locator('object[type="application/pdf"]')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', `/api/share/${share.id}?download=1`);
  await expect(page.getByTestId('share-viewer')).toHaveCount(0);
});
