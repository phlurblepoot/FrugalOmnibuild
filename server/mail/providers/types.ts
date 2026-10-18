export type MailProviderKind = 'google' | 'microsoft' | 'imap' | 'fake';
export interface Addr { addr: string; name?: string }
export interface AttachmentMeta {
  attId: string; name: string; mime: string; size: number; contentId?: string;
  // Ids this same part answered to in EARLIER generations of the indexed list.
  // Gmail re-mints attachment ids per fetch, so re-indexing a message (see
  // getAttachmentFresh in ../routes.ts) would otherwise strand every id an
  // already-open client is still holding. Only written by that re-index, only
  // read by wantedAttachment, and never sent to a provider.
  priorIds?: string[];
}
/** What a caller can tell getAttachment about a part without a message read. */
export interface AttachmentHint { name: string; mime: string }
export interface Envelope {
  providerMessageId: string; providerThreadId?: string;
  messageIdHeader?: string; inReplyTo?: string; references: string[];
  from: Addr; to: Addr[]; cc: Addr[]; bcc: Addr[];
  subject: string; snippet: string; date: string;           // ISO
  isRead: boolean; isStarred: boolean; isDraft: boolean;
  attachments: AttachmentMeta[]; sizeBytes: number;
  folderProviderIds: string[];
  /** A provider that cannot learn the id of a message it just sent indexes the
   *  sent row under a placeholder (Graph: `sent:<the Message-ID we generated>`).
   *  When the real message later arrives from a sync, this carries that
   *  placeholder id so `upsertEnvelopes` RE-KEYS the existing row instead of
   *  inserting a second copy of the user's own sent message. Matching on
   *  `messageIdHeader` cannot do this job: the provider rewrote the header, so
   *  the placeholder and the real envelope do not share one. */
  replacesProviderMessageId?: string;
}
/** One `move`/`archive`/`trash` outcome: `to` is the message's new
 *  providerMessageId, or null when the provider did not report one.
 *  `failed` means the move did NOT happen (the server refused it, the mailbox
 *  was unreadable). It has to be distinguishable from "moved but unnamed": the
 *  caller deletes/re-keys the local row for the latter, and must instead put
 *  the row back where it was for the former. */
export interface MoveResult { from: string; to: string | null; failed?: true }
export interface ProviderFolder { providerId: string; name: string; role: FolderRole | null; unreadCount?: number; totalCount?: number; sortOrder?: number }
export type FolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'spam' | 'starred';
export type SyncState = Record<string, unknown>;
export interface OutgoingAttachment { name: string; mime: string; content: Buffer; contentId?: string }
export interface OutgoingMessage {
  from: Addr; to: Addr[]; cc: Addr[]; bcc: Addr[]; subject: string; html: string; text: string;
  attachments: OutgoingAttachment[]; inReplyTo?: string; references?: string[]; messageIdHeader: string;
}
export interface MailProvider {
  kind: MailProviderKind;
  listFolders(): Promise<ProviderFolder[]>;
  /** Reads the mailbox a page at a time. `cursor` resumes a paused import; a
   *  provider that keeps a per-import watermark (Gmail's history id, read
   *  BEFORE the first page so mid-import arrivals cannot fall in a gap) returns
   *  it as `watermark` and accepts it back on `opts.watermark`, so an import
   *  resumed in a fresh process still adopts the watermark it began with.
   *  Providers without one ignore both fields. */
  backfill(opts: { since: Date; cursor?: string; watermark?: string }): Promise<{ messages: Envelope[]; cursor?: string; done: boolean; watermark?: string }>;
  /** `reset: true` means the provider's change log no longer reaches back to
   *  the caller's cursor (Gmail expires history after about a week), so the
   *  returned state is worthless and the caller must re-run a full backfill. */
  incremental(state: SyncState): Promise<{ upserts: Envelope[]; deletes: string[]; state: SyncState; reset?: boolean }>;
  getBody(providerMessageId: string): Promise<{ html?: string; text?: string; attachments: AttachmentMeta[] }>;
  /** `hint` is the name and MIME type the caller already knows for `attId`.
   *  A provider whose byte endpoint returns bytes and nothing else (Gmail)
   *  otherwise has to read the whole message to learn them — and Gmail mints
   *  NEW attachment ids on every such read, so a lookup done on the caller's
   *  behalf silently invalidates every other id the caller is holding (see
   *  getAttachmentFresh in ../routes.ts). With a hint the provider must go
   *  straight to the bytes and report a dead id as ProviderNotFoundError.
   *  Providers that carry the metadata with the bytes may ignore it. */
  getAttachment(providerMessageId: string, attId: string, hint?: AttachmentHint): Promise<{ stream: NodeJS.ReadableStream; mime: string; size?: number; name: string }>;
  /** `messageIdHeader` is the Message-ID the provider actually used — Gmail/Graph rewrite
   *  the one we hand them, and the sent row must be indexed under the real value or the
   *  reply that quotes it will not thread. Omitted = ours was kept verbatim. */
  send(msg: OutgoingMessage): Promise<{ providerMessageId: string; providerThreadId?: string; messageIdHeader?: string }>;
  setFlags(ids: string[], flags: { read?: boolean; starred?: boolean }): Promise<void>;
  /** Moving a message can change its provider id (an IMAP MOVE gives it a new
   *  UID in the destination). The result maps each id we asked to move to the
   *  id it now has, or `null` when the provider could not tell us — the caller
   *  must re-key its rows, or the next sync indexes the moved copy as a
   *  duplicate of a row that no longer resolves. */
  move(ids: string[], folderProviderId: string): Promise<MoveResult[]>;
  archive(ids: string[]): Promise<MoveResult[]>;
  trash(ids: string[]): Promise<MoveResult[]>;
  saveDraft(draft: OutgoingMessage, existingProviderId?: string): Promise<{ providerMessageId: string }>;
  deleteDraft(providerMessageId: string): Promise<void>;
  search(query: string, opts: { before?: Date; limit: number }): Promise<Envelope[]>;
  /** Optional live-change channel (IMAP IDLE, a webhook subscription, …).
   *  `onChange` is a hint that something moved — the caller re-syncs, it carries
   *  no payload. `onAuthError` fires when the channel died because the account's
   *  credentials stopped working: it will not reconnect on its own, so the
   *  caller must mark the account and stop expecting push. Providers without
   *  push simply omit both members. */
  startPush?(onChange: () => void, onAuthError?: (err: Error) => void): Promise<void>;
  stopPush?(): Promise<void>;
}
export class AuthExpiredError extends Error {}
export class RateLimitedError extends Error { retryAfterMs = 60_000 }
export class ProviderNotFoundError extends Error {}
/** An attachment the provider cannot carry (Graph's 3 MB inline limit). Routes answer 413 with this message. */
export class AttachmentTooLargeError extends Error {}
