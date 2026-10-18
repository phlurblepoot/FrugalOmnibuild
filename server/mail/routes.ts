// server/mail/routes.ts  (spec §4.4)
import express from 'express';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import type { MailContext } from './context';
import * as accounts from './accountStore';
import { upsertEnvelopes, rebuildThread, runBackfill } from './sync/engine';
import { sanitizeEmailHtml, cleanDraftHtml } from './sanitize';
import { htmlToText, newMessageIdHeader } from './mime';
import { send, MailSendError, resolveAttachments, replyHeaders, MAX_DRAFT_ATTACHMENT_BYTES } from './sendService';
import { createLink, deleteLink, listLinksForItem, listLinksForThread, resolveLinkLabel, type ItemType } from './links';
import { normalizeSubject } from './threadKey';
import { stageUpload, touchUpload } from './uploads';
import { buildAuthUrl, createVerifier, challengeOf, signState, verifyState, exchangeCode, isOAuthProvider, redactGrant, redirectUri } from './oauth';
import { getWebhookSecret, getGooglePushSecret, handleGraphWebhook, handleGoogleWebhook, releaseGmailWatch, constantTimeEquals, WEBHOOK_PATH, GOOGLE_WEBHOOK_PATH } from './push';
import { putBuffer } from '../files';
import { listCustomers } from '../customerStore';
import type { BodyCache } from './sync/bodyCache';
import { AttachmentTooLargeError } from './providers/types';
import type { AttachmentMeta, AttachmentHint, Addr, MailProvider, MoveResult, OutgoingAttachment } from './providers/types';
import { AuthExpiredError, ProviderNotFoundError } from './providers/types';
import { getFakeProvider } from './providers/fakeRegistry';
import type { Seeded } from './providers/fake';
import type { AttachmentViewer } from '../onlyoffice/viewers';
import { setUntrustedContentHeaders } from '../untrustedContent';

export interface BodyPayload { html: string; text: string; blockedRemoteImages: number; attachments: AttachmentMeta[] }
export interface MailRouteDeps {
  ctx: MailContext;
  authenticateToken: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  verifyToken: (token: string) => { id: string; role: string } | null;
  bodyCache: BodyCache<BodyPayload>;
  publicUrl: string | null;
  env: NodeJS.ProcessEnv;
  /** The app's own JWT secret — signs the OAuth `state` envelope. */
  jwtSecret: string;
  /** Word/Excel/PowerPoint attachments in the ONLYOFFICE viewer (Phase 6,
   *  server/onlyoffice/viewers.ts). Without it they only download. */
  attachmentViewer?: AttachmentViewer;
  /** Injectable so route tests never reach a real provider. */
  oauthExchange?: typeof exchangeCode;
  /** Rate limiter for the unauthenticated Graph webhook. Injectable so a test
   *  can assert the limiter is consulted; defaults to WEBHOOK_RATE_LIMIT_PER_MIN. */
  webhookRateLimit?: express.RequestHandler;
  /** The same, for the unauthenticated Pub/Sub webhook — its own instance, so a
   *  burst from one provider cannot throttle the other. */
  googleWebhookRateLimit?: express.RequestHandler;
}

/** Graph batches change notifications, but a batch is a handful of ids — a body
 *  anywhere near this is not Microsoft. Also mounted as the webhook's own JSON
 *  limit, so the app-level parser's (much larger) limit does not apply here. */
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/** Per-IP ceiling on the Graph webhook. Graph batches its notifications, so a
 *  busy tenant sits far under this — it is here to cap an abusive caller, not
 *  to shape real traffic, and the old 120 was low enough that a burst across
 *  several accounts could trip it and cost real notifications. */
export const WEBHOOK_RATE_LIMIT_PER_MIN = 600;

/** The limiter for WEBHOOK_PATH. Exported (and parameterised) so a test can
 *  drive the throttle without issuing hundreds of requests. */
export function createWebhookRateLimit(max: number = WEBHOOK_RATE_LIMIT_PER_MIN, label = 'Graph'): express.RequestHandler {
  // Dropped notifications are invisible otherwise — the only symptom is mail
  // that arrives late. One line a minute names the cause without flooding the
  // log with the very burst that tripped the limit.
  let lastWarnedAt = 0;
  return rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      const now = Date.now();
      if (now - lastWarnedAt >= 60_000) {
        lastWarnedAt = now;
        console.warn(`[mail] ${label} webhook rate limit hit (${max}/min per IP) — notifications are being dropped`);
      }
      res.status(429).json({ error: 'Too many notifications' });
    },
  });
}

// The runtime twin of the ItemType union — typed as ItemType[] so a typo here is a compile error.
const ITEM_TYPES: readonly ItemType[] = ['proposal', 'invoice', 'changeOrder', 'lienRelease', 'payApp', 'issue', 'rfi', 'dailyReport', 'punch', 'task', 'project', 'customer'];
const isItemType = (v: unknown): v is ItemType => typeof v === 'string' && (ITEM_TYPES as readonly string[]).includes(v);

const ACTIONS = ['read', 'unread', 'star', 'unstar', 'archive', 'trash', 'move'] as const;
type Action = (typeof ACTIONS)[number];
const isAction = (v: unknown): v is Action => typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);

/* eslint-disable @typescript-eslint/no-explicit-any */
type MessageRowRaw = any;

// mail_messages row → client shape: JSON columns parsed, provider ids withheld.
const parseRow = (r: MessageRowRaw) => ({
  id: r.id, accountId: r.accountId, threadKey: r.threadKey, messageIdHeader: r.messageIdHeader, inReplyTo: r.inReplyTo,
  references: JSON.parse(r.referencesJson || '[]'),
  from: r.fromAddr ? { addr: r.fromAddr, name: r.fromName ?? undefined } : null,
  to: JSON.parse(r.toJson), cc: JSON.parse(r.ccJson), bcc: JSON.parse(r.bccJson),
  subject: r.subject, snippet: r.snippet, date: r.date,
  isRead: !!r.isRead, isStarred: !!r.isStarred, isDraft: !!r.isDraft, hasAttachments: !!r.hasAttachments,
  attachments: JSON.parse(r.attachmentsJson), sizeBytes: r.sizeBytes, folderIds: JSON.parse(r.folderIdsJson), sentFromApp: !!r.sentFromApp,
});

export function registerMailRoutes(app: express.Express, deps: MailRouteDeps): void {
  const { ctx, authenticateToken, requireAdmin } = deps;
  const { db } = ctx;
  const userOf = (req: express.Request) => (req as any).user as { id: string; role: string };
  const owned = (req: express.Request, accountId: string) => accounts.getOwned(db, userOf(req).id, accountId);
  const providerFor = (accountId: string): MailProvider => ctx.scheduler
    ? ctx.scheduler.getProvider(accountId)
    : ctx.providerFactory(accounts.getAccountAny(db, accountId)!, accounts.readAuth(db, ctx.crypto, accountId)!);
  const ownedMessage = (req: express.Request, id: string): MessageRowRaw | undefined =>
    db.prepare('SELECT m.* FROM mail_messages m JOIN mail_accounts a ON a.id = m.accountId WHERE m.id = ? AND a.userId = ?').get(id, userOf(req).id);

  // Mirrors /api/files/:id/content: <img>/<a download> can't set an Authorization header.
  const authOrQueryToken: express.RequestHandler = (req, res, next) => {
    const t = typeof req.query.token === 'string' ? req.query.token : null;
    if (t) {
      const u = deps.verifyToken(t);
      if (!u) return res.status(401).json({ error: 'Invalid token' });
      (req as any).user = u;
      return next();
    }
    return authenticateToken(req, res, next);
  };

  const fail = (res: express.Response, e: any, fallback: string) => {
    if (e instanceof MailSendError) return res.status(e.status).json({ error: e.message });
    if (e instanceof AttachmentTooLargeError) return res.status(413).json({ error: e.message });
    if (e instanceof AuthExpiredError) return res.status(409).json({ error: 'Mail account needs to be reconnected', code: 'auth_error' });
    // Spec §7: a provider's raw error can carry hosts, credentials or internal
    // detail. The client gets a fixed string; the detail stays in the log.
    console.error(fallback, e);
    return res.status(502).json({ error: 'Mail provider request failed' });
  };

  // NodeJS.ReadableStream has no destroy() in its type; provider streams are
  // real Readables, so release the socket when we stop reading early.
  const endStream = (stream: NodeJS.ReadableStream) => { (stream as { destroy?: () => void }).destroy?.(); };
  const itemError = (e: unknown) =>
    e instanceof MailSendError ? e.message
      : e instanceof AuthExpiredError ? 'Mail account needs to be reconnected'
        : 'Could not save this attachment';

  /** One request's memo of a message's re-read part list. Shared across a
   *  multi-attachment save so the recovery costs ONE getBody, not one per
   *  item, and so only the first recovery writes and broadcasts. */
  interface FreshParts { list: AttachmentMeta[] | null }

  /** The entry in a freshly read part list that is the same file as `want`:
   *  by name AND size, or failing that by the position the stale entry held
   *  (`at`), still requiring the name to agree. */
  const sameFile = (fresh: AttachmentMeta[], want: AttachmentMeta | null, at: number): AttachmentMeta | undefined =>
    want
      ? (fresh.find(f => f.name === want.name && f.size === want.size)
        ?? (at >= 0 && at < fresh.length && fresh[at]?.name === want.name ? fresh[at] : undefined))
      : undefined;

  /** What we can tell the provider about a part so it need not read the
   *  message to learn it (see AttachmentHint). */
  const hintOf = (meta: AttachmentMeta | null | undefined): AttachmentHint | undefined =>
    meta ? { name: meta.name, mime: meta.mime || 'application/octet-stream' } : undefined;

  /**
   * getAttachment, but tolerant of an attachment id that has gone stale.
   *
   * Gmail's `attachmentId`s are NOT durable: they are minted per message fetch
   * and change when the message is re-indexed, so the ids we wrote into
   * `mail_messages.attachmentsJson` at SYNC time routinely 404 by the time the
   * user clicks the chip days later — which is exactly what "attachment save
   * fails" looked like against a real mailbox.
   *
   * On a 404 (and only a 404), re-read the message for a fresh part list, find
   * the same file in it (sameFile) and retry.
   *
   * Two rules keep a multi-item batch to ONE message read in total, which is
   * what makes it work at all: every read mints new ids, so a second read
   * anywhere strands whatever the first one returned.
   *  - The provider is always given the part's name and MIME type, so it never
   *    reads the message on its own to look an unknown id up.
   *  - Once a batch has paid for its read (`cache.list`), every later item is
   *    resolved against that list FIRST and fetched under its live id — the
   *    stale id is not even tried.
   *
   * `wanted` is resolved by the CALLER from a snapshot of the indexed list
   * taken before the batch began, and deliberately not re-read from the row
   * here: the first recovery rewrites that row with the fresh ids, so a second
   * item looking itself up afterwards would no longer find its own stale id and
   * would fail with the very 404 this exists to absorb.
   */
  const getAttachmentFresh = async (
    m: MessageRowRaw,
    wanted: { attId: string; meta: AttachmentMeta | null; index: number },
    cache: FreshParts = { list: null },
  ): Promise<{ att: Awaited<ReturnType<MailProvider['getAttachment']>>; attId: string }> => {
    const provider = providerFor(m.accountId);
    const { attId, meta: want, index: at } = wanted;
    const known = cache.list && sameFile(cache.list, want, at);
    if (known) return { att: await provider.getAttachment(m.providerMessageId, known.attId, hintOf(known)), attId: known.attId };
    try {
      return { att: await provider.getAttachment(m.providerMessageId, attId, hintOf(want)), attId };
    } catch (e) {
      if (!(e instanceof ProviderNotFoundError)) throw e;
      let fresh = cache.list;
      if (!fresh) {
        fresh = (await provider.getBody(m.providerMessageId)).attachments;
        cache.list = fresh;
        // Re-index whatever the provider says now, even if the match below
        // fails: reaching this branch already proves the row is out of date.
        // The broadcast is what makes an OPEN client drop the dead ids it is
        // still rendering chips for.
        if (fresh.length) {
          reindexAttachments(m, fresh);
          const owner = accounts.getAccountAny(db, m.accountId);
          if (owner) ctx.broadcastChange({ type: 'mailThread', id: m.threadKey, action: 'updated', byUserId: owner.userId });
        }
      }
      const match = sameFile(fresh, want, at);
      // No confident match (or the provider handed back the same dead id):
      // the original 404 is the honest answer.
      if (!match || match.attId === attId) throw e;
      console.warn(`[mail] attachment id went stale on message=${m.id} account=${m.accountId}; retrying ${attId} as ${match.attId}`);
      return { att: await provider.getAttachment(m.providerMessageId, match.attId, hintOf(match)), attId: match.attId };
    }
  };

  /** Writes the provider's CURRENT part list into the row, each entry still
   *  answering to the id it replaced (withPriorIds). */
  const reindexAttachments = (m: MessageRowRaw, fresh: AttachmentMeta[]): void => {
    db.prepare('UPDATE mail_messages SET attachmentsJson = ? WHERE id = ?').run(JSON.stringify(withPriorIds(m, fresh)), m.id);
  };

  const indexedAttachments = (m: MessageRowRaw): AttachmentMeta[] => {
    try { return JSON.parse(m.attachmentsJson || '[]') as AttachmentMeta[]; } catch { return []; }
  };

  const sameIds = (a: AttachmentMeta[], b: AttachmentMeta[]): boolean =>
    a.length === b.length && a.every((x, i) => x.attId === b[i].attId);

  /**
   * Carries each stale attachment id forward onto the fresh part that replaced
   * it, so a request still holding a previous generation's id can be re-keyed
   * without another round trip (see wantedAttachment).
   *
   * The bug this closes: re-indexing REPLACES the ids in the row. A second
   * save request for the same message — the way saving attachments one at a
   * time actually goes — arrived with the id the client had rendered before
   * the first save's recovery rewrote the list, found nothing under it, and
   * was rejected with "That attachment is not on this message" before the
   * provider was ever asked. The stale-id recovery below could not help,
   * because that rejection happens while resolving the item, not while
   * fetching it.
   *
   * Matched the same way the recovery matches: name+size, else the position
   * the old entry held with the name still agreeing. Capped at 3 generations
   * so a long-lived message's row cannot grow without bound.
   */
  const withPriorIds = (m: MessageRowRaw, fresh: AttachmentMeta[]): AttachmentMeta[] => {
    const prev = indexedAttachments(m);
    if (!prev.length) return fresh;
    const taken = new Set<number>();
    return fresh.map((f, i) => {
      let at = prev.findIndex((p, j) => !taken.has(j) && p.name === f.name && p.size === f.size);
      if (at < 0 && prev[i] && !taken.has(i) && prev[i].name === f.name) at = i;
      if (at < 0) return f;
      taken.add(at);
      const old = prev[at];
      if (old.attId === f.attId) return { ...f, ...(old.priorIds?.length ? { priorIds: old.priorIds } : {}) };
      return { ...f, priorIds: [old.attId, ...(old.priorIds ?? [])].slice(0, 3) };
    });
  };

  /** The wanted-attachment descriptor `getAttachmentFresh` takes, resolved
   *  against a caller-owned snapshot of the indexed list. An id the list no
   *  longer carries is looked up in the parts' `priorIds` before it is called
   *  a miss — it is far more likely a client holding a re-keyed id than an
   *  attachment that is really not on this message. The returned attId is the
   *  one the provider knows TODAY, so the fetch goes straight to the live
   *  part instead of taking the 404-and-recover detour. */
  const wantedAttachment = (metas: AttachmentMeta[], attId: string) => {
    let index = metas.findIndex(x => x.attId === attId);
    if (index < 0) index = metas.findIndex(x => (x.priorIds ?? []).includes(attId));
    if (index < 0) return { attId, meta: null, index };
    return { attId: metas[index].attId, meta: metas[index], index };
  };

  // ── accounts ──
  app.get('/api/mail/accounts', authenticateToken, (req, res) => {
    const unread = db.prepare(`SELECT COALESCE(SUM(t.unreadCount), 0) n FROM mail_threads t
      JOIN mail_folders f ON f.accountId = t.accountId AND f.role = 'inbox'
      WHERE t.accountId = ? AND instr(t.folderIdsJson, '"' || f.id || '"') > 0`);
    res.json(accounts.listAccounts(db, userOf(req).id).map(a => {
      const row: any = { ...a, unreadCount: (unread.get(a.id) as { n: number }).n };
      // Non-secret auth fields only, so the Edit form can prefill host/port/
      // username without a round trip that needs the password re-typed each
      // time — the password itself never leaves the server on this route.
      if (a.provider === 'imap') {
        const auth = accounts.readAuth(db, ctx.crypto, a.id) as accounts.ImapAuth | null;
        if (auth) {
          row.imapAuth = {
            imapHost: auth.imapHost, imapPort: auth.imapPort, imapSecure: auth.imapSecure,
            smtpHost: auth.smtpHost, smtpPort: auth.smtpPort, smtpSecure: auth.smtpSecure,
            username: auth.username,
          };
        }
      }
      return row;
    }));
  });

  app.post('/api/mail/accounts/imap', authenticateToken, (req, res) => {
    const b = req.body ?? {};
    for (const k of ['emailAddress', 'imapHost', 'smtpHost', 'username']) {
      if (typeof b[k] !== 'string' || !b[k].trim()) return res.status(400).json({ error: `${k} is required` });
    }
    const auth: accounts.ImapAuth = {
      imapHost: b.imapHost.trim(), imapPort: Number(b.imapPort) || 993, imapSecure: b.imapSecure !== false,
      smtpHost: b.smtpHost.trim(), smtpPort: Number(b.smtpPort) || 587, smtpSecure: !!b.smtpSecure,
      username: b.username.trim(), password: String(b.password ?? ''),
    };
    if (typeof b.id === 'string') {
      const a = owned(req, b.id);
      if (!a) return res.status(404).json({ error: 'Account not found' });
      const prev = accounts.readAuth(db, ctx.crypto, a.id) as accounts.ImapAuth | null;
      if (!auth.password) auth.password = prev?.password ?? '';   // blank on update = keep the stored one
      accounts.updateAuth(db, ctx.crypto, a.id, auth);
      accounts.updateAccount(db, a.id, { emailAddress: b.emailAddress.trim().toLowerCase(), displayName: b.displayName ?? a.displayName, status: 'needs_review' });
      ctx.scheduler?.stopAccount(a.id);
      ctx.scheduler?.dropProvider(a.id);
      return res.json(accounts.getAccountAny(db, a.id));
    }
    if (!auth.password) return res.status(400).json({ error: 'password is required' });
    const a = accounts.createAccount(db, ctx.crypto, {
      userId: userOf(req).id, provider: deps.env.MAIL_FAKE_PROVIDER === '1' ? 'fake' : 'imap',
      emailAddress: b.emailAddress, displayName: b.displayName ?? null, auth, status: 'needs_review',
    });
    res.json(a);
  });

  app.post('/api/mail/accounts/:id/test', authenticateToken, async (req, res) => {
    const a = owned(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try {
      ctx.scheduler?.dropProvider(a.id);   // re-read the credentials just written
      await providerFor(a.id).listFolders();
      accounts.updateAccount(db, a.id, { status: 'ok', lastError: null });
      ctx.scheduler?.startAccount(a.id);
      ctx.broadcastChange({ type: 'mailAccount', id: a.id, action: 'updated', byUserId: a.userId });
      res.json({ ok: true });
    } catch (e: any) {
      accounts.updateAccount(db, a.id, { lastError: e?.message || 'Connection failed' });
      res.status(400).json({ error: e?.message || 'Connection failed' });
    }
  });

  app.patch('/api/mail/accounts/:id', authenticateToken, (req, res) => {
    const a = owned(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const b = req.body ?? {};
    const patch: Parameters<typeof accounts.updateAccount>[2] = {};
    if (typeof b.displayName === 'string') patch.displayName = b.displayName;
    if (typeof b.signatureHtml === 'string') patch.signatureHtml = b.signatureHtml;
    if (b.status === 'disabled') {
      patch.status = 'disabled';
      ctx.scheduler?.stopAccount(a.id);
      // Nothing is left to poke a disabled account, so a live Gmail watch would
      // only publish into a mailbox nobody is syncing. Clearing the stored
      // expiry is what makes re-enabling register a fresh watch straight away.
      releaseGmailWatch(ctx, a, () => providerFor(a.id), { clearState: true });
    }
    else if (b.status === 'ok' && a.status === 'disabled') { patch.status = 'ok'; }
    accounts.updateAccount(db, a.id, patch);
    if (patch.status === 'ok') ctx.scheduler?.startAccount(a.id);   // only after the row says 'ok'
    if (b.isDefault === true) accounts.setDefault(db, a.userId, a.id);
    ctx.broadcastChange({ type: 'mailAccount', id: a.id, action: 'updated', byUserId: a.userId });
    res.json(accounts.getAccountAny(db, a.id));
  });

  app.delete('/api/mail/accounts/:id', authenticateToken, (req, res) => {
    const a = owned(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    // Stop the worker and drop the cached provider BEFORE the row goes away —
    // a live worker would otherwise tick against a deleted account.
    ctx.scheduler?.stopAccount(a.id);
    // Between stopping the worker and dropping the cached provider: the stop
    // needs a client with live credentials, and the row is about to go, so
    // there is no state left to clear.
    releaseGmailWatch(ctx, a, () => providerFor(a.id));
    ctx.scheduler?.dropProvider(a.id);
    accounts.deleteAccount(db, a.id);
    ctx.broadcastChange({ type: 'mailAccount', id: a.id, action: 'deleted', byUserId: a.userId });
    res.json({ ok: true });
  });

  // Manual "check for mail now". The scheduler owns every provider call, so
  // this only nudges the account's worker — 202, not 200: the sync runs after
  // the response, and the client learns about new mail through the same
  // `mailThread` broadcasts a timed sync produces.
  app.post('/api/mail/accounts/:id/refresh', authenticateToken, (req, res) => {
    const a = owned(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    // Without a scheduler nothing would ever run the sync, and a 202 would be
    // a lie the client shows as a settled spinner and no new mail.
    if (!ctx.scheduler) return res.status(503).json({ error: 'Sync unavailable' });
    ctx.scheduler.pokeAccount(a.id);
    res.status(202).json({ ok: true });
  });

  app.post('/api/mail/accounts/:id/load-older', authenticateToken, (req, res) => {
    const a = owned(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const months = Math.min(60, Math.max(1, Number(req.body?.months) || 6));
    const newSince = new Date(new Date(a.indexedSince).getTime() - months * 30 * 86400000).toISOString();
    accounts.updateAccount(db, a.id, { indexedSince: newSince });
    // Resolve the account row and provider BEFORE responding: a throw here after
    // res.json() would be an unhandled error on an already-sent response.
    const fresh = accounts.getAccountAny(db, a.id)!;
    let provider: MailProvider;
    try { provider = providerFor(a.id); } catch (e) { return fail(res, e, 'Could not reach the mail account'); }
    res.json({ indexedSince: newSince });
    // Backfill only the newly opened window, in the background.
    runBackfill(ctx, fresh, provider, new Date(newSince)).catch(e => console.error('[mail] load-older backfill failed', e));
  });

  // ── OAuth connect (see oauth.ts for why state is a signed JWT) ──
  // The browser NAVIGATES here, so it cannot send an Authorization header —
  // ?token= is accepted exactly as the attachment routes do.
  app.get('/api/mail/oauth/:provider/start', authOrQueryToken, (req, res) => {
    const provider = req.params.provider;
    if (!isOAuthProvider(provider)) return res.status(400).json({ error: 'Unknown mail provider' });
    // Without a public origin there is no redirect URI to register or return to.
    if (!deps.publicUrl) return res.status(503).json({ error: 'APP_PUBLIC_URL is not set — see Settings → Mail → Server setup guide' });
    const verifier = createVerifier();
    let url: string;
    try {
      url = buildAuthUrl(provider, deps.env, deps.publicUrl, signState(deps.jwtSecret, { userId: userOf(req).id, provider, verifier }), challengeOf(verifier));
    } catch (e: any) {
      // A missing client id/secret is a deployment gap, not a request error.
      return res.status(503).json({ error: e?.message || 'This mail provider is not configured' });
    }
    // The ?token= above sits in THIS url, and a browser sends the redirecting
    // url as the Referer of the hop it takes next — which would hand the app's
    // session token to the provider. Suppress it for this response only.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(url);
  });

  // No auth middleware: the browser arrives from the provider. The signed state
  // is what says who started the flow — and it is the ONLY thing trusted here.
  app.get('/api/mail/oauth/:provider/callback', async (req, res) => {
    const settings = (params: string) => res.redirect(`/settings?tab=mail&${params}`);
    // Never let a provider's text (or ours) carry a grant back into the URL bar.
    const failed = (message: string) => settings(`error=${encodeURIComponent(message.slice(0, 300))}`);
    const provider = req.params.provider;
    if (!isOAuthProvider(provider)) return failed('Unknown mail provider');
    if (!deps.publicUrl) return failed('APP_PUBLIC_URL is not set on this server');
    // Consent was declined or the provider bailed: its own error code is not
    // reflected back, only that it did not complete.
    if (req.query.error) return failed('The mail provider did not complete the sign-in — please try again');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const rawState = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !rawState) return failed('That sign-in did not come back with everything we need — please try again');
    let state: ReturnType<typeof verifyState>;
    try { state = verifyState(deps.jwtSecret, rawState); }
    catch { return failed('That sign-in link expired or was not issued by this app — please try connecting again'); }
    // A Google grant must never be filed as a Microsoft account.
    if (state.provider !== provider) return failed('That sign-in did not match the provider it started from');

    try {
      const exchange = deps.oauthExchange ?? exchangeCode;
      const r = await exchange(provider, deps.env, deps.publicUrl, code, state.verifier, undefined);
      const { refreshToken, name } = r;
      // createAccount stores addresses folded; fold here too or a reconnect
      // whose provider answered with different casing would miss and duplicate.
      const email = r.email.trim().toLowerCase();
      // Reconnecting the SAME mailbox updates the account in place — a second
      // row would double every sync and split the user's threads.
      const existing = accounts.listAccounts(db, state.userId)
        .find(a => a.provider === provider && a.emailAddress === email);
      let id: string;
      if (existing) {
        accounts.updateAuth(db, ctx.crypto, existing.id, { refreshToken });
        accounts.updateAccount(db, existing.id, { status: 'ok', lastError: null });
        // A live worker captured its provider — holding the OLD refresh token —
        // when it started, and startAccount() no-ops while that worker exists.
        // Stop it and drop the cache, or the reconnect changes nothing and the
        // next AuthExpiredError stops the worker for good.
        ctx.scheduler?.stopAccount(existing.id);
        ctx.scheduler?.dropProvider(existing.id);
        id = existing.id;
      } else {
        id = accounts.createAccount(db, ctx.crypto, {
          userId: state.userId, provider, emailAddress: email, displayName: name ?? null,
          auth: { refreshToken }, status: 'ok',
        }).id;
      }
      ctx.scheduler?.startAccount(id);
      ctx.broadcastChange({ type: 'mailAccount', id, action: existing ? 'updated' : 'created', byUserId: state.userId });
      settings(`connected=${encodeURIComponent(id)}`);
    } catch (e: any) {
      // The detail (which may name the grant) stays in the log; the user gets
      // the provider's own summary with the code and verifier already scrubbed.
      console.error('[mail] oauth callback failed', e);
      // redactGrant again (not only inside exchangeCode) so ANY thrower —
      // including a provider client we swap in later — is covered.
      failed(redactGrant(e?.message || 'Could not connect that mailbox', code, state.verifier));
    }
  });

  // ── Microsoft Graph change notifications ──
  // Deliberately unauthenticated: Microsoft has no token of ours to send. What
  // makes it safe is that the body is never believed beyond "re-sync account X"
  // — the `clientState` secret must match, the subscription id must already
  // belong to an account, and nothing from the payload is stored. The response
  // must also be fast (Graph retries, then drops the subscription, if we are
  // slow), so the handler only reads the DB and returns; the re-sync it kicks
  // off is fire-and-forget.
  //
  // It is also the only route in the app that takes an unauthenticated POST
  // body, so it gets its own limiter and its own body cap. Two notes on the cap:
  //   * the Content-Length check answers before a byte of body is read, and is
  //     what stops a large declared body;
  //   * the route-local express.json() is the real limit for a chunked body
  //     that declares no length — but it only bites if the HOST app let this
  //     path past its own parser (server.ts exempts WEBHOOK_PATH for exactly
  //     that reason; a body-parser that already ran wins and this one no-ops).
  const webhookLimiter: express.RequestHandler = deps.webhookRateLimit ?? createWebhookRateLimit();
  const webhookSizeGuard: express.RequestHandler = (req, res, next) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) return res.status(413).end();
    next();
  };
  app.post(WEBHOOK_PATH, webhookLimiter, webhookSizeGuard, express.json({ limit: WEBHOOK_MAX_BODY_BYTES }), (req, res) => {
    // Handshake: Microsoft validates a new subscription by POSTing a token that
    // must come straight back as plain text. Cap it so we never echo a payload.
    const token = req.query.validationToken;
    if (typeof token === 'string') {
      if (token.length > 2048) return res.status(400).end();
      // nosniff: the body is caller-supplied text, and only text/plain is safe for that.
      res.set('X-Content-Type-Options', 'nosniff').type('text/plain').status(200).send(token);
      return;
    }
    try {
      for (const id of handleGraphWebhook(ctx, req.body, getWebhookSecret(db))) ctx.scheduler?.pokeAccount(id);
    } catch (e) {
      // Never 500 a notification: Graph would retry it, and a retry cannot help
      // a body we could not read.
      console.error('[mail] graph webhook failed', e);
    }
    res.status(202).end();
  });

  // ── Gmail change notifications (Cloud Pub/Sub) ──
  // Same shape of route as the Graph one above and the same hardening, with one
  // difference that drives its design: a Pub/Sub push body is whatever Gmail
  // published, so there is no field of ours in it to carry a shared secret.
  // The secret therefore rides in the query string of the URL the admin pastes
  // into the subscription — which is why `GET /api/mail/setup-info` (admin
  // only) is the one place that URL is ever shown.
  //
  // The body is believed only as far as "re-sync this mailbox": the address is
  // matched against accounts we already hold, and the historyId in the payload
  // is ignored outright — the poll owns that watermark.
  const googleWebhookLimiter: express.RequestHandler = deps.googleWebhookRateLimit ?? createWebhookRateLimit(WEBHOOK_RATE_LIMIT_PER_MIN, 'Pub/Sub');
  // The token is in the URL, so it can be checked before a byte of body is
  // parsed — an unauthenticated caller gets no free JSON parsing out of us.
  // (The Graph route cannot do this: its clientState arrives inside the body,
  // so there is nothing to check until after the parser has run.)
  const googleTokenGuard: express.RequestHandler = (req, res, next) => {
    const token = req.query.token;
    // 403 with an empty body: a wrong guess learns nothing, not even a length.
    if (typeof token !== 'string' || !constantTimeEquals(token, getGooglePushSecret(db))) return res.status(403).end();
    next();
  };
  app.post(GOOGLE_WEBHOOK_PATH, googleWebhookLimiter, webhookSizeGuard, googleTokenGuard, express.json({ limit: WEBHOOK_MAX_BODY_BYTES }), (req, res) => {
    try {
      for (const id of handleGoogleWebhook(ctx, req.body)) ctx.scheduler?.pokeAccount(id);
    } catch (e) {
      // 204 even on a failure: Pub/Sub redelivers anything it does not get an
      // ack for, and a redelivery cannot help a body we could not read.
      console.error('[mail] pub/sub webhook failed', e);
    }
    res.status(204).end();
  });

  // Which OAuth providers the deployment has credentials for (never the values).
  app.get('/api/mail/providers', authenticateToken, (_req, res) => res.json({
    google: !!(deps.env.GOOGLE_OAUTH_CLIENT_ID && deps.env.GOOGLE_OAUTH_CLIENT_SECRET),
    microsoft: !!(deps.env.MS_OAUTH_CLIENT_ID && deps.env.MS_OAUTH_CLIENT_SECRET),
  }));

  // ── folders / threads / messages ──
  app.get('/api/mail/folders', authenticateToken, (req, res) => {
    const a = owned(req, String(req.query.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    res.json(db.prepare('SELECT * FROM mail_folders WHERE accountId = ? ORDER BY sortOrder, name').all(a.id));
  });

  const linksFor = (keys: string[]): Map<string, any[]> => {
    const out = new Map<string, any[]>();
    if (!keys.length) return out;
    const rows = db.prepare(`SELECT id, threadKey, itemType, itemId, projectId, customerId FROM mail_thread_links WHERE threadKey IN (${keys.map(() => '?').join(',')})`).all(...keys) as any[];
    for (const l of rows) { const withLabel = { ...l, label: resolveLinkLabel(db, l.itemType, l.itemId) }; const arr = out.get(l.threadKey) ?? []; arr.push(withLabel); out.set(l.threadKey, arr); }
    return out;
  };
  const lastSnippet = db.prepare('SELECT snippet FROM mail_messages WHERE accountId = ? AND threadKey = ? ORDER BY date DESC LIMIT 1');
  const threadRow = (t: any, links: Map<string, any[]>) => ({
    threadKey: t.threadKey, subject: t.subject, firstDate: t.firstDate, lastDate: t.lastDate,
    messageCount: t.messageCount, unreadCount: t.unreadCount, hasAttachments: t.hasAttachments, isStarred: t.isStarred,
    participants: JSON.parse(t.participantsJson), folderIds: JSON.parse(t.folderIdsJson),
    snippet: (lastSnippet.get(t.accountId, t.threadKey) as { snippet: string } | undefined)?.snippet ?? '',
    links: links.get(t.threadKey) ?? [],
  });

  /** `?threadKeys=` — comma-separated or repeated. Capped so a caller cannot
   *  make us build a thousand-placeholder IN clause. */
  const MAX_THREAD_KEYS = 50;
  const threadKeysOf = (raw: unknown): string[] => {
    const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const out: string[] = [];
    for (const v of list) {
      if (typeof v !== 'string') continue;
      for (const k of v.split(',').map(x => x.trim()).filter(Boolean)) {
        if (!out.includes(k)) out.push(k);
      }
    }
    return out.slice(0, MAX_THREAD_KEYS);
  };

  app.get('/api/mail/threads', authenticateToken, (req, res) => {
    const a = owned(req, String(req.query.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : null;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const keys = threadKeysOf(req.query.threadKeys);
    const where = ['t.accountId = ?'];
    const params: unknown[] = [a.id];
    if (keys.length) {
      // Explicit result set (what /api/mail/search just filed). It deliberately
      // bypasses BOTH the folder filter and the q LIKE: a provider match is
      // usually on body text the local index never sees, and the hit is usually
      // archived — either filter would hide the very mail the user searched for.
      where.push(`t.threadKey IN (${keys.map(() => '?').join(',')})`);
      params.push(...keys);
    } else {
      // Folder ids are uuids inside a JSON array, so matching the QUOTED id is exact.
      if (folderId) { where.push('instr(t.folderIdsJson, ?) > 0'); params.push(`"${folderId}"`); }
      if (q) {
        where.push(`EXISTS (SELECT 1 FROM mail_messages m WHERE m.accountId = t.accountId AND m.threadKey = t.threadKey
          AND (lower(m.subject) LIKE ? OR lower(COALESCE(m.fromAddr, '')) LIKE ? OR lower(COALESCE(m.fromName, '')) LIKE ? OR lower(m.snippet) LIKE ? OR lower(m.toJson) LIKE ?))`);
        params.push(...Array(5).fill(`%${q}%`));
      }
    }
    if (before) { where.push('t.lastDate < ?'); params.push(before); }
    const rows = db.prepare(`SELECT * FROM mail_threads t WHERE ${where.join(' AND ')} ORDER BY t.lastDate DESC LIMIT ?`).all(...params, limit + 1) as any[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const links = linksFor(page.map(p => p.threadKey));
    res.json({ threads: page.map(t => threadRow(t, links)), hasMore, indexedSince: a.indexedSince });
  });

  app.get('/api/mail/threads/:accountId/:threadKey', authenticateToken, (req, res) => {
    const a = owned(req, req.params.accountId);
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const t = db.prepare('SELECT * FROM mail_threads WHERE accountId = ? AND threadKey = ?').get(a.id, req.params.threadKey) as any;
    if (!t) return res.status(404).json({ error: 'Thread not found' });
    const messages = (db.prepare('SELECT * FROM mail_messages WHERE accountId = ? AND threadKey = ? ORDER BY date').all(a.id, t.threadKey) as any[]).map(parseRow);
    const threadLinks = listLinksForThread(db, t.threadKey).map(l => ({ ...l, label: resolveLinkLabel(db, l.itemType, l.itemId) }));
    res.json({ thread: threadRow(t, linksFor([t.threadKey])), messages, links: threadLinks });
  });

  // A message the provider could not name yet (see Envelope.replacesProviderMessageId):
  // the send went out, but the copy has not been filed where we can read it
  // back, so asking the provider for it would 404 on the user's OWN message.
  const isPending = (m: MessageRowRaw): boolean => String(m.providerMessageId || '').startsWith('sent:');

  app.get('/api/mail/messages/:id/body', authenticateToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'Message not found' });
    // 202, not an error: this resolves itself on the next sync, and the client
    // shows "Sending…" rather than a failure.
    if (isPending(m)) return res.status(202).json({ pending: true });
    const sender = (m.fromAddr || '').trim().toLowerCase() || null;
    const senderTrusted = !!sender && !!db.prepare('SELECT 1 FROM mail_trusted_image_senders WHERE userId = ? AND addr = ?').get(userOf(req).id, sender);
    const allowImages = req.query.images === '1' || senderTrusted;
    // sender/trust are per user, so they are layered on after the cache.
    const key = `${m.id}:${allowImages ? 1 : 0}`;
    const hit = deps.bodyCache.get(key);
    if (hit) return res.json({ ...hit, imagesAllowed: allowImages, sender, senderTrusted });
    try {
      const raw = await providerFor(m.accountId).getBody(m.providerMessageId);
      // This read is the one that hands the client its attachment ids (the
      // payload below, and the inline-image URLs built from it), so the row
      // has to know them too: the download route resolves an id against the
      // row, and until this was written a Gmail id minted by THIS read was
      // "not on this message" there — every inline image 404'd.
      if (raw.attachments.length && !sameIds(indexedAttachments(m), raw.attachments)) reindexAttachments(m, raw.attachments);
      const attachmentUrl = (cid: string) => {
        const att = raw.attachments.find(x => (x.contentId || '').replace(/^<|>$/g, '') === cid);
        return att ? `/api/mail/messages/${m.id}/attachments/${encodeURIComponent(att.attId)}?inline=1` : null;
      };
      const escaped = (raw.text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
      const html = raw.html
        ? sanitizeEmailHtml(raw.html, { attachmentUrl, allowRemoteImages: allowImages })
        : { html: `<pre style="white-space:pre-wrap;font-family:inherit">${escaped}</pre>`, blockedRemoteImages: 0 };
      const payload: BodyPayload = { html: html.html, text: raw.text ?? htmlToText(raw.html ?? ''), blockedRemoteImages: html.blockedRemoteImages, attachments: raw.attachments };
      deps.bodyCache.set(key, payload, payload.html.length + payload.text.length);
      res.json({ ...payload, imagesAllowed: allowImages, sender, senderTrusted });
    } catch (e) { fail(res, e, 'Failed to load message'); }
  });

  // Senders whose remote images this user always loads.
  const normAddr = (v: unknown): string => String(v ?? '').trim().toLowerCase();
  app.get('/api/mail/image-senders', authenticateToken, (req, res) => {
    const rows = db.prepare('SELECT addr FROM mail_trusted_image_senders WHERE userId = ? ORDER BY addr').all(userOf(req).id) as { addr: string }[];
    res.json({ senders: rows.map(r => r.addr) });
  });
  app.put('/api/mail/image-senders', authenticateToken, (req, res) => {
    const addr = normAddr((req.body as { addr?: unknown } | undefined)?.addr);
    if (!addr || addr.length > 320 || !addr.includes('@')) return res.status(400).json({ error: 'A sender address is required' });
    db.prepare('INSERT OR IGNORE INTO mail_trusted_image_senders (userId, addr, createdAt) VALUES (?, ?, ?)').run(userOf(req).id, addr, Date.now());
    res.status(204).end();
  });
  app.delete('/api/mail/image-senders', authenticateToken, (req, res) => {
    const addr = normAddr(req.query.addr);
    if (!addr) return res.status(400).json({ error: 'A sender address is required' });
    db.prepare('DELETE FROM mail_trusted_image_senders WHERE userId = ? AND addr = ?').run(userOf(req).id, addr);
    res.status(204).end();
  });

  const PENDING_ATTACHMENT = 'This message is still being filed by the mail server — its attachments will be available in a minute';

  /** Streams one attachment from the provider. */
  const sendAttachment = async (res: express.Response, m: MessageRowRaw, attId: string, inline: boolean): Promise<void> => {
    try {
      const metas: AttachmentMeta[] = JSON.parse(m.attachmentsJson || '[]');
      const { att } = await getAttachmentFresh(m, wantedAttachment(metas, attId));
      res.setHeader('Content-Type', att.mime || 'application/octet-stream');
      // An attachment is whatever a stranger emailed: never script on our origin.
      setUntrustedContentHeaders(res, att.mime || 'application/octet-stream');
      if (att.size) res.setHeader('Content-Length', String(att.size));
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${(att.name || 'attachment').replace(/["\r\n]/g, '')}"`);
      att.stream.on('error', err => { console.error('[mail] attachment stream failed', err); res.destroy(); });
      // A client that navigates away mid-download closes the response; without
      // this the provider stream keeps pulling bytes nobody will ever read.
      res.on('close', () => { if (!res.writableEnded) endStream(att.stream); });
      att.stream.pipe(res);
    } catch (e) { fail(res, e, `Failed to load attachment attId=${attId} message=${m.id} account=${m.accountId}`); }
  };

  app.get('/api/mail/messages/:id/attachments/:attId', authOrQueryToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'Message not found' });
    if (isPending(m)) return res.status(404).json({ error: PENDING_ATTACHMENT });
    await sendAttachment(res, m, req.params.attId, req.query.inline === '1');
  });

  // The document viewer for a Word, Excel or PowerPoint attachment (ONLYOFFICE
  // Phase 6): the attachment's owner gets a view-only config whose download
  // link opens this one attachment, for an hour.
  app.post('/api/mail/messages/:id/attachments/:attId/viewer', authenticateToken, (req, res) => {
    const m = ownedMessage(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'Message not found' });
    if (isPending(m)) return res.status(404).json({ error: PENDING_ATTACHMENT });
    const wanted = wantedAttachment(indexedAttachments(m), req.params.attId);
    if (!wanted.meta) return res.status(404).json({ error: 'That attachment is not on this message' });
    if (!deps.attachmentViewer) return res.status(503).json({ error: "The document viewer isn't set up.", code: 'not-configured' });
    const user = userOf(req) as { id: string; username?: string };
    const opened = deps.attachmentViewer.config({
      messageId: m.id, attId: wanted.attId, name: wanted.meta.name || 'attachment', mime: wanted.meta.mime || '', size: wanted.meta.size || 0,
      user: { id: String(user.id), name: String(user.username || user.id) },
      device: req.body?.device === 'phone' ? 'phone' : 'desktop',
      theme: req.body?.theme === 'dark' ? 'dark' : 'light',
    });
    if ('error' in opened) {
      return opened.error === 'not-configured'
        ? res.status(503).json({ error: "The document viewer isn't set up, so attachments download instead.", code: 'not-configured' })
        : res.status(415).json({ error: "This kind of attachment isn't shown in the document viewer.", code: 'unsupported' });
    }
    res.json(opened);
  });

  // For the Document Server only (it has no user session): the link token
  // opens this one attachment, for an hour, and nothing else.
  app.get('/api/mail/viewer-file/:id/:attId', async (req, res) => {
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    if (!deps.attachmentViewer || !deps.attachmentViewer.verify(token, req.params.id, req.params.attId)) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }
    const m = db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(req.params.id) as MessageRowRaw | undefined;
    if (!m) return res.status(404).json({ error: 'Message not found' });
    if (isPending(m)) return res.status(404).json({ error: PENDING_ATTACHMENT });
    await sendAttachment(res, m, req.params.attId, false);
  });

  app.post('/api/mail/messages/:id/attachments/save', authenticateToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'Message not found' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'items required' });
    // 200 with every item failed, not a 4xx: the client's save modal only
    // understands the {saved, failed} shape, and a per-item reason is what it
    // puts in the toast. Asking the provider would 404 on the user's own message.
    if (isPending(m)) {
      const error = 'This message is still being filed by the mail server — try again in a minute';
      return res.json({ fileIds: [], saved: [], failed: items.map((it: { attId?: unknown }) => ({ attId: String(it?.attId ?? ''), error })) });
    }
    const metas = indexedAttachments(m);
    const providerKind = accounts.getAccountAny(db, m.accountId)?.provider ?? 'unknown';
    // Per item, not all-or-nothing: one bad attachment used to abort the whole
    // request with a 502, leaving the items already written to Documents saved
    // and broadcast but invisible to a client that got no fileIds back.
    const fileIds: string[] = [];
    const saved: Array<{ attId: string; fileId: string }> = [];
    const failed: Array<{ attId: string; error: string }> = [];
    // One memo for the whole batch: the first stale id pays for the re-read,
    // every later one is matched against the list it already fetched.
    const freshParts: FreshParts = { list: null };
    for (const it of items) {
      // The id the CLIENT sent. Every failed[] entry is reported under it —
      // even when wantedAttachment re-keyed a stale id — because the client
      // narrows its retry list by matching failed[].attId against the chips it
      // is showing, which still carry the ids it was given.
      const askedId = String(it?.attId ?? '');
      const wanted = wantedAttachment(metas, askedId);
      const meta = wanted.meta;
      if (!meta) { failed.push({ attId: askedId, error: 'That attachment is not on this message' }); continue; }
      try {
        const { att, attId: usedAttId } = await getAttachmentFresh(m, wanted, freshParts);
        const chunks: Buffer[] = [];
        let total = 0;
        try {
          for await (const c of att.stream as AsyncIterable<Buffer>) {
            total += c.length;
            if (total > 100 * 1024 * 1024) throw new MailSendError('Attachment exceeds 100 MB', 413);
            chunks.push(c);
          }
        } catch (e) { endStream(att.stream); throw e; }
        // 'email-attachment' is a MULTI_INSTANCE kind, so several attachments off
        // one message stay separate documents instead of versioning each other.
        const r = putBuffer(db, ctx.dataDir, uuidv4(), Buffer.concat(chunks), att.mime, {
          projectId: it.projectId || undefined, customerId: it.customerId || undefined,
          kind: typeof it.kind === 'string' && it.kind ? it.kind : 'email-attachment',
          name: it.name || meta.name, sourceType: 'mailMessage', sourceId: m.id,
        });
        fileIds.push(r.id);
        // The id the provider actually served — which is NOT the one the client
        // sent when the recovery above re-keyed it. A client that wants to act
        // on the saved item again needs the live id, not the dead one.
        saved.push({ attId: usedAttId, fileId: r.id });
        ctx.broadcastChange({ type: 'file', id: r.id, projectId: it.projectId || undefined, action: 'created', byUserId: userOf(req).id });
      } catch (e) {
        // The client only ever sees itemError()'s fixed string, so this line is
        // the ONLY record of why a save failed — it has to name the account,
        // its provider, the message and the attachment, or the next report of
        // "attachment save fails" is undiagnosable all over again.
        console.error(`[mail] could not save attachment attId=${meta.attId} asked=${askedId} name=${meta.name} message=${m.id} account=${m.accountId} provider=${providerKind}`, e);
        failed.push({ attId: askedId, error: itemError(e) });
      }
    }
    res.json({ fileIds, saved, failed });
  });

  // ── actions (optimistic local write, provider call, revert on failure) ──
  async function applyAction(req: express.Request, rows: MessageRowRaw[], action: Action, folderId?: string): Promise<void> {
    if (!rows.length) return;
    const byAccount = new Map<string, MessageRowRaw[]>();
    for (const r of rows) byAccount.set(r.accountId, [...(byAccount.get(r.accountId) ?? []), r]);
    for (const [accountId, list] of byAccount) {
      const snapshot = list.map(r => ({ id: r.id, isRead: r.isRead, isStarred: r.isStarred, folderIdsJson: r.folderIdsJson }));
      const roleFolder = (role: string) => db.prepare('SELECT id, providerId FROM mail_folders WHERE accountId = ? AND role = ?').get(accountId, role) as { id: string; providerId: string } | undefined;
      const target = action === 'archive' ? roleFolder('archive')
        : action === 'trash' ? roleFolder('trash')
          : action === 'move' ? db.prepare('SELECT id, providerId FROM mail_folders WHERE id = ? AND accountId = ?').get(folderId, accountId) as { id: string; providerId: string } | undefined
            : null;
      // Archive is the one action that works WITHOUT a destination folder:
      // Gmail (and Gmail-over-IMAP) has no Archive mailbox — archiving there
      // just removes the Inbox label — so the provider is asked to archive and
      // the local row simply drops the inbox folder instead of moving.
      if ((action === 'trash' || action === 'move') && !target) throw new MailSendError('Folder not found', 400);
      const inboxId = action === 'archive' && !target ? roleFolder('inbox')?.id : undefined;
      // Where each row's folder list lands, computed once so the optimistic
      // write and the post-move re-key cannot disagree.
      const foldersAfter = new Map<string, string>();
      if (action === 'archive' || action === 'trash' || action === 'move') {
        for (const r of list) {
          foldersAfter.set(r.id, target
            ? JSON.stringify([target.id])
            : JSON.stringify((JSON.parse(r.folderIdsJson || '[]') as string[]).filter(f => f !== inboxId)));
        }
      }
      const keys = new Set<string>(list.map(r => r.threadKey));
      db.transaction(() => {
        for (const r of list) {
          if (action === 'read' || action === 'unread') db.prepare('UPDATE mail_messages SET isRead = ? WHERE id = ?').run(action === 'read' ? 1 : 0, r.id);
          else if (action === 'star' || action === 'unstar') db.prepare('UPDATE mail_messages SET isStarred = ? WHERE id = ?').run(action === 'star' ? 1 : 0, r.id);
          else db.prepare('UPDATE mail_messages SET folderIdsJson = ? WHERE id = ?').run(foldersAfter.get(r.id)!, r.id);
        }
        for (const k of keys) rebuildThread(db, accountId, k);
      })();
      try {
        const p = providerFor(accountId);
        const ids = list.map(r => r.providerMessageId);
        let moved: MoveResult[] | null = null;
        if (action === 'read' || action === 'unread') await p.setFlags(ids, { read: action === 'read' });
        else if (action === 'star' || action === 'unstar') await p.setFlags(ids, { starred: action === 'star' });
        else if (action === 'archive') moved = await p.archive(ids);
        else if (action === 'trash') moved = await p.trash(ids);
        else moved = await p.move(ids, target!.providerId);
        // A moved message usually has a NEW provider id (an IMAP MOVE re-numbers
        // it). Re-key the row now, or the next poll indexes the moved copy as a
        // second message and the old row points at nothing.
        if (moved?.length) {
          const byFrom = new Map(list.map(r => [r.providerMessageId, r]));
          const snapById = new Map(snapshot.map(sn => [sn.id, sn]));
          try {
            db.transaction(() => {
              for (const m of moved!) {
                const row = byFrom.get(m.from);
                if (!row) continue;
                // The server refused this one (an unreadable mailbox, a MOVE
                // the host rejected). It is still where it was, so undo the
                // optimistic re-file — deleting or re-keying it here would
                // throw away a message that never actually moved.
                if (m.failed) {
                  const sn = snapById.get(row.id);
                  if (sn) db.prepare('UPDATE mail_messages SET folderIdsJson = ? WHERE id = ?').run(sn.folderIdsJson, row.id);
                  continue;
                }
                if (m.to === m.from) continue;
                if (m.to) db.prepare('UPDATE mail_messages SET providerMessageId = ?, folderIdsJson = ? WHERE id = ?').run(m.to, foldersAfter.get(row.id)!, row.id);
                // Trashed and untraceable: the server copy can no longer be
                // addressed, so keeping a local row would only ever be a ghost.
                else if (action === 'trash') db.prepare('DELETE FROM mail_messages WHERE id = ?').run(row.id);
              }
              for (const k of keys) rebuildThread(db, accountId, k);
            })();
          } catch (e) {
            // The move itself succeeded — never unwind it over bookkeeping.
            console.error('[mail] could not re-key moved messages', e);
          }
        }
      } catch (e) {
        db.transaction(() => {
          for (const s of snapshot) db.prepare('UPDATE mail_messages SET isRead = ?, isStarred = ?, folderIdsJson = ? WHERE id = ?').run(s.isRead, s.isStarred, s.folderIdsJson, s.id);
          for (const k of keys) rebuildThread(db, accountId, k);
        })();
        throw e;
      } finally {
        for (const k of keys) ctx.broadcastChange({ type: 'mailThread', id: k, action: 'updated', byUserId: userOf(req).id });
      }
    }
  }

  app.post('/api/mail/messages/actions', authenticateToken, async (req, res) => {
    if (!isAction(req.body?.action)) return res.status(400).json({ error: 'Unknown action' });
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const rows = ids.map(id => ownedMessage(req, id)).filter((r): r is MessageRowRaw => !!r);
    if (ids.length && !rows.length) return res.status(404).json({ error: 'Message not found' });
    try { await applyAction(req, rows, req.body.action, req.body?.folderId); res.json({ ok: true }); }
    catch (e) { fail(res, e, 'Action failed'); }
  });

  app.post('/api/mail/threads/actions', authenticateToken, async (req, res) => {
    if (!isAction(req.body?.action)) return res.status(400).json({ error: 'Unknown action' });
    const a = owned(req, String(req.body?.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    const keys: string[] = Array.isArray(req.body?.threadKeys) ? req.body.threadKeys : [];
    const rows = keys.length
      ? db.prepare(`SELECT * FROM mail_messages WHERE accountId = ? AND threadKey IN (${keys.map(() => '?').join(',')})`).all(a.id, ...keys) as MessageRowRaw[]
      : [];
    try { await applyAction(req, rows, req.body.action, req.body?.folderId); res.json({ ok: true }); }
    catch (e) { fail(res, e, 'Action failed'); }
  });

  // ── send / drafts / uploads / provider search ──
  app.post('/api/mail/send', authenticateToken, async (req, res) => {
    const b = req.body ?? {};
    // Validate the item tags BEFORE the provider is handed the message: an unknown
    // itemType reaches resolveChain/applySendEffects only after the mail is already
    // irretrievably sent, so rejecting it here is the only place it costs nothing.
    if (!Array.isArray(b.to) || !b.to.length) return res.status(400).json({ error: 'At least one recipient is required' });
    const tagged: unknown[] = [
      ...(Array.isArray(b.links) ? b.links : []).map((l: any) => l?.itemType),
      ...(Array.isArray(b.attachments) ? b.attachments : []).map((a: any) => a?.itemType).filter((t: unknown) => t !== undefined && t !== null),
    ];
    if (tagged.some(t => !isItemType(t))) return res.status(400).json({ error: 'Invalid itemType' });
    // sessionId comes from the header, never the body — the sender's own tab is
    // identified by the request, not by what it claims.
    try { res.json(await send(ctx, userOf(req), { ...b, sessionId: req.get('x-session-id') || undefined })); }
    catch (e) { fail(res, e, 'Send failed'); }
  });

  /** A reply draft carries the same In-Reply-To/References its send will, so the provider files it
   *  in the conversation and a resumed draft still knows what it answers. */
  const draftReplyHeaders = (req: express.Request, b: any): { inReplyTo?: string; references?: string[] } => {
    const r = b?.replyTo;
    if (!r || typeof r.accountId !== 'string' || typeof r.threadKey !== 'string') return {};
    return replyHeaders(ctx, userOf(req).id, { accountId: r.accountId, threadKey: r.threadKey });
  };
  const draftMsg = (req: express.Request, a: accounts.MailAccountRow, b: any, attachments: OutgoingAttachment[] = []) => ({
    from: a.displayName ? { addr: a.emailAddress, name: a.displayName } : { addr: a.emailAddress },
    to: b.to ?? [], cc: b.cc ?? [], bcc: b.bcc ?? [], subject: b.subject ?? '', html: b.html ?? '', text: htmlToText(b.html ?? ''),
    attachments, messageIdHeader: newMessageIdHeader(a.emailAddress.split('@')[1] || 'localhost'),
    ...draftReplyHeaders(req, b),
  });
  /** Draft saves carry the composer's attachments (app files and staged uploads). Staged uploads are
   *  touched, not discarded, so the sweeper keeps them while the draft is still being edited; send discards them. */
  const draftAttachments = (b: any): OutgoingAttachment[] => {
    const r = resolveAttachments(ctx, Array.isArray(b?.attachments) ? b.attachments : [], { maxTotalBytes: MAX_DRAFT_ATTACHMENT_BYTES });
    r.usedUploads.forEach(id => touchUpload(ctx.dataDir, id));
    return r.attachments;
  };
  app.post('/api/mail/drafts', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.body?.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try { const r = await providerFor(a.id).saveDraft(draftMsg(req, a, req.body, draftAttachments(req.body))); res.json({ draftId: r.providerMessageId }); }
    catch (e) { fail(res, e, 'Draft save failed'); }
  });
  app.put('/api/mail/drafts/:id', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.body?.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try { const r = await providerFor(a.id).saveDraft(draftMsg(req, a, req.body, draftAttachments(req.body)), req.params.id); res.json({ draftId: r.providerMessageId }); }
    catch (e) { fail(res, e, 'Draft save failed'); }
  });
  /**
   * Reopens a draft in the composer (spec §9). Answers its fields, a lightly
   * cleaned body (not the reader's sanitized one), and its attachments staged as
   * uploads, so the next autosave re-sends them like any composer attachment.
   * `draftId` is the provider id every provider's saveDraft/deleteDraft accepts
   * for a synced draft (Gmail resolves a message id to its draft id).
   * `replyTo` names the thread the draft answers, so its send threads.
   */
  app.get('/api/mail/messages/:id/draft', authenticateToken, async (req, res) => {
    const m = ownedMessage(req, req.params.id);
    if (!m) return res.status(404).json({ error: 'Message not found' });
    if (!m.isDraft) return res.status(400).json({ error: 'This message is not a draft' });
    try {
      const provider = providerFor(m.accountId);
      const raw = await provider.getBody(m.providerMessageId);
      const attachments: Array<{ uploadId: string; name: string; size: number }> = [];
      let total = 0;
      for (const meta of raw.attachments) {
        const att = await provider.getAttachment(m.providerMessageId, meta.attId, hintOf(meta));
        const chunks: Buffer[] = [];
        try {
          for await (const c of att.stream as AsyncIterable<Buffer>) {
            total += c.length;
            if (total > MAX_DRAFT_ATTACHMENT_BYTES) throw new MailSendError('This draft\'s attachments are too large to open here', 413);
            chunks.push(c);
          }
        } catch (e) { endStream(att.stream); throw e; }
        const buf = Buffer.concat(chunks);
        const name = meta.name || att.name || 'attachment';
        const { uploadId } = stageUpload(ctx.dataDir, name, meta.mime || att.mime || 'application/octet-stream', buf);
        attachments.push({ uploadId, name, size: buf.length });
      }
      const escaped = (raw.text || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
      const html = raw.html ? cleanDraftHtml(raw.html) : escaped.replace(/\r?\n/g, '<br>');

      // A reply draft shares its thread with the mail it answers; failing that,
      // its In-Reply-To names the message (a provider may have filed it alone).
      let replyTo: { accountId: string; threadKey: string } | null = null;
      const answered = db.prepare('SELECT 1 FROM mail_messages WHERE accountId = ? AND threadKey = ? AND isDraft = 0 LIMIT 1').get(m.accountId, m.threadKey);
      if (answered) replyTo = { accountId: m.accountId, threadKey: m.threadKey };
      else if (m.inReplyTo) {
        const parent = db.prepare('SELECT threadKey FROM mail_messages WHERE accountId = ? AND messageIdHeader = ? AND isDraft = 0 LIMIT 1').get(m.accountId, m.inReplyTo) as { threadKey: string } | undefined;
        if (parent) replyTo = { accountId: m.accountId, threadKey: parent.threadKey };
      }

      const row = parseRow(m);
      res.json({
        messageId: m.id, accountId: m.accountId, draftId: m.providerMessageId,
        to: row.to, cc: row.cc, bcc: row.bcc, subject: row.subject ?? '', html, attachments, replyTo,
      });
    } catch (e) { fail(res, e, 'Failed to open draft'); }
  });

  app.delete('/api/mail/drafts/:id', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.query.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try { await providerFor(a.id).deleteDraft(req.params.id); res.json({ ok: true }); }
    catch (e) { fail(res, e, 'Draft delete failed'); }
  });

  app.post('/api/mail/uploads', authenticateToken, express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
    const name = typeof req.query.name === 'string' && req.query.name ? req.query.name : 'attachment';
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty upload body' });
    const { uploadId } = stageUpload(ctx.dataDir, name, req.get('content-type') || 'application/octet-stream', req.body as Buffer);
    res.json({ uploadId });
  });

  // Server-side search for mail older than the local index window.
  app.get('/api/mail/search', authenticateToken, async (req, res) => {
    const a = owned(req, String(req.query.accountId));
    if (!a) return res.status(404).json({ error: 'Account not found' });
    try {
      const hits = await providerFor(a.id).search(String(req.query.q || ''), {
        before: typeof req.query.before === 'string' ? new Date(req.query.before) : new Date(a.indexedSince), limit: 50,
      });
      // The keys are the point: a provider hit is usually body-text-only and
      // usually archived, so neither the local LIKE re-query nor the active
      // folder would show it. The client asks for these keys by name instead.
      const { threadKeys } = upsertEnvelopes(ctx, a, hits);
      res.json({ count: hits.length, threadKeys });
    } catch (e) { fail(res, e, 'Search failed'); }
  });

  // ── misc ──
  app.get('/api/mail/recipients', authenticateToken, (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const out: Array<Addr & { source: string; customerId?: string; role?: string }> = [];
    for (const c of listCustomers(db)) {
      const emails = (c.emails ?? {}) as Record<string, { to?: string; cc?: string; bcc?: string } | undefined>;
      for (const role of ['general', 'accounting', 'estimating', 'pm']) {
        for (const field of ['to', 'cc'] as const) {
          const raw = emails?.[role]?.[field] ?? '';
          for (const addr of raw.split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
            if (q && !addr.toLowerCase().includes(q) && !c.name.toLowerCase().includes(q)) continue;
            out.push({ addr: addr.toLowerCase(), name: c.contactName || c.name, source: `${c.name} · ${role}`, customerId: c.id, role });
          }
        }
      }
    }
    const recent = db.prepare(`SELECT m.fromAddr addr, MAX(m.fromName) name, MAX(m.date) lastDate FROM mail_messages m
      JOIN mail_accounts a ON a.id = m.accountId
      WHERE a.userId = ? AND m.fromAddr IS NOT NULL AND (lower(m.fromAddr) LIKE ? OR lower(COALESCE(m.fromName, '')) LIKE ?)
      GROUP BY m.fromAddr ORDER BY lastDate DESC LIMIT 20`).all(userOf(req).id, `%${q}%`, `%${q}%`) as { addr: string; name: string | null }[];
    for (const r of recent) if (!out.some(o => o.addr === r.addr)) out.push({ addr: r.addr, name: r.name ?? undefined, source: 'recent' });
    res.json(out.slice(0, 25));
  });

  app.get('/api/mail/unread-count', authenticateToken, (req, res) => {
    const rows = db.prepare(`SELECT t.accountId, SUM(t.unreadCount) n FROM mail_threads t
      JOIN mail_accounts a ON a.id = t.accountId
      JOIN mail_folders f ON f.accountId = t.accountId AND f.role = 'inbox'
      WHERE a.userId = ? AND instr(t.folderIdsJson, '"' || f.id || '"') > 0 GROUP BY t.accountId`).all(userOf(req).id) as { accountId: string; n: number }[];
    const byAccount: Record<string, number> = {};
    let total = 0;
    for (const r of rows) { byAccount[r.accountId] = r.n; total += r.n; }
    res.json({ total, byAccount });
  });

  app.post('/api/mail/heartbeat', authenticateToken, (req, res) => {
    const ids: string[] = Array.isArray(req.body?.accountIds) ? req.body.accountIds : [];
    ctx.scheduler?.markViewed(ids.filter(id => owned(req, id)));
    res.status(204).end();
  });

  // The engine only maintains reply state for threads that were ALREADY linked when
  // a message arrived, so a thread linked after the fact needs its state seeded from
  // the messages it already has.
  const backfillReplyState = (accountId: string, threadKey: string) => {
    const rows = db.prepare('SELECT fromAddr, date FROM mail_messages WHERE accountId = ? AND threadKey = ?').all(accountId, threadKey) as { fromAddr: string | null; date: string }[];
    if (!rows.length) return;
    const own = new Set((db.prepare('SELECT LOWER(emailAddress) e FROM mail_accounts').all() as { e: string }[]).map(r => r.e));
    let inbound: string | null = null;
    let outbound: string | null = null;
    for (const r of rows) {
      if (own.has((r.fromAddr || '').trim().toLowerCase())) { if (!outbound || r.date > outbound) outbound = r.date; }
      else if (!inbound || r.date > inbound) inbound = r.date;
    }
    const now = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)').run(threadKey, now);
    db.prepare(`UPDATE mail_thread_reply_state SET
        lastInboundDate = NULLIF(MAX(COALESCE(lastInboundDate, ''), COALESCE(?, '')), ''),
        lastOutboundDate = NULLIF(MAX(COALESCE(lastOutboundDate, ''), COALESCE(?, '')), ''),
        updatedAt = ? WHERE threadKey = ?`).run(inbound, outbound, now, threadKey);
  };

  // The subjectSnapshot/participantsJson columns are app-written snapshots taken at
  // link time (see POST below) — not a live read of anyone's mailbox — so they carry
  // no more mailbox content than GET /api/mail/project-threads already serves to every
  // viewer regardless of who created the link. Redacting them for non-owners protected
  // nothing and starved the cross-user thread-open flow (#5) of the subject/participants
  // it needs to resolve or to render the reference card.
  app.get('/api/mail/links', authenticateToken, (req, res) => {
    const { itemType, itemId } = req.query;
    if (!isItemType(itemType)) return res.status(400).json({ error: 'Unknown itemType' });
    if (typeof itemId !== 'string' || !itemId) return res.status(400).json({ error: 'itemId is required' });
    res.json(listLinksForItem(db, itemType, itemId).map(l => ({ ...l, label: resolveLinkLabel(db, l.itemType, l.itemId) })));
  });

  app.post('/api/mail/links', authenticateToken, (req, res) => {
    const b = req.body ?? {};
    if (!b.threadKey || !b.itemId) return res.status(400).json({ error: 'threadKey, itemType, itemId required' });
    if (!isItemType(b.itemType)) return res.status(400).json({ error: 'Unknown itemType' });
    const t = db.prepare('SELECT t.* FROM mail_threads t JOIN mail_accounts a ON a.id = t.accountId WHERE t.threadKey = ? AND a.userId = ? LIMIT 1').get(b.threadKey, userOf(req).id) as any;
    const link = createLink(db, {
      threadKey: b.threadKey, itemType: b.itemType, itemId: b.itemId, linkedByUserId: userOf(req).id,
      subjectSnapshot: t?.subject ?? null, firstDate: t?.firstDate ?? null, participants: t ? JSON.parse(t.participantsJson) : [],
    });
    if (t) backfillReplyState(t.accountId, b.threadKey);
    res.json(link);
  });

  app.delete('/api/mail/links/:id', authenticateToken, (req, res) => {
    // Anyone could see a link id from the app-wide GET; only the person who made the
    // link (or an admin) may remove it. A link outside that scope is a 404, not a 403,
    // so the route never confirms an id exists to someone who can't touch it.
    const u = userOf(req);
    const row = db.prepare('SELECT linkedByUserId FROM mail_thread_links WHERE id = ?').get(req.params.id) as { linkedByUserId: string } | undefined;
    if (!row || (row.linkedByUserId !== u.id && u.role !== 'admin')) return res.status(404).json({ error: 'Link not found' });
    deleteLink(db, req.params.id);
    res.json({ ok: true });
  });

  const MAX_REPLY_FLAG_IDS = 100;

  /**
   * Batch "did they reply and we haven't yet" indicator for a list of items
   * (spec Goal 4). Viewer-independent — same trust model as GET /api/mail/links:
   * it reads only the link/reply-state rows, never a mailbox, so it works the
   * same for a user with no mail account of their own.
   *
   * Per item, only its NEWEST link (by createdAt, rowid as a tiebreak for two
   * links landed in the same instant) governs — an older, already-superseded
   * link's reply state must not flag an item the newest link doesn't.
   */
  app.get('/api/mail/reply-flags', authenticateToken, (req, res) => {
    const { itemType, itemIds: rawIds } = req.query;
    if (!isItemType(itemType)) return res.status(400).json({ error: 'Unknown itemType' });
    if (typeof rawIds !== 'string' || !rawIds) return res.status(400).json({ error: 'itemIds is required' });
    const itemIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);
    if (!itemIds.length) return res.status(400).json({ error: 'itemIds is required' });
    if (itemIds.length > MAX_REPLY_FLAG_IDS) return res.status(400).json({ error: `Too many itemIds (max ${MAX_REPLY_FLAG_IDS})` });
    const rows = db.prepare(`SELECT l.itemId, l.createdAt, r.lastInboundDate, r.lastOutboundDate
        FROM mail_thread_links l LEFT JOIN mail_thread_reply_state r ON r.threadKey = l.threadKey
        WHERE l.itemType = ? AND l.itemId IN (${itemIds.map(() => '?').join(',')})
        ORDER BY l.itemId, l.createdAt DESC, l.rowid DESC`).all(itemType, ...itemIds) as
      { itemId: string; createdAt: string; lastInboundDate: string | null; lastOutboundDate: string | null }[];
    const seen = new Set<string>();
    const flagged: string[] = [];
    for (const r of rows) {
      // Rows arrive newest-first per item — the first one seen for an itemId IS its newest link.
      if (seen.has(r.itemId)) continue;
      seen.add(r.itemId);
      if (!r.lastInboundDate) continue;
      const floor = r.lastOutboundDate && r.lastOutboundDate > r.createdAt ? r.lastOutboundDate : r.createdAt;
      if (r.lastInboundDate > floor) flagged.push(r.itemId);
    }
    res.json({ flagged });
  });

  /** A link row's participant snapshot, defensively parsed — the column is app-written
   *  JSON, but a hand-edited or pre-Phase-1 row must not throw a 500 on a listing. */
  const parseAddrs = (json: string | null | undefined): Addr[] => {
    try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
  };

  /**
   * Every mail thread linked to a project (or, alternatively, a customer) or
   * one of its items (spec Goal 5, extended for Wave 2's customer mail view).
   *
   * Deliberately viewer-INDEPENDENT: links are app data everyone on the job can
   * see, exactly like GET /api/mail/links. Nothing here reads a mailbox — the
   * subject/participants/firstDate come from the SNAPSHOT columns the linker
   * stored on the link row, so a user with no account of their own gets the same
   * rows without any mailbox content leaking out of its owner's account.
   */
  app.get('/api/mail/project-threads', authenticateToken, (req, res) => {
    const projectId = req.query.projectId;
    const customerId = req.query.customerId;
    const hasProjectId = typeof projectId === 'string' && projectId.length > 0;
    const hasCustomerId = typeof customerId === 'string' && customerId.length > 0;
    if (hasProjectId === hasCustomerId) return res.status(400).json({ error: 'Exactly one of projectId or customerId is required' });
    // The key set is "threads this project/customer touches"; the rows are then EVERY
    // link on those keys. A thread linked to both a p1 invoice and a p2 RFI shows both
    // chips — cross-project linking is the point of Goal 1 — while a key the
    // project/customer does not touch at all never enters the set.
    const filterColumn = hasProjectId ? 'projectId' : 'customerId';
    const filterValue = hasProjectId ? projectId : customerId;
    const rows = db.prepare(`SELECT l.threadKey, l.subjectSnapshot, l.firstDate, l.participantsJson, l.itemType, l.itemId, l.createdAt,
        r.lastInboundDate, r.lastOutboundDate
      FROM mail_thread_links l LEFT JOIN mail_thread_reply_state r ON r.threadKey = l.threadKey
      WHERE l.threadKey IN (SELECT threadKey FROM mail_thread_links WHERE ${filterColumn} = ?)
      ORDER BY l.createdAt, l.rowid`).all(filterValue) as any[];
    const byKey = new Map<string, any>();
    for (const l of rows) {
      let t = byKey.get(l.threadKey);
      if (!t) {
        t = {
          threadKey: l.threadKey, subjectSnapshot: null, participants: [], firstDate: null, links: [],
          lastInboundDate: l.lastInboundDate ?? null, lastOutboundDate: l.lastOutboundDate ?? null, lastActivity: '',
          // Rows are queried `ORDER BY l.createdAt`, so the first row seen for
          // this key IS its earliest link — the moment this thread first
          // became project mail. The client's reply-indicator rule floors on
          // this (spec Goal 4's `max(lastOutboundDate, link.createdAt)`, same
          // as the per-item reply-flags route just above) so linking an
          // already-old inbound-only thread doesn't read as an unanswered
          // reply that arrived before anyone here was tracking it.
          earliestLinkCreatedAt: l.createdAt,
        };
        byKey.set(l.threadKey, t);
      }
      // Oldest link that captured a snapshot wins: a link made from an ITEM view has no
      // thread of its own to snapshot and stores nulls, so it must not blank a real one.
      if (t.subjectSnapshot === null && l.subjectSnapshot !== null) t.subjectSnapshot = l.subjectSnapshot;
      if (t.firstDate === null && l.firstDate !== null) t.firstDate = l.firstDate;
      if (!t.participants.length) t.participants = parseAddrs(l.participantsJson);
      t.links.push({ itemType: l.itemType, itemId: l.itemId, label: resolveLinkLabel(db, l.itemType, l.itemId) });
      // "Last activity" is the newest thing we can honestly date without a mailbox:
      // a reply either way, or the moment somebody linked the thread here.
      for (const d of [l.createdAt, l.lastInboundDate, l.lastOutboundDate]) if (d && d > t.lastActivity) t.lastActivity = d;
    }
    res.json([...byKey.values()].sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0)));
  });

  // Caps on the fallback's inputs: they come off a URL a client builds from a link
  // snapshot, and every one of them ends up in a scan the caller pays for.
  const MAX_RESOLVE_CHARS = 500;
  const MAX_RESOLVE_PARTICIPANTS = 20;
  const RESOLVE_WINDOW_MS = 3 * 86400000;

  /**
   * Where does THIS user open a thread somebody else linked? (spec Goal 3.)
   *
   * 1. exact `threadKey` in one of the caller's own accounts, else
   * 2. same normalized subject + a first date within ±3 days + at least one shared
   *    participant address, over the caller's own accounts (newest thread wins), else
   * 3. `{ match: null }` — the client shows the read-only reference card.
   *
   * Every query here is joined to `mail_accounts.userId`, so a thread in someone
   * else's mailbox is never a match, whatever the caller passes in.
   */
  app.get('/api/mail/resolve-thread', authenticateToken, (req, res) => {
    const uid = userOf(req).id;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const threadKey = str(req.query.threadKey);
    const subject = str(req.query.subject);
    const participants = str(req.query.participants).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (threadKey.length > MAX_RESOLVE_CHARS) return res.status(400).json({ error: 'threadKey is too long' });
    if (subject.length > MAX_RESOLVE_CHARS) return res.status(400).json({ error: 'subject is too long' });
    if (participants.length > MAX_RESOLVE_PARTICIPANTS) return res.status(400).json({ error: 'Too many participants' });

    if (threadKey) {
      const exact = db.prepare(`SELECT t.accountId, t.threadKey FROM mail_threads t JOIN mail_accounts a ON a.id = t.accountId
        WHERE t.threadKey = ? AND a.userId = ? ORDER BY t.lastDate DESC LIMIT 1`).get(threadKey, uid) as { accountId: string; threadKey: string } | undefined;
      if (exact) return res.json({ match: exact });
    }

    const at = Date.parse(str(req.query.firstDate));
    const want = normalizeSubject(subject);
    // All three are required for the fallback — a subject alone would open the wrong
    // conversation, which is worse than showing the reference card.
    if (!want || !Number.isFinite(at) || !participants.length) return res.json({ match: null });
    // Every provider normalizes `date` through toISOString(), so these UTC strings sort
    // chronologically and the SQL range is an exact prefilter; the JS check below is
    // what actually decides the window, so a stray legacy format can only narrow it.
    const lo = new Date(at - RESOLVE_WINDOW_MS).toISOString();
    const hi = new Date(at + RESOLVE_WINDOW_MS).toISOString();
    const cands = db.prepare(`SELECT t.accountId, t.threadKey, t.subject, t.firstDate, t.participantsJson FROM mail_threads t
      JOIN mail_accounts a ON a.id = t.accountId
      WHERE a.userId = ? AND t.firstDate >= ? AND t.firstDate <= ? ORDER BY t.lastDate DESC`).all(uid, lo, hi) as any[];
    for (const c of cands) {
      if (normalizeSubject(c.subject || '') !== want) continue;
      if (!(Math.abs(Date.parse(c.firstDate) - at) <= RESOLVE_WINDOW_MS)) continue;
      if (!parseAddrs(c.participantsJson).some(p => participants.includes(String(p?.addr ?? '').trim().toLowerCase()))) continue;
      return res.json({ match: { accountId: c.accountId, threadKey: c.threadKey } });
    }
    res.json({ match: null });
  });

  app.get('/api/mail/setup-info', authenticateToken, requireAdmin, (_req, res) => {
    // The URIs shown here are the ones an admin pastes into the provider console,
    // so they MUST come from the same builder the real redirect uses.
    const base = deps.publicUrl?.replace(/\/+$/, '') ?? null;
    res.json({
      publicUrl: base,
      google: {
        configured: !!(deps.env.GOOGLE_OAUTH_CLIENT_ID && deps.env.GOOGLE_OAUTH_CLIENT_SECRET),
        redirectUri: base ? redirectUri(base, 'google') : null,
        // Optional real-time push. The webhook URL embeds the shared secret
        // because Pub/Sub has nowhere else to put it (see the route above), so
        // this block is admin-only like the rest of this response — and it is
        // shown even when unconfigured, since an admin needs the URL in hand to
        // create the subscription in the first place.
        pubsub: {
          configured: !!deps.env.GOOGLE_PUBSUB_TOPIC,
          topic: deps.env.GOOGLE_PUBSUB_TOPIC || null,
          webhookUrl: base ? `${base}${GOOGLE_WEBHOOK_PATH}?token=${encodeURIComponent(getGooglePushSecret(db))}` : null,
        },
      },
      microsoft: {
        configured: !!(deps.env.MS_OAUTH_CLIENT_ID && deps.env.MS_OAUTH_CLIENT_SECRET),
        redirectUri: base ? redirectUri(base, 'microsoft') : null,
        webhookUrl: base ? base + WEBHOOK_PATH : null,
        tenant: deps.env.MS_OAUTH_TENANT || 'common',
      },
      secretKey: deps.env.MAIL_SECRET_KEY ? 'env' : 'file',
    });
  });

  // ── test-only fixture routes (E2E) ──
  // Gated at REGISTRATION time, not per-request: MAIL_FAKE_PROVIDER=1 is the
  // same switch providers/index.ts already uses to route every account
  // through the fake, so a deployment that never sets it never mounts these
  // paths at all — a route.test.ts case proves both routes 404 when the flag
  // is unset. Never reachable in a real deployment.
  if (deps.env.MAIL_FAKE_PROVIDER === '1') {
    // Builds one fake envelope. `references`/`inReplyTo` are the caller's own
    // threading chain — the engine's deriveThreadKey (see threadKey.ts) walks
    // exactly that chain, so a root message (empty references, no inReplyTo)
    // becomes its own thread, keyed by its own messageIdHeader.
    const seededEnvelope = (
      toAddr: string, domain: string, from: Addr, subject: string,
      m: { text: string; html?: string; date?: string; attachments?: Array<{ name: string; mime: string; bytesBase64: string }> },
      references: string[], inReplyTo: string | undefined,
    ): Seeded => {
      const atts = Array.isArray(m.attachments) ? m.attachments : [];
      const attachments: AttachmentMeta[] = atts.map((att, i) => ({ attId: `att${i}`, name: att.name, mime: att.mime, size: Buffer.from(att.bytesBase64 || '', 'base64').length }));
      const attachmentBytes: Record<string, Buffer> = {};
      atts.forEach((att, i) => { attachmentBytes[`att${i}`] = Buffer.from(att.bytesBase64 || '', 'base64'); });
      return {
        providerMessageId: 'fake-' + uuidv4(), messageIdHeader: newMessageIdHeader(domain), inReplyTo, references,
        from, to: [{ addr: toAddr }], cc: [], bcc: [],
        subject, snippet: (m.text || '').slice(0, 200), date: m.date ?? new Date().toISOString(),
        isRead: false, isStarred: false, isDraft: false,
        attachments, sizeBytes: (m.html || m.text || '').length,
        folderProviderIds: ['INBOX'], html: m.html, text: m.text, attachmentBytes,
      };
    };

    app.post('/api/mail/_test/seed', authenticateToken, async (req, res) => {
      const b = req.body ?? {};
      const uid = userOf(req).id;
      const email = (typeof b.emailAddress === 'string' && b.emailAddress.trim() ? b.emailAddress : `fake+${uid}@e2e.test`).trim().toLowerCase();
      let a = accounts.listAccounts(db, uid).find(x => x.provider === 'fake' && x.emailAddress === email);
      if (!a) a = accounts.createAccount(db, ctx.crypto, { userId: uid, provider: 'fake', emailAddress: email, auth: { refreshToken: 'test' }, status: 'ok' });
      const domain = email.split('@')[1] || 'e2e.test';
      const fake = getFakeProvider(a.id);
      const threads: Array<{ subject?: string; from: Addr; messages?: unknown[] }> = Array.isArray(b.threads) ? b.threads : [];
      const threadKeys: string[] = [];
      const list: Seeded[] = [];
      for (const th of threads) {
        const headers: string[] = [];
        const msgs = Array.isArray(th.messages) ? th.messages : [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (msgs as any[]).forEach((m, i) => {
          const seeded = seededEnvelope(email, domain, th.from, th.subject || '', m, [...headers], headers[headers.length - 1]);
          headers.push(seeded.messageIdHeader!);
          list.push(seeded);
          if (i === 0) threadKeys.push(seeded.messageIdHeader!);   // a root's own header IS its threadKey
        });
      }
      fake.seed(list);
      // Await the backfill directly (not scheduler.pokeAccount) so the DB —
      // and the threadKeys this responds with — are true before the response
      // goes out; startAccount() below only takes over the ONGOING poll.
      await runBackfill(ctx, accounts.getAccountAny(db, a.id)!, fake);
      ctx.scheduler?.startAccount(a.id);
      res.json({ accountId: a.id, threadKeys });
    });

    app.post('/api/mail/_test/inject', authenticateToken, (req, res) => {
      const b = req.body ?? {};
      const a = owned(req, String(b.accountId));
      if (!a) return res.status(404).json({ error: 'Account not found' });
      if (!b.from?.addr || typeof b.text !== 'string') return res.status(400).json({ error: 'from and text are required' });
      const fake = getFakeProvider(a.id);
      let references: string[] = [];
      let inReplyTo: string | undefined;
      if (typeof b.threadKey === 'string' && b.threadKey) {
        // The thread's own message chain, in arrival order — so the injected
        // envelope's References line names every message already on it and
        // deriveThreadKey resolves straight back to this threadKey.
        const rows = db.prepare('SELECT messageIdHeader FROM mail_messages WHERE accountId = ? AND threadKey = ? ORDER BY date').all(a.id, b.threadKey) as { messageIdHeader: string }[];
        references = rows.map(r => r.messageIdHeader).filter(Boolean);
        inReplyTo = references[references.length - 1];
      } else if (typeof b.inReplyToMessageId === 'string' && b.inReplyToMessageId) {
        const row = db.prepare('SELECT messageIdHeader, referencesJson FROM mail_messages WHERE id = ? AND accountId = ?').get(b.inReplyToMessageId, a.id) as { messageIdHeader: string; referencesJson: string } | undefined;
        if (row) { references = [...JSON.parse(row.referencesJson || '[]'), row.messageIdHeader].filter(Boolean); inReplyTo = row.messageIdHeader; }
      }
      const domain = a.emailAddress.split('@')[1] || 'e2e.test';
      const seeded = seededEnvelope(a.emailAddress, domain, b.from, b.subject || '', { text: b.text, html: b.html, attachments: b.attachments }, references, inReplyTo);
      fake.injectInbound(seeded);
      // Fire-and-forget, same as every other real nudge (POST .../refresh, a
      // webhook, IMAP IDLE): the caller learns about it through the same
      // mailThread broadcast a live inbound message would produce.
      ctx.scheduler?.pokeAccount(a.id);
      res.json({ ok: true });
    });
  }
}
