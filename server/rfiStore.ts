// server/rfiStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';
import {
  type PdfAttachmentTable, listPdfAttachments, addPdfAttachment, updatePdfAttachment, removePdfAttachment,
} from './pdfAttachments';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}
/** Nothing to accept — the RFI exists, its pending reply does not (already
 *  accepted or dismissed, possibly by someone else a moment ago). A conflict,
 *  not bad input, so the routes can answer 409 rather than 400. */
export class NoPendingReplyError extends ValidationError {}

export const RFI_STATUSES = ['open', 'sent', 'answered', 'closed'] as const;

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

interface RfiInput {
  title?: string; question?: string; specRef?: string; drawingRef?: string;
  attention?: string; responseNeededBy?: string; status?: string;
  /** The internal "Assigned to" (a user id). Left alone on save when absent. */
  assigneeUserId?: string | null;
}

function validateAssignee(db: Database.Database, assigneeUserId: unknown): string | null {
  if (assigneeUserId === undefined || assigneeUserId === null || assigneeUserId === '') return null;
  if (typeof assigneeUserId !== 'string') throw new ValidationError('Invalid assignee');
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(assigneeUserId)) throw new ValidationError('Assignee is not a known user');
  return assigneeUserId;
}

function photoCount(db: Database.Database, rfiId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM rfi_photos WHERE rfiId = ?').get(rfiId) as any).c;
}

export interface RfiPendingReply {
  threadKey: string; accountId: string; mailMessageId: string; messageIdHeader: string | null;
  from: { addr: string; name?: string }; date: string; text: string;
  attachments: Array<{ attId: string; name: string; mime: string; size: number }>; receivedAt: string;
}

function withPendingReply<T extends { pendingReplyJson?: string | null }>(row: T): Omit<T, 'pendingReplyJson'> & { pendingReply: RfiPendingReply | null } {
  const { pendingReplyJson, ...rest } = row;
  return { ...rest, pendingReply: pendingReplyJson ? JSON.parse(pendingReplyJson) : null };
}

export function getRfi(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM rfis WHERE id = ?').get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM rfi_photos WHERE rfiId = ? ORDER BY sortOrder, createdAt').all(id);
  const attachments = listPdfAttachments(db, RFI_ATTACHMENTS, id);
  return { ...withPendingReply(row), photos, attachments };
}

export function listRfis(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM rfis WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
  return rows.map(r => ({ ...withPendingReply(r), photoCount: photoCount(db, r.id) }));
}

export function createRfi(db: Database.Database, projectId: string, input: RfiInput): { id: string; number: number } {
  requireProject(db, projectId);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('RFI title is required');
  if (input.status !== undefined && !(RFI_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid RFI status: ${input.status}`);
  }
  const assignee = validateAssignee(db, input.assigneeUserId);
  const id = crypto.randomUUID();
  let number = 0;
  const tx = db.transaction(() => {
    // Never reuse an issued number: the high-water counter survives deletes.
    // MAX(number) is a guard so numbering can't collide even if the counter
    // were ever behind (e.g., imported rows).
    const counter = (db.prepare('SELECT rfiCounter c FROM projects WHERE id = ?').get(projectId) as any).c;
    const max = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM rfis WHERE projectId = ?').get(projectId) as any).m;
    number = Math.max(counter, max) + 1;
    const now = Date.now();
    db.prepare(`INSERT INTO rfis (id, projectId, number, title, question, specRef, drawingRef, attention, responseNeededBy,
                responseText, responseFileId, status, version, sentAt, answeredAt, createdAt, updatedAt, assigneeUserId)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, NULL, NULL, ?, ?, ?)`)
      .run(id, projectId, number, input.title!.trim(), input.question ?? null, input.specRef ?? null,
           input.drawingRef ?? null, input.attention ?? null, input.responseNeededBy ?? null,
           input.status ?? 'open', now, now, assignee);
    db.prepare('UPDATE projects SET rfiCounter = ? WHERE id = ?').run(number, projectId);
  });
  tx();
  return { id, number };
}

export function saveRfi(db: Database.Database, id: string, input: RfiInput & { version?: number }): { version: number } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('RFI title is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the RFI');
  const setsAssignee = Object.prototype.hasOwnProperty.call(input, 'assigneeUserId');
  const assignee = setsAssignee ? validateAssignee(db, input.assigneeUserId) : null;
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM rfis WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('RFI not found');
    if (row.version !== input.version) throw new ConflictError(`RFI changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE rfis SET title = ?, question = ?, specRef = ?, drawingRef = ?, attention = ?, responseNeededBy = ?, version = ?, updatedAt = ? WHERE id = ?')
      .run(input.title!.trim(), input.question ?? null, input.specRef ?? null, input.drawingRef ?? null,
           input.attention ?? null, input.responseNeededBy ?? null, newVersion, Date.now(), id);
    if (setsAssignee) db.prepare('UPDATE rfis SET assigneeUserId = ? WHERE id = ?').run(assignee, id);
  });
  tx();
  return { version: newVersion };
}

export function setRfiStatus(db: Database.Database, id: string, status: string): { status: string } {
  if (!(RFI_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid RFI status: ${status}`);
  const row = db.prepare('SELECT id FROM rfis WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('RFI not found');
  db.prepare('UPDATE rfis SET status = ?, version = version + 1, updatedAt = ? WHERE id = ?').run(status, Date.now(), id);
  return { status };
}

export function deleteRfi(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM rfi_photos WHERE rfiId = ?').run(id);
    db.prepare('DELETE FROM rfi_attachments WHERE rfiId = ?').run(id);
    db.prepare('DELETE FROM rfis WHERE id = ?').run(id);
  });
  tx();
}

export function addPhoto(db: Database.Database, rfiId: string, fileId: string): void {
  if (!db.prepare('SELECT id FROM rfis WHERE id = ?').get(rfiId)) throw new NotFoundError('RFI not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const exists = db.prepare('SELECT id FROM rfi_photos WHERE rfiId = ? AND fileId = ?').get(rfiId, fileId);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM rfi_photos WHERE rfiId = ?').get(rfiId) as any).m;
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO rfi_photos (id, rfiId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), rfiId, fileId, max + 1, now);
    db.prepare('UPDATE rfis SET updatedAt = ? WHERE id = ?').run(now, rfiId);
  });
  tx();
}

export function removePhoto(db: Database.Database, rfiId: string, fileId: string): void {
  const tx = db.transaction(() => {
    const r = db.prepare('DELETE FROM rfi_photos WHERE rfiId = ? AND fileId = ?').run(rfiId, fileId);
    if (r.changes > 0) db.prepare('UPDATE rfis SET updatedAt = ? WHERE id = ?').run(Date.now(), rfiId);
  });
  tx();
}

// PDF attachments, appended to the generated RFI after its photos. Not the
// GC's answer — that stays responseFileId. Same freshness rule as the photos
// above: updatedAt moves (so the stored PDF reads out of date) but version
// does not — see the photo routes in routes.ts.
const RFI_ATTACHMENTS: PdfAttachmentTable = {
  table: 'rfi_attachments', ownerColumn: 'rfiId', ownerTable: 'rfis',
  notFoundMessage: 'RFI not found', noun: 'RFI',
  NotFoundError, ValidationError,
  touch: (db, rfiId) => { db.prepare('UPDATE rfis SET updatedAt = ? WHERE id = ?').run(Date.now(), rfiId); },
};

export function addAttachment(db: Database.Database, rfiId: string, fileId: string): void {
  addPdfAttachment(db, RFI_ATTACHMENTS, rfiId, fileId);
}

export function updateAttachment(db: Database.Database, rfiId: string, fileId: string, patch: { sortOrder: number }): void {
  updatePdfAttachment(db, RFI_ATTACHMENTS, rfiId, fileId, patch);
}

export function removeAttachment(db: Database.Database, rfiId: string, fileId: string): void {
  removePdfAttachment(db, RFI_ATTACHMENTS, rfiId, fileId);
}

// Advances status to 'sent' only from 'open'; answered/closed are never demoted
// by a (re)send. sentAt is always refreshed, but version/updatedAt move only on
// a real transition: updatedAt is what the generated-PDF "up to date" chip
// compares the stored file's createdAt against, so bumping it on a no-op status
// write would mark the just-emailed PDF stale the moment the send succeeded.
export function markRfiSent(db: Database.Database, id: string, sentByUserId?: string | null): void {
  const row = db.prepare('SELECT status FROM rfis WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new NotFoundError('RFI not found');
  // Who sent it last: told, with the assignee, when the GC answers.
  if (sentByUserId) db.prepare('UPDATE rfis SET sentByUserId = ? WHERE id = ?').run(String(sentByUserId), id);
  const nextStatus = row.status === 'open' ? 'sent' : row.status;
  const now = Date.now();
  if (nextStatus === row.status) {
    db.prepare('UPDATE rfis SET sentAt = ? WHERE id = ?').run(now, id);
    return;
  }
  db.prepare('UPDATE rfis SET status = ?, sentAt = ?, version = version + 1, updatedAt = ? WHERE id = ?').run(nextStatus, now, now, id);
}

// Records the answer. Usually the response arrives as a PDF (fileId of an
// uploaded shared file, kind 'rfi-response'); text covers phone/verbal answers.
// Only the provided fields are written, so a file and text can coexist.
// Auto-advances to 'answered' unless the RFI was already closed.
export function setRfiResponse(db: Database.Database, id: string, input: { fileId?: string; text?: string }): { status: string } {
  const row = db.prepare('SELECT status FROM rfis WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new NotFoundError('RFI not found');
  const hasFile = typeof input.fileId === 'string' && input.fileId.trim() !== '';
  const hasText = typeof input.text === 'string' && input.text.trim() !== '';
  if (!hasFile && !hasText) throw new ValidationError('A response file or response text is required');
  const nextStatus = row.status === 'closed' ? 'closed' : 'answered';
  const tx = db.transaction(() => {
    if (hasFile) db.prepare('UPDATE rfis SET responseFileId = ? WHERE id = ?').run(input.fileId!.trim(), id);
    if (hasText) db.prepare('UPDATE rfis SET responseText = ? WHERE id = ?').run(input.text!.trim(), id);
    const now = Date.now();
    db.prepare('UPDATE rfis SET status = ?, answeredAt = COALESCE(answeredAt, ?), version = version + 1, updatedAt = ? WHERE id = ?')
      .run(nextStatus, now, now, id);
  });
  tx();
  return { status: nextStatus };
}

// Stashes an inbound email as a candidate reply for review, rather than
// auto-answering the RFI. Only accepted while the RFI is 'sent' — once it's
// answered/closed a later reply shouldn't silently overwrite the recorded
// response. Each call replaces any prior pending reply (last inbound wins).
//
// version bumps (so live listeners refresh) but updatedAt does NOT — an email
// merely arriving must not flip the generated-PDF "up to date" freshness chip
// the way an actual edit to the RFI would (the owner's ruling). Only accepting
// the reply into the recorded response (acceptPendingReply → setRfiResponse)
// is a real content change and bumps updatedAt.
export function setPendingReply(db: Database.Database, id: string, reply: RfiPendingReply): boolean {
  const row = db.prepare('SELECT status FROM rfis WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new NotFoundError('RFI not found');
  if (row.status !== 'sent') return false;
  db.prepare('UPDATE rfis SET pendingReplyJson = ?, version = version + 1 WHERE id = ?')
    .run(JSON.stringify(reply), id);
  return true;
}

// Promotes the pending email reply into the recorded response, using the same
// answered-transition semantics as setRfiResponse. Text defaults to the
// pending reply's own text when the caller doesn't supply an override.
export function acceptPendingReply(db: Database.Database, id: string, input: { text?: string; fileId?: string }): { status: string } {
  const row = db.prepare('SELECT pendingReplyJson FROM rfis WHERE id = ?').get(id) as { pendingReplyJson: string | null } | undefined;
  if (!row) throw new NotFoundError('RFI not found');
  const pending: RfiPendingReply | null = row.pendingReplyJson ? JSON.parse(row.pendingReplyJson) : null;
  if (!pending) throw new NoPendingReplyError('No pending reply to accept');
  const hasText = typeof input.text === 'string' && input.text.trim() !== '';
  const hasFile = typeof input.fileId === 'string' && input.fileId.trim() !== '';
  const text = hasText ? input.text : pending.text;
  let result: { status: string } = { status: '' };
  const tx = db.transaction(() => {
    result = setRfiResponse(db, id, { text, fileId: hasFile ? input.fileId : undefined });
    db.prepare('UPDATE rfis SET responseSource = ?, responseMessageIdHeader = ?, pendingReplyJson = NULL, version = version + 1, updatedAt = ? WHERE id = ?')
      .run('email', pending.messageIdHeader, Date.now(), id);
  });
  tx();
  return result;
}

// Same freshness reasoning as setPendingReply: dismissing an unwanted email
// is not a content edit, so version bumps but updatedAt is left alone.
export function dismissPendingReply(db: Database.Database, id: string): void {
  const row = db.prepare('SELECT id FROM rfis WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('RFI not found');
  db.prepare('UPDATE rfis SET pendingReplyJson = NULL, version = version + 1 WHERE id = ?').run(id);
}
