import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { connectFakeAccount, resetMailAccounts } from './fixtures/mail';

// Characterization spec for sending an app document through the mail client:
// the DocumentActionsBar's Email button (src/components/documents/
// DocumentActionsBar.tsx) opening the shared MailComposer, the item send route
// stamping the record, the SentThreadChip that deep-links into the resulting
// conversation, and the "no mailbox → Send is blocked" gate.
//
// The RFI editor is the item under test because an RFI send is open to any
// authenticated user (no admin gate) and its status transition is visible in
// the editor itself.
//
// Runs against the in-memory FAKE mail provider (MAIL_FAKE_PROVIDER=1, set by
// playwright.config.ts's webServer). One fake account per test, and
// `resetMailAccounts` first — see the header of e2e/mail.spec.ts for why.

/** A project carrying a general contact email, so useItemEmailDefaults can
 *  resolve a recipient for the RFI composer (resolveRecipient falls back
 *  project.<role> → customer.<role> → project.general → customer.general). */
async function seedProjectWithContact(
  request: APIRequestContext,
  token: string,
  contactEmail: string,
): Promise<{ projectId: string; projectName: string }> {
  const auth = { Authorization: `Bearer ${token}` };
  const projectId = randomUUID();
  const projectName = `E2E RFI Mail Project ${projectId.slice(0, 8)}`;
  const res = await request.post('/api/projects', {
    headers: auth,
    data: {
      id: projectId,
      name: projectName,
      createdAt: Date.now(),
      status: 'in_progress',
      pages: [],
      takeoffs: [],
      version: 1,
      contactEmails: { general: { to: contactEmail } },
    },
  });
  if (!res.ok()) throw new Error(`project seed failed: ${res.status()} ${await res.text()}`);
  return { projectId, projectName };
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

test('RFI Email: prefilled composer, send stamps Sent + links a thread, second send replies in it', async ({
  authedPage, apiToken, request,
}) => {
  test.setTimeout(180_000);
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);
  const gcEmail = `gc-${short}@tidewater.test`;

  const { projectId } = await seedProjectWithContact(request, token, gcEmail);
  const rfiTitle = `Corridor ceiling height ${short}`;
  const rfi = await seedRfi(request, token, projectId, rfiTitle);

  await resetMailAccounts(request, token);
  const { accountId } = await connectFakeAccount(request, token, { emailAddress: `rfi-send-${short}@e2e.test` });

  await authedPage.goto(`/project/${projectId}/rfis`);
  await authedPage.getByRole('row').filter({ hasText: rfiTitle }).click();

  const editor = authedPage.getByRole('dialog', { name: `RFI-${rfi.padded}` });
  await expect(editor).toBeVisible();
  await expect(authedPage.getByTestId('doc-status')).toHaveText('No PDF yet');
  await expect(authedPage.getByTestId('doc-open')).toHaveCount(0);

  // ── first send ───────────────────────────────────────────────────────────
  const sendButton = authedPage.getByTestId('doc-send');
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  const composer = authedPage.getByTestId('mail-composer');
  await expect(composer).toBeVisible();
  // Prefilled from the project's contact email, with the not-yet-built RFI PDF
  // shown as the fixed primary attachment.
  await expect(composer.getByTestId('recipient-pill')).toContainText(gcEmail);
  await expect(composer.getByTestId('primary-attachment-chip')).toContainText(`RFI-${rfi.padded}.pdf`);
  // Nothing has been emailed yet, so there is no thread to reply into.
  await expect(composer.getByRole('radio', { name: /Reply in existing thread/ })).toHaveCount(0);

  await authedPage.getByTestId('mail-composer-send').click();
  // Generating the PDF and sending it happen inside this one click.
  await expect(authedPage.getByTestId('mail-composer')).toHaveCount(0, { timeout: 60_000 });

  // The send route stamped the RFI, and the editor refreshed without remounting.
  await expect(editor.getByRole('button', { name: 'Sent', exact: true })).toBeVisible();
  const rfiAfterSend = await (await request.get(`/api/rfis/${rfi.id}`, { headers: auth })).json();
  expect(rfiAfterSend.status).toBe('sent');
  // markRfiSent bumps updatedAt AFTER the PDF was persisted, so the stored
  // document is legitimately behind the record now.
  await expect(authedPage.getByTestId('doc-status')).toHaveText('PDF out of date');

  const linksRes = await request.get(`/api/mail/links?itemType=rfi&itemId=${rfi.id}`, { headers: auth });
  expect(linksRes.ok()).toBeTruthy();
  const links = (await linksRes.json()) as Array<{ threadKey: string }>;
  expect(links).toHaveLength(1);
  const threadKey = links[0].threadKey;

  // ── the chip deep-links into the conversation ────────────────────────────
  const chip = authedPage.getByTestId('doc-sent-thread');
  await expect(chip).toContainText('Open thread');
  await chip.click();
  await expect(authedPage).toHaveURL(new RegExp(`/mail/${accountId}/_/`));
  const thread = authedPage.getByTestId('mail-thread-slot');
  await expect(thread).toHaveAttribute('data-thread-key', threadKey);
  await expect(thread.getByTestId('mail-attachment-chip')).toContainText(`RFI-${rfi.padded}.pdf`);
  // Mail phase 2 (Goal 1): link chips show the resolved item label, not the
  // bare item type.
  await expect(thread.getByTestId('mail-thread-link-chip')).toHaveText(`RFI-${rfi.padded} — ${rfiTitle}`);

  // ── second send: offered the thread this one started ─────────────────────
  await authedPage.goto(`/project/${projectId}/rfis`);
  await authedPage.getByRole('row').filter({ hasText: rfiTitle }).click();
  await expect(authedPage.getByRole('dialog', { name: `RFI-${rfi.padded}` })).toBeVisible();
  await authedPage.getByTestId('doc-send').click();

  const composer2 = authedPage.getByTestId('mail-composer');
  await expect(composer2).toBeVisible();
  const replyInThread = composer2.getByRole('radio', { name: /Reply in existing thread/ });
  await expect(replyInThread).toBeChecked();
  await authedPage.getByTestId('mail-composer-send').click();

  // The stored PDF is out of date, so the bar rebuilds it as a new version
  // (no prompt) and sends that.
  await expect(authedPage.getByTestId('mail-composer')).toHaveCount(0, { timeout: 60_000 });

  const threadRes = await request.get(
    `/api/mail/threads/${accountId}/${encodeURIComponent(threadKey)}`,
    { headers: auth },
  );
  expect(threadRes.ok()).toBeTruthy();
  expect((await threadRes.json()).messages).toHaveLength(2);

  // Same thread, same item — createLink dedupes on (threadKey, itemType, itemId).
  const linksAfter = await (await request.get(`/api/mail/links?itemType=rfi&itemId=${rfi.id}`, { headers: auth })).json();
  expect(linksAfter).toHaveLength(1);
});

test('RFI Email is blocked once the last mail account is removed', async ({ authedPage, apiToken, request }) => {
  test.setTimeout(60_000);
  const { token } = apiToken;
  const short = randomUUID().slice(0, 8);

  const { projectId } = await seedProjectWithContact(request, token, `gc-${short}@tidewater.test`);
  const rfiTitle = `Slab edge detail ${short}`;
  const rfi = await seedRfi(request, token, projectId, rfiTitle);

  await resetMailAccounts(request, token);
  const { accountId } = await connectFakeAccount(request, token, { emailAddress: `rfi-block-${short}@e2e.test` });

  // Remove it through the real Settings → Mail flow rather than the API, since
  // that is the path the blocked-reason copy points the user at.
  await authedPage.goto('/settings?tab=mail');
  const card = authedPage.getByTestId(`mail-account-${accountId}`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Remove' }).click();
  await authedPage
    .getByRole('dialog', { name: 'Remove this mail account?' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(card).toHaveCount(0);

  await authedPage.goto(`/project/${projectId}/rfis`);
  await authedPage.getByRole('row').filter({ hasText: rfiTitle }).click();
  await expect(authedPage.getByRole('dialog', { name: `RFI-${rfi.padded}` })).toBeVisible();

  const sendButton = authedPage.getByTestId('doc-send');
  await expect(sendButton).toBeDisabled();
  await expect(sendButton).toHaveAttribute('title', 'Connect a mail account in Settings → Mail');
  // Generating a PDF is still fine — only sending it has nowhere to go.
  await expect(authedPage.getByTestId('doc-generate')).toBeEnabled();
});
