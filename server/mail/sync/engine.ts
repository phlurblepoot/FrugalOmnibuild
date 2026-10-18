// server/mail/sync/engine.ts  (spec §4.2, §3.1, §3 reply-state rule)
import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { MailContext } from '../context';
import type { MailAccountRow } from '../accountStore';
import * as accounts from '../accountStore';
import type { Envelope, MailProvider, ProviderFolder } from '../providers/types';
import { AuthExpiredError, RateLimitedError } from '../providers/types';
import { deriveThreadKey, mergeThreadKeys, normalizeMessageId, normalizeSubject, stripSubjectPrefixes } from '../threadKey';
import { snippetOf } from '../mime';
import { clearPushState, mergePushState, mergeSyncKeys, parseSyncState, pickPushState, writeSyncState } from '../push';

export type InboundHook = (ctx: MailContext, ev: { threadKey: string; messageId: string; account: MailAccountRow }) => void;
const inboundHooks: InboundHook[] = [];
export function registerInboundHook(fn: InboundHook): void { inboundHooks.push(fn); }
export function clearInboundHooks(): void { inboundHooks.length = 0; }   // tests

/** How far apart our sent row and the provider's copy of it may be before they
 *  stop looking like the same message. */
const SENT_MATCH_WINDOW_MS = 5 * 60_000;
/** A placeholder older than this has had every chance to be reconciled. */
const PLACEHOLDER_TTL_MS = 60 * 60_000;
/** Where a paused import parks its place in the mailbox, inside the account's
 *  syncState JSON. Deliberately NOT push-state keys: `writeSyncState` carries
 *  only those forward, so the moment the import completes and writes the
 *  provider's real state these disappear on their own. */
const BACKFILL_KEYS = ['backfillCursor', 'backfillWatermark', 'backfillSince'] as const;
/** What the user is told while the provider is throttling the import. The raw
 *  "Gmail 403 — rate limited" reads like a fault the user has to fix; this is a
 *  wait state the scheduler is already handling. */
export const RATE_LIMIT_NOTICE = 'Mailbox import is rate limited by the provider — retrying automatically';

/** True when a stored syncState holds a paused import — the scheduler's gate
 *  and the engine's resume path must agree on what that looks like. */
export function hasParkedBackfill(syncStateJson: string | null): boolean {
  const cursor = parseSyncState(syncStateJson).backfillCursor;
  return typeof cursor === 'string' && cursor.length > 0;
}

export function upsertFolders(db: Database.Database, accountId: string, folders: ProviderFolder[]): Map<string, string> {
  const map = new Map<string, string>();
  const tx = db.transaction(() => {
    folders.forEach((f, i) => {
      const existing = db.prepare('SELECT id FROM mail_folders WHERE accountId = ? AND providerId = ?').get(accountId, f.providerId) as { id: string } | undefined;
      const id = existing?.id ?? uuidv4();
      if (existing) db.prepare('UPDATE mail_folders SET name = ?, role = ?, unreadCount = COALESCE(?, unreadCount), totalCount = COALESCE(?, totalCount), sortOrder = ? WHERE id = ?')
        .run(f.name, f.role, f.unreadCount ?? null, f.totalCount ?? null, f.sortOrder ?? i, id);
      else db.prepare('INSERT INTO mail_folders (id, accountId, providerId, name, role, unreadCount, totalCount, sortOrder) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, accountId, f.providerId, f.name, f.role, f.unreadCount ?? 0, f.totalCount ?? 0, f.sortOrder ?? i);
      map.set(f.providerId, id);
    });
  });
  tx();
  return map;
}

function folderMap(db: Database.Database, accountId: string): Map<string, string> {
  const m = new Map<string, string>();
  (db.prepare('SELECT id, providerId FROM mail_folders WHERE accountId = ?').all(accountId) as { id: string; providerId: string }[]).forEach(r => m.set(r.providerId, r.id));
  return m;
}

export function isInbound(db: Database.Database, env: Envelope): boolean {
  const own = db.prepare('SELECT 1 FROM mail_accounts WHERE LOWER(emailAddress) = ?').get((env.from?.addr || '').trim().toLowerCase());
  return !own;
}

export function rebuildThread(db: Database.Database, accountId: string, threadKey: string): void {
  const rows = db.prepare('SELECT * FROM mail_messages WHERE accountId = ? AND threadKey = ? ORDER BY date').all(accountId, threadKey) as any[];
  if (!rows.length) { db.prepare('DELETE FROM mail_threads WHERE accountId = ? AND threadKey = ?').run(accountId, threadKey); return; }
  const participants = new Map<string, { addr: string; name?: string }>();
  const folders = new Set<string>();
  let hasAtt = 0, starred = 0, unread = 0;
  let subject = '';
  for (const r of rows) {
    const addrs = [{ addr: r.fromAddr, name: r.fromName }, ...JSON.parse(r.toJson), ...JSON.parse(r.ccJson)];
    addrs.forEach((a: any) => { if (a?.addr && !participants.has(a.addr)) participants.set(a.addr, a.name ? { addr: a.addr, name: a.name } : { addr: a.addr }); });
    JSON.parse(r.folderIdsJson).forEach((f: string) => folders.add(f));
    if (r.hasAttachments) hasAtt = 1; if (r.isStarred) starred = 1; if (!r.isRead) unread++;
    if (!subject && r.subject) subject = stripSubjectPrefixes(r.subject);
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO mail_threads (id, accountId, threadKey, subject, firstDate, lastDate, messageCount, unreadCount, hasAttachments, isStarred, participantsJson, folderIdsJson, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(accountId, threadKey) DO UPDATE SET subject=excluded.subject, firstDate=excluded.firstDate, lastDate=excluded.lastDate, messageCount=excluded.messageCount,
                unreadCount=excluded.unreadCount, hasAttachments=excluded.hasAttachments, isStarred=excluded.isStarred, participantsJson=excluded.participantsJson, folderIdsJson=excluded.folderIdsJson, updatedAt=excluded.updatedAt`)
    .run(uuidv4(), accountId, threadKey, subject, rows[0].date, rows[rows.length - 1].date, rows.length, unread, hasAtt, starred, JSON.stringify([...participants.values()]), JSON.stringify([...folders]), now);
}

// opts.sessionId: when this upsert is the direct result of a request (a send),
// the originating tab's x-session-id rides along on the broadcasts so it does
// not refetch a change it already applied locally.
export function upsertEnvelopes(ctx: MailContext, account: MailAccountRow, envelopes: Envelope[], opts: { sentFromApp?: boolean; sessionId?: string } = {}): { messageIds: string[]; threadKeys: string[] } {
  const { db } = ctx;
  const fmap = folderMap(db, account.id);
  const touched = new Set<string>();
  const mergedAway = new Set<string>();
  const messageIds: string[] = [];
  const inboundEvents: { threadKey: string; messageId: string }[] = [];

  // Prepared once per call, reused across every envelope/candidate in the loop below.
  const lookupStmt = db.prepare('SELECT threadKey FROM mail_messages WHERE accountId = ? AND messageIdHeader = ?');
  const lookup = (mid: string) => (lookupStmt.get(account.id, mid) as { threadKey: string } | undefined)?.threadKey ?? null;
  const orphanStmt = db.prepare('SELECT 1 FROM mail_messages WHERE accountId = ? AND threadKey = ?');
  // Also serves the by-id placeholder lookup: same account, same column.
  const existingStmt = db.prepare('SELECT id, threadKey FROM mail_messages WHERE accountId = ? AND providerMessageId = ?');
  const threadByProviderStmt = db.prepare('SELECT threadKey FROM mail_messages WHERE accountId = ? AND providerThreadId = ? LIMIT 1');
  const lookupByProviderThread = (pt: string) => (threadByProviderStmt.get(account.id, pt) as { threadKey: string } | undefined)?.threadKey ?? null;
  // Microsoft Graph never reports the id of a message it sent, so a send whose
  // Sent Items read-back came up empty is indexed under "sent:<Message-ID>".
  // When the sync later delivers the same message under its real id, that row
  // has to be RE-KEYED rather than inserted alongside, or the user's own sent
  // message shows up twice in the thread for ever. Three ways in, weakest last:
  // the provider names the row (it recognises its own correlation header); the
  // Message-ID matches (only for a provider that kept ours); or the real copy
  // lands in Sent and looks like the placeholder (SENT_MATCH below).
  const sentPlaceholderStmt = db.prepare(`SELECT id, threadKey FROM mail_messages WHERE accountId = ? AND messageIdHeader = ? AND providerMessageId LIKE 'sent:%'`);
  // A range rather than LIKE 'sent:%': SQLite only turns a LIKE prefix into an
  // index range when case_sensitive_like is on, and this wants the
  // (accountId, providerMessageId) index.
  const placeholderRowsStmt = db.prepare(`SELECT id, threadKey, providerThreadId, subject, date FROM mail_messages
    WHERE accountId = ? AND providerMessageId >= 'sent:' AND providerMessageId < 'sent;'`);
  const sentFolderIds = new Set((db.prepare(`SELECT id FROM mail_folders WHERE accountId = ? AND role = 'sent'`).all(account.id) as { id: string }[]).map(r => r.id));
  const ownAddressStmt = db.prepare('SELECT 1 FROM mail_accounts WHERE LOWER(emailAddress) = ?');
  const updateStmt = db.prepare(`UPDATE mail_messages SET accountId=?, providerMessageId=?, providerThreadId=?, messageIdHeader=?, inReplyTo=?, referencesJson=?, threadKey=?, fromAddr=?, fromName=?, toJson=?, ccJson=?, bccJson=?,
    subject=?, snippet=?, date=?, isRead=?, isStarred=?, isDraft=?, hasAttachments=?, attachmentsJson=?, sizeBytes=?, folderIdsJson=?, sentFromApp=MAX(sentFromApp, ?), updatedAt=? WHERE id=?`);
  const insertStmt = db.prepare(`INSERT INTO mail_messages (accountId, providerMessageId, providerThreadId, messageIdHeader, inReplyTo, referencesJson, threadKey, fromAddr, fromName, toJson, ccJson, bccJson,
    subject, snippet, date, isRead, isStarred, isDraft, hasAttachments, attachmentsJson, sizeBytes, folderIdsJson, sentFromApp, id, createdAt, updatedAt) VALUES (${Array.from({ length: 23 }, () => '?').join(',')}, ?, ?, ?)`);
  const linkedStmt = db.prepare('SELECT 1 FROM mail_thread_links WHERE threadKey = ? LIMIT 1');
  const insertReplyStateStmt = db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)');
  const updateInboundStmt = db.prepare(`UPDATE mail_thread_reply_state SET lastInboundDate = MAX(COALESCE(lastInboundDate, ''), ?), updatedAt = ? WHERE threadKey = ?`);
  const updateOutboundStmt = db.prepare(`UPDATE mail_thread_reply_state SET lastOutboundDate = MAX(COALESCE(lastOutboundDate, ''), ?), updatedAt = ? WHERE threadKey = ?`);

  /** Last line of defence for a `sent:` placeholder whose provider could not
   *  name it (a Graph REPLY carries no correlation header, because Graph only
   *  accepts one on a message it did not create itself). The real copy is
   *  recognised by the conversation it shares with the placeholder, or by the
   *  same subject within five minutes.
   *
   *  Both tests are guarded on the message being FROM one of our own addresses.
   *  Without that guard the guard is worse than nothing: normalizeSubject
   *  strips "Re:", so a reply arriving within five minutes of our own send
   *  matches on subject, and we would re-key our sent row onto the INBOUND
   *  message and lose both. */
  const matchPlaceholder = (env: Envelope): { id: string; threadKey: string } | undefined => {
    const landsInSent = (env.folderProviderIds || []).some(p => { const local = fmap.get(p); return !!local && sentFolderIds.has(local); });
    if (!landsInSent && account.provider !== 'microsoft') return undefined;
    if (ownAddressStmt.get((env.from?.addr || '').trim().toLowerCase()) === undefined) return undefined;
    const rows = placeholderRowsStmt.all(account.id) as { id: string; threadKey: string; providerThreadId: string | null; subject: string; date: string }[];
    if (!rows.length) return undefined;
    const when = Date.parse(env.date);
    const subject = normalizeSubject(env.subject || '');
    // Subject ties are broken by time: with two sends of the same subject in
    // flight, the nearest in time is the one this copy is of.
    const nearestBySubject = rows
      .filter(r => normalizeSubject(r.subject || '') === subject && Number.isFinite(when) && Math.abs(Date.parse(r.date) - when) <= SENT_MATCH_WINDOW_MS)
      .sort((a, b) => Math.abs(Date.parse(a.date) - when) - Math.abs(Date.parse(b.date) - when))[0];
    const hit = rows.find(r => env.providerThreadId && r.providerThreadId === env.providerThreadId) ?? nearestBySubject;
    return hit ? { id: hit.id, threadKey: hit.threadKey } : undefined;
  };

  const tx = db.transaction(() => {
    for (const env of envelopes) {
      const mid = normalizeMessageId(env.messageIdHeader);
      const { threadKey } = deriveThreadKey(lookup, { messageIdHeader: mid, inReplyTo: env.inReplyTo ?? null, references: env.references ?? [], fallbackSeed: account.id + ':' + env.providerMessageId, providerThreadId: env.providerThreadId ?? null }, lookupByProviderThread);

      // Bridge merge (spec §3.1 step 7): fold in ANY existing thread that this
      // message's own chain (references, in-reply-to, or its own id) points
      // at but which didn't resolve to `threadKey` — covers a late-arriving
      // root AND a late-arriving mid-chain message that finally links two
      // previously-separate, independently-keyed groups.
      const candidates = new Set<string>((env.references || []).map(normalizeMessageId).filter((x): x is string => !!x));
      const irt = normalizeMessageId(env.inReplyTo);
      if (irt) candidates.add(irt);
      if (mid) candidates.add(mid);
      for (const c of candidates) {
        if (c === threadKey) continue;
        if (orphanStmt.get(account.id, c)) { mergeThreadKeys(db, account.id, c, threadKey); touched.delete(c); mergedAway.add(c); touched.add(threadKey); }
      }

      const isPlaceholder = env.providerMessageId.startsWith('sent:');
      const replaces = !isPlaceholder && env.replacesProviderMessageId?.startsWith('sent:') ? env.replacesProviderMessageId : null;
      const existing = (existingStmt.get(account.id, env.providerMessageId)
        ?? (replaces ? existingStmt.get(account.id, replaces) : undefined)
        // Only a placeholder is adopted this way: two REAL ids that happen to
        // share a Message-ID (the same message filed in two mailboxes) stay
        // two rows, which is what the folder list expects.
        ?? (mid && !isPlaceholder ? sentPlaceholderStmt.get(account.id, mid) : undefined)
        ?? (isPlaceholder ? undefined : matchPlaceholder(env))) as { id: string; threadKey: string } | undefined;
      const id = existing?.id ?? uuidv4();
      const now = new Date().toISOString();
      const folderIds = (env.folderProviderIds || []).map(p => fmap.get(p)).filter((x): x is string => !!x);
      const values = [account.id, env.providerMessageId, env.providerThreadId ?? null, mid, normalizeMessageId(env.inReplyTo), JSON.stringify((env.references || []).map(normalizeMessageId).filter(Boolean)), threadKey,
        env.from?.addr?.toLowerCase() ?? null, env.from?.name ?? null, JSON.stringify(env.to || []), JSON.stringify(env.cc || []), JSON.stringify(env.bcc || []),
        env.subject || '', snippetOf(env.snippet || ''), env.date, env.isRead ? 1 : 0, env.isStarred ? 1 : 0, env.isDraft ? 1 : 0,
        env.attachments?.length ? 1 : 0, JSON.stringify(env.attachments || []), env.sizeBytes || 0, JSON.stringify(folderIds), opts.sentFromApp ? 1 : 0];
      if (existing) {
        updateStmt.run(...values, now, id);
        if (existing.threadKey !== threadKey) touched.add(existing.threadKey);
      } else {
        insertStmt.run(...values, id, now, now);
        // Reply-state + hooks only for NEW messages on linked threads.
        const linked = linkedStmt.get(threadKey);
        if (linked) {
          const inbound = !ownAddressStmt.get((env.from?.addr || '').trim().toLowerCase());
          insertReplyStateStmt.run(threadKey, now);
          (inbound ? updateInboundStmt : updateOutboundStmt).run(env.date, now, threadKey);
          if (inbound) inboundEvents.push({ threadKey, messageId: id });
        }
      }
      messageIds.push(id); touched.add(threadKey);
    }
    for (const key of touched) rebuildThread(db, account.id, key);
  });
  tx();
  for (const key of touched) ctx.broadcastChange({ type: 'mailThread', id: key, action: 'updated', byUserId: account.userId, bySessionId: opts.sessionId });
  for (const key of mergedAway) ctx.broadcastChange({ type: 'mailThread', id: key, action: 'deleted', byUserId: account.userId, bySessionId: opts.sessionId });
  for (const ev of inboundEvents) for (const h of inboundHooks) { try { h(ctx, { ...ev, account }); } catch (e) { console.error('[mail] inbound hook failed', e); } }
  return { messageIds, threadKeys: [...touched] };
}

export function removeMessages(ctx: MailContext, account: MailAccountRow, providerMessageIds: string[]): void {
  const { db } = ctx; const touched = new Set<string>();
  db.transaction(() => {
    for (const pid of providerMessageIds) {
      const row = db.prepare('SELECT threadKey FROM mail_messages WHERE accountId = ? AND providerMessageId = ?').get(account.id, pid) as { threadKey: string } | undefined;
      if (!row) continue;
      db.prepare('DELETE FROM mail_messages WHERE accountId = ? AND providerMessageId = ?').run(account.id, pid);
      touched.add(row.threadKey);
    }
    for (const key of touched) rebuildThread(db, account.id, key);
  })();
  for (const key of touched) ctx.broadcastChange({ type: 'mailThread', id: key, action: 'updated', byUserId: account.userId });
}

/** Drops `sent:` placeholders that have outlived their usefulness: the real
 *  message reached the index under some OTHER id, so the placeholder is now a
 *  visible duplicate of the user's own sent message. A placeholder whose thread
 *  holds nothing else of ours is KEPT — it is the only record the user has that
 *  they sent the thing, and showing a stale row beats losing the message. */
export function sweepSentPlaceholders(ctx: MailContext, account: MailAccountRow): number {
  const { db } = ctx;
  const cutoff = new Date(Date.now() - PLACEHOLDER_TTL_MS).toISOString();
  const stale = db.prepare(`SELECT id, threadKey FROM mail_messages
    WHERE accountId = ? AND providerMessageId >= 'sent:' AND providerMessageId < 'sent;' AND createdAt < ?`).all(account.id, cutoff) as { id: string; threadKey: string }[];
  if (!stale.length) return 0;
  const supersededStmt = db.prepare(`SELECT 1 FROM mail_messages m
    JOIN mail_accounts a ON LOWER(a.emailAddress) = m.fromAddr
    WHERE m.accountId = ? AND m.threadKey = ? AND m.id <> ?
      AND NOT (m.providerMessageId >= 'sent:' AND m.providerMessageId < 'sent;') LIMIT 1`);
  const touched = new Set<string>();
  db.transaction(() => {
    for (const row of stale) {
      if (!supersededStmt.get(account.id, row.threadKey, row.id)) continue;
      db.prepare('DELETE FROM mail_messages WHERE id = ?').run(row.id);
      touched.add(row.threadKey);
    }
    for (const key of touched) rebuildThread(db, account.id, key);
  })();
  for (const key of touched) ctx.broadcastChange({ type: 'mailThread', id: key, action: 'updated', byUserId: account.userId });
  return touched.size;
}

async function guarded(ctx: MailContext, account: MailAccountRow, fn: () => Promise<void>): Promise<void> {
  try { await fn(); accounts.updateAccount(ctx.db, account.id, { status: 'ok', lastSyncAt: new Date().toISOString(), lastError: null }); }
  catch (e: any) {
    if (e instanceof AuthExpiredError) accounts.updateAccount(ctx.db, account.id, { status: 'auth_error', lastError: e.message });
    // A throttle is not something the user did or can fix, and the import is
    // parked rather than lost, so it gets said in those words.
    else if (e instanceof RateLimitedError) accounts.updateAccount(ctx.db, account.id, { lastError: RATE_LIMIT_NOTICE });
    else accounts.updateAccount(ctx.db, account.id, { lastError: e?.message || String(e) });
    throw e;
  } finally { ctx.broadcastChange({ type: 'mailAccount', id: account.id, action: 'updated', byUserId: account.userId }); }
}

/** Imports the mailbox from `since` (default: the account's indexedSince), a
 *  provider page at a time, and leaves the incremental baseline behind it.
 *
 *  Progress is PARKED after every page. Without that, a mailbox big enough to
 *  outlast the provider's rate limit could never finish: the whole state is
 *  written only at the end, so a throttle three quarters of the way through
 *  threw the run away and the next tick started again from page one — which
 *  re-read enough of the mailbox to be throttled at the same place, for ever,
 *  with the account stuck showing "Syncing". */
export async function runBackfill(ctx: MailContext, account: MailAccountRow, provider: MailProvider, since?: Date): Promise<void> {
  await guarded(ctx, account, async () => {
    accounts.updateAccount(ctx.db, account.id, { status: 'syncing' });
    upsertFolders(ctx.db, account.id, await provider.listFolders());
    const from = since ?? new Date(account.indexedSince);
    const parked = parseSyncState(account.syncState);
    // A parked cursor belongs to the window it was minted for: `load-older`
    // widens `since`, and a page token for the old query would either be
    // rejected or, worse, silently skip the newly opened months.
    const resumable = typeof parked.backfillCursor === 'string' && !!parked.backfillCursor
      && parked.backfillSince === from.toISOString();
    let cursor: string | undefined = resumable ? parked.backfillCursor as string : undefined;
    let watermark: string | undefined = resumable && typeof parked.backfillWatermark === 'string' ? parked.backfillWatermark : undefined;
    const resumedFrom = cursor;
    let first = true;
    let restarted = false;

    for (;;) {
      let page: Awaited<ReturnType<MailProvider['backfill']>>;
      try {
        page = await provider.backfill({ since: from, cursor, ...(watermark ? { watermark } : {}) });
      } catch (e) {
        // A parked page token can go stale while the import is standing down
        // (Gmail answers 400). Once, and only once, throw it away and read the
        // mailbox from the top rather than parking a token that can never work.
        const status = (e as { status?: number } | null)?.status;
        if (first && !restarted && resumedFrom && !(e instanceof RateLimitedError) && status === 400) {
          console.warn(`[mail] the parked import cursor for ${account.id} was rejected (400) — restarting the import from the beginning`);
          restarted = true; first = false;
          cursor = undefined; watermark = undefined;
          clearPushState(ctx.db, account.id, BACKFILL_KEYS);
          continue;
        }
        throw e;
      }
      first = false;
      upsertEnvelopes(ctx, account, page.messages);
      if (page.watermark) watermark = page.watermark;
      cursor = page.cursor;
      if (page.done || !cursor) break;
      mergeSyncKeys(ctx.db, account.id, {
        backfillCursor: cursor,
        backfillSince: from.toISOString(),
        ...(watermark ? { backfillWatermark: watermark } : {}),
      });
    }
    // Establish the incremental baseline so history starts "now". Deliberately
    // `{}` and not the row's syncState: a backfill has just re-read everything,
    // so any cursor from before it is stale — and after a reset it is the very
    // cursor the provider told us it could no longer honour.
    const r = await provider.incremental({});
    upsertEnvelopes(ctx, account, r.upserts);
    // writeSyncState keeps only the push keys from the old row, so this is also
    // what retires the parked cursor: the import is over, it must not resume.
    writeSyncState(ctx.db, account.id, r.state);
  });
}

export async function runIncremental(ctx: MailContext, account: MailAccountRow, provider: MailProvider): Promise<void> {
  await guarded(ctx, account, async () => {
    const fresh = accounts.getAccountAny(ctx.db, account.id)!;
    const r = await provider.incremental(JSON.parse(fresh.syncState || '{}'));
    // The provider's change log no longer reaches our cursor (Gmail drops
    // history after about a week offline). Its state is meaningless now, so
    // clear it and re-read from indexedSince — upserts are keyed by provider
    // id, so a re-read refreshes the existing rows instead of duplicating them.
    if (r.reset) {
      // Nulling the state is what routes the next pass back through a backfill,
      // but the Graph subscription living in the same JSON is still valid — put
      // it back once the backfill has written the new provider state.
      const push = pickPushState(fresh.syncState);
      accounts.updateAccount(ctx.db, account.id, { syncState: null });
      await runBackfill(ctx, accounts.getAccountAny(ctx.db, account.id)!, provider);
      if (Object.keys(push).length) mergePushState(ctx.db, account.id, push);
      return;
    }
    if (r.upserts.length) { upsertFolders(ctx.db, account.id, await provider.listFolders()); upsertEnvelopes(ctx, account, r.upserts); }
    if (r.deletes.length) removeMessages(ctx, account, r.deletes);
    sweepSentPlaceholders(ctx, account);
    writeSyncState(ctx.db, account.id, r.state);
  });
}
