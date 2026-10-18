import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { connectFakeAccount, injectReply, resetMailAccounts } from './fixtures/mail';

// Characterization spec for "someone emailed an answer back on this RFI":
// server/mail/inboundHooks.ts captures the inbound message as a PENDING reply
// (never an automatic answer), ProjectRfis flags the row with a Reply chip,
// and src/pages/project/rfi/PendingReplyBanner.tsx offers Use as response /
// Dismiss inside the editor.
//
// Runs against the in-memory FAKE mail provider (MAIL_FAKE_PROVIDER=1, set by
// playwright.config.ts's webServer). One fake account per test, and
// `resetMailAccounts` first — see the header of e2e/mail.spec.ts for why.

/** The reply as a real mail client would send it: the sender's own words, then
 *  an "On … wrote:" attribution and the quoted original. The banner must show
 *  only the first part (server/mail/mime.ts stripQuotedReply). */
const ANSWER = 'Corridor is 9 ft to the underside of the deck.';
const QUOTED_LINE = 'Please find the attached RFI.';
const replyBody = (): string =>
  `${ANSWER}\n\nOn Fri, 29 Aug 2026 at 10:00, FrugalOmnibuild wrote:\n> ${QUOTED_LINE}\n`;

async function seedProjectWithContact(
  request: APIRequestContext,
  token: string,
  contactEmail: string,
): Promise<string> {
  const projectId = randomUUID();
  const res = await request.post('/api/projects', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      id: projectId,
      name: `E2E RFI Reply Project ${projectId.slice(0, 8)}`,
      createdAt: Date.now(),
      status: 'in_progress',
      pages: [],
      takeoffs: [],
      version: 1,
      contactEmails: { general: { to: contactEmail } },
    },
  });
  if (!res.ok()) throw new Error(`project seed failed: ${res.status()} ${await res.text()}`);
  return projectId;
}

async function seedRfi(
  request: APIRequestContext,
  token: string,
  projectId: string,
  title: string,
): Promise<{ id: string; number: number; padded: string }> {
  const res = await request.post(`/api/projects/${projectId}/rfis`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title },
  });
  if (!res.ok()) throw new Error(`rfi seed failed: ${res.status()} ${await res.text()}`);
  const rfi = (await res.json()) as { id: string; number: number };
  return { ...rfi, padded: String(rfi.number).padStart(3, '0') };
}

/** Opens the RFI from the project's list and emails it, leaving the editor
 *  closed afterwards. Returns the thread the send created. */
async function sendRfiByEmail(
  page: Page,
  request: APIRequestContext,
  token: string,
  projectId: string,
  rfi: { id: string; padded: string },
  rfiTitle: string,
): Promise<string> {
  await page.goto(`/project/${projectId}/rfis`);
  await page.getByRole('row').filter({ hasText: rfiTitle }).click();
  await expect(page.getByRole('dialog', { name: `RFI-${rfi.padded}` })).toBeVisible();

  await page.getByTestId('doc-send').click();
  await expect(page.getByTestId('mail-composer')).toBeVisible();
  await page.getByTestId('mail-composer-send').click();
  // The PDF is generated inside this click, then sent.
  await expect(page.getByTestId('mail-composer')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Sent', exact: true })).toBeVisible();

  const links = (await (await request.get(
    `/api/mail/links?itemType=rfi&itemId=${rfi.id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )).json()) as Array<{ threadKey: string }>;
  expect(links).toHaveLength(1);

  // exact: the Modal's own icon button is "Close dialog".
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog', { name: `RFI-${rfi.padded}` })).toHaveCount(0);
  return links[0].threadKey;
}

test('emailed RFI reply: quote-stripped banner + list chip, Use as response records it as email-sourced', async ({
  authedPage, apiToken, request,
}) => {
  test.setTimeout(120_000);
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);

  const projectId = await seedProjectWithContact(request, token, `gc-${short}@tidewater.test`);
  const rfiTitle = `Corridor height ${short}`;
  const rfi = await seedRfi(request, token, projectId, rfiTitle);

  await resetMailAccounts(request, token);
  const { accountId } = await connectFakeAccount(request, token, { emailAddress: `rfi-reply-${short}@e2e.test` });

  const threadKey = await sendRfiByEmail(authedPage, request, token, projectId, rfi, rfiTitle);

  // ── the GC answers by email ──────────────────────────────────────────────
  await injectReply(request, token, {
    accountId,
    threadKey,
    from: { addr: 'mike@tidewater.test', name: 'Mike Torres' },
    text: replyBody(),
  });

  // The row flags it as soon as the sync worker has filed the message and the
  // inbound hook has captured it (a live `rfi` broadcast, no reload needed).
  const listRow = authedPage.getByRole('row').filter({ hasText: rfiTitle });
  await expect(listRow.getByText('Reply', { exact: true })).toBeVisible({ timeout: 30_000 });
  // Captured, NOT answered: the status has not moved.
  await expect(listRow.getByText('Sent', { exact: true })).toBeVisible();

  // ── the banner in the editor ─────────────────────────────────────────────
  await listRow.click();
  const editor = authedPage.getByRole('dialog', { name: `RFI-${rfi.padded}` });
  await expect(editor).toBeVisible();

  const banner = authedPage.getByTestId('rfi-pending-reply');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Reply received from Mike Torres');
  // Only the sender's own words — the "On … wrote:" attribution and everything
  // under it is stripped server-side.
  await expect(authedPage.getByTestId('rfi-pending-reply-text')).toHaveText(ANSWER);
  await expect(banner).not.toContainText(QUOTED_LINE);
  // The receiving mailbox is this user's own, so the deep link is offered.
  await expect(banner.getByTestId('rfi-pending-reply-foreign')).toHaveCount(0);

  // ── use it as the response ───────────────────────────────────────────────
  await banner.getByRole('button', { name: 'Use as response' }).click();
  await expect(editor.locator('#rfi-resp')).toHaveValue(ANSWER);

  await editor.getByRole('button', { name: 'Save response text' }).click();
  await expect(authedPage.getByTestId('rfi-pending-reply')).toHaveCount(0, { timeout: 20_000 });
  await expect(
    authedPage.getByRole('dialog', { name: `RFI-${rfi.padded}` }).getByRole('button', { name: 'Answered', exact: true }),
  ).toBeVisible();

  const answered = await (await request.get(`/api/rfis/${rfi.id}`, { headers: auth })).json();
  expect(answered.status).toBe('answered');
  expect(answered.responseText).toBe(ANSWER);
  expect(answered.responseSource).toBe('email');
  expect(answered.pendingReply ?? null).toBeNull();

  // The thread itself now carries both messages.
  const thread = await (await request.get(
    `/api/mail/threads/${accountId}/${encodeURIComponent(threadKey)}`,
    { headers: auth },
  )).json();
  expect(thread.messages).toHaveLength(2);
});

test('emailed RFI reply: Dismiss drops the banner and leaves the RFI Sent', async ({
  authedPage, apiToken, request,
}) => {
  test.setTimeout(120_000);
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);

  const projectId = await seedProjectWithContact(request, token, `gc-${short}@tidewater.test`);
  const rfiTitle = `Soffit framing ${short}`;
  const rfi = await seedRfi(request, token, projectId, rfiTitle);

  await resetMailAccounts(request, token);
  const { accountId } = await connectFakeAccount(request, token, { emailAddress: `rfi-dismiss-${short}@e2e.test` });

  const threadKey = await sendRfiByEmail(authedPage, request, token, projectId, rfi, rfiTitle);

  await injectReply(request, token, {
    accountId,
    threadKey,
    from: { addr: 'dana@tidewater.test', name: 'Dana Lee' },
    text: 'Thanks, got it — no action needed.',
  });

  const listRow = authedPage.getByRole('row').filter({ hasText: rfiTitle });
  await expect(listRow.getByText('Reply', { exact: true })).toBeVisible({ timeout: 30_000 });
  await listRow.click();

  const banner = authedPage.getByTestId('rfi-pending-reply');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Reply received from Dana Lee');
  await banner.getByRole('button', { name: 'Dismiss' }).click();

  await expect(authedPage.getByTestId('rfi-pending-reply')).toHaveCount(0, { timeout: 20_000 });
  await expect(
    authedPage.getByRole('dialog', { name: `RFI-${rfi.padded}` }).getByRole('button', { name: 'Sent', exact: true }),
  ).toBeVisible();

  const after = await (await request.get(`/api/rfis/${rfi.id}`, { headers: auth })).json();
  expect(after.status).toBe('sent');
  expect(after.responseText ?? null).toBeNull();
  expect(after.pendingReply ?? null).toBeNull();
});
