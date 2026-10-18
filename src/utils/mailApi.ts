// Client for the mail-client REST surface — server/mail/routes.ts. Every call
// carries the app's own auth headers (Bearer token + X-Session-Id, matching
// every other API helper in src/utils/store.ts); GET/POST/PUT/PATCH/DELETE go
// through small shared wrappers below, with two exceptions that need the raw
// Response: stageUpload (binary body) and body() (may 202 with no BodyPayload).
import { getAuthHeaders, handleResponse } from './store';
import type {
  Addr,
  AttachmentMeta,
  BodyPayload,
  BodyPending,
  MailAccount,
  MailAccountStatus,
  MailAction,
  MailFolder,
  MessageRow,
  OpenedDraft,
  ProjectThreadRow,
  Recipient,
  SendRequest,
  SendResult,
  SetupInfo,
  ThreadLink,
  ThreadListRow,
} from '../pages/mail/types';

export type ImapAccountInput = {
  /** Present to update an existing IMAP account in place; omitted to create a new one. */
  id?: string;
  emailAddress: string;
  displayName?: string | null;
  imapHost: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  username: string;
  /** Blank on an update keeps the previously stored password. */
  password?: string;
};

export type MailAccountPatch = Partial<{
  displayName: string;
  signatureHtml: string;
  status: Extract<MailAccountStatus, 'ok' | 'disabled'>;
  isDefault: boolean;
}>;

export type SaveAttachmentItem = {
  attId: string;
  name: string;
  kind: string;
  projectId?: string;
  customerId?: string;
};

export type SaveAttachmentsResult = {
  fileIds: string[];
  saved: Array<{ attId: string; fileId: string }>;
  failed: Array<{ attId: string; error: string }>;
};

export type DraftInput = { accountId: string; to: Addr[]; cc?: Addr[]; bcc?: Addr[]; subject: string; html: string;
  attachments?: Array<{ fileId: string; name?: string } | { uploadId: string }>;
  replyTo?: { accountId: string; threadKey: string } };

const jsonHeaders = (): Record<string, string> => ({ 'Content-Type': 'application/json', ...getAuthHeaders() });

/**
 * The app's JWT, for the handful of URLs the browser fetches WITHOUT going
 * through fetch() — `<img src>`, a top-level navigation, an opaque-origin
 * iframe — none of which can carry an Authorization header. Those URLs take
 * the token as a `?token=` query param instead; read from localStorage the
 * same way getAuthHeaders() does.
 */
export const getMailToken = (): string => localStorage.getItem('token') || '';

async function apiFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init);
  await handleResponse(res);
  return res.json() as Promise<T>;
}

async function apiVoid(url: string, init: RequestInit = {}): Promise<void> {
  const res = await fetch(url, init);
  await handleResponse(res);
}

const get = <T>(url: string): Promise<T> => apiFetch<T>(url, { method: 'GET', headers: getAuthHeaders() });
const post = <T>(url: string, body?: unknown, method: string = 'POST'): Promise<T> =>
  apiFetch<T>(url, { method, headers: jsonHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
const postVoid = (url: string, body?: unknown, method: string = 'POST'): Promise<void> =>
  apiVoid(url, { method, headers: jsonHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
const del = (url: string): Promise<void> => apiVoid(url, { method: 'DELETE', headers: getAuthHeaders() });

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const mailApi = {
  accounts: (): Promise<MailAccount[]> => get('/api/mail/accounts'),

  createImapAccount: (b: ImapAccountInput): Promise<MailAccount> => post('/api/mail/accounts/imap', b),

  testAccount: (id: string): Promise<void> => postVoid(`/api/mail/accounts/${encodeURIComponent(id)}/test`),

  patchAccount: (id: string, patch: MailAccountPatch): Promise<MailAccount> =>
    post(`/api/mail/accounts/${encodeURIComponent(id)}`, patch, 'PATCH'),

  deleteAccount: (id: string): Promise<void> => del(`/api/mail/accounts/${encodeURIComponent(id)}`),

  loadOlder: (id: string, months: number): Promise<{ indexedSince: string }> =>
    post(`/api/mail/accounts/${encodeURIComponent(id)}/load-older`, { months }),

  // "Check for mail now": the server answers 202 the moment it has nudged the
  // account's sync worker, so a caller that wants to SEE the new mail has to
  // wait for the sync itself (the `mailThread` broadcasts, or a short delay
  // then a reload) rather than treating this promise as the result.
  refreshAccount: (id: string): Promise<void> =>
    postVoid(`/api/mail/accounts/${encodeURIComponent(id)}/refresh`),

  // The browser NAVIGATES here (a redirect to the provider's consent screen),
  // so it can't carry an Authorization header — the token rides in the query
  // string instead, read from localStorage the same way getAuthHeaders() does.
  oauthStartUrl: (provider: 'google' | 'microsoft'): string => {
    const token = getMailToken();
    return `/api/mail/oauth/${provider}/start?token=${encodeURIComponent(token)}`;
  },

  providers: (): Promise<{ google: boolean; microsoft: boolean }> => get('/api/mail/providers'),

  folders: (accountId: string): Promise<MailFolder[]> => get(`/api/mail/folders${qs({ accountId })}`),

  // `threadKeys` asks for an explicit set of conversations and BYPASSES the
  // folder and q filters server-side — it is how a server-search result is
  // shown, since those hits are typically archived and matched on body text
  // the local index never saw.
  threads: (q: { accountId: string; folderId?: string; q?: string; before?: string; limit?: number; threadKeys?: string[] }): Promise<{
    threads: ThreadListRow[];
    hasMore: boolean;
    indexedSince: string;
  }> => get(`/api/mail/threads${qs({ ...q, threadKeys: q.threadKeys?.length ? q.threadKeys.join(',') : undefined })}`),

  thread: (accountId: string, threadKey: string): Promise<{ thread: ThreadListRow; messages: MessageRow[]; links: ThreadLink[] }> =>
    get(`/api/mail/threads/${encodeURIComponent(accountId)}/${encodeURIComponent(threadKey)}`),

  body: (messageId: string, opts?: { images?: boolean }): Promise<BodyPayload | BodyPending> =>
    get(`/api/mail/messages/${encodeURIComponent(messageId)}/body${qs({ images: opts?.images ? 1 : undefined })}`),

  trustImageSender: (addr: string): Promise<void> =>
    postVoid('/api/mail/image-senders', { addr }, 'PUT'),
  untrustImageSender: (addr: string): Promise<void> =>
    del(`/api/mail/image-senders${qs({ addr })}`),

  // <img>/<a download> can't set an Authorization header, so this (like
  // oauthStartUrl) carries the token in the query string; ?inline=1 asks the
  // server for an inline Content-Disposition instead of a download prompt.
  attachmentUrl: (messageId: string, attId: string, opts?: { inline?: boolean }): string => {
    const token = getMailToken();
    return `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attId)}${qs({
      token,
      inline: opts?.inline ? 1 : undefined,
    })}`;
  },

  saveAttachments: (messageId: string, items: SaveAttachmentItem[]): Promise<SaveAttachmentsResult> =>
    post(`/api/mail/messages/${encodeURIComponent(messageId)}/attachments/save`, { items }),

  messageActions: (ids: string[], action: MailAction, folderId?: string): Promise<void> =>
    postVoid('/api/mail/messages/actions', { ids, action, folderId }),

  threadActions: (accountId: string, threadKeys: string[], action: MailAction, folderId?: string): Promise<void> =>
    postVoid('/api/mail/threads/actions', { accountId, threadKeys, action, folderId }),

  send: (req: SendRequest): Promise<SendResult> => post('/api/mail/send', req),

  saveDraft: (b: DraftInput, existingId?: string): Promise<{ draftId: string }> =>
    existingId ? post(`/api/mail/drafts/${encodeURIComponent(existingId)}`, b, 'PUT') : post('/api/mail/drafts', b, 'POST'),

  // A draft reopened in the composer: its fields, a lightly cleaned body, its
  // attachments re-staged as uploads, and the thread it answers (if any).
  openDraft: (messageId: string): Promise<OpenedDraft> =>
    get(`/api/mail/messages/${encodeURIComponent(messageId)}/draft`),

  deleteDraft: (accountId: string, draftId: string): Promise<void> =>
    del(`/api/mail/drafts/${encodeURIComponent(draftId)}${qs({ accountId })}`),

  stageUpload: (file: File): Promise<{ uploadId: string }> =>
    apiFetch(`/api/mail/uploads?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', ...getAuthHeaders() },
      body: file,
    }),

  // `threadKeys` are the conversations the hits were filed into — feed them
  // straight back to threads() to show results the normal list cannot reach.
  searchServer: (accountId: string, q: string, before?: string): Promise<{ count: number; threadKeys: string[] }> =>
    get(`/api/mail/search${qs({ accountId, q, before })}`),

  recipients: (q: string): Promise<Recipient[]> => get(`/api/mail/recipients${qs({ q })}`),

  unreadCount: (): Promise<{ total: number; byAccount: Record<string, number> }> => get('/api/mail/unread-count'),

  heartbeat: (accountIds: string[]): Promise<void> => postVoid('/api/mail/heartbeat', { accountIds }),

  links: (itemType: string, itemId: string): Promise<ThreadLink[]> => get(`/api/mail/links${qs({ itemType, itemId })}`),

  createLink: (b: { threadKey: string; itemType: string; itemId: string }): Promise<ThreadLink> => post('/api/mail/links', b),

  deleteLink: (id: string): Promise<void> => del(`/api/mail/links/${encodeURIComponent(id)}`),

  setupInfo: (): Promise<SetupInfo> => get('/api/mail/setup-info'),

  // Cross-user thread opening (spec Goal 3): does one of the CURRENT user's
  // own mailboxes hold this thread — exact threadKey, else a normalized
  // subject + ±3d date window + shared participant. See openThreadLink.ts,
  // the one place that turns this into a navigation or a reference card.
  resolveThread: (q: { threadKey: string; subject: string; firstDate: string; participants: string }):
    Promise<{ match: { accountId: string; threadKey: string } | null }> => get(`/api/mail/resolve-thread${qs(q)}`),

  // Every mail thread linked to a project or one of its items (spec Goal 5),
  // one row per distinct threadKey. Viewer-independent, like links()/threads().
  projectThreads: (projectId: string): Promise<ProjectThreadRow[]> => get(`/api/mail/project-threads${qs({ projectId })}`),

  // Batch "they replied and we haven't yet" flags (spec Goal 4) — the ids out
  // of `itemIds` whose newest thread link satisfies the indicator rule.
  replyFlags: (itemType: string, itemIds: string[]): Promise<{ flagged: string[] }> =>
    get(`/api/mail/reply-flags${qs({ itemType, itemIds: itemIds.join(',') })}`),
};

// Re-exported so callers of mailApi can import the shape of an attachment
// without reaching into pages/mail/types directly.
export type { AttachmentMeta };
