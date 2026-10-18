// server/issueStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';
import {
  type PdfAttachmentTable, listPdfAttachments, addPdfAttachment, updatePdfAttachment, removePdfAttachment,
} from './pdfAttachments';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const ISSUE_STATUSES = ['open', 'sent', 'resolved'] as const;

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

interface IssueInput { title?: string; description?: string; status?: string; }

function photoCount(db: Database.Database, issueId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM issue_photos WHERE issueId = ?').get(issueId) as any).c;
}

export function getIssue(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM issue_photos WHERE issueId = ? ORDER BY sortOrder, createdAt').all(id);
  const attachments = listPdfAttachments(db, ISSUE_ATTACHMENTS, id);
  return { ...row, photos, attachments };
}

export function listIssues(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM issues WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}

export function createIssue(db: Database.Database, projectId: string, input: IssueInput): { id: string; number: number } {
  requireProject(db, projectId);
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Issue title is required');
  if (input.status !== undefined && !(ISSUE_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid issue status: ${input.status}`);
  }
  const id = crypto.randomUUID();
  let number = 0;
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(number), 0) m FROM issues WHERE projectId = ?').get(projectId) as any).m;
    number = max + 1;
    const now = Date.now();
    db.prepare('INSERT INTO issues (id, projectId, number, title, description, status, version, sentAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)')
      .run(id, projectId, number, input.title!.trim(), input.description ?? null, input.status ?? 'open', now, now);
  });
  tx();
  return { id, number };
}

export function saveIssue(db: Database.Database, id: string, input: IssueInput & { version?: number }): { version: number } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Issue title is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the issue');
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM issues WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Issue not found');
    if (row.version !== input.version) throw new ConflictError(`Issue changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE issues SET title = ?, description = ?, version = ?, updatedAt = ? WHERE id = ?')
      .run(input.title!.trim(), input.description ?? null, newVersion, Date.now(), id);
  });
  tx();
  return { version: newVersion };
}

export function setIssueStatus(db: Database.Database, id: string, status: string): { status: string } {
  if (!(ISSUE_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid issue status: ${status}`);
  const row = db.prepare('SELECT id FROM issues WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Issue not found');
  db.prepare('UPDATE issues SET status = ?, version = version + 1, updatedAt = ? WHERE id = ?').run(status, Date.now(), id);
  return { status };
}

export function deleteIssue(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM issue_photos WHERE issueId = ?').run(id);
    db.prepare('DELETE FROM issue_attachments WHERE issueId = ?').run(id);
    db.prepare('DELETE FROM issues WHERE id = ?').run(id);
  });
  tx();
}

export function addPhoto(db: Database.Database, issueId: string, fileId: string): void {
  if (!db.prepare('SELECT id FROM issues WHERE id = ?').get(issueId)) throw new NotFoundError('Issue not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const exists = db.prepare('SELECT id FROM issue_photos WHERE issueId = ? AND fileId = ?').get(issueId, fileId);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM issue_photos WHERE issueId = ?').get(issueId) as any).m;
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO issue_photos (id, issueId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), issueId, fileId, max + 1, now);
    db.prepare('UPDATE issues SET updatedAt = ? WHERE id = ?').run(now, issueId);
  });
  tx();
}

export function removePhoto(db: Database.Database, issueId: string, fileId: string): void {
  const tx = db.transaction(() => {
    const r = db.prepare('DELETE FROM issue_photos WHERE issueId = ? AND fileId = ?').run(issueId, fileId);
    if (r.changes > 0) db.prepare('UPDATE issues SET updatedAt = ? WHERE id = ?').run(Date.now(), issueId);
  });
  tx();
}

// PDF attachments, appended to the generated issue report after its photos.
// Same freshness rule as the photos above: updatedAt moves (so the stored PDF
// reads out of date) but version does not — see the photo routes in routes.ts.
const ISSUE_ATTACHMENTS: PdfAttachmentTable = {
  table: 'issue_attachments', ownerColumn: 'issueId', ownerTable: 'issues',
  notFoundMessage: 'Issue not found', noun: 'issue',
  NotFoundError, ValidationError,
  touch: (db, issueId) => { db.prepare('UPDATE issues SET updatedAt = ? WHERE id = ?').run(Date.now(), issueId); },
};

export function addAttachment(db: Database.Database, issueId: string, fileId: string): void {
  addPdfAttachment(db, ISSUE_ATTACHMENTS, issueId, fileId);
}

export function updateAttachment(db: Database.Database, issueId: string, fileId: string, patch: { sortOrder: number }): void {
  updatePdfAttachment(db, ISSUE_ATTACHMENTS, issueId, fileId, patch);
}

export function removeAttachment(db: Database.Database, issueId: string, fileId: string): void {
  removePdfAttachment(db, ISSUE_ATTACHMENTS, issueId, fileId);
}

// sentAt is always refreshed; the status/version/updatedAt write happens only
// on a real transition. updatedAt is the clock the generated-PDF "up to date"
// chip compares the stored file against, so a re-send of an already-sent issue
// must leave it alone — otherwise every successful send immediately marks its
// own PDF stale, with no way back to current.
export function markIssueSent(db: Database.Database, id: string): void {
  const row = db.prepare('SELECT status FROM issues WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new NotFoundError('Issue not found');
  const now = Date.now();
  if (row.status === 'sent') {
    db.prepare('UPDATE issues SET sentAt = ? WHERE id = ?').run(now, id);
    return;
  }
  db.prepare("UPDATE issues SET status = 'sent', sentAt = ?, version = version + 1, updatedAt = ? WHERE id = ?").run(now, now, id);
}

export function countOpenIssues(db: Database.Database, projectId: string): number {
  return (db.prepare("SELECT COUNT(*) c FROM issues WHERE projectId = ? AND status = 'open'").get(projectId) as any).c;
}
