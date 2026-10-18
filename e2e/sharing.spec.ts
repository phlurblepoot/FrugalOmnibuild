import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { test, expect, seedProjectWithPage } from './fixtures/test';

// Sharing (ONLYOFFICE Phase 7) in a real browser: any document shares from
// its row menu with a chosen expiry, opens for someone signed out, and stops
// working when sharing is stopped; several documents share under one link
// from the bulk bar; a plan page's link is made as its window opens. Expired
// links, who may share what, and every public route turning a dead link away
// are covered by server/shares.test.ts (an e2e can't wind the clock).
//
// Rows are scoped to a fresh project per test and to the desktop table, as in
// e2e/documents.spec.ts (the suite shares one database).

const tableRows = (page: Page) => page.locator('table [data-testid="documents-row"]');
const rowFor = (page: Page, name: string) => tableRows(page).filter({ hasText: name });

const upload = async (request: APIRequestContext, token: string, projectId: string, name: string, mime: string, body: string) => {
  const res = await request.post(`/api/files/${randomUUID()}?projectId=${projectId}&kind=document&name=${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime }, data: Buffer.from(body),
  });
  if (!res.ok()) throw new Error(`upload failed: ${res.status()} ${await res.text()}`);
};

/** The id at the end of the link the share window shows. */
const shownLinkId = async (page: Page) => {
  const url = await page.getByTestId('share-dialog').getByLabel('Share URL').inputValue();
  expect(url).toMatch(/\/share\/[0-9a-f-]{36}$/);
  return url.split('/share/')[1];
};

/** A browser with nobody signed in. */
const signedOut = async (browser: Browser, baseURL: string | undefined) => {
  const ctx = await browser.newContext({ baseURL });
  return { page: await ctx.newPage(), close: () => ctx.close() };
};

test('any document: share with an expiry, open signed out, stop sharing', async ({ authedPage, request, apiToken, browser, baseURL }) => {
  const { projectId } = await seedProjectWithPage(request, apiToken.token);
  const name = `share-notes-${randomUUID().slice(0, 8)}.txt`;
  await upload(request, apiToken.token, projectId, name, 'text/plain', 'site notes');

  await authedPage.goto(`/documents?projectIds=${projectId}`);
  await rowFor(authedPage, name).click({ button: 'right' });
  await authedPage.getByTestId('doc-context-menu').getByRole('menuitem', { name: 'Share…' }).click();
  const dialog = authedPage.getByTestId('share-dialog');
  await expect(dialog.getByTestId('share-links-empty')).toHaveText('Not shared yet.');
  await expect(dialog.getByTestId('share-expiry-30')).toHaveAttribute('aria-checked', 'true');
  await dialog.getByTestId('share-expiry-7').click();
  await dialog.getByTestId('share-create').click();
  const id = await shownLinkId(authedPage);
  await expect(dialog.getByTestId('share-current-expiry')).toHaveText(/^Expires /);
  await expect(dialog.getByTestId('share-link-row')).toHaveCount(1);
  const info = await (await request.get(`/api/share/${id}/info`)).json();
  expect(info.expiresAt - Date.now()).toBeGreaterThan(6 * 86_400_000);
  expect(info.expiresAt - Date.now()).toBeLessThan(7 * 86_400_000 + 60_000);

  const guest = await signedOut(browser, baseURL);
  await guest.page.goto(`/share/${id}`);
  await expect(guest.page.getByRole('heading', { name })).toBeVisible();
  await expect(guest.page.getByTestId('share-expiry-note')).toHaveText(/^Link expires /);
  await expect(guest.page.getByTestId('share-download-card')).toBeVisible();
  const download = guest.page.getByRole('link', { name: 'Download', exact: true });
  await expect(download).toHaveAttribute('href', `/api/share/${id}?download=1`);
  expect(await (await guest.page.request.get(`/api/share/${id}?download=1`)).text()).toBe('site notes');

  await dialog.getByTestId('share-stop').click();
  await authedPage.getByRole('dialog', { name: 'Stop sharing?' }).getByRole('button', { name: 'Stop sharing' }).click();
  await expect(dialog.getByTestId('share-links-empty')).toBeVisible();

  await guest.page.reload();
  await expect(guest.page.getByTestId('share-problem')).toHaveAttribute('data-problem', 'revoked');
  await expect(guest.page.getByRole('heading', { name: 'This link was turned off' })).toBeVisible();
  expect((await guest.page.request.get(`/api/share/${id}?download=1`)).status()).toBe(410);
  await guest.close();
});

test('several documents under one link, from the bulk bar', async ({ authedPage, request, apiToken, browser, baseURL }) => {
  const { projectId, name: projectName } = await seedProjectWithPage(request, apiToken.token);
  const short = randomUUID().slice(0, 8);
  const pdf = `bid-set-${short}.pdf`;
  const txt = `scope-${short}.txt`;
  await upload(request, apiToken.token, projectId, pdf, 'application/pdf', '%PDF-1.4\n%%EOF');
  await upload(request, apiToken.token, projectId, txt, 'text/plain', 'scope text');

  await authedPage.goto(`/documents?projectIds=${projectId}`);
  await expect(tableRows(authedPage)).toHaveCount(2);
  const selectAll = authedPage.locator('table thead').getByRole('checkbox', { name: 'Select all documents' });
  await selectAll.click();
  await expect(selectAll).toBeChecked();
  await authedPage.getByTestId('documents-bulk-share').click();
  const dialog = authedPage.getByTestId('share-dialog');
  await expect(dialog.getByRole('heading', { name: 'Share 2 documents' })).toBeVisible();
  await expect(dialog.getByTestId('share-file-names')).toContainText('One link to 2 documents');
  await dialog.getByTestId('share-create').click();
  const id = await shownLinkId(authedPage);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // The link shows among each document's links.
  await rowFor(authedPage, pdf).click({ button: 'right' });
  await authedPage.getByTestId('doc-context-menu').getByRole('menuitem', { name: 'Share…' }).click();
  await expect(dialog.getByTestId('share-link-row')).toHaveCount(1);
  await expect(dialog.getByTestId('share-link-row')).toContainText('with 1 other document');
  await expect(dialog.getByTestId('share-link-row')).toContainText(id);

  const guest = await signedOut(browser, baseURL);
  await guest.page.goto(`/share/${id}`);
  await expect(guest.page.getByRole('heading', { name: `${projectName}: 2 documents` })).toBeVisible();
  const rows = guest.page.getByTestId('share-file-row');
  await expect(rows).toHaveCount(2);
  await guest.page.getByTestId('share-file-open').filter({ hasText: pdf }).click();
  await expect(guest.page).toHaveURL(/\?f=\d$/);
  await expect(guest.page.getByRole('heading', { name: pdf })).toBeVisible();
  await expect(guest.page.locator('object[type="application/pdf"]')).toHaveCount(1);
  await guest.page.getByTestId('share-back').click();
  await expect(rows).toHaveCount(2);
  const txtRow = rows.filter({ hasText: txt });
  const href = await txtRow.getByRole('link', { name: `Download ${txt}` }).getAttribute('href');
  expect(await (await guest.page.request.get(href as string)).text()).toBe('scope text');

  // Stopping it from one document stops it for both.
  await dialog.getByTestId('share-stop').click();
  await expect(authedPage.getByRole('dialog', { name: 'Stop sharing?' })).toContainText('opens 2 documents');
  await authedPage.getByRole('dialog', { name: 'Stop sharing?' }).getByRole('button', { name: 'Stop sharing' }).click();
  await expect(dialog.getByTestId('share-links-empty')).toBeVisible();
  await guest.page.reload();
  await expect(guest.page.getByTestId('share-problem')).toHaveAttribute('data-problem', 'revoked');
  await guest.close();
});

test("a plan page's link is made as its window opens", async ({ authedPage, request, apiToken, browser, baseURL }) => {
  const { projectId } = await seedProjectWithPage(request, apiToken.token);
  await authedPage.goto(`/project/${projectId}/takeoff`);
  const row = authedPage.getByTestId('page-row').first();
  await row.hover();
  await row.getByTitle('Share page').click();
  const dialog = authedPage.getByTestId('share-dialog');
  const id = await shownLinkId(authedPage);
  await expect(dialog.getByTestId('share-current-expiry')).toHaveText(/^Expires /);
  await expect(dialog.getByTestId('share-link-row')).toHaveCount(1);

  const guest = await signedOut(browser, baseURL);
  const image = await guest.page.request.get(`/api/share/${id}`);
  expect([image.status(), image.headers()['content-type']]).toEqual([200, 'image/png']);
  await guest.close();
});
