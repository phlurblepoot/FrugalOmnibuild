// server/mail/sendService.ts  (spec §4.5)
import type { MailContext } from './context';
import * as accounts from './accountStore';
import { getMeta } from '../files';
import { readFileContent } from '../fileStore';
import type { Addr, OutgoingAttachment, OutgoingMessage } from './providers/types';
import { htmlToText, newMessageIdHeader, snippetOf } from './mime';
import { normalizeMessageId } from './threadKey';
import { upsertEnvelopes, removeMessages } from './sync/engine';
import { createLink, type ItemType } from './links';
import { applySendEffects } from './itemSendEffects';
import { readUpload, discardUpload } from './uploads';

/** Gmail refuses messages over 25 MB; the same ceiling keeps a draft save from stalling any provider. */
export const MAX_DRAFT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
import type { EntityChangedEvent } from '../realtime/changeFeed';

export class MailSendError extends Error { constructor(msg: string, public status = 400) { super(msg); } }
export interface SendRequest {
  accountId?: string; to: Addr[]; cc?: Addr[]; bcc?: Addr[]; subject: string; html: string;
  attachments: Array<{ fileId: string; name?: string; itemType?: ItemType; itemId?: string } | { uploadId: string }>;
  replyTo?: { accountId: string; threadKey: string };
  links?: Array<{ itemType: ItemType; itemId: string }>;
  draftProviderId?: string;
  /** The caller's x-session-id, so the tab that sent doesn't refetch its own change. */
  sessionId?: string;
}
export interface SendResult { messageId: string; threadKey: string; accountId: string; effectsSkipped: ItemType[] }

function fileAttachment(ctx: MailContext, fileId: string, name?: string): OutgoingAttachment {
  const meta = getMeta(ctx.db, fileId); const buf = readFileContent(ctx.dataDir, fileId);
  if (!meta || !buf) throw new MailSendError(`Attachment ${fileId} not found`, 400);
  return { name: name || meta.name || 'attachment', mime: meta.mime || 'application/octet-stream', content: buf };
}

/** Resolves request attachments (app files and staged uploads) to bytes. Shared by send and draft saves. */
export function resolveAttachments(ctx: MailContext, list: SendRequest['attachments'] | undefined, opts: { maxTotalBytes?: number } = {}):
  { attachments: OutgoingAttachment[]; usedUploads: string[]; tagged: Array<{ itemType: ItemType; itemId: string }> } {
  const attachments: OutgoingAttachment[] = []; const usedUploads: string[] = []; const tagged: Array<{ itemType: ItemType; itemId: string }> = [];
  let total = 0;
  for (const a of list ?? []) {
    if (a && typeof a === 'object' && 'uploadId' in a) {
      const u = readUpload(ctx.dataDir, String(a.uploadId)); if (!u) throw new MailSendError('Staged upload expired — re-attach the file');
      attachments.push({ name: u.name, mime: u.mime, content: u.buf }); usedUploads.push(a.uploadId); total += u.buf.length;
    } else if (a && typeof a === 'object' && 'fileId' in a) {
      const att = fileAttachment(ctx, a.fileId, a.name); attachments.push(att); total += att.content.length;
      if (a.itemType && a.itemId) tagged.push({ itemType: a.itemType, itemId: a.itemId });
    } else throw new MailSendError('Invalid attachment');
    if (opts.maxTotalBytes && total > opts.maxTotalBytes) throw new MailSendError(`Attachments total more than ${Math.round(opts.maxTotalBytes / 1024 / 1024)} MB — remove some or send them as links`, 413);
  }
  return { attachments, usedUploads, tagged };
}

/** In-Reply-To / References for a message answering `replyTo`'s thread: its newest
 *  non-draft message. Drafts are skipped because a resumed reply draft sits in the same
 *  thread, and answering it would point the reply at a message nobody received.
 *  Shared by send and draft saves, so a saved reply draft threads the way its send will. */
export function replyHeaders(ctx: MailContext, userId: string, replyTo: { accountId: string; threadKey: string }):
  { inReplyTo?: string; references?: string[] } {
  // The reply target's accountId comes straight from the request — scope it to an
  // account this user owns, or a user could probe another account's threads (IDOR).
  const replyAccount = accounts.getOwned(ctx.db, userId, replyTo.accountId);
  if (!replyAccount) throw new MailSendError('Reply target not found', 404);
  const last = ctx.db.prepare('SELECT messageIdHeader, referencesJson FROM mail_messages WHERE accountId = ? AND threadKey = ? AND messageIdHeader IS NOT NULL AND isDraft = 0 ORDER BY date DESC LIMIT 1').get(replyTo.accountId, replyTo.threadKey) as { messageIdHeader: string; referencesJson: string } | undefined;
  if (!last) return {};
  return {
    inReplyTo: last.messageIdHeader,
    references: [...JSON.parse(last.referencesJson || '[]'), last.messageIdHeader].filter((x, i, arr) => arr.indexOf(x) === i),
  };
}

export async function send(ctx: MailContext, user: { id: string; role: string }, req: SendRequest): Promise<SendResult> {
  const { db } = ctx;
  if (!req.to?.length) throw new MailSendError('At least one recipient is required');
  // The server picks the account, not the client: an explicit accountId is
  // honoured (scoped to this user), and otherwise we take the first USABLE
  // account preferring the default one. Falling back to the default even when
  // it is auth_error/needs_review is what let the client and the server
  // disagree about who was sending.
  const usable = (a: accounts.MailAccountRow) => a.status === 'ok' || a.status === 'syncing';
  const account = req.accountId
    ? accounts.getOwned(db, user.id, req.accountId)
    : (() => { const ok = accounts.listAccounts(db, user.id).filter(usable); return ok.find(a => a.isDefault) ?? ok[0] ?? null; })();
  if (!account) throw new MailSendError('No usable mail account — connect or activate one in Settings → Mail', 409);
  if (!usable(account)) throw new MailSendError(`Mail account ${account.emailAddress} is ${account.status.replace('_', ' ')} — fix it in Settings → Mail`, 409);
  const provider = ctx.scheduler ? ctx.scheduler.getProvider(account.id) : ctx.providerFactory(account, accounts.readAuth(db, ctx.crypto, account.id)!);

  const resolved = resolveAttachments(ctx, req.attachments);
  const { attachments, usedUploads } = resolved; const tagged: Array<{ itemType: ItemType; itemId: string }> = [...(req.links ?? []), ...resolved.tagged];

  const { inReplyTo, references } = req.replyTo ? replyHeaders(ctx, user.id, req.replyTo) : {};
  const domain = account.emailAddress.split('@')[1] || 'localhost';
  const msg: OutgoingMessage = {
    from: account.displayName ? { addr: account.emailAddress, name: account.displayName } : { addr: account.emailAddress },
    to: req.to, cc: req.cc ?? [], bcc: req.bcc ?? [], subject: req.subject || '(no subject)', html: req.html || '', text: htmlToText(req.html || ''),
    attachments, inReplyTo, references, messageIdHeader: newMessageIdHeader(domain),
  };
  const sent = await provider.send(msg);
  // Gmail/Graph replace the Message-ID we generated with one of their own. Index the sent
  // row under the header the provider reports, or the recipient's In-Reply-To will point at
  // a header we never stored and the reply will start a new thread.
  const sentMessageIdHeader = normalizeMessageId(sent.messageIdHeader) ?? msg.messageIdHeader;

  // Everything below is local bookkeeping AFTER the provider has already accepted
  // the message — it must never look like the send itself failed. If any of it
  // throws, the message is irretrievably sent but not indexed locally; surface a
  // distinct error telling the caller not to resend rather than letting a DB/link
  // error masquerade as a send failure (which would invite a duplicate send).
  try {
    if (req.draftProviderId) {
      try { await provider.deleteDraft(req.draftProviderId); } catch { /* best effort */ }
      // Drop the draft's local row (and broadcast) now, so it leaves the Drafts list at
      // once instead of at the next sync. Runs even if the provider delete failed: the
      // message has been sent, so the draft is stale either way.
      try { removeMessages(ctx, account, [req.draftProviderId]); } catch (e) { console.error('[mail] draft row removal failed', e); }
    }

    const { messageIds, threadKeys } = upsertEnvelopes(ctx, account, [{
      providerMessageId: sent.providerMessageId, providerThreadId: sent.providerThreadId, messageIdHeader: sentMessageIdHeader, inReplyTo, references: references ?? [],
      from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, snippet: snippetOf(msg.text), date: new Date().toISOString(),
      isRead: true, isStarred: false, isDraft: false, attachments: attachments.map((a, i) => ({ attId: 'out' + i, name: a.name, mime: a.mime, size: a.content.length })), sizeBytes: msg.html.length,
      folderProviderIds: ['SENT'],
    }], { sentFromApp: true, sessionId: req.sessionId });
    const messageId = messageIds[0];
    const threadKey = (db.prepare('SELECT threadKey FROM mail_messages WHERE id = ?').get(messageId) as { threadKey: string }).threadKey;

    const effectsSkipped: ItemType[] = []; const to = req.to.map(a => a.addr).join(', ');
    // The proposal's sentTo snapshot records who it went to AND what it said —
    // carry cc/subject through so the rewired routes keep that record intact.
    const cc = (req.cc ?? []).map(a => a.addr).join(', ') || undefined;
    const seen = new Set<string>();
    const broadcasts: EntityChangedEvent[] = [];
    db.transaction(() => {
      for (const t of tagged) {
        const key = t.itemType + ':' + t.itemId; if (seen.has(key)) continue; seen.add(key);
        createLink(db, { threadKey, itemType: t.itemType, itemId: t.itemId, linkedByUserId: user.id, subjectSnapshot: msg.subject, firstDate: new Date().toISOString(), participants: [msg.from, ...msg.to] });
        const eff = applySendEffects(db, { itemType: t.itemType, itemId: t.itemId, userId: user.id, role: user.role, to, cc, subject: msg.subject, threadKey });
        if (eff.skipped === 'role') effectsSkipped.push(t.itemType);
        if (eff.broadcast) broadcasts.push({ ...eff.broadcast, action: 'updated', byUserId: user.id, bySessionId: req.sessionId });
      }
    })();
    broadcasts.forEach(b => ctx.broadcastChange(b));

    // Reply-state for a thread that only became linked by this send.
    const now = new Date().toISOString();
    if (tagged.length) {
      db.prepare('INSERT OR IGNORE INTO mail_thread_reply_state (threadKey, updatedAt) VALUES (?, ?)').run(threadKey, now);
      db.prepare(`UPDATE mail_thread_reply_state SET lastOutboundDate = MAX(COALESCE(lastOutboundDate,''), ?), updatedAt = ? WHERE threadKey = ?`).run(now, now, threadKey);
    }

    // Only discard staged uploads once the send is fully recorded — on failure the
    // sweeper still reaps them within the hour, but they stay around for diagnosis.
    usedUploads.forEach(id => discardUpload(ctx.dataDir, id));
    void threadKeys;
    return { messageId, threadKey, accountId: account.id, effectsSkipped };
  } catch (e) {
    console.error('[mail] sent but not recorded', e);
    throw new MailSendError('Message was sent but could not be recorded locally — do not resend; it will appear after the next sync', 502);
  }
}
