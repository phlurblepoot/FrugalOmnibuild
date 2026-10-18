// server/mail/providers/google.ts
// The Gmail provider. It speaks to the REST API over the injected `fetch`
// rather than the `googleapis` SDK: the SDK is only worth its weight for the
// consent-screen dance in oauth.ts, and keeping the runtime on plain fetch is
// what lets every method here be tested against recorded JSON.
//
// Ids: `providerMessageId` is Gmail's message id. Labels are folders, so a
// move/archive never changes an id — every MoveResult maps an id to itself.
// Drafts are the exception: a draft has BOTH a draft id and a message id, and
// only the draft id can update or delete it, so saveDraft hands back
// "draft:<draftId>" and deleteDraft/saveDraft can also resolve a message id
// that came from a sync back to its draft.
import { Readable } from 'stream';
import type {
  MailProvider, Envelope, ProviderFolder, SyncState, OutgoingMessage, AttachmentMeta, AttachmentHint, FolderRole, Addr, MoveResult,
} from './types';
import { AuthExpiredError, RateLimitedError, ProviderNotFoundError } from './types';
import type { TokenSource } from './tokenSource';
import { buildRawMime } from './mimeBuild';
import { parseAddressList, snippetOf, htmlToText } from '../mime';
import { normalizeMessageId } from '../threadKey';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 30_000;
/** Gmail fetches are one HTTP round trip each; five in flight keeps a backfill
 *  brisk without tripping the per-user rate limit. */
const CONCURRENCY = 5;
const PAGE_SIZE = 100;
/** messages.batchModify accepts at most 1000 ids per call. */
const BATCH_MAX = 1000;
const DRAFT_PREFIX = 'draft:';
/** How many messages' part lists getAttachment may remember. Metadata only —
 *  never body bytes — and bounded so a long-lived account cannot grow it. */
const PART_CACHE_MAX = 500;
/** Gmail budgets roughly 250 quota units per second per user, and a
 *  `messages.get?format=full` costs 5 of them — so CONCURRENCY fetches over a
 *  fast link burst straight through the ceiling and the whole import is thrown
 *  back with a 403. Starting requests at least this far apart holds a provider
 *  instance to ~40 calls/s (~200 units/s), which is under the limit with room
 *  to spare and imperceptible on a single interactive call. */
const FETCH_SPACING_MS = 25;

const sleepMs = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** A minimum-spacing limiter: successive calls START at least `ms` apart.
 *
 *  Callers queue on a promise chain, so nothing is dropped or reordered, and a
 *  request that arrives after a quiet spell waits not at all — the spacing is
 *  measured against the clock, not simply slept on every time. `sleep` and
 *  `now` are injectable so the behaviour can be tested without real timers. */
export function makeSpacer(
  ms: number,
  sleep: (ms: number) => Promise<void> = sleepMs,
  now: () => number = () => Date.now(),
): () => Promise<void> {
  let earliestNext = 0;
  let tail: Promise<void> = Promise.resolve();
  return () => {
    const mine = tail.then(async () => {
      const wait = earliestNext - now();
      if (wait > 0) await sleep(wait);
      earliestNext = Math.max(earliestNext, now()) + ms;
    });
    // One caller's failure must not wedge the queue behind a rejected promise.
    tail = mine.catch(() => {});
    return mine;
  };
}

// -- Gmail JSON shapes (only the fields this provider reads) ----------------
interface GmailHeader { name: string; value: string }
interface GmailBody { size?: number; data?: string; attachmentId?: string }
interface GmailPart { partId?: string; mimeType?: string; filename?: string; headers?: GmailHeader[]; body?: GmailBody; parts?: GmailPart[] }
interface GmailMessage {
  id: string; threadId?: string; labelIds?: string[]; snippet?: string;
  internalDate?: string; sizeEstimate?: number; payload?: GmailPart;
}
interface GmailLabel { id: string; name: string; type?: string; messagesTotal?: number; messagesUnread?: number }
interface GmailListResponse { messages?: Array<{ id: string; threadId?: string }>; nextPageToken?: string }
interface GmailHistoryRecord {
  id?: string;
  messagesAdded?: Array<{ message?: { id?: string } }>;
  messagesDeleted?: Array<{ message?: { id?: string } }>;
  labelsAdded?: Array<{ message?: { id?: string } }>;
  labelsRemoved?: Array<{ message?: { id?: string } }>;
}
interface GmailHistoryResponse { history?: GmailHistoryRecord[]; historyId?: string; nextPageToken?: string }
interface GmailDraft { id?: string; message?: { id?: string; threadId?: string } }
interface GmailDraftList { drafts?: GmailDraft[]; nextPageToken?: string }
interface GmailProfile { emailAddress?: string; historyId?: string }
interface GmailAttachment { size?: number; data?: string }

// -- base64url ---------------------------------------------------------------
const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string): Buffer => Buffer.from(String(s ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// -- label → folder ----------------------------------------------------------
const ROLE_BY_LABEL: Record<string, FolderRole> = {
  INBOX: 'inbox', SENT: 'sent', DRAFT: 'drafts', TRASH: 'trash', SPAM: 'spam', STARRED: 'starred',
};
const DISPLAY_NAME: Record<string, string> = {
  INBOX: 'Inbox', SENT: 'Sent', DRAFT: 'Drafts', TRASH: 'Trash', SPAM: 'Spam', STARRED: 'Starred',
};
/** System labels that are Gmail bookkeeping, not places mail lives. UNREAD and
 *  STARRED-style state already rides on the envelope; the tab categories and
 *  CHAT would only clutter the folder list. */
const HIDDEN_LABEL = (id: string): boolean =>
  id.startsWith('CATEGORY_') || id === 'CHAT' || id === 'UNREAD' || id === 'IMPORTANT';
const LABEL_ORDER = ['INBOX', 'STARRED', 'SENT', 'DRAFT', 'SPAM', 'TRASH'];

const headerOf = (part: GmailPart | undefined, name: string): string | undefined =>
  part?.headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value;

/** Buffer understands only a handful of labels; anything exotic is read as
 *  UTF-8, which at worst mangles a few accents rather than throwing. */
function decodeText(data: string | undefined, contentType: string | undefined): string {
  if (!data) return '';
  const charset = /charset="?([\w-]+)"?/i.exec(contentType || '')?.[1]?.toLowerCase();
  const enc: BufferEncoding =
    charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252' ? 'latin1'
      : charset === 'us-ascii' || charset === 'ascii' ? 'ascii'
        : charset === 'utf-16le' || charset === 'utf-16' ? 'utf16le'
          : 'utf8';
  return fromB64url(data).toString(enc);
}

/** A 4xx that is about the REQUEST, not about the credentials (401) or the
 *  quota (429/503, which arrive as their own error types and carry no status).
 *  Used to decide that a send is worth one retry with the threadId dropped. */
const isThreadRejection = (e: unknown): boolean => {
  const s = (e as { status?: number } | null)?.status;
  return typeof s === 'number' && s >= 400 && s < 500 && s !== 401 && s !== 429;
};

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const chunk = <T>(xs: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
};

const gmailDate = (d: Date): string =>
  `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;

export interface GoogleProviderOpts { fetch: typeof fetch; emailAddress: string }

/** Exchanges a refresh token for an access token. Errors keep Google's own
 *  `error` code in the message because TokenSource matches on `invalid_grant`
 *  to decide the account needs reconnecting rather than retrying. */
export async function googleRefresh(
  env: NodeJS.ProcessEnv,
  refreshToken: string,
  fetchFn: typeof fetch,
): Promise<{ accessToken: string; expiresInSec: number; refreshToken?: string }> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok) throw new Error(`${body.error || res.status}: ${body.error_description || ''}`);
  // A 200 with no token would otherwise be cached as an empty Bearer and every
  // later call would 401 in a way that looks like a revoked grant.
  if (!body.access_token) throw new Error('Google returned no access token for the refresh');
  return {
    accessToken: String(body.access_token),
    expiresInSec: Number(body.expires_in) || 3600,
    refreshToken: body.refresh_token,
  };
}

export class GmailProvider implements MailProvider {
  kind = 'google' as const;
  /** message id → the attachment metadata from its last format=full fetch.
   *  attachments.get returns bytes and nothing else, so the name and MIME type
   *  a download needs can only come from the message's part list. */
  private partCache = new Map<string, AttachmentMeta[]>();
  /** The watermark read at the START of a backfill. Adopting it (rather than
   *  the profile's value once the backfill finishes) is what stops a message
   *  that arrived mid-backfill from falling into the gap between the two. */
  private backfillHistoryId: string | null = null;
  /** Paces every call this instance makes — see FETCH_SPACING_MS. Per instance,
   *  which is per account: the quota Gmail is defending is per user. */
  private space = makeSpacer(FETCH_SPACING_MS);

  constructor(private tokens: TokenSource, private opts: GoogleProviderOpts) {}

  // -- transport ------------------------------------------------------------

  private async api<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
    retry = true,
  ): Promise<T> {
    await this.space();
    const { query, ...rest } = init;
    const url = new URL(API + path.replace(/^\//, ''));
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.opts.fetch(url.toString(), {
      ...rest,
      headers: {
        ...(rest.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${await this.tokens.get()}`,
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      // The cached access token may simply have been revoked early; one retry
      // with a freshly minted one tells us whether the grant itself is dead.
      this.tokens.invalidate();
      if (retry) return this.api<T>(path, init, false);
      throw new AuthExpiredError('Google rejected the access token — reconnect the account in Settings → Mail');
    }
    if (res.status === 429 || res.status === 503) throw this.rateLimited(res);
    if (res.status === 404) throw Object.assign(new ProviderNotFoundError(path), { status: 404 });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(body)) throw this.rateLimited(res);
      // Deliberately only the response text: the request's Authorization
      // header must never reach a log or an error surfaced to the UI.
      throw Object.assign(new Error(`Gmail ${res.status}: ${body.slice(0, 200)}`), { status: res.status });
    }
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Gmail returned a non-JSON response for ${path}`);
    }
  }

  private rateLimited(res: Response): RateLimitedError {
    const e = new RateLimitedError(`Gmail ${res.status} — rate limited`);
    const after = Number(res.headers.get('retry-after'));
    if (Number.isFinite(after) && after > 0) e.retryAfterMs = after * 1000;
    return e;
  }

  // -- folders --------------------------------------------------------------

  async listFolders(): Promise<ProviderFolder[]> {
    const r = await this.api<{ labels?: GmailLabel[] }>('labels');
    const visible = (r.labels ?? []).filter(l => l.id && !HIDDEN_LABEL(l.id));
    const rank = (l: GmailLabel): number => {
      const i = LABEL_ORDER.indexOf(l.id);
      return i >= 0 ? i : LABEL_ORDER.length;
    };
    visible.sort((a, b) => rank(a) - rank(b) || (a.name || '').localeCompare(b.name || ''));
    return visible.map((l, i): ProviderFolder => ({
      providerId: l.id,
      name: DISPLAY_NAME[l.id] ?? l.name ?? l.id,
      role: ROLE_BY_LABEL[l.id] ?? null,
      ...(l.messagesUnread !== undefined ? { unreadCount: l.messagesUnread } : {}),
      ...(l.messagesTotal !== undefined ? { totalCount: l.messagesTotal } : {}),
      sortOrder: i,
    }));
  }

  // -- message mapping ------------------------------------------------------

  /** Walks the MIME tree collecting the parts a user would call attachments.
   *  A part only qualifies if Gmail gave it an attachmentId AND it names
   *  itself (filename or Content-ID) — a large text/html BODY also carries an
   *  attachmentId, and listing it would put a phantom "attachment" chip on
   *  every long message. */
  private attachmentsOf(payload: GmailPart | undefined): AttachmentMeta[] {
    const out: AttachmentMeta[] = [];
    const walk = (p: GmailPart | undefined): void => {
      if (!p) return;
      const attId = p.body?.attachmentId;
      const contentId = headerOf(p, 'Content-ID')?.replace(/^<|>$/g, '') || undefined;
      const filename = p.filename || '';
      if (attId && (filename || contentId)) {
        out.push({
          attId,
          name: filename || (contentId ? `inline-${contentId}` : 'attachment'),
          mime: p.mimeType || 'application/octet-stream',
          size: p.body?.size ?? 0,
          ...(contentId ? { contentId } : {}),
        });
      }
      p.parts?.forEach(walk);
    };
    walk(payload);
    return out;
  }

  private rememberParts(id: string, atts: AttachmentMeta[]): void {
    this.partCache.delete(id);
    this.partCache.set(id, atts);
    while (this.partCache.size > PART_CACHE_MAX) {
      const oldest = this.partCache.keys().next().value;
      if (oldest === undefined) break;
      this.partCache.delete(oldest);
    }
  }

  /** Turns a `format=full` message into an index row. The part BODIES that came
   *  down with it are deliberately dropped here — only the structure, headers
   *  and snippet are indexed; bodies are fetched on demand by getBody. */
  private toEnvelope(m: GmailMessage): Envelope {
    const payload = m.payload;
    const h = (n: string): string => headerOf(payload, n) ?? '';
    const labels = m.labelIds ?? [];
    const refs = (h('References').match(/<[^>]+>/g) ?? h('References').split(/\s+/))
      .map(normalizeMessageId)
      .filter((x): x is string => !!x);
    const internal = Number(m.internalDate);
    const when = Number.isFinite(internal) && internal > 0 ? new Date(internal) : new Date(h('Date'));
    const attachments = this.attachmentsOf(payload);
    this.rememberParts(m.id, attachments);
    const from: Addr = parseAddressList(h('From'))[0] ?? { addr: '' };
    return {
      providerMessageId: m.id,
      providerThreadId: m.threadId,
      messageIdHeader: normalizeMessageId(h('Message-ID')) ?? undefined,
      inReplyTo: normalizeMessageId(h('In-Reply-To')) ?? undefined,
      references: refs,
      from,
      to: parseAddressList(h('To')),
      cc: parseAddressList(h('Cc')),
      bcc: parseAddressList(h('Bcc')),
      subject: h('Subject'),
      // Gmail's snippet arrives HTML-escaped ("&#39;", "&mdash;"), so it goes
      // through the entity decoder before the list renders it as plain text.
      snippet: snippetOf(htmlToText(m.snippet ?? '')),
      date: (isNaN(when.getTime()) ? new Date() : when).toISOString(),
      isRead: !labels.includes('UNREAD'),
      isStarred: labels.includes('STARRED'),
      isDraft: labels.includes('DRAFT'),
      attachments,
      sizeBytes: m.sizeEstimate ?? 0,
      folderProviderIds: labels,
    };
  }

  private getMessage(id: string): Promise<GmailMessage> {
    return this.api<GmailMessage>(`messages/${encodeURIComponent(id)}`, { query: { format: 'full' } });
  }

  /** Fetches and maps a batch of ids, five at a time. An id that has vanished
   *  between the listing and the fetch is dropped rather than failing the page. */
  private async envelopesFor(ids: string[]): Promise<Envelope[]> {
    const got = await mapLimit(ids, CONCURRENCY, async id => {
      try {
        return this.toEnvelope(await this.getMessage(id));
      } catch (e) {
        if (e instanceof ProviderNotFoundError) return null;
        throw e;
      }
    });
    return got.filter((e): e is Envelope => !!e);
  }

  // -- sync -----------------------------------------------------------------

  async backfill(opts: { since: Date; cursor?: string; watermark?: string }): Promise<{ messages: Envelope[]; cursor?: string; done: boolean; watermark?: string }> {
    if (!opts.cursor) {
      // Read the watermark BEFORE listing so the first incremental poll starts
      // from where this import began, not from where it finished.
      this.backfillHistoryId = (await this.api<GmailProfile>('profile')).historyId ?? null;
    } else if (opts.watermark && !this.backfillHistoryId) {
      // Resuming an import this instance did not start (the server restarted,
      // or a throttle stood the account down long enough to lose the provider).
      // Adopting the caller's stored watermark rather than re-reading the
      // profile is the whole point: the profile has moved on, and everything
      // that arrived in between would fall into the gap.
      this.backfillHistoryId = opts.watermark;
    }
    const list = await this.api<GmailListResponse>('messages', {
      query: {
        q: `after:${Math.floor(opts.since.getTime() / 1000)}`,
        maxResults: PAGE_SIZE,
        pageToken: opts.cursor,
      },
    });
    const messages = await this.envelopesFor((list.messages ?? []).map(m => m.id));
    return {
      messages, cursor: list.nextPageToken, done: !list.nextPageToken,
      ...(this.backfillHistoryId ? { watermark: this.backfillHistoryId } : {}),
    };
  }

  async incremental(state: SyncState): Promise<{ upserts: Envelope[]; deletes: string[]; state: SyncState; reset?: boolean }> {
    const startHistoryId = typeof state?.historyId === 'string' && state.historyId ? state.historyId : null;
    if (!startHistoryId) {
      // No baseline yet (a fresh account, or the pass right after a backfill):
      // adopt a watermark and let the next poll do the work.
      const historyId = this.backfillHistoryId ?? (await this.api<GmailProfile>('profile')).historyId ?? null;
      this.backfillHistoryId = null;
      return { upserts: [], deletes: [], state: { historyId } };
    }

    const touched = new Set<string>();
    const deleted = new Set<string>();
    let historyId = startHistoryId;
    let pageToken: string | undefined;
    try {
      do {
        // No historyTypes filter: Gmail declares it a REPEATED parameter, and a
        // comma-joined value is silently rejected. The loop below already reads
        // only the four record types it cares about, so the unfiltered feed
        // costs a little payload and removes a way to get this wrong.
        const page = await this.api<GmailHistoryResponse>('history', {
          query: { startHistoryId, maxResults: PAGE_SIZE, pageToken },
        });
        for (const rec of page.history ?? []) {
          for (const a of [...(rec.messagesAdded ?? []), ...(rec.labelsAdded ?? []), ...(rec.labelsRemoved ?? [])]) {
            if (a.message?.id) touched.add(a.message.id);
          }
          for (const d of rec.messagesDeleted ?? []) if (d.message?.id) deleted.add(d.message.id);
        }
        if (page.historyId) historyId = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (e) {
      // Gmail keeps roughly a week of history; past that startHistoryId is a
      // 404 and the only way back is a full re-read.
      if (e instanceof ProviderNotFoundError) return { upserts: [], deletes: [], state: { historyId: null }, reset: true };
      throw e;
    }

    // A message added and then deleted inside the same window is gone: never
    // refetch it, or the poll 404s on an id we already know the fate of.
    for (const id of deleted) touched.delete(id);
    const upserts = await this.envelopesFor([...touched]);
    // Anything that vanished between the history read and the refetch is a
    // delete too — envelopesFor dropped it, so recover it here.
    const seen = new Set(upserts.map(u => u.providerMessageId));
    const deletes = [...deleted, ...[...touched].filter(id => !seen.has(id))];
    return { upserts, deletes, state: { historyId } };
  }

  // -- real-time push (Cloud Pub/Sub) ---------------------------------------

  /** Asks Gmail to publish this mailbox's change notifications to `topicName`
   *  (a full `projects/<project>/topics/<topic>`). A watch lasts about seven
   *  days, so push.ts renews it from the sync tick.
   *
   *  Deliberately unfiltered: `labelIds` would narrow what Gmail publishes, and
   *  since a notification only ever means "re-sync this mailbox" the filter
   *  could only lose mail, never save work. The returned `expiration` is a
   *  millisecond epoch **as a string** — Gmail's own encoding, kept verbatim so
   *  the caller decides how to parse it. */
  async watch(topicName: string): Promise<{ historyId: string; expiration: string }> {
    const r = await this.api<{ historyId?: string; expiration?: string }>('watch', {
      method: 'POST',
      body: JSON.stringify({ topicName }),
    });
    return { historyId: r.historyId ?? '', expiration: r.expiration ?? '' };
  }

  /** Cancels the mailbox's watch. Best effort by design: it is called while an
   *  account is being torn down, nothing downstream depends on it, and an
   *  abandoned watch expires by itself within a week. */
  async stopWatch(): Promise<void> {
    try {
      await this.api<void>('stop', { method: 'POST' });
    } catch (e) {
      console.warn(`[mail] could not stop the Gmail watch for ${this.opts.emailAddress}:`, (e as Error).message);
    }
  }

  // -- bodies and attachments -----------------------------------------------

  /** Drafts are addressed by draft id everywhere else in this class, so a
   *  "draft:" id has to be resolved to the message that carries the content. */
  private async messageFor(providerMessageId: string): Promise<GmailMessage> {
    if (providerMessageId.startsWith(DRAFT_PREFIX)) {
      const d = await this.api<GmailDraft>(`drafts/${encodeURIComponent(providerMessageId.slice(DRAFT_PREFIX.length))}`, { query: { format: 'full' } });
      if (!d.message?.id) throw new ProviderNotFoundError(providerMessageId);
      return d.message as GmailMessage;
    }
    return this.getMessage(providerMessageId);
  }

  /** The id the messages.* endpoints answer to. A draft's parts hang off its
   *  MESSAGE, so downloading one needs the message id, not the draft id. */
  private async underlyingMessageId(providerMessageId: string): Promise<string> {
    if (!providerMessageId.startsWith(DRAFT_PREFIX)) return providerMessageId;
    const d = await this.api<GmailDraft>(`drafts/${encodeURIComponent(providerMessageId.slice(DRAFT_PREFIX.length))}`, { query: { format: 'minimal' } });
    if (!d.message?.id) throw new ProviderNotFoundError(providerMessageId);
    return d.message.id;
  }

  async getBody(providerMessageId: string): Promise<{ html?: string; text?: string; attachments: AttachmentMeta[] }> {
    const m = await this.messageFor(providerMessageId);
    let html: string | undefined;
    let text: string | undefined;
    const walk = (p: GmailPart | undefined): void => {
      if (!p) return;
      // A part that names a file is an attachment even when it is text/*.
      const isFile = !!p.filename || !!headerOf(p, 'Content-ID');
      const type = (p.mimeType || '').toLowerCase();
      if (!isFile && p.body?.data) {
        const ct = headerOf(p, 'Content-Type');
        if (type === 'text/html' && html === undefined) html = decodeText(p.body.data, ct);
        else if (type === 'text/plain' && text === undefined) text = decodeText(p.body.data, ct);
      }
      p.parts?.forEach(walk);
    };
    walk(m.payload);
    const attachments = this.attachmentsOf(m.payload);
    // Cached under the id the CALLER used (which may be a "draft:" one) as
    // well as the message's own, so either reaches the list from getAttachment.
    this.rememberParts(providerMessageId, attachments);
    if (m.id && m.id !== providerMessageId) this.rememberParts(m.id, attachments);
    return { html, text, attachments };
  }

  async getAttachment(providerMessageId: string, attId: string, hint?: AttachmentHint): Promise<{ stream: NodeJS.ReadableStream; mime: string; size?: number; name: string }> {
    // attachments.get answers with bytes and a length — the name and MIME type
    // live in the message's part list, so make sure we have it. The order
    // matters: the part list from the LAST read is authoritative; failing that
    // the caller's hint; and only with neither is the message re-read. That
    // re-read is a last resort because Gmail mints a fresh set of attachment
    // ids on every messages.get, so doing it here invalidates every id the
    // caller is still holding for this message's OTHER parts — which is how
    // saving several attachments at once used to fail on all but the first.
    let meta: { name: string; mime: string } | undefined = this.partCache.get(providerMessageId)?.find(a => a.attId === attId);
    if (!meta && hint) meta = hint;
    if (!meta) {
      const parts = (await this.getBody(providerMessageId)).attachments;
      meta = parts.find(a => a.attId === attId);
    }
    if (!meta) throw new ProviderNotFoundError(attId);
    let r: GmailAttachment;
    try {
      r = await this.api<GmailAttachment>(
        `messages/${encodeURIComponent(await this.underlyingMessageId(providerMessageId))}/attachments/${encodeURIComponent(attId)}`,
      );
    } catch (e) {
      // A stale attachment id comes back from attachments.get as 400 "Invalid
      // attachment token", not as a 404 — same meaning: nothing lives under
      // this id any more, and the caller's stale-id recovery is the answer.
      if ((e as { status?: number }).status === 400) throw Object.assign(new ProviderNotFoundError(attId), { status: 404 });
      throw e;
    }
    const buf = fromB64url(r.data ?? '');
    return { stream: Readable.from(buf), mime: meta.mime, size: buf.length, name: meta.name };
  }

  // -- sending --------------------------------------------------------------

  async send(msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string; messageIdHeader?: string }> {
    // keepBcc: Gmail has no SMTP envelope of ours to read — it takes the
    // recipient list from the headers, so a stripped Bcc is a bcc nobody gets.
    const raw = b64url(await buildRawMime(msg, { keepBcc: true }));
    // Matching In-Reply-To/References is not enough for Gmail's OWN UI: without
    // an explicit threadId it files the reply as a new conversation. Only a
    // reply pays for the lookup, and a miss just sends it unthreaded.
    const threadId = msg.inReplyTo ? await this.threadIdOf(msg.inReplyTo) : undefined;
    const post = (body: Record<string, string>): Promise<GmailMessage> =>
      this.api<GmailMessage>('messages/send', { method: 'POST', body: JSON.stringify(body) });
    let r: GmailMessage;
    if (threadId) {
      try {
        r = await post({ raw, threadId });
      } catch (e) {
        // Gmail rejects a threadId whose subject no longer matches, or one that
        // was deleted between the lookup and the send. That is a threading
        // detail — losing the whole message over it would be far worse, so the
        // send is retried once as a new conversation.
        if (!isThreadRejection(e)) throw e;
        console.warn('[gmail] send with threadId was rejected, retrying unthreaded:', (e as Error).message);
        r = await post({ raw });
      }
    } else {
      r = await post({ raw });
    }
    const messageIdHeader = await this.sentMessageIdHeader(r.id);
    return { providerMessageId: r.id, providerThreadId: r.threadId, ...(messageIdHeader ? { messageIdHeader } : {}) };
  }

  /** The thread a Message-ID belongs to, via Gmail's own header index. Returns
   *  undefined when the parent is not in this mailbox (a reply to something
   *  that only ever lived in another account) — the send then goes out
   *  unthreaded rather than failing. */
  private async threadIdOf(messageIdHeader: string): Promise<string | undefined> {
    try {
      const r = await this.api<GmailListResponse>('messages', {
        query: { q: `rfc822msgid:${messageIdHeader.replace(/^<|>$/g, '')}`, maxResults: 1 },
      });
      return r.messages?.[0]?.threadId;
    } catch (e) {
      console.warn('[gmail] could not resolve the parent thread for a reply:', (e as Error).message);
      return undefined;
    }
  }

  /** Gmail stamps its own Message-ID on anything it sends, so the header we
   *  built is not the one the recipient will quote in a reply. Reading the real
   *  value back is what keeps the sent row findable when that reply lands.
   *  The message is already gone by now — a failure here must not fail send. */
  private async sentMessageIdHeader(id: string): Promise<string | undefined> {
    try {
      const m = await this.api<GmailMessage>(`messages/${encodeURIComponent(id)}`, { query: { format: 'metadata', metadataHeaders: 'Message-ID' } });
      return normalizeMessageId(headerOf(m.payload, 'Message-ID')) ?? undefined;
    } catch (e) {
      console.warn('[gmail] could not read back the sent Message-ID:', (e as Error).message);
      return undefined;
    }
  }

  // -- labels as mailbox operations -----------------------------------------

  private async batchModify(ids: string[], addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    if (!ids.length || (!addLabelIds.length && !removeLabelIds.length)) return;
    for (const group of chunk(ids, BATCH_MAX)) {
      await this.api<void>('messages/batchModify', {
        method: 'POST',
        body: JSON.stringify({ ids: group, addLabelIds, removeLabelIds }),
      });
    }
  }

  async setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }): Promise<void> {
    const add: string[] = [];
    const remove: string[] = [];
    if (flags.read !== undefined) (flags.read ? remove : add).push('UNREAD');
    if (flags.starred !== undefined) (flags.starred ? add : remove).push('STARRED');
    await this.batchModify(ids, add, remove);
  }

  /** Gmail never re-keys a message when its labels change, so every id survives
   *  a move — but the contract still wants the mapping spelled out. */
  private static same(ids: string[]): MoveResult[] {
    return ids.map(id => ({ from: id, to: id }));
  }

  async move(ids: string[], folderProviderId: string): Promise<MoveResult[]> {
    if (folderProviderId === 'TRASH') return this.trash(ids);
    // Adding the INBOX label IS the move into the inbox; stripping it in the
    // same call would undo the operation.
    await this.batchModify(ids, [folderProviderId], folderProviderId === 'INBOX' ? [] : ['INBOX']);
    return GmailProvider.same(ids);
  }

  async archive(ids: string[]): Promise<MoveResult[]> {
    await this.batchModify(ids, [], ['INBOX']);
    return GmailProvider.same(ids);
  }

  async trash(ids: string[]): Promise<MoveResult[]> {
    // There is no batch trash: the TRASH label can only be applied by the
    // per-message endpoint (batchModify refuses it).
    await mapLimit(ids, CONCURRENCY, id => this.api<void>(`messages/${encodeURIComponent(id)}/trash`, { method: 'POST' }));
    return GmailProvider.same(ids);
  }

  // -- drafts ---------------------------------------------------------------

  /** Accepts either the "draft:<id>" we hand out or the message id a sync
   *  recorded for a draft written in another client. Null = no such draft. */
  private async draftIdFor(providerId: string): Promise<string | null> {
    if (providerId.startsWith(DRAFT_PREFIX)) return providerId.slice(DRAFT_PREFIX.length) || null;
    let pageToken: string | undefined;
    do {
      const r = await this.api<GmailDraftList>('drafts', { query: { maxResults: 500, pageToken } });
      const hit = (r.drafts ?? []).find(d => d.message?.id === providerId || d.id === providerId);
      if (hit?.id) return hit.id;
      pageToken = r.nextPageToken;
    } while (pageToken);
    return null;
  }

  async saveDraft(draft: OutgoingMessage, existingProviderId?: string): Promise<{ providerMessageId: string }> {
    const raw = b64url(await buildRawMime(draft));
    const existing = existingProviderId ? await this.draftIdFor(existingProviderId) : null;
    // A reply draft names its thread, as a reply send does, or Gmail's own UI
    // files it as a new conversation. A rejected threadId only costs threading.
    const threadId = draft.inReplyTo ? await this.threadIdOf(draft.inReplyTo) : undefined;
    const message = (withThread: boolean): Record<string, string> => (withThread && threadId ? { raw, threadId } : { raw });
    const write = (withThread: boolean): Promise<GmailDraft> => {
      const create = (): Promise<GmailDraft> => this.api<GmailDraft>('drafts', { method: 'POST', body: JSON.stringify({ message: message(withThread) }) });
      return existing
        ? this.api<GmailDraft>(`drafts/${encodeURIComponent(existing)}`, { method: 'PUT', body: JSON.stringify({ id: existing, message: message(withThread) }) })
          // The draft was discarded elsewhere while it was open here: saving must
          // still keep the user's words, so fall back to writing a new one.
          .catch(e => { if (e instanceof ProviderNotFoundError) return create(); throw e; })
        : create();
    };
    const r = await write(true).catch(e => {
      if (!threadId || !isThreadRejection(e)) throw e;
      console.warn('[gmail] draft with threadId was rejected, saving unthreaded:', (e as Error).message);
      return write(false);
    });
    const id = r.id ?? existing;
    if (!id) throw new Error('Gmail stored the draft but did not return its id — reopen it from Drafts');
    return { providerMessageId: DRAFT_PREFIX + id };
  }

  async deleteDraft(providerMessageId: string): Promise<void> {
    const id = await this.draftIdFor(providerMessageId);
    if (!id) return;                                   // already gone, or never a draft
    await this.api<void>(`drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // -- search ---------------------------------------------------------------

  async search(query: string, opts: { before?: Date; limit: number }): Promise<Envelope[]> {
    const q = [query.trim(), opts.before ? `before:${gmailDate(opts.before)}` : ''].filter(Boolean).join(' ');
    if (!q) return [];
    const list = await this.api<GmailListResponse>('messages', { query: { q, maxResults: Math.max(1, opts.limit) } });
    return this.envelopesFor((list.messages ?? []).slice(0, opts.limit).map(m => m.id));
  }
}
