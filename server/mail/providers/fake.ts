import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import type { MailProvider, Envelope, ProviderFolder, SyncState, OutgoingMessage, AttachmentMeta, MoveResult } from './types';
import { ProviderNotFoundError } from './types';

// Exported so the test-only fixture routes (server/mail/routes.ts, gated on
// MAIL_FAKE_PROVIDER=1) can build envelopes without re-declaring this shape.
export type Seeded = Envelope & { html?: string; text?: string; attachmentBytes?: Record<string, Buffer> };

export class FakeMailProvider implements MailProvider {
  kind = 'fake' as const;
  private msgs = new Map<string, Seeded>();
  private log: Array<{ seq: number; upsert?: string; delete?: string }> = [];
  private seq = 0;
  sent: OutgoingMessage[] = [];
  drafts = new Map<string, OutgoingMessage>();
  folders: ProviderFolder[] = [
    { providerId: 'INBOX', name: 'Inbox', role: 'inbox' }, { providerId: 'SENT', name: 'Sent', role: 'sent' },
    { providerId: 'DRAFTS', name: 'Drafts', role: 'drafts' }, { providerId: 'TRASH', name: 'Trash', role: 'trash' },
    { providerId: 'ARCHIVE', name: 'Archive', role: 'archive' },
  ];
  private nextFailure: Error | null = null;
  /** When set, send() reports this back as the Message-ID the provider actually used
   *  (mirrors Gmail/Graph rewriting the header we supplied). */
  sendMessageIdHeader: string | null = null;
  /** Gmail-like attachment ids. Gmail mints a NEW set of attachment ids on
   *  EVERY message read, so with this on each getBody() rotates the ids
   *  (`<base>-gen<n>`), and getAttachment() with an unknown id and no hint
   *  re-reads the body to look it up — exactly what GmailProvider does — which
   *  rotates them again and so can never find it. `bodyReads` counts every
   *  read, including those, so a test can prove a batch paid for ONE. */
  gmailAttachmentIds = false;
  bodyReads = 0;

  seed(list: Seeded[]): void { this.msgs.clear(); this.log = []; list.forEach(m => this.msgs.set(m.providerMessageId, m)); }
  injectInbound(m: Seeded): void { this.msgs.set(m.providerMessageId, m); this.log.push({ seq: ++this.seq, upsert: m.providerMessageId }); }
  failNextWith(err: Error): void { this.nextFailure = err; }
  /** Mimics Gmail: the attachment ids handed out at sync time stop resolving,
   *  and the message's CURRENT part list names the same files under new ones.
   *  getAttachment then 404s on the indexed id exactly as the real thing does,
   *  while getBody serves the fresh list. */
  rotateAttachmentIds(providerMessageId: string, rename: (attId: string) => string): void {
    const m = this.msgs.get(providerMessageId);
    if (!m) return;
    const bytes: Record<string, Buffer> = {};
    m.attachments = m.attachments.map(a => {
      const next = rename(a.attId);
      bytes[next] = m.attachmentBytes?.[a.attId] ?? Buffer.from('fake-bytes');
      return { ...a, attId: next };
    });
    m.attachmentBytes = bytes;
  }
  private guard(): void { if (this.nextFailure) { const e = this.nextFailure; this.nextFailure = null; throw e; } }

  async listFolders(): Promise<ProviderFolder[]> { this.guard(); return this.folders; }
  async backfill(opts: { since: Date; cursor?: string }) {
    this.guard();
    const messages = [...this.msgs.values()].filter(m => new Date(m.date) >= opts.since && !m.isDraft);
    return { messages, done: true };
  }
  async incremental(state: SyncState) {
    this.guard();
    const cursor = typeof state.cursor === 'number' ? state.cursor : 0;
    const entries = this.log.filter(e => e.seq > cursor);
    const upserts = entries.filter(e => e.upsert).map(e => this.msgs.get(e.upsert!)!).filter(Boolean);
    const deletes = entries.filter(e => e.delete).map(e => e.delete!);
    return { upserts, deletes, state: { cursor: this.seq } };
  }
  async getBody(id: string) {
    this.guard(); const m = this.msgs.get(id); if (!m) throw new ProviderNotFoundError(id);
    this.bodyReads++;
    if (this.gmailAttachmentIds) this.rotateAttachmentIds(id, a => `${a.replace(/-gen\d+$/, '')}-gen${this.bodyReads}`);
    return { html: m.html, text: m.text, attachments: m.attachments };
  }
  async getAttachment(id: string, attId: string, hint?: { name: string; mime: string }) {
    this.guard(); const m = this.msgs.get(id);
    let meta = m?.attachments.find(a => a.attId === attId);
    // Mirrors GmailProvider: an id it has no metadata for is looked up in a
    // fresh body read UNLESS the caller supplied the name/mime itself.
    if (!meta && m && this.gmailAttachmentIds && !hint) meta = (await this.getBody(id)).attachments.find(a => a.attId === attId);
    if (!m || !meta) throw new ProviderNotFoundError(attId);
    const buf = m.attachmentBytes?.[attId] ?? Buffer.from('fake-bytes');
    return { stream: Readable.from(buf), mime: meta.mime, size: buf.length, name: meta.name };
  }
  async send(msg: OutgoingMessage) {
    this.guard(); this.sent.push(msg);
    const id = 'sent-' + uuidv4();
    const messageIdHeader = this.sendMessageIdHeader ?? msg.messageIdHeader;
    const env: Seeded = { providerMessageId: id, messageIdHeader, inReplyTo: msg.inReplyTo, references: msg.references ?? [],
      from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, snippet: msg.text.slice(0, 200), date: new Date().toISOString(),
      isRead: true, isStarred: false, isDraft: false, sizeBytes: msg.html.length,
      attachments: msg.attachments.map((a, i): AttachmentMeta => ({ attId: 'att' + i, name: a.name, mime: a.mime, size: a.content.length })),
      folderProviderIds: ['SENT'], html: msg.html, text: msg.text };
    this.msgs.set(id, env); this.log.push({ seq: ++this.seq, upsert: id });
    return this.sendMessageIdHeader ? { providerMessageId: id, messageIdHeader: this.sendMessageIdHeader } : { providerMessageId: id };
  }
  async setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }) {
    this.guard(); ids.forEach(id => { const m = this.msgs.get(id); if (!m) return; if (flags.read !== undefined) m.isRead = flags.read; if (flags.starred !== undefined) m.isStarred = flags.starred; this.log.push({ seq: ++this.seq, upsert: id }); });
  }
  // The fake keeps a message's id across a move (nothing here is UID-based), so
  // every mapping is `to === from`. Tests that need a re-keying provider stub
  // move/archive/trash directly.
  async move(ids: string[], folder: string): Promise<MoveResult[]> {
    this.guard();
    return ids.map(id => { const m = this.msgs.get(id); if (m) { m.folderProviderIds = [folder]; this.log.push({ seq: ++this.seq, upsert: id }); } return { from: id, to: id }; });
  }
  async archive(ids: string[]) { return this.move(ids, 'ARCHIVE'); }
  async trash(ids: string[]) { return this.move(ids, 'TRASH'); }
  async saveDraft(draft: OutgoingMessage, existing?: string) { this.guard(); const id = existing ?? 'draft-' + uuidv4(); this.drafts.set(id, draft); return { providerMessageId: id }; }
  async deleteDraft(id: string) { this.guard(); this.drafts.delete(id); }
  async search(query: string, opts: { before?: Date; limit: number }) {
    this.guard(); const q = query.toLowerCase();
    return [...this.msgs.values()].filter(m => (!opts.before || new Date(m.date) < opts.before) && (m.subject.toLowerCase().includes(q) || (m.text ?? '').toLowerCase().includes(q))).slice(0, opts.limit);
  }
}
