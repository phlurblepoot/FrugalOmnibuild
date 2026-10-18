import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { test, expect, seedProjectWithPage } from './fixtures/test';
import { connectFakeAccount, resetMailAccounts } from './fixtures/mail';

// Characterization spec for the mail client's reading surface
// (src/pages/mail/*): the three-pane shell, the thread list, the sandboxed
// message body, Save-to-Documents, the inline reply composer, archiving,
// composing a new message, and the phone-width stacked layout.
//
// Everything here runs against the in-memory FAKE provider, which the
// webServer enables with MAIL_FAKE_PROVIDER=1 (playwright.config.ts) — that
// flag is also what mounts the /api/mail/_test/seed + /inject fixture routes
// e2e/fixtures/mail.ts talks to. No live IMAP/OAuth mailbox is involved.
//
// Two rules the whole file follows:
//  - ONE fake account per test. `FakeMailProvider.seed()` clears that
//    account's whole in-memory message map, so a second seed against the same
//    account would erase the first test's mail.
//  - `resetMailAccounts` first. The suite shares one server/DB (workers:1,
//    .e2e-data is never reset between spec files), so a leftover mailbox from
//    an earlier test would decide where `/mail` redirects and would be counted
//    by the sidebar's unread badge.

/** A real (tiny) PDF, base64'd — the fake provider serves these bytes back
 *  through the attachment route the same way a provider would. */
const pdfBase64 = async (title: string): Promise<string> => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  page.drawText(title, { x: 20, y: 150, size: 14, font, color: rgb(0, 0, 0) });
  return Buffer.from(await doc.save()).toString('base64');
};

test('mail inbox: seeded threads, unread badge, blocked images, save an attachment, inline reply, archive', async ({
  authedPage, apiToken, request,
}) => {
  test.setTimeout(90_000);
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);
  const { projectId, name: projectName } = await seedProjectWithPage(request, token);

  const detailSubject = `E2E Corridor detail ${short}`;
  const scheduleSubject = `E2E Site schedule ${short}`;
  const attachmentName = `corridor-detail-${short}.pdf`;

  await resetMailAccounts(request, token);
  const { accountId, threadKeys } = await connectFakeAccount(request, token, {
    emailAddress: `inbox-${short}@e2e.test`,
    threads: [
      {
        subject: detailSubject,
        from: { addr: 'mike@tidewater.test', name: 'Mike Torres' },
        messages: [{
          text: 'The corridor detail needs a dimension.',
          // The remote <img> is the point: server/mail/sanitize.ts must park it
          // in data-blocked-src and report blockedRemoteImages > 0, which is
          // what raises the "Remote images blocked" bar.
          html: '<p>The corridor detail needs a dimension.</p><img src="https://tracker.invalid/pixel.png" alt="">',
          attachments: [{ name: attachmentName, mime: 'application/pdf', bytesBase64: await pdfBase64('Corridor detail') }],
        }],
      },
      {
        subject: scheduleSubject,
        from: { addr: 'dana@tidewater.test', name: 'Dana Lee' },
        messages: [{ text: 'Next week’s schedule is up on the portal.' }],
      },
    ],
  });
  const detailKey = threadKeys[0];

  // ── /mail lands on the only account's inbox ──────────────────────────────
  await authedPage.goto('/mail');
  await expect(authedPage).toHaveURL(new RegExp(`/mail/${accountId}/`));

  const rows = authedPage.getByTestId('mail-thread-row');
  const detailRow = rows.filter({ hasText: detailSubject });
  const scheduleRow = rows.filter({ hasText: scheduleSubject });
  await expect(detailRow).toHaveCount(1);
  await expect(scheduleRow).toHaveCount(1);
  await expect(detailRow).toHaveAttribute('data-unread', 'true');
  // Both seeded messages are unread, and this is the user's only mailbox.
  await expect(authedPage.getByTestId('sidebar-mail-badge')).toHaveText('2');

  // ── open it: subject, sandboxed body, blocked-images bar ─────────────────
  await detailRow.click();
  const thread = authedPage.getByTestId('mail-thread-slot');
  await expect(thread).toHaveAttribute('data-thread-key', detailKey);
  await expect(thread).toHaveAttribute('data-account-id', accountId);
  await expect(thread.getByRole('heading', { name: detailSubject })).toBeVisible();

  const bodyFrame = thread.getByTestId('mail-body-frame');
  await expect(bodyFrame).toBeVisible();
  // The body is rendered INSIDE the opaque-origin iframe, so assert through
  // the frame rather than on the host document.
  await expect(
    authedPage.frameLocator('[data-testid="mail-body-frame"]').locator('#__mail_root'),
  ).toContainText('The corridor detail needs a dimension.');

  const imagesBar = thread.getByTestId('mail-images-bar');
  await expect(imagesBar).toBeVisible();
  await imagesBar.getByRole('button', { name: 'Load images' }).click();
  // Re-fetched with images=1 → nothing blocked → the bar has nothing to say.
  await expect(thread.getByTestId('mail-images-bar')).toHaveCount(0);

  // ── Save to Documents… ───────────────────────────────────────────────────
  await expect(thread.getByTestId('mail-attachment-chip')).toContainText(attachmentName);
  await thread.getByTestId('mail-save-attachments').click();
  const uploadModal = authedPage.getByTestId('documents-upload-modal');
  await expect(uploadModal).toBeVisible();
  await expect(uploadModal).toContainText(attachmentName);
  await uploadModal.locator('#upload-project').selectOption(projectId);
  await expect(uploadModal.locator('#upload-project')).toHaveValue(projectId);
  await authedPage.getByRole('button', { name: 'Save 1 file' }).click();
  await expect(uploadModal).toHaveCount(0, { timeout: 15_000 });

  const docsRes = await request.get(`/api/documents?projectIds=${projectId}`, { headers: auth });
  expect(docsRes.ok()).toBeTruthy();
  const { rows: docRows } = (await docsRes.json()) as { rows: Array<{ id: string; name: string; projectName: string }> };
  const savedDoc = docRows.find(r => r.name === attachmentName);
  expect(savedDoc, `expected ${attachmentName} in ${projectName}'s documents`).toBeTruthy();
  // /api/documents has no resolver for mailMessage sources, so the source
  // attribution is asserted on the file row itself.
  const metaRes = await request.get(`/api/files/${savedDoc!.id}/meta`, { headers: auth });
  expect(metaRes.ok()).toBeTruthy();
  expect((await metaRes.json()).sourceType).toBe('mailMessage');

  // ── inline reply ─────────────────────────────────────────────────────────
  // exact: the message card's own buttons are "Reply to this message".
  await thread.getByRole('button', { name: 'Reply', exact: true }).click();
  const inlineComposer = authedPage.getByTestId('mail-composer-inline');
  await expect(inlineComposer).toBeVisible();
  await expect(inlineComposer.getByTestId('recipient-pill')).toContainText('mike@tidewater.test');
  await inlineComposer.locator('.ft-mail-body').click();
  await authedPage.keyboard.type('The corridor is 9 ft to the underside.');
  await inlineComposer.getByTestId('mail-composer-send').click();

  await expect(authedPage.getByTestId('mail-composer-inline')).toHaveCount(0, { timeout: 20_000 });
  await expect(thread.getByTestId('mail-message-card')).toHaveCount(2);

  const threadRes = await request.get(
    `/api/mail/threads/${accountId}/${encodeURIComponent(detailKey)}`,
    { headers: auth },
  );
  expect(threadRes.ok()).toBeTruthy();
  expect((await threadRes.json()).messages).toHaveLength(2);

  // The reply is the newest message, so the row sorts to the top and the
  // account owner joins the participants as "me".
  await expect(rows.first()).toContainText(detailSubject);
  await expect(detailRow.getByRole('img', { name: '2 messages' })).toBeVisible();
  await expect(detailRow).toContainText('me');

  // ── archive ──────────────────────────────────────────────────────────────
  await thread.getByRole('button', { name: 'Archive' }).click();
  await expect(rows.filter({ hasText: detailSubject })).toHaveCount(0);
  await expect(rows.filter({ hasText: scheduleSubject })).toHaveCount(1);

  await authedPage.getByTestId('mail-folder-row').filter({ hasText: 'Archive' }).click();
  await expect(rows.filter({ hasText: detailSubject })).toHaveCount(1);
});

test('mail compose: recipient autocomplete off a customer, sent message lands in Sent', async ({
  authedPage, apiToken, request,
}) => {
  test.setTimeout(60_000);
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);

  const gcEmail = `gc-${short}@tidewater.test`;
  const customerRes = await request.post('/api/customers', {
    headers: auth,
    data: { name: `E2E Mail Customer ${short}`, emails: { general: { to: gcEmail } } },
  });
  if (!customerRes.ok()) throw new Error(`customer seed failed: ${customerRes.status()} ${await customerRes.text()}`);

  await resetMailAccounts(request, token);
  const { accountId } = await connectFakeAccount(request, token, {
    emailAddress: `compose-${short}@e2e.test`,
  });

  await authedPage.goto('/mail');
  await expect(authedPage).toHaveURL(new RegExp(`/mail/${accountId}/`));

  await authedPage.getByTestId('mail-compose-open').click();
  const composer = authedPage.getByTestId('mail-composer');
  await expect(composer).toBeVisible();
  await expect(authedPage).toHaveURL(/compose=1/);

  // /api/mail/recipients indexes the customer's role addresses; picking the
  // suggestion (rather than typing the whole address) is what proves it.
  await composer.getByLabel('To').fill(`gc-${short}`);
  const suggestion = composer.getByRole('option').filter({ hasText: gcEmail });
  await expect(suggestion).toHaveCount(1);
  await suggestion.click();
  await expect(composer.getByTestId('recipient-pill')).toContainText(gcEmail);

  const subject = `E2E Compose ${short}`;
  await composer.getByLabel('Subject').fill(subject);
  await composer.locator('.ft-mail-body').click();
  await authedPage.keyboard.type('Sending this from the e2e suite.');
  await authedPage.getByTestId('mail-composer-send').click();
  await expect(authedPage.getByTestId('mail-composer')).toHaveCount(0, { timeout: 20_000 });

  await authedPage.getByTestId('mail-folder-row').filter({ hasText: 'Sent' }).click();
  const sentRow = authedPage.getByTestId('mail-thread-row').filter({ hasText: subject });
  await expect(sentRow).toHaveCount(1);
  // The account owner is always "me" in the participants label; the customer
  // contact shows under its display name, so the address itself is asserted on
  // the recorded message rather than on the row's label.
  await expect(sentRow).toContainText('me');

  const sentKey = await sentRow.getAttribute('data-thread-key');
  const sentThread = await (await request.get(
    `/api/mail/threads/${accountId}/${encodeURIComponent(sentKey!)}`,
    { headers: auth },
  )).json();
  expect(sentThread.messages).toHaveLength(1);
  expect(sentThread.messages[0].to.map((a: { addr: string }) => a.addr)).toContain(gcEmail);
});

test('mail on a phone: the list and the thread take turns, Back returns to the list', async ({
  authedPage, apiToken, request,
}) => {
  const { token } = apiToken;
  const short = randomUUID().slice(0, 8);
  const subject = `E2E Phone thread ${short}`;

  await resetMailAccounts(request, token);
  await connectFakeAccount(request, token, {
    emailAddress: `phone-${short}@e2e.test`,
    threads: [{
      subject,
      from: { addr: 'dana@tidewater.test', name: 'Dana Lee' },
      messages: [{ text: 'Reading this on a phone.' }],
    }],
  });

  // Set BEFORE the first navigation: AppShell reads the media query once, in
  // a useState initializer.
  await authedPage.setViewportSize({ width: 390, height: 800 });
  await authedPage.goto('/mail');

  const row = authedPage.getByTestId('mail-thread-row').filter({ hasText: subject });
  await expect(row).toBeVisible();
  // Below lg the reading pane is not rendered at all until a thread is picked.
  await expect(authedPage.getByTestId('mail-thread-slot')).toHaveCount(0);

  await row.click();
  await expect(authedPage.getByTestId('mail-thread-slot')).toBeVisible();
  // The list pane is `hidden lg:flex` while a thread is open.
  await expect(row).toBeHidden();

  await authedPage.getByRole('button', { name: 'Back' }).click();
  await expect(row).toBeVisible();
  await expect(authedPage.getByTestId('mail-thread-slot')).toHaveCount(0);
});
