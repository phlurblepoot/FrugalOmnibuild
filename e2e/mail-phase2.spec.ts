import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { connectFakeAccount, injectReply, resetMailAccounts } from './fixtures/mail';

// Characterization spec for Mail Phase 2's client-visible pieces
// (docs/superpowers/specs/2026-09-03-mail-phase2-design.md): linking a thread
// to a project item with a resolved-label chip (Goal 1), converting a thread
// into an RFI (Goal 2), the per-project Mail tab (Goal 5), and a reply
// indicator on a linked item (Goal 4). Cross-user opening and the reference
// card (Goal 3) are covered by ProjectMail.test.tsx / openThreadLink.test.ts
// at the unit level, so not repeated here.
//
// Runs against the in-memory FAKE mail provider (MAIL_FAKE_PROVIDER=1, set by
// playwright.config.ts's webServer). One fake account per test, and
// `resetMailAccounts` first — see the header of e2e/mail.spec.ts for why.

async function seedProject(
  request: APIRequestContext,
  token: string,
  opts: { contactEmail?: string } = {},
): Promise<{ projectId: string; projectName: string }> {
  const projectId = randomUUID();
  const projectName = `E2E Mail Phase 2 Project ${projectId.slice(0, 8)}`;
  const res = await request.post('/api/projects', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      id: projectId,
      name: projectName,
      createdAt: Date.now(),
      status: 'in_progress',
      pages: [],
      takeoffs: [],
      version: 1,
      ...(opts.contactEmail ? { contactEmails: { general: { to: opts.contactEmail } } } : {}),
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

async function seedInvoice(
  request: APIRequestContext,
  token: string,
  projectId: string,
  number: string,
): Promise<{ id: string }> {
  const res = await request.post(`/api/projects/${projectId}/invoices`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { number, lines: [] },
  });
  if (!res.ok()) throw new Error(`invoice seed failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { id: string };
}

test('link-from-thread: "+ Link" to an RFI shows a resolved-label chip, not the bare item type', async ({
  authedPage, apiToken, request,
}) => {
  test.setTimeout(60_000);
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);

  const { projectId } = await seedProject(request, token);
  const rfiTitle = `Corridor ceiling height ${short}`;
  const rfi = await seedRfi(request, token, projectId, rfiTitle);

  const subject = `E2E Link-from-thread ${short}`;
  await resetMailAccounts(request, token);
  await connectFakeAccount(request, token, {
    emailAddress: `link-${short}@e2e.test`,
    threads: [{
      subject,
      from: { addr: 'mike@tidewater.test', name: 'Mike Torres' },
      messages: [{ text: 'Can you confirm the corridor ceiling height?' }],
    }],
  });

  await authedPage.goto('/mail');
  await authedPage.getByTestId('mail-thread-row').filter({ hasText: subject }).click();
  const thread = authedPage.getByTestId('mail-thread-slot');
  await expect(thread).toBeVisible();

  await thread.getByRole('button', { name: 'Link' }).click();
  const modal = authedPage.getByTestId('link-picker-modal');
  await expect(modal).toBeVisible();

  await modal.getByRole('tab', { name: 'Item' }).click();
  await modal.locator('#link-item-project').selectOption(projectId);
  await modal.locator('#link-item-type').selectOption('rfi');
  await expect(modal.locator('#link-item-id')).toBeEnabled();
  await modal.locator('#link-item-id').selectOption(rfi.id);
  await authedPage.getByRole('dialog').getByRole('button', { name: 'Link' }).click();
  await expect(modal).toHaveCount(0);

  const expectedLabel = `RFI-${rfi.padded} — ${rfiTitle}`;
  await expect(thread.getByTestId('mail-thread-link-chip')).toHaveText(expectedLabel);

  const linksRes = await request.get(`/api/mail/links?itemType=rfi&itemId=${rfi.id}`, { headers: auth });
  expect(linksRes.ok()).toBeTruthy();
  const links = (await linksRes.json()) as Array<{ threadKey: string; label?: string }>;
  expect(links).toHaveLength(1);
  expect(links[0].label).toBe(expectedLabel);
});

test('convert-from-thread: "Create ▾" → RFI carries the subject/body and auto-links the thread', async ({
  authedPage, apiToken, request,
}) => {
  test.setTimeout(60_000);
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);

  const { projectId, projectName } = await seedProject(request, token);

  const subject = `E2E Convert to RFI ${short}`;
  const question = 'What is the required ceiling height in the main corridor?';
  await resetMailAccounts(request, token);
  await connectFakeAccount(request, token, {
    emailAddress: `convert-${short}@e2e.test`,
    threads: [{
      subject,
      from: { addr: 'mike@tidewater.test', name: 'Mike Torres' },
      messages: [{ text: question }],
    }],
  });

  await authedPage.goto('/mail');
  await authedPage.getByTestId('mail-thread-row').filter({ hasText: subject }).click();
  const thread = authedPage.getByTestId('mail-thread-slot');
  await expect(thread).toBeVisible();

  await thread.getByRole('button', { name: 'Create' }).click();
  const createMenu = authedPage.getByTestId('create-from-thread-menu');
  await expect(createMenu).toBeVisible();
  await createMenu.getByRole('menuitem', { name: 'RFI' }).click();

  // The thread has no project link yet, so the menu asks for one before it
  // will create anything.
  await createMenu.locator('#create-from-thread-project').selectOption(projectId);
  await createMenu.getByRole('button', { name: 'Create RFI' }).click();

  // Lands in the RFI list — ?open= drove the editor straight open, then
  // ProjectRfis strips it from the URL once it has (a transient param, so
  // this only asserts the destination page, not the query string).
  await expect(authedPage).toHaveURL(new RegExp(`/project/${projectId}/rfis`));
  const editor = authedPage.getByRole('dialog');
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Title')).toHaveValue(subject);
  await expect(editor.getByLabel('Question')).toHaveValue(question);

  const rfisRes = await request.get(`/api/projects/${projectId}/rfis`, { headers: auth });
  const rfis = (await rfisRes.json()) as Array<{ id: string; title: string }>;
  const created = rfis.find(r => r.title === subject);
  expect(created, `expected an RFI titled "${subject}" in ${projectName}`).toBeTruthy();

  const linksRes = await request.get(`/api/mail/links?itemType=rfi&itemId=${created!.id}`, { headers: auth });
  const links = (await linksRes.json()) as Array<{ threadKey: string }>;
  expect(links).toHaveLength(1);
});

test('project Mail tab lists a thread linked to the project', async ({ authedPage, apiToken, request }) => {
  test.setTimeout(60_000);
  const { token } = apiToken;
  const short = randomUUID().slice(0, 8);

  const { projectId } = await seedProject(request, token);
  const subject = `E2E Project Mail tab ${short}`;

  await resetMailAccounts(request, token);
  await connectFakeAccount(request, token, {
    emailAddress: `projectmail-${short}@e2e.test`,
    threads: [{
      subject,
      from: { addr: 'dana@tidewater.test', name: 'Dana Lee' },
      messages: [{ text: 'Following up on the schedule.' }],
    }],
  });

  await authedPage.goto('/mail');
  await authedPage.getByTestId('mail-thread-row').filter({ hasText: subject }).click();
  const thread = authedPage.getByTestId('mail-thread-slot');
  await expect(thread).toBeVisible();

  await thread.getByRole('button', { name: 'Link' }).click();
  const modal = authedPage.getByTestId('link-picker-modal');
  await expect(modal).toBeVisible();
  // Project mode links the whole conversation to the project directly — no
  // item drilling needed.
  await modal.getByRole('tab', { name: 'Project' }).click();
  await modal.locator('#link-project').selectOption(projectId);
  await authedPage.getByRole('dialog').getByRole('button', { name: 'Link' }).click();
  await expect(modal).toHaveCount(0);
  await expect(thread.getByTestId('mail-thread-link-chip')).toBeVisible();

  await authedPage.goto(`/project/${projectId}/mail`);
  const row = authedPage.getByTestId('project-mail-row').filter({ hasText: subject });
  await expect(row).toHaveCount(1);
  // participantsLabel: first name only, and the account owner reads as "me".
  await expect(row).toContainText('Dana');
  // Regression coverage for the earliestLinkCreatedAt fix: this thread's only
  // message predates the link (nothing was ever sent about it from this
  // project), so it must NOT read as an unanswered reply just because it was
  // linked after the fact.
  await expect(row.locator('[data-testid^="project-mail-reply-"]')).toHaveCount(0);
});

test('reply indicator: an injected reply flags a linked, sent invoice', async ({ authedPage, apiToken, request }) => {
  test.setTimeout(90_000);
  const { token } = apiToken;
  const auth = { Authorization: `Bearer ${token}` };
  const short = randomUUID().slice(0, 8);
  const gcEmail = `gc-${short}@tidewater.test`;

  const { projectId } = await seedProject(request, token, { contactEmail: gcEmail });
  const invoiceNumber = `INV-${short}`;
  const invoice = await seedInvoice(request, token, projectId, invoiceNumber);

  await resetMailAccounts(request, token);
  const { accountId } = await connectFakeAccount(request, token, { emailAddress: `invoice-reply-${short}@e2e.test` });

  await authedPage.goto(`/project/${projectId}/billing?tab=invoices`);
  await authedPage.getByRole('row').filter({ hasText: invoiceNumber }).click();
  const editor = authedPage.getByRole('dialog').filter({ hasText: `Invoice ${invoiceNumber}` });
  await expect(editor).toBeVisible();

  await editor.getByTestId('doc-send').click();
  const composer = authedPage.getByTestId('mail-composer');
  await expect(composer).toBeVisible();
  await expect(composer.getByTestId('recipient-pill')).toContainText(gcEmail);
  await authedPage.getByTestId('mail-composer-send').click();
  await expect(authedPage.getByTestId('mail-composer')).toHaveCount(0, { timeout: 60_000 });
  await expect(editor.getByTestId('invoice-reply-flag-' + invoice.id)).toHaveCount(0);

  const linksRes = await request.get(`/api/mail/links?itemType=invoice&itemId=${invoice.id}`, { headers: auth });
  const links = (await linksRes.json()) as Array<{ threadKey: string }>;
  expect(links).toHaveLength(1);
  const threadKey = links[0].threadKey;

  // exact: the Modal's own icon button is "Close dialog".
  await authedPage.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor).toHaveCount(0);

  // No reply yet: the list row carries no indicator.
  const listRow = authedPage.getByRole('row').filter({ hasText: invoiceNumber });
  await expect(listRow.getByTestId('invoice-reply-flag-' + invoice.id)).toHaveCount(0);

  await injectReply(request, token, {
    accountId,
    threadKey,
    from: { addr: 'mike@tidewater.test', name: 'Mike Torres' },
    text: 'Received, thanks — payment is scheduled for Friday.',
  });

  // useReplyFlags stays live on the `mailThread` broadcast (debounced ~1s),
  // so this should not need a manual reload.
  await expect(listRow.getByTestId('invoice-reply-flag-' + invoice.id)).toBeVisible({ timeout: 30_000 });
});
