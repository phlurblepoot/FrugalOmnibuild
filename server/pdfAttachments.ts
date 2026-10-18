// server/pdfAttachments.ts
// PDF attachments: stored PDFs appended to the end of a record's generated
// PDF, after its photos, in sortOrder. Invoices had them first (migration 34);
// change orders, RFIs, issues and daily reports got identical tables in
// migration 42 (spec docs/superpowers/specs/2026-10-06-pdf-attachments-design.md).
// Every table is (id, <owner>, fileId, sortOrder, createdAt) with
// UNIQUE(<owner>, fileId), so one implementation serves all five. The owning
// store says which table, which error classes its routes map, and how a change
// marks the record's generated PDF out of date.
import type Database from 'better-sqlite3';
import crypto from 'crypto';

type ErrorClass = new (message: string) => Error;

export interface PdfAttachmentTable {
  /** The join table, e.g. 'invoice_attachments'. A constant — never input. */
  table: string;
  /** Its owner column, e.g. 'invoiceId'. */
  ownerColumn: string;
  /** The owner's own table, e.g. 'invoices'. */
  ownerTable: string;
  /** 'Invoice not found' — thrown when attaching to a record that isn't there. */
  notFoundMessage: string;
  /** In a sentence: "Attachment not on this invoice". */
  noun: string;
  NotFoundError: ErrorClass;
  ValidationError: ErrorClass;
  /** Runs inside the change's transaction. Moves the owner's updatedAt (the
   *  clock DocumentActionsBar's "up to date" chip compares the stored PDF
   *  against) — and its version too where the owner's photos do. */
  touch: (db: Database.Database, ownerId: string) => void;
}

export interface PdfAttachmentRow {
  id: string; fileId: string; sortOrder: number;
  name: string | null; mime: string | null; size: number | null;
}

// name/mime/size come from the file's own row, so a file deleted since reads
// as nulls rather than dropping the attachment out of the list.
export function listPdfAttachments(db: Database.Database, t: PdfAttachmentTable, ownerId: string): PdfAttachmentRow[] {
  return db.prepare(`SELECT a.id, a.fileId, a.sortOrder, f.name, f.mime, f.size
    FROM ${t.table} a LEFT JOIN files f ON f.id = a.fileId WHERE a.${t.ownerColumn} = ? ORDER BY a.sortOrder, a.createdAt`).all(ownerId) as PdfAttachmentRow[];
}

// Only an existing PDF can be attached. Attaching one the record already has
// is a no-op — no second row, and the generated PDF stays current.
export function addPdfAttachment(db: Database.Database, t: PdfAttachmentTable, ownerId: string, fileId: unknown): void {
  if (!db.prepare(`SELECT id FROM ${t.ownerTable} WHERE id = ?`).get(ownerId)) throw new t.NotFoundError(t.notFoundMessage);
  if (typeof fileId !== 'string' || !fileId) throw new t.ValidationError('fileId is required');
  const f = db.prepare('SELECT mime FROM files WHERE id = ?').get(fileId) as { mime: string } | undefined;
  if (!f) throw new t.NotFoundError('File not found');
  if (f.mime !== 'application/pdf') throw new t.ValidationError('Only PDF files can be attached');
  if (db.prepare(`SELECT 1 FROM ${t.table} WHERE ${t.ownerColumn} = ? AND fileId = ?`).get(ownerId, fileId)) return;
  const max = (db.prepare(`SELECT COALESCE(MAX(sortOrder), -1) m FROM ${t.table} WHERE ${t.ownerColumn} = ?`).get(ownerId) as { m: number }).m;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO ${t.table} (id, ${t.ownerColumn}, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), ownerId, fileId, max + 1, Date.now());
    t.touch(db, ownerId);
  });
  tx();
}

// Reorder: the client swaps two neighbours' sortOrders with two of these.
export function updatePdfAttachment(db: Database.Database, t: PdfAttachmentTable, ownerId: string, fileId: string, patch: { sortOrder?: unknown }): void {
  if (!Number.isInteger(patch.sortOrder)) throw new t.ValidationError('sortOrder must be an integer');
  const tx = db.transaction(() => {
    const r = db.prepare(`UPDATE ${t.table} SET sortOrder = ? WHERE ${t.ownerColumn} = ? AND fileId = ?`).run(patch.sortOrder, ownerId, fileId);
    if (r.changes === 0) throw new t.NotFoundError(`Attachment not on this ${t.noun}`);
    t.touch(db, ownerId);
  });
  tx();
}

export function removePdfAttachment(db: Database.Database, t: PdfAttachmentTable, ownerId: string, fileId: string): void {
  const tx = db.transaction(() => {
    const r = db.prepare(`DELETE FROM ${t.table} WHERE ${t.ownerColumn} = ? AND fileId = ?`).run(ownerId, fileId);
    if (r.changes > 0) t.touch(db, ownerId);
  });
  tx();
}
