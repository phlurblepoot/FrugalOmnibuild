import type { APIRequestContext } from '@playwright/test';

// Talks to the test-only fixture routes in server/mail/routes.ts
// (`POST /api/mail/_test/seed` / `.../inject`), which only exist when the
// server is started with MAIL_FAKE_PROVIDER=1 — see playwright.config.ts's
// webServer env. Specs that need a mail account with real threads (not a
// live IMAP/OAuth mailbox) use these instead of talking to a provider.

export interface FakeAddr { addr: string; name?: string }
export interface FakeAttachment { name: string; mime: string; bytesBase64: string }
export interface FakeThreadMessage { text: string; html?: string; date?: string; attachments?: FakeAttachment[] }
export interface FakeThreadSpec { subject: string; from: FakeAddr; messages: FakeThreadMessage[] }

/**
 * Delete every FAKE-provider mail account this token owns (cascading its
 * folders, threads and messages). Specs call this BEFORE `connectFakeAccount`
 * so each one owns the only mailbox on the shared server/DB: `/mail` then
 * redirects to a known account, the sidebar's unread badge counts only this
 * test's mail, and the fresh account id gets a fresh `FakeMailProvider` (whose
 * `seed()` clears its whole in-memory map, so one account per scenario is the
 * rule).
 *
 * DATA SAFETY — this is the destructive step in the mail suite, and
 * `reuseExistingServer: !CI` means a bare `npm run test:e2e` on a dev box
 * points it at whatever server is already on the port. That can be a REAL
 * dev/LAN instance holding a real connected Gmail/IMAP mailbox. Two guards,
 * both no-ops inside the e2e webServer (which only ever has `fake` accounts):
 *
 *   1. If ANY non-fake account exists we throw before deleting ANYTHING, so
 *      the whole suite aborts instead of cascading away a live mailbox.
 *   2. The delete loop itself is filtered to `provider === 'fake'`, so even a
 *      future caller that skips guard 1 cannot touch a real account.
 *
 * Throws if any request fails.
 */
export async function resetMailAccounts(request: APIRequestContext, token: string): Promise<void> {
  const headers = { Authorization: `Bearer ${token}` };
  const res = await request.get('/api/mail/accounts', { headers });
  if (!res.ok()) throw new Error(`resetMailAccounts list failed: ${res.status()} ${await res.text()}`);
  const accounts = (await res.json()) as Array<{ id: string; provider?: string }>;

  const real = accounts.filter(a => a.provider !== 'fake');
  if (real.length) {
    throw new Error(
      'Refusing to run mail e2e against a server with real mail accounts ' +
      `(found ${real.length}: ${real.map(a => a.provider ?? 'unknown').join(', ')}). ` +
      'The mail specs delete mail accounts — point them at a throwaway server ' +
      '(stop the dev server so playwright starts its own with MAIL_FAKE_PROVIDER=1).'
    );
  }

  for (const a of accounts.filter(a => a.provider === 'fake')) {
    const del = await request.delete(`/api/mail/accounts/${encodeURIComponent(a.id)}`, { headers });
    if (!del.ok()) throw new Error(`resetMailAccounts delete failed: ${del.status()} ${await del.text()}`);
  }
}

export interface ConnectFakeAccountResult {
  accountId: string;
  /** One threadKey per seeded thread, in the same order as `opts.threads`. */
  threadKeys: string[];
}

/**
 * Create-or-reuse a `fake`-provider mail account for the given token and seed
 * it with `opts.threads` via `POST /api/mail/_test/seed`. Threads are proper
 * References/In-Reply-To chains, so they thread the same way real mail does.
 * Throws if the request fails (including a 404 — the flag was not set).
 */
export async function connectFakeAccount(
  request: APIRequestContext,
  token: string,
  opts: { emailAddress?: string; threads?: FakeThreadSpec[] } = {},
): Promise<ConnectFakeAccountResult> {
  const res = await request.post('/api/mail/_test/seed', {
    headers: { Authorization: `Bearer ${token}` },
    data: { emailAddress: opts.emailAddress, threads: opts.threads ?? [] },
  });
  if (!res.ok()) {
    throw new Error(`connectFakeAccount failed: ${res.status()} ${await res.text()}`);
  }
  return (await res.json()) as ConnectFakeAccountResult;
}

/**
 * Inject an inbound message onto an existing thread (or chain it off a
 * specific message via `inReplyToMessageId`) of a fake account, via
 * `POST /api/mail/_test/inject`. Fire-and-forget on the server side — the
 * app learns about it through the same `mailThread` broadcast a real inbound
 * message would produce, so a spec should assert via the UI (auto-retrying),
 * not assume the reply has landed the instant this resolves.
 * Throws if the request fails.
 */
export async function injectReply(
  request: APIRequestContext,
  token: string,
  opts: {
    accountId: string;
    threadKey?: string;
    inReplyToMessageId?: string;
    from: FakeAddr;
    subject?: string;
    text: string;
    html?: string;
    attachments?: FakeAttachment[];
  },
): Promise<void> {
  const res = await request.post('/api/mail/_test/inject', {
    headers: { Authorization: `Bearer ${token}` },
    data: opts,
  });
  if (!res.ok()) {
    throw new Error(`injectReply failed: ${res.status()} ${await res.text()}`);
  }
}
