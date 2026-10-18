// Client-side types for the mail client UI (Plan 3). Mirrors the shapes the
// live server routes actually return — see server/mail/routes.ts — not the
// (partially stale) shapes sketched in the task brief.

export interface Addr { addr: string; name?: string }

/** The closed set of app entities a mail thread can be linked to (server/mail/links.ts ItemType). */
export type ItemType =
  | 'proposal' | 'invoice' | 'changeOrder' | 'lienRelease' | 'payApp' | 'issue' | 'rfi'
  | 'dailyReport' | 'punch' | 'task' | 'project' | 'customer';

export type MailAccountStatus = 'ok' | 'syncing' | 'auth_error' | 'needs_review' | 'disabled';

export interface MailAccount {
  id: string;
  provider: 'google' | 'microsoft' | 'imap' | 'fake';
  emailAddress: string;
  displayName: string | null;
  signatureHtml: string | null;
  isDefault: number;
  status: MailAccountStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  indexedSince: string;
  /** Server-computed: unread count across this account's inbox folder(s). */
  unreadCount: number;
  /** imap accounts only — non-secret auth fields for the Edit form to
   *  prefill; the password never comes back from the server. */
  imapAuth?: {
    imapHost: string; imapPort: number; imapSecure: boolean;
    smtpHost: string; smtpPort: number; smtpSecure: boolean; username: string;
  };
}

export interface MailFolder {
  id: string;
  accountId: string;
  providerId: string;
  name: string;
  role: string | null;
  unreadCount: number;
  totalCount: number;
  sortOrder: number;
}

/** A mail_thread_links row. subjectSnapshot/participantsJson/firstDate are
 *  app-written snapshots taken at link time, visible to any viewer — not a
 *  live read of anyone's mailbox — same trust model as project-threads. */
export interface ThreadLink {
  id: string;
  threadKey: string;
  subjectSnapshot: string | null;
  firstDate: string | null;
  participantsJson: string | null;
  itemType: ItemType;
  itemId: string;
  projectId: string | null;
  customerId: string | null;
  linkedByUserId: string;
  createdAt: string;
  /** Resolved item label (number/title for the item, or the project/customer
   *  name for those link kinds); a generic fallback if the target row is gone.
   *  Optional in the type since not every route that returns a ThreadLink adds
   *  it (e.g. the raw POST /api/mail/links response) — present wherever the
   *  server calls resolveLinkLabel (GET /links, thread/threads, project-threads). */
  label?: string;
}

// Booleans that come out of SQLite as 0/1 travel over JSON as plain numbers —
// typed as `number` here (not `boolean`) to match what actually arrives.
export interface ThreadListRow {
  threadKey: string;
  subject: string;
  firstDate: string;
  lastDate: string;
  messageCount: number;
  unreadCount: number;
  hasAttachments: number;
  isStarred: number;
  participants: Addr[];
  folderIds: string[];
  snippet: string;
  links: ThreadLink[];
}

export interface ProjectThreadLinkRef { itemType: ItemType; itemId: string; label: string }

/** One row per distinct thread linked to a project or one of its items — GET
 *  /api/mail/project-threads. Viewer-independent: same trust model as the
 *  ThreadLink snapshot fields (app-written at link time, not a mailbox read). */
export interface ProjectThreadRow {
  threadKey: string;
  subjectSnapshot: string | null;
  participants: Addr[];
  firstDate: string | null;
  links: ProjectThreadLinkRef[];
  lastInboundDate: string | null;
  lastOutboundDate: string | null;
  /** The earliest link's createdAt across every row aggregated into this
   *  thread — the floor for the reply-indicator rule (spec Goal 4:
   *  `lastInboundDate > max(lastOutboundDate, link.createdAt)`), so a thread
   *  linked to this project only just now doesn't read as an unanswered
   *  reply for mail that predates the link entirely. */
  earliestLinkCreatedAt: string;
  lastActivity: string;
}

export interface AttachmentMeta {
  attId: string;
  name: string;
  mime: string;
  size: number;
  contentId?: string;
}

export interface MessageRow {
  id: string;
  accountId: string;
  threadKey: string;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  from: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  snippet: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  attachments: AttachmentMeta[];
  sizeBytes: number;
  folderIds: string[];
  sentFromApp: boolean;
}

export interface BodyPayload {
  html: string;
  text: string;
  blockedRemoteImages: number;
  attachments: AttachmentMeta[];
  /** True when remote images were let through (asked for, or sender trusted). */
  imagesAllowed?: boolean;
  /** Lower-cased sender address, for "always load from". */
  sender?: string | null;
  /** The signed-in user always loads images from `sender`. */
  senderTrusted?: boolean;
}

/** GET /api/mail/messages/:id/body can 202 while a just-sent message's Graph
 *  copy is still being filed; the client renders a "Sending…" placeholder. */
export interface BodyPending { pending: true }

export type MailAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'trash' | 'move';

export interface SendRequest {
  accountId?: string;
  to: Addr[];
  cc?: Addr[];
  bcc?: Addr[];
  subject: string;
  html: string;
  attachments: Array<
    | { fileId: string; name?: string; itemType?: ItemType; itemId?: string }
    | { uploadId: string }
  >;
  replyTo?: { accountId: string; threadKey: string };
  links?: Array<{ itemType: ItemType; itemId: string }>;
  draftProviderId?: string;
}

/** GET /api/mail/messages/:id/draft — a draft reopened in the composer.
 *  `draftId` is the provider id the draft routes and send's draftProviderId take. */
export interface OpenedDraft {
  messageId: string;
  accountId: string;
  draftId: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  html: string;
  attachments: Array<{ uploadId: string; name: string; size: number }>;
  replyTo: { accountId: string; threadKey: string } | null;
}

export interface SendResult {
  messageId: string;
  threadKey: string;
  accountId: string;
  effectsSkipped: ItemType[];
}

export interface Recipient extends Addr {
  source: string;
  customerId?: string;
  role?: string;
}

export interface SetupInfo {
  publicUrl: string | null;
  google: {
    configured: boolean;
    redirectUri: string | null;
    /** Optional Gmail real-time push. `webhookUrl` embeds the shared secret, so
     *  it only ever comes back from the admin-only setup-info route. */
    pubsub: { configured: boolean; topic: string | null; webhookUrl: string | null };
  };
  microsoft: { configured: boolean; redirectUri: string | null; webhookUrl: string | null; tenant: string };
  secretKey: 'env' | 'file';
}
