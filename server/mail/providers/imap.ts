// server/mail/providers/imap.ts
// The IMAP/SMTP provider: imapflow for reading and mailbox ops, nodemailer for
// sending, mailparser for bodies. Every operation opens its own short-lived
// connection and always logs out — the one long-lived connection is the IDLE
// listener started by startPush().
import type { Readable } from 'stream';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import type { ImapAuth } from '../accountStore';
import type {
  MailProvider, Envelope, ProviderFolder, SyncState, OutgoingMessage, AttachmentMeta, FolderRole, Addr, MoveResult,
} from './types';
import { AuthExpiredError, ProviderNotFoundError } from './types';
import { buildRawMime } from './mimeBuild';
import { normalizeMessageId } from '../threadKey';

// ---------------------------------------------------------------------------
// providerMessageId: "<folder> <uidValidity> <uid>". A UID alone is not stable
// (it is only unique within one folder and only valid for one UIDVALIDITY), so
// all three travel together in the single string the engine's unique index
// wants. Folder paths may contain spaces, so parsing reads from the END.
// ---------------------------------------------------------------------------
const SEP = ' ';
export const makePmid = (folder: string, uidValidity: number, uid: number): string =>
  `${folder}${SEP}${uidValidity}${SEP}${uid}`;

export function parsePmid(id: string): { folder: string; uidValidity: number; uid: number } {
  const parts = String(id ?? '').split(SEP);
  const uid = Number(parts.pop());
  const uidValidity = Number(parts.pop());
  return { folder: parts.join(SEP), uidValidity, uid };
}
/** Same, but null for anything that is not a real folder/uid pair — e.g. the
 *  synthetic id send() falls back to when the Sent APPEND was refused. */
function tryParsePmid(id: string): { folder: string; uidValidity: number; uid: number } | null {
  const p = parsePmid(id);
  return p.folder && Number.isInteger(p.uid) && p.uid > 0 ? p : null;
}
/** Marks a sent message the server would not let us APPEND — nothing to act on
 *  later, so it deliberately does NOT parse as a folder/uid pair. */
const unappendedSentId = (messageIdHeader: string): string => `sent:unappended:${messageIdHeader}`;

const ROLE_BY_USE: Record<string, FolderRole> = {
  '\\Inbox': 'inbox', '\\Sent': 'sent', '\\Drafts': 'drafts', '\\Trash': 'trash',
  '\\Junk': 'spam', '\\Archive': 'archive', '\\All': 'archive', '\\Flagged': 'starred',
};
const ROLE_BY_NAME: Array<[RegExp, FolderRole]> = [
  [/^inbox$/i, 'inbox'],
  [/^(sent|sent items|sent mail|sent messages)$/i, 'sent'],
  [/^drafts?$/i, 'drafts'],
  [/^(trash|deleted items|deleted messages|bin)$/i, 'trash'],
  [/^(junk|spam|junk e-?mail|bulk mail)$/i, 'spam'],
  [/^(archive|archives|all mail)$/i, 'archive'],
];

/** Gmail-over-IMAP exposes "[Gmail]/All Mail" (\\All), which holds a copy of
 *  every message that also lives in its own label folder. Syncing it would
 *  index each message twice under two different UIDs. It stays in the folder
 *  LIST (users navigate to it, and archive still moves into it) — only the
 *  message walks skip it. */
const isAllMailBox = (b: ImapListItem): boolean => b.specialUse === '\\All';

/** How far back each incremental poll re-reads flags so a read/star toggled in
 *  another client shows up here. Newer than this is covered by the UID walk. */
const FLAG_RESCAN_WINDOW = 200;
/** Ceiling on the messages one backfill() call returns. A first sync of a large
 *  mailbox used to build ONE array of every message since the cutoff and hand
 *  it to the engine in a single transaction; this hands back a cursor instead
 *  so memory stays flat however big the mailbox is. */
const BACKFILL_PAGE = 500;
/** The flags that map to a column the engine stores, in a fixed order so the
 *  code is comparable between polls. Anything else is not worth a re-index. */
const TRACKED_FLAGS: Array<[string, string]> = [['\\Seen', 'S'], ['\\Flagged', 'F'], ['\\Draft', 'D']];
const flagCode = (flags: Set<string> | undefined): string =>
  TRACKED_FLAGS.filter(([f]) => flags?.has(f)).map(([, c]) => c).join('');
const envelopeFlagCode = (e: Envelope): string =>
  `${e.isRead ? 'S' : ''}${e.isStarred ? 'F' : ''}${e.isDraft ? 'D' : ''}`;
const OP_SOCKET_TIMEOUT_MS = 60_000;
const PUSH_IDLE_MS = 4 * 60_000;          // < the 29-minute IDLE ceiling in RFC 2177
const PUSH_REARM_MS = 1_000;              // never re-IDLE in a hot loop
const PUSH_BACKOFF_MS = 5_000;
const PUSH_BACKOFF_MAX_MS = 300_000;

// The subset of ImapFlow this provider uses. Declaring it locally (rather than
// depending on the full class) is what lets the tests inject a scripted fake.
export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  list(): Promise<ImapListItem[]>;
  mailboxOpen(path: string): Promise<{ path: string; uidValidity: bigint | number; uidNext?: number; exists?: number }>;
  fetch(range: unknown, query: unknown, options?: unknown): AsyncIterable<ImapFetchMessage>;
  fetchOne(range: string, query: unknown, options?: unknown): Promise<ImapFetchMessage | false>;
  download(range: string, part?: string, options?: unknown): Promise<{ meta?: ImapDownloadMeta; content: Readable | null }>;
  messageFlagsAdd(range: string, flags: string[], options?: unknown): Promise<unknown>;
  messageFlagsRemove(range: string, flags: string[], options?: unknown): Promise<unknown>;
  messageMove(range: string, destination: string, options?: unknown): Promise<unknown>;
  messageDelete(range: string, options?: unknown): Promise<unknown>;
  append(path: string, content: Buffer, flags?: string[]): Promise<{ uid?: number; uidValidity?: bigint | number } | false>;
  search(query: unknown, options?: unknown): Promise<number[] | false>;
  idle(): Promise<unknown>;
  /** Hard socket close, used when a connect could not be completed. */
  close?(): void;
  // `any` payload: each imapflow event carries a different shape
  on(event: string, listener: (...args: any[]) => void): unknown;
}
interface ImapListItem { path: string; name?: string; delimiter?: string; specialUse?: string; flags?: Set<string> }
interface ImapDownloadMeta { contentType?: string; filename?: string; expectedSize?: number }
interface ImapBodyNode {
  part?: string; type?: string; size?: number; id?: string; disposition?: string;
  dispositionParameters?: Record<string, string>; parameters?: Record<string, string>; childNodes?: ImapBodyNode[];
}
interface ImapAddress { address?: string; name?: string }
interface ImapFetchMessage {
  uid: number; size?: number; flags?: Set<string>; headers?: Buffer; internalDate?: Date | string;
  bodyStructure?: ImapBodyNode;
  envelope?: { messageId?: string; inReplyTo?: string | null; subject?: string; date?: Date | string; from?: ImapAddress[]; to?: ImapAddress[]; cc?: ImapAddress[]; bcc?: ImapAddress[] };
}

export interface ImapProviderOpts {
  fromAddress: string;
  clientFactory?: (auth: ImapAuth) => ImapClientLike;
  transportFactory?: (auth: ImapAuth) => { sendMail(options: Record<string, unknown>): Promise<unknown> };
  /** Test seams for the push loop's timers. */
  pushRearmMs?: number;
  pushBackoffMs?: number;
}

type FolderState = {
  uidValidity: number;
  lastUid: number;
  /** uid → tracked-flag code, for the UIDs inside the re-scan window. Lets a
   *  poll emit only the messages whose flags actually changed instead of
   *  re-upserting the whole window (every upsert reads as a change downstream).
   *  Absent on the first poll for a folder: that pass records the baseline. */
  flags?: Record<string, string>;
};
type ImapSyncState = { folders: Record<string, FolderState> };

/** Where a paged backfill resumes. A cursor we cannot read restarts from the
 *  top rather than throwing: re-reading is harmless (upserts are idempotent),
 *  a hard failure would strand the account mid-sync. */
type BackfillCursor = { folderIndex: number; lastUid: number };
function parseBackfillCursor(raw: string | undefined): BackfillCursor {
  if (!raw) return { folderIndex: 0, lastUid: 0 };
  try {
    const c = JSON.parse(raw) as Partial<BackfillCursor>;
    const folderIndex = Number(c?.folderIndex);
    const lastUid = Number(c?.lastUid);
    return {
      folderIndex: Number.isInteger(folderIndex) && folderIndex >= 0 ? folderIndex : 0,
      lastUid: Number.isInteger(lastUid) && lastUid >= 0 ? lastUid : 0,
    };
  } catch {
    return { folderIndex: 0, lastUid: 0 };
  }
}

const FETCH_QUERY = {
  uid: true, envelope: true, flags: true, size: true, internalDate: true,
  bodyStructure: true, headers: ['references'],
};
/** The flag re-scan reads nothing else — it runs over hundreds of UIDs. */
const FLAGS_QUERY = { uid: true, flags: true };

const AUTH_FAIL_RE = /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed|\bAUTH\b.*(failed|reject)/i;
/** nodemailer classifies the failure for us: `code` EAUTH, or a 53x reply to
 *  the AUTH command. 530 is deliberately NOT here — it is most often
 *  "must issue STARTTLS first", a configuration fault, not a dead password. */
const isSmtpAuthFailure = (e: unknown): boolean => {
  const err = e as { code?: string; responseCode?: number };
  return err?.code === 'EAUTH' || err?.responseCode === 535 || err?.responseCode === 534;
};

export class ImapMailProvider implements MailProvider {
  kind = 'imap' as const;
  private pushClient: ImapClientLike | null = null;
  private pushStopped = true;
  private pushLoop: Promise<void> | null = null;
  /** Set once the credentials in `this.auth` were rejected: reconnecting can
   *  only fail the same way (and hammer the server into rate-limiting us), so
   *  push stays down until the account is rebuilt with new credentials. */
  private pushDead = false;
  /** Bumped by every startPush AND every stopPush. A loop captures the value it
   *  started with and exits the moment it no longer matches, which is what
   *  stops a stop→start cycle from leaving the previous loop alive: stopPush
   *  cannot wait for a loop parked inside idle(), so the old loop wakes up
   *  AFTER the new one is already running and would otherwise keep idling
   *  (and firing onChange) forever alongside it. */
  private pushEpoch = 0;

  constructor(private auth: ImapAuth, private opts: ImapProviderOpts) {}

  // -- connection plumbing --------------------------------------------------

  private newClient(push = false): ImapClientLike {
    if (this.opts.clientFactory) return this.opts.clientFactory(this.auth);
    return new ImapFlow({
      host: this.auth.imapHost, port: this.auth.imapPort, secure: this.auth.imapSecure,
      auth: { user: this.auth.username, pass: this.auth.password },
      logger: false,                                   // never let credentials reach the log
      disableAutoIdle: true,
      ...(push ? { maxIdleTime: PUSH_IDLE_MS, socketTimeout: PUSH_IDLE_MS * 2 } : { socketTimeout: OP_SOCKET_TIMEOUT_MS }),
    }) as unknown as ImapClientLike;
  }

  /** Connects, runs `fn`, and logs out on every path — including throws. */
  private async withClient<T>(fn: (c: ImapClientLike) => Promise<T>): Promise<T> {
    const c = this.newClient();
    await this.connect(c);
    try {
      return await fn(c);
    } finally {
      await c.logout().catch(() => { /* the socket is going away regardless */ });
    }
  }

  private async connect(c: ImapClientLike): Promise<void> {
    try {
      await c.connect();
    } catch (e) {
      try { c.close?.(); } catch { /* the socket may already be gone */ }
      const err = e as Error & { authenticationFailed?: boolean };
      // Deliberately a fresh message: the server's text can quote the username.
      if (err?.authenticationFailed || AUTH_FAIL_RE.test(String(err?.message ?? ''))) {
        throw new AuthExpiredError('IMAP login rejected — re-enter the mailbox password in Settings → Mail');
      }
      throw e;
    }
  }

  // -- folders --------------------------------------------------------------

  private roleOf(box: ImapListItem): FolderRole | null {
    if (box.specialUse && ROLE_BY_USE[box.specialUse]) return ROLE_BY_USE[box.specialUse];
    const leaf = String(box.path).split(box.delimiter || '/').pop() || '';
    for (const [re, role] of ROLE_BY_NAME) if (re.test(leaf)) return role;
    return null;
  }

  private async selectable(c: ImapClientLike): Promise<ImapListItem[]> {
    const boxes = await c.list();
    return (boxes ?? []).filter(b => !b.flags?.has?.('\\Noselect') && !b.flags?.has?.('\\NonExistent'));
  }

  async listFolders(): Promise<ProviderFolder[]> {
    return this.withClient(async c => (await this.selectable(c)).map((b, i): ProviderFolder => ({
      providerId: b.path, name: b.name || b.path, role: this.roleOf(b), sortOrder: i,
    })));
  }

  private async roleFolder(c: ImapClientLike, role: FolderRole, fallback: string): Promise<string> {
    const box = (await this.selectable(c)).find(b => this.roleOf(b) === role);
    return box?.path ?? fallback;
  }

  // -- envelope mapping -----------------------------------------------------

  private toEnvelope(folder: string, uidValidity: number, m: ImapFetchMessage): Envelope {
    const e = m.envelope ?? {};
    const headers = m.headers ? m.headers.toString() : '';
    const refLine = /^references:[ \t]*((?:.|\r?\n[ \t])+)/im.exec(headers)?.[1] ?? '';
    const references = (refLine.match(/<[^>]+>/g) ?? [])
      .map(r => normalizeMessageId(r))
      .filter((r): r is string => !!r);
    const addr = (a: ImapAddress): Addr => {
      const name = (a?.name ?? '').trim();
      return { addr: String(a?.address ?? '').trim().toLowerCase(), ...(name ? { name } : {}) };
    };
    const list = (a: ImapAddress[] | undefined): Addr[] => (a ?? []).map(addr).filter(x => x.addr);
    const flags = m.flags ?? new Set<string>();
    const when = e.date ?? m.internalDate ?? new Date();
    const date = new Date(when);
    return {
      providerMessageId: makePmid(folder, uidValidity, m.uid),
      messageIdHeader: normalizeMessageId(e.messageId) ?? undefined,
      inReplyTo: normalizeMessageId(e.inReplyTo) ?? undefined,
      references,
      from: e.from?.[0] ? addr(e.from[0]) : { addr: '' },
      to: list(e.to), cc: list(e.cc), bcc: list(e.bcc),
      subject: e.subject || '',
      snippet: '',                                     // IMAP envelopes carry no preview; the body cache fills it in
      date: (isNaN(date.getTime()) ? new Date() : date).toISOString(),
      isRead: flags.has('\\Seen'), isStarred: flags.has('\\Flagged'), isDraft: flags.has('\\Draft'),
      attachments: this.attachmentsOf(m.bodyStructure),
      sizeBytes: m.size ?? 0,
      folderProviderIds: [folder],
    };
  }

  /** Leaf BODYSTRUCTURE nodes that are real attachments. `attId` is the IMAP
   *  part path ("2", "1.2") — exactly what download() wants later. */
  private attachmentsOf(bs: ImapBodyNode | undefined): AttachmentMeta[] {
    const out: AttachmentMeta[] = [];
    const walk = (n: ImapBodyNode | undefined): void => {
      if (!n) return;
      if (n.childNodes?.length) { n.childNodes.forEach(walk); return; }
      const filename = n.dispositionParameters?.filename || n.parameters?.name;
      const type = (n.type || '').toLowerCase();
      const isBodyText = (type === 'text/plain' || type === 'text/html') && n.disposition !== 'attachment' && !filename;
      if (isBodyText || !n.part) return;
      if (n.disposition !== 'attachment' && !filename && !n.id && (!type || /^text\//.test(type) || /^multipart\//.test(type))) return;
      out.push({
        attId: String(n.part),
        name: filename || 'attachment',
        mime: n.type || 'application/octet-stream',
        size: n.size || 0,
        ...(n.id ? { contentId: String(n.id).replace(/^<|>$/g, '') } : {}),
      });
    };
    walk(bs);
    return out;
  }

  /** Fetches a UID range from the ALREADY OPEN mailbox. */
  private async fetchRange(
    c: ImapClientLike, path: string, uidValidity: number, range: string | { since: Date }, limit?: number,
  ): Promise<{ msgs: Envelope[]; maxUid: number }> {
    const msgs: Envelope[] = [];
    let maxUid = 0;
    for await (const m of c.fetch(range, FETCH_QUERY, { uid: true })) {
      if (!m || typeof m.uid !== 'number') continue;
      msgs.push(this.toEnvelope(path, uidValidity, m));
      if (m.uid > maxUid) maxUid = m.uid;
      if (limit && msgs.length >= limit) break;
    }
    return { msgs, maxUid };
  }

  // -- sync -----------------------------------------------------------------

  /** Walks the syncable folders in list order, at most BACKFILL_PAGE messages
   *  per call. The cursor names where to resume: which folder, and the last UID
   *  already handed back inside it. `runBackfill` calls again until `done`. */
  async backfill(opts: { since: Date; cursor?: string }): Promise<{ messages: Envelope[]; cursor?: string; done: boolean }> {
    const start = parseBackfillCursor(opts.cursor);
    return this.withClient(async c => {
      const boxes = (await this.selectable(c)).filter(b => {
        const role = this.roleOf(b);
        return role !== 'trash' && role !== 'spam' && !isAllMailBox(b);   // history nobody asked to import
      });
      const messages: Envelope[] = [];
      let folderIndex = Math.max(0, Math.min(start.folderIndex, boxes.length));
      let lastUid = start.lastUid;
      const more = (): { messages: Envelope[]; cursor: string; done: false } =>
        ({ messages, cursor: JSON.stringify({ folderIndex, lastUid }), done: false });

      while (folderIndex < boxes.length) {
        const b = boxes[folderIndex];
        try {
          const box = await c.mailboxOpen(b.path);
          const uidValidity = Number(box.uidValidity);
          // SINCE first, then a UID-ranged fetch of one page of the result: the
          // server-side search is cheap, and it is the UID list that lets a
          // later call resume in the middle of a folder.
          const found = await c.search({ since: opts.since }, { uid: true });
          const pending = (found || []).filter(u => u > lastUid).sort((x, y) => x - y);
          const chunk = pending.slice(0, BACKFILL_PAGE - messages.length);
          if (chunk.length) {
            const r = await this.fetchRange(c, b.path, uidValidity, chunk.join(','));
            messages.push(...r.msgs);
            lastUid = chunk[chunk.length - 1];
          }
          if (chunk.length < pending.length) return more();          // page full, folder not
        } catch (e) {
          // One unreadable mailbox (permissions, a shared folder that vanished)
          // must not cost the account every other folder's history.
          console.warn(`[imap] skipping folder ${b.path}: ${(e as Error).message}`);
        }
        folderIndex += 1;
        lastUid = 0;
        if (messages.length >= BACKFILL_PAGE && folderIndex < boxes.length) return more();
      }
      return { messages, done: true };
    });
  }

  async incremental(state: SyncState): Promise<{ upserts: Envelope[]; deletes: string[]; state: SyncState }> {
    const prevFolders = (state as ImapSyncState | undefined)?.folders ?? {};
    // Rebuilt from the live folder list, so folders deleted on the server drop
    // out of the state instead of accumulating forever.
    const next: ImapSyncState = { folders: {} };
    return this.withClient(async c => {
      const byId = new Map<string, Envelope>();
      for (const b of await this.selectable(c)) {
        if (isAllMailBox(b)) continue;                  // every message here is already indexed under its own folder
        const prev = prevFolders[b.path];
        try {
          const box = await c.mailboxOpen(b.path);
          const uidValidity = Number(box.uidValidity);
          const head = Math.max(0, Number(box.uidNext ?? 1) - 1);
          // A folder we have never synced (or one whose UIDVALIDITY the server
          // reset) is adopted at its current head: history is backfill's job, and
          // replaying it here would re-emit every message under new ids.
          if (!prev || prev.uidValidity !== uidValidity) {
            next.folders[b.path] = { uidValidity, lastUid: head };
            continue;
          }
          const fresh = await this.fetchRange(c, b.path, uidValidity, `${prev.lastUid + 1}:*`);
          // "N:*" is not empty when N is past the end — IMAP answers with the
          // highest existing UID — so the filter below is what keeps an idle
          // folder from re-emitting its newest message on every poll.
          const added = fresh.msgs.filter(m => parsePmid(m.providerMessageId).uid > prev.lastUid);
          for (const m of added) byId.set(m.providerMessageId, m);

          // IMAP has no flag change feed, so a window of known UIDs is re-read
          // every poll. Only the FLAGS are read back and compared against the
          // codes stored last time: unchanged UIDs cost one cheap FETCH and
          // produce no upsert, and only the ones that really changed are then
          // fetched in full.
          const codes: Record<string, string> = {};
          const changed: number[] = [];
          if (prev.lastUid > 0) {
            const from = Math.max(1, prev.lastUid - FLAG_RESCAN_WINDOW);
            for await (const m of c.fetch(`${from}:${prev.lastUid}`, FLAGS_QUERY, { uid: true })) {
              if (!m || typeof m.uid !== 'number' || m.uid > prev.lastUid) continue;
              const code = flagCode(m.flags);
              codes[String(m.uid)] = code;
              // No stored codes yet = this pass is the baseline, emit nothing.
              if (prev.flags && prev.flags[String(m.uid)] !== code) changed.push(m.uid);
            }
            if (changed.length) {
              const refetched = await this.fetchRange(c, b.path, uidValidity, changed.join(','));
              for (const m of refetched.msgs) if (!byId.has(m.providerMessageId)) byId.set(m.providerMessageId, m);
            }
          }
          // Seed the codes of the messages this poll just indexed, or the next
          // poll would see them as brand-new entries and re-emit them once.
          for (const m of added) codes[String(parsePmid(m.providerMessageId).uid)] = envelopeFlagCode(m);
          next.folders[b.path] = { uidValidity, lastUid: Math.max(prev.lastUid, fresh.maxUid), flags: codes };
        } catch (e) {
          console.warn(`[imap] skipping folder ${b.path}: ${(e as Error).message}`);
          if (prev) next.folders[b.path] = prev;      // keep the cursor, retry next poll
        }
      }
      // IMAP gives no cheap tombstones; disappearing messages are reconciled by
      // the next backfill rather than guessed at here.
      return { upserts: [...byId.values()], deletes: [], state: next as unknown as SyncState };
    });
  }

  // -- bodies ---------------------------------------------------------------

  async getBody(providerMessageId: string): Promise<{ html?: string; text?: string; attachments: AttachmentMeta[] }> {
    const p = tryParsePmid(providerMessageId);
    if (!p) throw new ProviderNotFoundError(providerMessageId);
    return this.withClient(async c => {
      await c.mailboxOpen(p.folder);
      // BODYSTRUCTURE first: imapflow serialises commands, and the download
      // stream must be consumed before another one can be issued.
      const one = await c.fetchOne(String(p.uid), { uid: true, bodyStructure: true }, { uid: true });
      const attachments = this.attachmentsOf(one ? one.bodyStructure : undefined);
      const dl = await c.download(String(p.uid), undefined, { uid: true });
      if (!dl?.content) throw new ProviderNotFoundError(providerMessageId);
      const parsed = await simpleParser(dl.content);
      return {
        html: parsed.html || undefined,
        text: parsed.text || undefined,
        attachments,
      };
    });
  }

  async getAttachment(providerMessageId: string, attId: string): Promise<{ stream: NodeJS.ReadableStream; mime: string; size?: number; name: string }> {
    const p = tryParsePmid(providerMessageId);
    if (!p) throw new ProviderNotFoundError(providerMessageId);
    // Not withClient: the stream outlives this call, so the logout is tied to
    // the stream ending instead of to the function returning.
    const c = this.newClient();
    await this.connect(c);
    let dl: { meta?: ImapDownloadMeta; content: Readable | null };
    try {
      await c.mailboxOpen(p.folder);
      dl = await c.download(String(p.uid), attId, { uid: true });
    } catch (e) {
      await c.logout().catch(() => {});
      throw e;
    }
    if (!dl?.content) {
      await c.logout().catch(() => {});
      throw new ProviderNotFoundError(attId);
    }
    // 'end', 'close' and 'error' can all fire — log out on the first of them.
    let closed = false;
    const close = (): void => { if (closed) return; closed = true; void c.logout().catch(() => {}); };
    const stream = dl.content;
    stream.once('end', close);
    stream.once('error', close);
    stream.once('close', close);
    // No `size`: imapflow's `expectedSize` is RFC822.SIZE — the whole message,
    // not this part — and a caller that turned it into a Content-Length would
    // truncate or stall every download. The contract makes size optional.
    return {
      stream,
      mime: dl.meta?.contentType || 'application/octet-stream',
      name: dl.meta?.filename || 'attachment',
    };
  }

  // -- mailbox operations ---------------------------------------------------

  /** Batches ids per source folder — UIDs are only meaningful inside one. The
   *  caller's exact id string rides along so a MoveResult can name it back. */
  private groupByFolder(ids: string[]): { groups: Map<string, Array<{ uid: number; id: string }>>; skipped: string[] } {
    const groups = new Map<string, Array<{ uid: number; id: string }>>();
    const skipped: string[] = [];
    for (const id of ids) {
      const p = tryParsePmid(id);
      if (!p) { skipped.push(id); continue; }           // synthetic/unknown id: nothing on the server to touch
      groups.set(p.folder, [...(groups.get(p.folder) ?? []), { uid: p.uid, id }]);
    }
    return { groups, skipped };
  }

  async setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }): Promise<void> {
    const { groups } = this.groupByFolder(ids);
    if (!groups.size || (flags.read === undefined && flags.starred === undefined)) return;
    await this.withClient(async c => {
      for (const [folder, entries] of groups) {
        await c.mailboxOpen(folder);
        const range = entries.map(e => e.uid).join(',');
        if (flags.read !== undefined) {
          await (flags.read ? c.messageFlagsAdd(range, ['\\Seen'], { uid: true }) : c.messageFlagsRemove(range, ['\\Seen'], { uid: true }));
        }
        if (flags.starred !== undefined) {
          await (flags.starred ? c.messageFlagsAdd(range, ['\\Flagged'], { uid: true }) : c.messageFlagsRemove(range, ['\\Flagged'], { uid: true }));
        }
      }
    });
  }

  async move(ids: string[], folderProviderId: string): Promise<MoveResult[]> {
    return this.moveTo(ids, () => Promise.resolve(folderProviderId));
  }

  async archive(ids: string[]): Promise<MoveResult[]> {
    return this.moveTo(ids, c => this.roleFolder(c, 'archive', 'Archive'));
  }

  async trash(ids: string[]): Promise<MoveResult[]> {
    return this.moveTo(ids, c => this.roleFolder(c, 'trash', 'Trash'));
  }

  /** One connection for both halves: resolve the destination, then move into
   *  it, reporting the new provider id of every message the server re-numbered.
   *  A UID only means something in one mailbox, so a moved message is a
   *  DIFFERENT id afterwards — a caller that keeps the old one ends up with a
   *  row nothing resolves plus a duplicate at the next sync. */
  private async moveTo(ids: string[], destOf: (c: ImapClientLike) => Promise<string>): Promise<MoveResult[]> {
    const { groups, skipped } = this.groupByFolder(ids);
    const out: MoveResult[] = skipped.map(id => ({ from: id, to: null }));
    if (!groups.size) return out;
    await this.withClient(async c => {
      const dest = await destOf(c);
      for (const [folder, entries] of groups) {
        if (folder === dest) { out.push(...entries.map(e => ({ from: e.id, to: e.id }))); continue; }
        try {
          await c.mailboxOpen(folder);
          const r = await c.messageMove(entries.map(e => e.uid).join(','), dest, { uid: true }) as
            { uidValidity?: bigint | number; uidMap?: Map<number, number> } | false | undefined;
          // uidMap/uidValidity only arrive from a server with UIDPLUS; without
          // them the move still happened, we just cannot name the new copy.
          const destValidity = r && r.uidValidity != null ? Number(r.uidValidity) : null;
          const uidMap = r && r.uidMap instanceof Map ? r.uidMap : null;
          for (const e of entries) {
            const newUid = uidMap?.get(e.uid);
            out.push({ from: e.id, to: newUid && destValidity != null ? makePmid(dest, destValidity, newUid) : null });
          }
        } catch (err) {
          // `failed`, not a plain null mapping: the messages are still sitting
          // in their old mailbox, and a caller that read this as "moved but
          // unnamed" would delete or re-file rows the server never touched.
          console.warn(`[imap] skipping folder ${folder}: ${(err as Error).message}`);
          out.push(...entries.map(e => ({ from: e.id, to: null, failed: true as const })));
        }
      }
    });
    return out;
  }

  // -- sending --------------------------------------------------------------

  private transport(): { sendMail(options: Record<string, unknown>): Promise<unknown> } {
    if (this.opts.transportFactory) return this.opts.transportFactory(this.auth);
    return nodemailer.createTransport({
      host: this.auth.smtpHost, port: this.auth.smtpPort, secure: this.auth.smtpSecure,
      auth: { user: this.auth.username, pass: this.auth.password },
      // Without these a wrong host/port hangs the request until the platform's
      // TCP timeout — minutes with nothing on screen.
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    });
  }

  /** The UID of a message we just APPENDed. Servers without UIDPLUS answer the
   *  APPEND without one, so fall back to looking the copy up by its Message-ID. */
  private async appendedUid(c: ImapClientLike, dest: string, appended: { uid?: number; uidValidity?: bigint | number } | false, messageIdHeader: string): Promise<string | null> {
    if (appended && appended.uid) return makePmid(dest, Number(appended.uidValidity ?? 0), Number(appended.uid));
    try {
      const box = await c.mailboxOpen(dest);
      const found = await c.search({ header: { 'message-id': messageIdHeader } }, { uid: true });
      const uid = found && found.length ? found[found.length - 1] : 0;
      return uid ? makePmid(dest, Number(box.uidValidity), uid) : null;
    } catch {
      return null;
    }
  }

  async send(msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string; messageIdHeader?: string }> {
    const raw = await buildRawMime(msg);
    const rcpt = [...msg.to, ...msg.cc, ...msg.bcc].map(a => a.addr).filter(Boolean);
    try {
      await this.transport().sendMail({ envelope: { from: msg.from.addr || this.opts.fromAddress, to: rcpt }, raw });
    } catch (e) {
      if (isSmtpAuthFailure(e)) {
        throw new AuthExpiredError('SMTP login rejected — re-enter the mailbox password in Settings → Mail');
      }
      throw e;
    }
    // The message is already gone; a failed Sent copy must not fail the send.
    try {
      return await this.withClient(async c => {
        const dest = await this.roleFolder(c, 'sent', 'Sent');
        const r = await c.append(dest, raw, ['\\Seen']);
        const pmid = await this.appendedUid(c, dest, r, msg.messageIdHeader);
        return { providerMessageId: pmid ?? unappendedSentId(msg.messageIdHeader) };
      });
    } catch (e) {
      console.warn('[imap] could not append the sent copy to Sent:', (e as Error).message);
      return { providerMessageId: unappendedSentId(msg.messageIdHeader) };
    }
  }

  // -- drafts ---------------------------------------------------------------

  async saveDraft(draft: OutgoingMessage, existingProviderId?: string): Promise<{ providerMessageId: string }> {
    const raw = await buildRawMime(draft);
    const prev = existingProviderId ? tryParsePmid(existingProviderId) : null;
    return this.withClient(async c => {
      const dest = await this.roleFolder(c, 'drafts', 'Drafts');
      if (prev) {
        await c.mailboxOpen(prev.folder);
        // Delete first: an IMAP draft is immutable, so "editing" is replace.
        await c.messageDelete(String(prev.uid), { uid: true }).catch(() => { /* already gone */ });
      }
      const r = await c.append(dest, raw, ['\\Draft', '\\Seen']);
      const pmid = await this.appendedUid(c, dest, r, draft.messageIdHeader);
      if (!pmid) throw new Error('The mail server stored the draft but would not say where — reopen it from the Drafts folder');
      return { providerMessageId: pmid };
    });
  }

  async deleteDraft(providerMessageId: string): Promise<void> {
    const p = tryParsePmid(providerMessageId);
    if (!p) return;
    await this.withClient(async c => {
      await c.mailboxOpen(p.folder);
      await c.messageDelete(String(p.uid), { uid: true });
    });
  }

  // -- search ---------------------------------------------------------------

  async search(query: string, opts: { before?: Date; limit: number }): Promise<Envelope[]> {
    const q = (query || '').trim();
    if (!q) return [];
    return this.withClient(async c => {
      const out: Envelope[] = [];
      for (const b of await this.selectable(c)) {
        if (out.length >= opts.limit) break;
        if (isAllMailBox(b)) continue;                  // its hits are duplicates of the per-folder ones
        try {
          const box = await c.mailboxOpen(b.path);
          const criteria = { or: [{ subject: q }, { from: q }, { body: q }], ...(opts.before ? { before: opts.before } : {}) };
          const uids = await c.search(criteria, { uid: true });
          if (!uids || !uids.length) continue;
          const room = opts.limit - out.length;
          const wanted = uids.slice(-room);                 // newest matches first
          const r = await this.fetchRange(c, b.path, Number(box.uidValidity), wanted.join(','), room);
          out.push(...r.msgs);
        } catch (e) {
          console.warn(`[imap] skipping folder ${b.path}: ${(e as Error).message}`);
        }
      }
      return out.slice(0, opts.limit);
    });
  }

  // -- push -----------------------------------------------------------------

  /** Holds one extra connection in IDLE on INBOX and pings `onChange` whenever
   *  the server announces new mail or a flag change. Reconnects with backoff —
   *  except on an auth failure, which ends the loop and reports `onAuthError`. */
  async startPush(onChange: () => void, onAuthError?: (err: Error) => void): Promise<void> {
    if (!this.pushStopped || this.pushDead) return;                    // already running, or dead credentials
    this.pushStopped = false;
    const epoch = ++this.pushEpoch;
    const current = (): boolean => !this.pushStopped && epoch === this.pushEpoch;
    const rearm = this.opts.pushRearmMs ?? PUSH_REARM_MS;
    const baseBackoff = this.opts.pushBackoffMs ?? PUSH_BACKOFF_MS;
    const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

    const loop = async (): Promise<void> => {
      let backoff = baseBackoff;
      while (current()) {
        const c = this.newClient(true);
        this.pushClient = c;
        try {
          await this.connect(c);
          await c.mailboxOpen('INBOX');
          backoff = baseBackoff;
          c.on('exists', () => { if (current()) onChange(); });
          c.on('flags', () => { if (current()) onChange(); });
          while (current()) {
            await c.idle();
            if (current() && rearm) await sleep(rearm);
          }
        } catch (e) {
          const err = e as Error & { authenticationFailed?: boolean };
          // Retrying rejected credentials just fails on a timer forever, so the
          // loop ends and the caller is told the channel is not coming back.
          if (err instanceof AuthExpiredError || err?.authenticationFailed) {
            this.pushDead = true;
            this.pushStopped = true;
            console.warn('[imap] IDLE stopped: the mailbox rejected the stored credentials');
            try { onAuthError?.(err); } catch { /* the caller's problem, not ours */ }
          } else if (current()) {
            console.warn('[imap] IDLE connection dropped:', err.message);
          }
        } finally {
          await c.logout().catch(() => {});
          if (this.pushClient === c) this.pushClient = null;
        }
        if (!current()) break;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, PUSH_BACKOFF_MAX_MS);
      }
    };
    this.pushLoop = loop();
    void this.pushLoop.catch(() => { /* the loop already logs */ });
  }

  async stopPush(): Promise<void> {
    this.pushStopped = true;
    // Invalidates any loop still running: one parked in idle() only wakes when
    // the socket below closes, by which time startPush may already have set
    // pushStopped back to false.
    this.pushEpoch += 1;
    const c = this.pushClient;
    this.pushClient = null;
    // Breaks the socket out of IDLE so the loop's `await idle()` settles.
    await c?.logout().catch(() => {});
    // The loop is not awaited: it may still be parked inside idle() until the
    // socket actually closes, and stopPush must not block on the network.
    this.pushLoop = null;
  }
}
