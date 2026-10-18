// server/mail/providers/microsoft.ts
// The Microsoft 365 / Outlook.com provider, speaking Graph v1.0 over the
// injected `fetch` for the same reason the Gmail one does: every method stays
// testable against recorded JSON, and the SDK is only worth its weight for the
// consent dance in oauth.ts.
//
// Ids: `providerMessageId` is the Graph message id — and unlike Gmail's, it is
// NOT stable across a move. `/move` answers with the message's new id, so every
// MoveResult here really does re-key the row (see MoveResult in types.ts).
//
// Sync: Graph has no mailbox-wide change feed, only a per-folder delta query,
// so the sync state is `{ deltaLinks: { [folderId]: deltaLink } }` and a poll
// walks one link per folder. Junk and Deleted Items are deliberately not
// indexed.
//
// Sending: Graph will not let a client set Message-ID, In-Reply-To or
// References — it writes them itself — so a reply CANNOT go through sendMail
// with hand-built headers. It is built as a draft from `createReply` (which is
// what makes Outlook thread it) and sent from there. Either way the Message-ID
// the recipient will quote is one we never chose, so `send` reads the sent copy
// back out of Sent Items and reports the real header; when that read-back finds
// nothing, the id falls back to `sent:<our header>` and the next delta pass
// re-keys that row rather than duplicating it — tied together by the
// `x-frugal-message-id` header this provider sets on the way out and reads back
// off the synced message as Envelope.replacesProviderMessageId.
import { Readable } from 'stream';
import type {
  MailProvider, Envelope, ProviderFolder, SyncState, OutgoingMessage, OutgoingAttachment,
  AttachmentMeta, FolderRole, Addr, MoveResult,
} from './types';
import { AuthExpiredError, RateLimitedError, ProviderNotFoundError, AttachmentTooLargeError } from './types';
import type { TokenSource } from './tokenSource';
import { snippetOf, htmlToText, decodeEntities } from '../mime';
import { normalizeMessageId } from '../threadKey';

const API = 'https://graph.microsoft.com/v1.0/';
const TOKEN_HOST = 'https://login.microsoftonline.com';
export const GRAPH_SCOPES = [
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
].join(' ');
const TIMEOUT_MS = 30_000;
/** Graph fetches are one HTTP round trip each; five in flight keeps a backfill
 *  brisk without tripping the per-mailbox throttle. */
const CONCURRENCY = 5;
const DELTA_PAGE = 100;
const FOLDER_PAGE = 200;
/** POST /attachments carries the bytes inline as base64; past ~3 MB Graph wants
 *  an upload session instead, which this path deliberately does not implement. */
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** The id a send falls back to when the sent copy has not landed in Sent Items
 *  yet. The engine swaps it for the real id on the next sync. */
const SENT_PREFIX = 'sent:';
/** A sent copy older than this is somebody else's message, not the one we
 *  just handed to Graph. */
const SENT_MATCH_WINDOW_MS = 60_000;
/** sendMail answers 202 the moment Exchange accepts the message and files the
 *  Sent Items copy some time AFTER that, so a single read-back mostly loses the
 *  race and the placeholder becomes the common path rather than the rare one.
 *  These are the waits before the 2nd, 3rd and 4th attempts. */
const SENT_READBACK_BACKOFF_MS = [500, 1000, 2000];
/** Lets the sent copy be matched exactly instead of by subject, and — when it
 *  comes back around on a later sync — lets the engine tie the real message to
 *  the `sent:` placeholder the send left behind. Graph rejects any custom
 *  header that does not start with `x-`, and only accepts them on a message it
 *  did not create itself, so a createReply draft cannot carry one. */
const CORRELATION_HEADER = 'x-frugal-message-id';
/** How many messages' attachment lists getAttachment may remember. Metadata
 *  only — never body bytes — and bounded so a long session cannot grow it. */
const PART_CACHE_MAX = 500;

const ENVELOPE_SELECT = [
  'id', 'conversationId', 'internetMessageId', 'subject', 'bodyPreview', 'receivedDateTime', 'sentDateTime',
  'isRead', 'isDraft', 'flag', 'hasAttachments', 'from', 'toRecipients', 'ccRecipients', 'bccRecipients',
  'parentFolderId', 'internetMessageHeaders',
].join(',');
const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline,contentId';
const FOLDER_SELECT = 'id,displayName,wellKnownName,unreadItemCount,totalItemCount,childFolderCount';

// -- Graph JSON shapes (only the fields this provider reads) -----------------
interface GraphEmailAddress { name?: string; address?: string }
interface GraphRecipient { emailAddress?: GraphEmailAddress }
interface GraphHeader { name?: string; value?: string }
interface GraphMessage {
  id: string; conversationId?: string; internetMessageId?: string; subject?: string; bodyPreview?: string;
  receivedDateTime?: string; sentDateTime?: string; isRead?: boolean; isDraft?: boolean; hasAttachments?: boolean;
  flag?: { flagStatus?: string }; parentFolderId?: string;
  from?: GraphRecipient; sender?: GraphRecipient;
  toRecipients?: GraphRecipient[]; ccRecipients?: GraphRecipient[]; bccRecipients?: GraphRecipient[];
  internetMessageHeaders?: GraphHeader[];
  body?: { contentType?: string; content?: string };
  '@removed'?: { reason?: string };
}
interface GraphFolder {
  id: string; displayName?: string; wellKnownName?: string | null;
  unreadItemCount?: number; totalItemCount?: number; childFolderCount?: number;
}
interface GraphAttachment { id?: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentId?: string | null }
interface GraphList<T> { value?: T[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }
interface GraphSubscription { id?: string; expirationDateTime?: string }

// -- folder roles ------------------------------------------------------------
const ROLE_BY_WELL_KNOWN: Record<string, FolderRole> = {
  inbox: 'inbox', sentitems: 'sent', drafts: 'drafts', deleteditems: 'trash', junkemail: 'spam', archive: 'archive',
};
/** The order the sidebar wants; everything else sorts by name after these. */
const ROLE_ORDER: FolderRole[] = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'];
/** Junk and Deleted Items are noise in an index and cost a delta call each. */
const SKIP_SYNC: Array<FolderRole | null> = ['spam', 'trash'];

const enc = encodeURIComponent;
/** Only the VALUES are escaped: the keys are all literal OData options ($top,
 *  $filter, …) and percent-encoding the `$` only makes the URL harder to read. */
const qs = (q: Record<string, string | number | undefined>): string =>
  Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${enc(String(v))}`).join('&');

const addrOf = (r: GraphRecipient | undefined): Addr | null => {
  const addr = r?.emailAddress?.address?.trim();
  if (!addr) return null;
  const name = r?.emailAddress?.name?.trim();
  // Graph fills `name` with the address itself when it has no display name;
  // carrying that through would render "bob@x <bob@x>" everywhere.
  return name && name.toLowerCase() !== addr.toLowerCase() ? { addr, name } : { addr };
};
const addrList = (rs: GraphRecipient[] | undefined): Addr[] =>
  (rs ?? []).map(addrOf).filter((a): a is Addr => !!a);
const recipient = (a: Addr): GraphRecipient => ({ emailAddress: { address: a.addr, ...(a.name ? { name: a.name } : {}) } });

const headerOf = (m: GraphMessage, name: string): string | undefined =>
  m.internetMessageHeaders?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value;

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

export interface MicrosoftProviderOpts {
  fetch: typeof fetch;
  /** Injectable only so the read-back retry below can be tested without
   *  actually waiting three and a half seconds. */
  sleep?: (ms: number) => Promise<void>;
}

/** Where a backfill has got to: the delta page it must read next, and the
 *  folders it has not started yet. Opaque to the caller, which only stores it. */
interface BackfillCursor { next?: string; queue: string[] }
const encodeCursor = (c: BackfillCursor): string => Buffer.from(JSON.stringify(c)).toString('base64url');
const decodeCursor = (s: string): BackfillCursor => {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as BackfillCursor;
    return { next: typeof c.next === 'string' ? c.next : undefined, queue: Array.isArray(c.queue) ? c.queue : [] };
  } catch {
    // A cursor we cannot read is a cursor from another build — start over
    // rather than failing the whole import.
    return { queue: [] };
  }
};

/** Exchanges a refresh token for an access token. Microsoft ROTATES refresh
 *  tokens, so the new one is returned for TokenSource.onRotate to persist —
 *  drop it and the account dies at the old token's 90-day expiry. Errors keep
 *  Microsoft's own `error`/AADSTS code in the message because TokenSource
 *  matches on it to decide the grant is dead rather than retrying. */
export async function microsoftRefresh(
  env: NodeJS.ProcessEnv,
  refreshToken: string,
  fetchFn: typeof fetch,
): Promise<{ accessToken: string; expiresInSec: number; refreshToken?: string }> {
  const tenant = env.MS_OAUTH_TENANT || 'common';
  const res = await fetchFn(`${TOKEN_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MS_OAUTH_CLIENT_ID ?? '',
      client_secret: env.MS_OAUTH_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: GRAPH_SCOPES,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
  if (!res.ok) throw new Error(`${body.error || res.status}: ${body.error_description || ''}`);
  // A 200 with no token would otherwise be cached as an empty Bearer and every
  // later call would 401 in a way that looks like a revoked grant.
  if (!body.access_token) throw new Error('Microsoft returned no access token for the refresh');
  return {
    accessToken: String(body.access_token),
    expiresInSec: Number(body.expires_in) || 3600,
    refreshToken: body.refresh_token,
  };
}

export class GraphProvider implements MailProvider {
  kind = 'microsoft' as const;
  /** message id → the attachment metadata from its last list. `$value` returns
   *  bytes and nothing else, so a download's name and MIME type can only come
   *  from here. */
  private partCache = new Map<string, AttachmentMeta[]>();
  /** The delta links a backfill collected. Adopting these (rather than reading
   *  fresh ones once the backfill finishes) is what stops a message that
   *  arrived mid-backfill from falling into the gap between the two. */
  private backfillDeltaLinks: Record<string, string> | null = null;

  constructor(private tokens: TokenSource, private opts: MicrosoftProviderOpts) {}

  // -- transport ------------------------------------------------------------

  /** `pathOrUrl` is either a path under /v1.0/ or an absolute Graph URL (the
   *  `@odata.nextLink`/`@odata.deltaLink` values, which already carry their
   *  own query). */
  private async request(
    pathOrUrl: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
    retry = true,
  ): Promise<Response> {
    const { query, ...rest } = init;
    const q = query ? qs(query) : '';
    const base = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : API + pathOrUrl.replace(/^\//, '');
    const url = q ? `${base}${base.includes('?') ? '&' : '?'}${q}` : base;
    const res = await this.opts.fetch(url, {
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
      if (retry) return this.request(pathOrUrl, init, false);
      throw new AuthExpiredError('Microsoft rejected the access token — reconnect the account in Settings → Mail');
    }
    if (res.status === 429 || res.status === 503) throw this.rateLimited(res);
    // 410 Gone is how Graph retires a delta token; incremental() treats it the
    // same way the Gmail provider treats an expired historyId — by resetting.
    if (res.status === 404 || res.status === 410) throw new ProviderNotFoundError(pathOrUrl);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Deliberately only the response text: the request's Authorization
      // header must never reach a log or an error surfaced to the UI.
      throw new Error(`Graph ${res.status}: ${body.slice(0, 200)}`);
    }
    return res;
  }

  private async api<T>(
    pathOrUrl: string,
    init: RequestInit & { query?: Record<string, string | number | undefined> } = {},
  ): Promise<T> {
    const res = await this.request(pathOrUrl, init);
    const text = await res.text();
    if (!text) return undefined as T;                         // 202/204 from send, move, delete
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Graph returned a non-JSON response for ${pathOrUrl.replace(/^https?:\/\/[^/]+/, '')}`);
    }
  }

  private rateLimited(res: Response): RateLimitedError {
    const e = new RateLimitedError(`Graph ${res.status} — rate limited`);
    const after = Number(res.headers.get('retry-after'));
    if (Number.isFinite(after) && after > 0) e.retryAfterMs = after * 1000;
    return e;
  }

  // -- folders --------------------------------------------------------------

  async listFolders(): Promise<ProviderFolder[]> {
    const top = await this.api<GraphList<GraphFolder>>('me/mailFolders', { query: { $top: FOLDER_PAGE, $select: FOLDER_SELECT } });
    const parents = top.value ?? [];
    // One level of nesting only: Outlook mailboxes are commonly two deep and
    // walking the whole tree would cost a request per folder on every sync.
    const kids = await mapLimit(parents.filter(p => (p.childFolderCount ?? 0) > 0), CONCURRENCY, async parent => {
      const r = await this.api<GraphList<GraphFolder>>(`me/mailFolders/${enc(parent.id)}/childFolders`, { query: { $top: FOLDER_PAGE, $select: FOLDER_SELECT } });
      return (r.value ?? []).map(c => ({ ...c, displayName: `${parent.displayName ?? 'Folder'}/${c.displayName ?? c.id}` }));
    });

    const all = [...parents, ...kids.flat()];
    const rank = (f: GraphFolder): number => {
      const role = ROLE_BY_WELL_KNOWN[String(f.wellKnownName ?? '').toLowerCase()];
      const i = role ? ROLE_ORDER.indexOf(role) : -1;
      return i >= 0 ? i : ROLE_ORDER.length;
    };
    all.sort((a, b) => rank(a) - rank(b) || (a.displayName ?? '').localeCompare(b.displayName ?? ''));
    return all.map((f, i): ProviderFolder => ({
      providerId: f.id,
      name: f.displayName ?? f.id,
      role: ROLE_BY_WELL_KNOWN[String(f.wellKnownName ?? '').toLowerCase()] ?? null,
      ...(f.unreadItemCount !== undefined ? { unreadCount: f.unreadItemCount } : {}),
      ...(f.totalItemCount !== undefined ? { totalCount: f.totalItemCount } : {}),
      sortOrder: i,
    }));
  }

  /** The folders a sync reads, in a stable order so a paged backfill can walk
   *  them across calls. */
  private async syncableFolderIds(): Promise<string[]> {
    return (await this.listFolders()).filter(f => !SKIP_SYNC.includes(f.role)).map(f => f.providerId);
  }

  // -- message mapping ------------------------------------------------------

  private rememberParts(id: string, atts: AttachmentMeta[]): void {
    this.partCache.delete(id);
    this.partCache.set(id, atts);
    while (this.partCache.size > PART_CACHE_MAX) {
      const oldest = this.partCache.keys().next().value;
      if (oldest === undefined) break;
      this.partCache.delete(oldest);
    }
  }

  private async listAttachments(messageId: string): Promise<AttachmentMeta[]> {
    const r = await this.api<GraphList<GraphAttachment>>(`me/messages/${enc(messageId)}/attachments`, { query: { $select: ATTACHMENT_SELECT } });
    const out = (r.value ?? []).filter(a => a.id).map((a): AttachmentMeta => ({
      attId: String(a.id),
      name: a.name || 'attachment',
      mime: a.contentType || 'application/octet-stream',
      size: a.size ?? 0,
      ...(a.contentId ? { contentId: a.contentId } : {}),
    }));
    this.rememberParts(messageId, out);
    return out;
  }

  private toEnvelope(m: GraphMessage, attachments: AttachmentMeta[]): Envelope {
    const refs = (headerOf(m, 'References') ?? '').match(/<[^>]+>/g) ?? [];
    const when = new Date(m.receivedDateTime || m.sentDateTime || '');
    // Our own correlation header, riding back in on the message Graph filed in
    // Sent Items: it is the only thing tying this message to the placeholder
    // row a send left behind, because Graph replaced the Message-ID we chose.
    const correlation = headerOf(m, CORRELATION_HEADER);
    return {
      ...(correlation ? { replacesProviderMessageId: SENT_PREFIX + correlation } : {}),
      providerMessageId: m.id,
      providerThreadId: m.conversationId,
      messageIdHeader: normalizeMessageId(m.internetMessageId) ?? undefined,
      inReplyTo: normalizeMessageId(headerOf(m, 'In-Reply-To')) ?? undefined,
      references: refs.map(normalizeMessageId).filter((x): x is string => !!x),
      from: addrOf(m.from ?? m.sender) ?? { addr: '' },
      to: addrList(m.toRecipients),
      cc: addrList(m.ccRecipients),
      bcc: addrList(m.bccRecipients),
      subject: m.subject ?? '',
      // bodyPreview is already plain text — only entity-escaped. Running it
      // through htmlToText would eat any literal "<...>" the sender wrote.
      snippet: snippetOf(decodeEntities(m.bodyPreview ?? '')),
      date: (isNaN(when.getTime()) ? new Date() : when).toISOString(),
      isRead: !!m.isRead,
      isStarred: m.flag?.flagStatus === 'flagged',
      isDraft: !!m.isDraft,
      attachments,
      // Graph v1.0 does not expose a message's wire size on the message
      // resource, and paying for a second call per message to guess it is not
      // worth it — the list UI never shows this figure.
      sizeBytes: 0,
      folderProviderIds: m.parentFolderId ? [m.parentFolderId] : [],
    };
  }

  /** Maps a delta/search page, fetching the attachment list only for the
   *  messages that admit to having one. Graph sets `hasAttachments` for
   *  non-inline attachments only, so a message whose sole attachment is an
   *  inline signature image indexes with none — getBody lists them properly
   *  when the message is actually opened. */
  private async envelopesFor(messages: GraphMessage[]): Promise<Envelope[]> {
    return mapLimit(messages, CONCURRENCY, async m => {
      let attachments: AttachmentMeta[] = [];
      if (m.hasAttachments) {
        try {
          attachments = await this.listAttachments(m.id);
        } catch (e) {
          // A message deleted between the delta page and this call must not
          // fail the whole page; it will be dropped by the next delta anyway.
          if (!(e instanceof ProviderNotFoundError)) throw e;
        }
      }
      return this.toEnvelope(m, attachments);
    });
  }

  // -- sync -----------------------------------------------------------------

  private deltaPath(folderId: string): string {
    return `me/mailFolders/${enc(folderId)}/messages/delta`;
  }

  private deltaQuery(since: Date): Record<string, string | number> {
    // delta accepts $filter on the INITIAL call only; it is then baked into the
    // nextLink/deltaLink Graph hands back, so it never has to be resent.
    return { $select: ENVELOPE_SELECT, $top: DELTA_PAGE, $filter: `receivedDateTime ge ${since.toISOString()}` };
  }

  async backfill(opts: { since: Date; cursor?: string }): Promise<{ messages: Envelope[]; cursor?: string; done: boolean }> {
    let state: BackfillCursor;
    if (opts.cursor) {
      state = decodeCursor(opts.cursor);
    } else {
      state = { queue: await this.syncableFolderIds() };
      this.backfillDeltaLinks = {};
    }
    if (this.backfillDeltaLinks === null) this.backfillDeltaLinks = {};

    // Which folder this page belongs to: the one being resumed, or the next
    // one off the queue.
    let folderId = state.next ? undefined : state.queue.shift();
    if (!state.next && !folderId) return { messages: [], done: true };

    const page = state.next
      ? await this.api<GraphList<GraphMessage>>(state.next)
      : await this.api<GraphList<GraphMessage>>(this.deltaPath(folderId as string), { query: this.deltaQuery(opts.since) });

    const nextLink = page['@odata.nextLink'];
    const deltaLink = page['@odata.deltaLink'];
    if (deltaLink) {
      // The link is stored against the folder it came from. On a resumed page
      // that folder is not in hand, so it is read back off the link itself.
      folderId = folderId ?? folderIdOfDeltaUrl(state.next ?? '') ?? undefined;
      if (folderId) this.backfillDeltaLinks[folderId] = deltaLink;
    }

    const messages = await this.envelopesFor((page.value ?? []).filter(m => m.id && !m['@removed']));
    const nextCursor: BackfillCursor = { ...(nextLink ? { next: nextLink } : {}), queue: state.queue };
    const done = !nextLink && !state.queue.length;
    return { messages, ...(done ? {} : { cursor: encodeCursor(nextCursor) }), done };
  }

  /** Walks one folder's delta from `link` to its next deltaLink. */
  private async drainDelta(link: string): Promise<{ messages: GraphMessage[]; removed: string[]; deltaLink: string }> {
    const messages: GraphMessage[] = [];
    const removed: string[] = [];
    let url: string | undefined = link;
    let deltaLink = link;
    while (url) {
      const page: GraphList<GraphMessage> = await this.api<GraphList<GraphMessage>>(url);
      for (const m of page.value ?? []) {
        if (!m.id) continue;
        if (m['@removed']) removed.push(m.id);
        else messages.push(m);
      }
      if (page['@odata.deltaLink']) deltaLink = page['@odata.deltaLink'];
      url = page['@odata.nextLink'];
    }
    return { messages, removed, deltaLink };
  }

  /** Establishes a baseline delta link for `folderId` without indexing its
   *  history — everything already there is either known or deliberately out of
   *  scope, so only what arrives from `since` on is of interest. */
  private async baselineLink(folderId: string, since: Date): Promise<{ link: string; messages: GraphMessage[] }> {
    const first = await this.api<GraphList<GraphMessage>>(this.deltaPath(folderId), { query: this.deltaQuery(since) });
    const messages: GraphMessage[] = (first.value ?? []).filter(m => m.id && !m['@removed']);
    let url = first['@odata.nextLink'];
    let link = first['@odata.deltaLink'] ?? '';
    while (url) {
      const page: GraphList<GraphMessage> = await this.api<GraphList<GraphMessage>>(url);
      messages.push(...(page.value ?? []).filter(m => m.id && !m['@removed']));
      if (page['@odata.deltaLink']) link = page['@odata.deltaLink'];
      url = page['@odata.nextLink'];
    }
    return { link, messages };
  }

  async incremental(state: SyncState): Promise<{ upserts: Envelope[]; deletes: string[]; state: SyncState; reset?: boolean }> {
    const stored = (state?.deltaLinks && typeof state.deltaLinks === 'object' ? state.deltaLinks : null) as Record<string, string> | null;
    if (!stored || !Object.keys(stored).length) {
      // No baseline yet (a fresh account, or the pass right after a backfill):
      // adopt what the backfill collected, or read watermarks from now, and let
      // the next poll do the work.
      const adopted = this.backfillDeltaLinks;
      this.backfillDeltaLinks = null;
      if (adopted && Object.keys(adopted).length) return { upserts: [], deletes: [], state: { deltaLinks: adopted } };
      const now = new Date();
      const links: Record<string, string> = {};
      for (const id of await this.syncableFolderIds()) {
        const { link } = await this.baselineLink(id, now);
        if (link) links[id] = link;
      }
      return { upserts: [], deletes: [], state: { deltaLinks: links } };
    }

    const links: Record<string, string> = {};
    const raw: GraphMessage[] = [];
    const deletes: string[] = [];
    const now = new Date();
    // Re-listing the folders is what discovers one created in Outlook since
    // the last poll; it gets a baseline link here rather than waiting for a
    // backfill that may never run again.
    for (const id of await this.syncableFolderIds()) {
      const link = stored[id];
      if (!link) {
        const { link: fresh, messages } = await this.baselineLink(id, now);
        raw.push(...messages);
        if (fresh) links[id] = fresh;
        continue;
      }
      let r: { messages: GraphMessage[]; removed: string[]; deltaLink: string };
      try {
        r = await this.drainDelta(link);
      } catch (e) {
        // Graph retires a delta token after a period offline (410 Gone,
        // syncStateNotFound). The stored state is worthless then and the only
        // way back is a full re-read. Deliberately scoped to the drain: a 404
        // from the folder listing or a baseline is a different problem, and
        // answering it with a whole-mailbox re-read would be a rough way to
        // find that out.
        if (e instanceof ProviderNotFoundError) return { upserts: [], deletes: [], state: { deltaLinks: {} }, reset: true };
        throw e;
      }
      raw.push(...r.messages);
      deletes.push(...r.removed);
      links[id] = r.deltaLink;
    }

    // A message deleted in the same window it changed in is gone: never refetch
    // its attachments, and never report it as an upsert.
    const gone = new Set(deletes);
    const upserts = await this.envelopesFor(raw.filter(m => !gone.has(m.id)));
    return { upserts, deletes, state: { deltaLinks: links } };
  }

  // -- bodies and attachments -----------------------------------------------

  async getBody(providerMessageId: string): Promise<{ html?: string; text?: string; attachments: AttachmentMeta[] }> {
    const m = await this.api<GraphMessage>(`me/messages/${enc(providerMessageId)}`, {
      query: { $select: 'body,uniqueBody' },
      // Without this Graph converts the body to plain text for some mailboxes.
      headers: { Prefer: 'outlook.body-content-type="html"' },
    });
    const content = m.body?.content ?? '';
    const isHtml = (m.body?.contentType ?? '').toLowerCase() === 'html';
    const html = isHtml ? content : undefined;
    const text = isHtml ? htmlToText(content) : content;
    // Always listed rather than trusting hasAttachments: an inline signature
    // image is an attachment the body's cid: reference needs resolved.
    const attachments = await this.listAttachments(providerMessageId);
    return { ...(html ? { html } : {}), ...(text ? { text } : {}), attachments };
  }

  async getAttachment(providerMessageId: string, attId: string): Promise<{ stream: NodeJS.ReadableStream; mime: string; size?: number; name: string }> {
    // $value answers with bytes and nothing else — the name and MIME type live
    // in the attachment list, so make sure we have it.
    let meta = this.partCache.get(providerMessageId)?.find(a => a.attId === attId);
    if (!meta) meta = (await this.listAttachments(providerMessageId)).find(a => a.attId === attId);
    if (!meta) throw new ProviderNotFoundError(attId);
    const res = await this.request(`me/messages/${enc(providerMessageId)}/attachments/${enc(attId)}/$value`);
    const stream = res.body
      ? Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
      : Readable.from(Buffer.from(await res.arrayBuffer()));
    return { stream, mime: meta.mime, size: meta.size || undefined, name: meta.name };
  }

  // -- sending --------------------------------------------------------------

  private assertSendable(a: OutgoingAttachment): void {
    if (a.content.length > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentTooLargeError(`Attachment "${a.name}" is ${(a.content.length / 1024 / 1024).toFixed(1)} MB — Microsoft 365 accepts at most 3 MB per attachment when sending from this app. Send it as a link instead.`);
    }
  }

  private fileAttachment(a: OutgoingAttachment): Record<string, unknown> {
    this.assertSendable(a);
    return {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name,
      contentType: a.mime,
      contentBytes: a.content.toString('base64'),
      isInline: !!a.contentId,
      ...(a.contentId ? { contentId: a.contentId } : {}),
    };
  }

  /** The fields a message resource takes, shared by sendMail, drafts and the
   *  PATCH that fills in a createReply draft. */
  private messageBody(msg: OutgoingMessage): Record<string, unknown> {
    return {
      subject: msg.subject,
      body: { contentType: 'HTML', content: msg.html },
      toRecipients: msg.to.map(recipient),
      ccRecipients: msg.cc.map(recipient),
      bccRecipients: msg.bcc.map(recipient),
    };
  }

  async send(msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string; messageIdHeader?: string }> {
    msg.attachments.forEach(a => this.assertSendable(a));
    const parent = msg.inReplyTo ? await this.parentOf(msg.inReplyTo) : null;
    const sentAt = Date.now();
    // A reply must be built from createReply: Graph writes In-Reply-To and
    // References itself and refuses to take ours, so this is the only way
    // Outlook (and the recipient's client) will thread it.
    if (parent) await this.sendAsReply(parent.id, msg);
    else {
      await this.api<void>('me/sendMail', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            ...this.messageBody(msg),
            attachments: msg.attachments.map(a => this.fileAttachment(a)),
            internetMessageHeaders: [{ name: CORRELATION_HEADER, value: msg.messageIdHeader }],
          },
          saveToSentItems: true,
        }),
      });
    }

    const found = await this.findSentCopy(msg, sentAt, parent?.conversationId);
    if (found) {
      return {
        providerMessageId: found.id,
        ...(found.conversationId ? { providerThreadId: found.conversationId } : {}),
        ...(found.messageIdHeader ? { messageIdHeader: found.messageIdHeader } : {}),
      };
    }
    // The copy has not been filed yet. A placeholder keeps the sent row in the
    // thread; the next delta pass finds the real message and upsertEnvelopes
    // re-keys this row by its Message-ID rather than inserting a duplicate.
    return {
      providerMessageId: SENT_PREFIX + msg.messageIdHeader,
      ...(parent?.conversationId ? { providerThreadId: parent.conversationId } : {}),
    };
  }

  /** The message in this mailbox carrying `messageIdHeader`, or null when the
   *  parent only ever lived in another account — the send then goes out
   *  unthreaded rather than failing. */
  private async parentOf(messageIdHeader: string): Promise<{ id: string; conversationId?: string } | null> {
    const id = `<${messageIdHeader.replace(/^<+|>+$/g, '')}>`;
    try {
      const r = await this.api<GraphList<GraphMessage>>('me/messages', {
        query: { $filter: `internetMessageId eq '${id.replace(/'/g, "''")}'`, $select: 'id,conversationId', $top: 1 },
      });
      const hit = r.value?.[0];
      return hit?.id ? { id: hit.id, ...(hit.conversationId ? { conversationId: hit.conversationId } : {}) } : null;
    } catch (e) {
      console.warn('[graph] could not resolve the parent message for a reply:', (e as Error).message);
      return null;
    }
  }

  private async sendAsReply(parentId: string, msg: OutgoingMessage): Promise<void> {
    const draft = await this.api<GraphMessage>(`me/messages/${enc(parentId)}/createReply`, { method: 'POST' });
    if (!draft?.id) throw new Error('Microsoft created the reply but did not return its id — try sending again');
    try {
      // createReply seeds the draft with a quoted body and the original
      // recipients; the PATCH replaces both with what the composer actually
      // sent, leaving only the threading headers Graph owns.
      await this.api<void>(`me/messages/${enc(draft.id)}`, { method: 'PATCH', body: JSON.stringify(this.messageBody(msg)) });
      for (const a of msg.attachments) {
        await this.api<void>(`me/messages/${enc(draft.id)}/attachments`, { method: 'POST', body: JSON.stringify(this.fileAttachment(a)) });
      }
      await this.api<void>(`me/messages/${enc(draft.id)}/send`, { method: 'POST' });
    } catch (e) {
      // A half-built reply left behind would show up in the user's Drafts as a
      // mystery duplicate of the message they thought they sent.
      await this.api<void>(`me/messages/${enc(draft.id)}`, { method: 'DELETE' })
        .catch(err => console.warn('[graph] could not discard a failed reply draft:', (err as Error).message));
      throw e;
    }
  }

  /** Graph never reports the id of what it sent, so the sent copy is matched
   *  out of Sent Items: exactly, by the correlation header when we were able to
   *  set one, then by the conversation a reply went into, and only then by
   *  subject within a minute of the send. Exchange files that copy
   *  asynchronously, so this retries with a short backoff rather than losing
   *  the race on the first look. A failure here must never fail a send that has
   *  already gone out. */
  private async findSentCopy(msg: OutgoingMessage, sentAt: number, conversationId?: string): Promise<{ id: string; conversationId?: string; messageIdHeader?: string } | null> {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      const hit = await this.readSentCopy(msg, sentAt, conversationId);
      if (hit) return hit;
      if (attempt >= SENT_READBACK_BACKOFF_MS.length) return null;
      await sleep(SENT_READBACK_BACKOFF_MS[attempt]);
    }
  }

  private async readSentCopy(msg: OutgoingMessage, sentAt: number, conversationId?: string): Promise<{ id: string; conversationId?: string; messageIdHeader?: string } | null> {
    try {
      const r = await this.api<GraphList<GraphMessage>>('me/mailFolders/sentitems/messages', {
        query: { $top: 5, $orderby: 'sentDateTime desc', $select: 'id,internetMessageId,conversationId,subject,sentDateTime,internetMessageHeaders' },
      });
      const recent = (r.value ?? []).filter(m => {
        const t = Date.parse(m.sentDateTime ?? '');
        return Number.isFinite(t) && Math.abs(t - sentAt) <= SENT_MATCH_WINDOW_MS;
      });
      const hit = recent.find(m => headerOf(m, CORRELATION_HEADER) === msg.messageIdHeader)
        // A reply carries no correlation header (Graph only accepts one on a
        // message it did not create), but we know the conversation it went
        // into, which beats matching on a subject two messages can share.
        ?? (conversationId ? recent.find(m => m.conversationId === conversationId) : undefined)
        ?? recent.find(m => (m.subject ?? '') === msg.subject);
      if (!hit?.id) return null;
      return {
        id: hit.id,
        ...(hit.conversationId ? { conversationId: hit.conversationId } : {}),
        ...(normalizeMessageId(hit.internetMessageId) ? { messageIdHeader: normalizeMessageId(hit.internetMessageId) as string } : {}),
      };
    } catch (e) {
      console.warn('[graph] could not read the sent copy back:', (e as Error).message);
      return null;
    }
  }

  // -- flags and mailbox operations -----------------------------------------

  async setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (flags.read !== undefined) patch.isRead = flags.read;
    if (flags.starred !== undefined) patch.flag = { flagStatus: flags.starred ? 'flagged' : 'notFlagged' };
    if (!ids.length || !Object.keys(patch).length) return;
    const body = JSON.stringify(patch);
    await mapLimit(ids, CONCURRENCY, id => this.api<void>(`me/messages/${enc(id)}`, { method: 'PATCH', body }));
  }

  /** Graph re-keys a message when it moves, and answers with the copy in the
   *  destination — that new id is what the caller must store, or the next sync
   *  indexes the moved copy alongside a row that no longer resolves. */
  async move(ids: string[], folderProviderId: string): Promise<MoveResult[]> {
    return mapLimit(ids, CONCURRENCY, async id => {
      const r = await this.api<GraphMessage>(`me/messages/${enc(id)}/move`, {
        method: 'POST',
        body: JSON.stringify({ destinationId: folderProviderId }),
      });
      return { from: id, to: r?.id ?? null };
    });
  }

  // 'archive' and 'deleteditems' are well-known folder names Graph accepts
  // wherever a folder id is taken, so neither needs the folder list first.
  archive(ids: string[]): Promise<MoveResult[]> { return this.move(ids, 'archive'); }
  trash(ids: string[]): Promise<MoveResult[]> { return this.move(ids, 'deleteditems'); }

  // -- drafts ---------------------------------------------------------------

  async saveDraft(draft: OutgoingMessage, existingProviderId?: string): Promise<{ providerMessageId: string }> {
    draft.attachments.forEach(a => this.assertSendable(a));
    const body = JSON.stringify(this.messageBody(draft));
    let id: string | undefined;
    if (existingProviderId) {
      // Whether the PATCH landed is decided by it NOT throwing, never by what
      // it returned — Graph answers some updates with a bare 204, and reading
      // that as "gone" would fork the draft into a second copy on every save.
      try {
        await this.api<GraphMessage>(`me/messages/${enc(existingProviderId)}`, { method: 'PATCH', body });
        id = existingProviderId;
      } catch (e) {
        // The draft was discarded elsewhere while it was open here: saving must
        // still keep the user's words, so fall through to writing a new one.
        if (!(e instanceof ProviderNotFoundError)) throw e;
      }
    }
    if (!id) {
      // A reply draft is built from createReply, the only way Graph files a
      // draft in the parent's conversation (it will not take our headers).
      const parent = draft.inReplyTo ? await this.parentOf(draft.inReplyTo) : null;
      if (parent) {
        const reply = await this.api<GraphMessage>(`me/messages/${enc(parent.id)}/createReply`, { method: 'POST' });
        if (reply?.id) {
          await this.api<GraphMessage>(`me/messages/${enc(reply.id)}`, { method: 'PATCH', body });
          for (const a of draft.attachments) {
            await this.api<void>(`me/messages/${enc(reply.id)}/attachments`, { method: 'POST', body: JSON.stringify(this.fileAttachment(a)) });
          }
          return { providerMessageId: reply.id };
        }
      }
      const created = await this.api<GraphMessage>('me/messages', { method: 'POST', body });
      if (!created?.id) throw new Error('Microsoft stored the draft but did not return its id — reopen it from Drafts');
      id = created.id;
      for (const a of draft.attachments) {
        await this.api<void>(`me/messages/${enc(id)}/attachments`, { method: 'POST', body: JSON.stringify(this.fileAttachment(a)) });
      }
      return { providerMessageId: id };
    }
    await this.syncDraftAttachments(id, draft.attachments);
    return { providerMessageId: id };
  }

  /** Graph attachments are separate resources, so an updated draft has to be
   *  reconciled by hand. Matching is by NAME: Graph's reported `size` includes
   *  MIME overhead, so comparing sizes would re-upload every file on every
   *  save. The cost is that replacing a file with a different one of the same
   *  name does not re-upload it — a trade the composer's "remove, then add"
   *  flow does not hit. */
  private async syncDraftAttachments(messageId: string, wanted: OutgoingAttachment[]): Promise<void> {
    const existing = await this.listAttachments(messageId);
    if (!existing.length && !wanted.length) return;
    const missing = [...wanted];
    for (const e of existing) {
      const i = missing.findIndex(a => a.name === e.name);
      if (i >= 0) missing.splice(i, 1);
      else await this.api<void>(`me/messages/${enc(messageId)}/attachments/${enc(e.attId)}`, { method: 'DELETE' });
    }
    for (const a of missing) {
      await this.api<void>(`me/messages/${enc(messageId)}/attachments`, { method: 'POST', body: JSON.stringify(this.fileAttachment(a)) });
    }
  }

  async deleteDraft(providerMessageId: string): Promise<void> {
    await this.api<void>(`me/messages/${enc(providerMessageId)}`, { method: 'DELETE' })
      // Already discarded elsewhere — the caller wanted it gone, and it is.
      .catch(e => { if (!(e instanceof ProviderNotFoundError)) throw e; });
  }

  // -- search ---------------------------------------------------------------

  async search(query: string, opts: { before?: Date; limit: number }): Promise<Envelope[]> {
    const q = query.trim();
    if (!q) return [];
    // $search cannot be combined with $filter or $orderby in Graph, so the date
    // bound is applied here instead of in the query.
    const r = await this.api<GraphList<GraphMessage>>('me/messages', {
      query: { $search: `"${q.replace(/"/g, '')}"`, $top: Math.max(1, opts.limit), $select: ENVELOPE_SELECT },
    });
    const before = opts.before?.getTime();
    const hits = (r.value ?? []).filter(m => {
      if (!m.id) return false;
      if (before === undefined) return true;
      const t = Date.parse(m.receivedDateTime || m.sentDateTime || '');
      return !Number.isFinite(t) || t < before;
    });
    return this.envelopesFor(hits.slice(0, opts.limit));
  }

  // -- push subscriptions (driven by push.ts, not by this class) ------------

  /** Graph push is a webhook, not a socket this class can hold open, so
   *  startPush/stopPush are deliberately absent: push.ts owns the endpoint and
   *  the renewal timer and only borrows these two calls. */
  async createSubscription(notificationUrl: string, clientState: string, expirationIso: string): Promise<{ id: string; expirationDateTime: string }> {
    const r = await this.api<GraphSubscription>('subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        changeType: 'created,updated,deleted',
        notificationUrl,
        // The whole mailbox rather than one folder: a message moved between
        // folders has to reach the same poll that indexed it.
        resource: '/me/messages',
        expirationDateTime: expirationIso,
        clientState,
      }),
    });
    if (!r?.id) throw new Error('Microsoft accepted the subscription but did not return its id');
    return { id: r.id, expirationDateTime: r.expirationDateTime ?? expirationIso };
  }

  async renewSubscription(id: string, expirationIso: string): Promise<{ id: string; expirationDateTime: string }> {
    const r = await this.api<GraphSubscription>(`subscriptions/${enc(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ expirationDateTime: expirationIso }),
    });
    return { id: r?.id ?? id, expirationDateTime: r?.expirationDateTime ?? expirationIso };
  }
}

/** Recovers the folder a delta page belongs to from its own URL, for the case
 *  where a backfill resumed mid-folder and no longer holds the id. */
function folderIdOfDeltaUrl(url: string): string | null {
  const m = /\/mailFolders\/([^/]+)\/messages\/delta/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}
