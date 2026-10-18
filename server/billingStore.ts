// server/billingStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { listPayAppRows, computeG702, assertSovEditable } from './aiaStore';
import {
  type PdfAttachmentTable, listPdfAttachments, addPdfAttachment, updatePdfAttachment, removePdfAttachment,
} from './pdfAttachments';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const INVOICE_STATUSES = ['draft', 'sent', 'paid'] as const;
// Phase 9 lifecycle: draft → sent → approved/rejected (only `approved` counts
// toward the contract total). Legacy rows may carry status='pending' — READS of
// such rows are tolerated everywhere; only new transitions (setChangeOrderStatus)
// validate the input status against this set.
export const CHANGE_ORDER_STATUSES = ['draft', 'sent', 'approved', 'rejected'] as const;

// All money math is integer cents. Dollars are rounded to the nearest cent
// (half-up) BEFORE summing, so float artefacts (0.1+0.2) never accumulate.
export function toCents(dollars: number): number {
  return Math.round((Number(dollars) || 0) * 100);
}
export function sumCents(lines: { qty?: number; unitPrice?: number }[]): number {
  return lines.reduce((acc, l) => acc + toCents((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)), 0);
}

function requireProject(db: Database.Database, projectId: string): void {
  const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!row) throw new NotFoundError('Project not found');
}

interface LineInput { description?: string; qty?: number; unitPrice?: number; }
interface InvoiceInput {
  number?: string; date?: number | null; terms?: string; status?: string; lines?: LineInput[];
  /** Internal-only — never printed on the invoice PDF or included in invoice
   *  emails (the owner's ruling). See saveInvoice's freshness handling below. */
  notes?: string | null;
}

// notes is free text; blank/whitespace-only is stored as NULL, same
// normalization as change_orders.title (normalizeTitle) so display/editor code
// can treat "no notes" one way regardless of how it got there.
function normalizeNotes(notes: unknown): string | null {
  if (typeof notes !== 'string') return null;
  const trimmed = notes.trim();
  return trimmed === '' ? null : trimmed;
}

// Content-equality for the line-item set, ignoring row identity (ids are
// re-minted on every save by writeLines). Used by saveInvoice to tell whether
// a save actually changed anything the generated PDF would show.
function lineContentKey(lines: { description?: string; qty?: number | string; unitPrice?: number | string }[]): string {
  return JSON.stringify(lines.map(l => ({
    description: l.description ?? '',
    qty: Number(l.qty) || 0,
    unitPrice: Number(l.unitPrice) || 0,
  })));
}

function validateLines(lines: any): LineInput[] {
  if (lines === undefined) return [];
  if (!Array.isArray(lines)) throw new ValidationError('lines must be an array');
  for (const l of lines) {
    if (!l || typeof l !== 'object') throw new ValidationError('each line must be an object');
    if (l.qty !== undefined && (!Number.isFinite(l.qty) || l.qty < 0)) throw new ValidationError('line qty must be a non-negative number');
    if (l.unitPrice !== undefined && (!Number.isFinite(l.unitPrice) || l.unitPrice < 0)) throw new ValidationError('line unitPrice must be a non-negative number');
  }
  return lines;
}

export const PAYMENT_TARGET_TYPES = ['invoice', 'payapp'] as const;
export type PaymentTargetType = (typeof PAYMENT_TARGET_TYPES)[number];

export function paidCentsFor(db: Database.Database, targetType: PaymentTargetType, targetId: string): number {
  const rows = db.prepare('SELECT amount FROM payments WHERE targetType = ? AND targetId = ?').all(targetType, targetId) as { amount: number }[];
  return rows.reduce((acc, p) => acc + toCents(p.amount), 0);
}

function lineTotalsCents(db: Database.Database, invoiceId: string): number {
  const lines = db.prepare('SELECT qty, unitPrice FROM invoice_lines WHERE invoiceId = ?').all(invoiceId) as any[];
  return sumCents(lines);
}

// An invoice's status follows its payments (spec
// docs/superpowers/specs/2026-10-06-reports-design.md): once they cover a
// total over $0 a draft or sent invoice is 'paid', and a 'paid' invoice whose
// balance opens up again (a payment deleted or reduced, its lines grown) goes
// back to 'sent'. Any other status — a manual pick the numbers don't
// contradict — is kept. A fully-paid draft turns 'paid' too: the customer has
// paid it, and as a draft it would stay out of every billed figure.
export function autoInvoiceStatus(status: string, totalCents: number, paidCents: number): string {
  if ((status === 'draft' || status === 'sent') && totalCents > 0 && paidCents >= totalCents) return 'paid';
  if (status === 'paid' && totalCents - paidCents > 0) return 'sent';
  return status;
}

/** An invoice whose status a payment change moved (see syncInvoicePaidStatus). */
export interface InvoiceStatusChange { invoiceId: string; status: string }

// Applies autoInvoiceStatus to a stored invoice. Runs inside the caller's
// transaction, after the payment change that may have moved the balance.
// Returns the change when the status moved, else null (also for an unknown
// invoice).
//
// version and updatedAt are deliberately left alone. A payment never bumps
// the invoice's version, so neither does the status it implies: bumping it
// would fail the next save of an invoice editor someone has open elsewhere
// with a conflict over a change they can't see. saveInvoice resolves the
// status it writes through the same rule, so the status that editor echoes
// back can't overwrite this one. The PDF never prints the status (its PAID
// stamp comes from the amounts), and the payment change already stamped
// updatedAt where Paid/Balance moved.
export function syncInvoicePaidStatus(db: Database.Database, invoiceId: string): InvoiceStatusChange | null {
  const row = db.prepare('SELECT status FROM invoices WHERE id = ?').get(invoiceId) as { status: string } | undefined;
  if (!row) return null;
  const status = autoInvoiceStatus(row.status, lineTotalsCents(db, invoiceId), paidCentsFor(db, 'invoice', invoiceId));
  if (status === row.status) return null;
  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoiceId);
  return { invoiceId, status };
}

function writeLines(db: Database.Database, invoiceId: string, lines: LineInput[]): void {
  db.prepare('DELETE FROM invoice_lines WHERE invoiceId = ?').run(invoiceId);
  const ins = db.prepare('INSERT INTO invoice_lines (id, invoiceId, description, qty, unitPrice, sortOrder) VALUES (?, ?, ?, ?, ?, ?)');
  lines.forEach((l, i) => ins.run(crypto.randomUUID(), invoiceId, l.description ?? '', Number(l.qty) || 0, Number(l.unitPrice) || 0, i));
}

export function getInvoice(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as any;
  if (!row) return null;
  const lines = db.prepare('SELECT id, description, qty, unitPrice, sortOrder FROM invoice_lines WHERE invoiceId = ? ORDER BY sortOrder').all(id);
  const totalCents = lineTotalsCents(db, id);
  const paidCents = paidCentsFor(db, 'invoice', id);
  const payments = db.prepare("SELECT id, date, amount, method, note FROM payments WHERE targetType = 'invoice' AND targetId = ? ORDER BY date").all(id);
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM invoice_photos WHERE invoiceId = ? ORDER BY sortOrder, createdAt').all(id);
  const attachments = listPdfAttachments(db, INVOICE_ATTACHMENTS, id);
  return { ...row, lines, payments, photos, attachments, totalCents, paidCents, balanceCents: totalCents - paidCents };
}

export function listInvoices(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM invoices WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
  return rows.map(r => {
    const totalCents = lineTotalsCents(db, r.id);
    const paidCents = paidCentsFor(db, 'invoice', r.id);
    return { ...r, totalCents, paidCents, balanceCents: totalCents - paidCents };
  });
}

// Universal invoice numbering: unlike RFI/proposal numbers (per-project
// counters on the `projects` row), invoice numbers are assigned from ONE
// counter app-wide — the owner wants a new invoice to pick up the next number
// after the highest one used anywhere, not just on this project. The counter
// lives in the generic `settings` key/value table (base-schema, migration 1)
// under key 'invoiceNumber' — no new table/migration needed for it.
//
// Never reuse an issued number: the high-water counter survives deletes. The
// MAX-of-trailing-integer guard is a re-scan of every invoice at ASSIGNMENT
// TIME (not just a read of the stored counter), so a save that later sets an
// explicit number higher than the counter still can't cause a future
// collision — the next autofill sees it via this scan. Existing numbers are
// free text ("1001", "INV-1007", "003"); only the trailing run of digits is
// considered, and non-matching numbers are ignored.
function nextInvoiceNumber(db: Database.Database): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'invoiceNumber'`).get() as { value: string } | undefined;
  const counter = row ? (parseInt(row.value, 10) || 0) : 0;
  const rows = db.prepare(`SELECT number FROM invoices WHERE number IS NOT NULL AND number <> ''`).all() as { number: string }[];
  let max = 0;
  for (const r of rows) {
    const m = /(\d+)\s*$/.exec(r.number);
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  }
  // 1000 is a floor, not a real invoice — it makes the very first assigned
  // number a professional-looking "1001" instead of "1", comfortably above
  // any small legacy numbers already in the data.
  const next = Math.max(counter, max, 1000) + 1;
  db.prepare(`INSERT INTO settings (key, value) VALUES ('invoiceNumber', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
  return String(next);
}

export function createInvoice(db: Database.Database, projectId: string, input: InvoiceInput): { id: string; version: number } {
  requireProject(db, projectId);
  const lines = validateLines(input.lines);
  if (input.status !== undefined && !(INVOICE_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid invoice status: ${input.status}`);
  }
  const id = crypto.randomUUID();
  const explicitNumber = typeof input.number === 'string' ? input.number.trim() : (input.number ?? null);
  const tx = db.transaction(() => {
    const now = Date.now();
    const number = explicitNumber || nextInvoiceNumber(db);
    db.prepare('INSERT INTO invoices (id, projectId, number, date, status, terms, notes, version, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, projectId, number, input.date ?? null, input.status ?? 'draft', input.terms ?? null, normalizeNotes(input.notes), now, now);
    writeLines(db, id, lines);
  });
  tx();
  return { id, version: 1 };
}

export function saveInvoice(db: Database.Database, id: string, input: InvoiceInput & { version?: number }): { version: number } {
  const lines = validateLines(input.lines);
  if (!Number.isInteger(input.version) || (input.version as number) < 1) {
    throw new ValidationError('Missing or invalid version — reload the invoice');
  }
  if (input.status !== undefined && !(INVOICE_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid invoice status: ${input.status}`);
  }
  const notes = normalizeNotes(input.notes);
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version, number, date, status, terms FROM invoices WHERE id = ?').get(id) as
      { version: number; number: string | null; date: number | null; status: string; terms: string | null } | undefined;
    if (!row) throw new NotFoundError('Invoice not found');
    if (row.version !== input.version) throw new ConflictError(`Invoice changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;

    // The status written follows the payments, as after a payment change
    // (syncInvoicePaidStatus): new lines can settle the invoice or open its
    // balance again. It also keeps a stale status out — the editor echoes the
    // status it loaded, and a payment recorded since may have moved it without
    // bumping the version this save was checked against.
    const status = autoInvoiceStatus(input.status ?? 'draft', sumCents(lines), paidCentsFor(db, 'invoice', id));

    // notes is internal-only — never printed on the invoice PDF or included in
    // invoice emails (the owner's ruling) — so a save that only touches notes must
    // not flip the generated-PDF "up to date" freshness chip the way an edit to
    // number/date/status/terms/lines would (same reasoning as the RFI
    // pendingReply exemption, commit 5907997). Everything else in this UPDATE
    // shares one call, so detect "nothing PDF-relevant changed" by comparing
    // against the row (and its lines) as loaded.
    const oldLines = db.prepare('SELECT description, qty, unitPrice FROM invoice_lines WHERE invoiceId = ? ORDER BY sortOrder').all(id) as any[];
    const contentChanged =
      (input.number ?? null) !== row.number ||
      (input.date ?? null) !== row.date ||
      status !== row.status ||
      (input.terms ?? null) !== row.terms ||
      lineContentKey(lines) !== lineContentKey(oldLines);

    if (contentChanged) {
      db.prepare('UPDATE invoices SET number = ?, date = ?, status = ?, terms = ?, notes = ?, version = ?, updatedAt = ? WHERE id = ?')
        .run(input.number ?? null, input.date ?? null, status, input.terms ?? null, notes, newVersion, Date.now(), id);
    } else {
      db.prepare('UPDATE invoices SET number = ?, date = ?, status = ?, terms = ?, notes = ?, version = ? WHERE id = ?')
        .run(input.number ?? null, input.date ?? null, status, input.terms ?? null, notes, newVersion, id);
    }
    writeLines(db, id, lines);
  });
  tx();
  return { version: newVersion };
}

// Photos + PDF attachments (mirrors change_order_photos / proposal_attachments).
// Each mutation bumps the invoice's version + updatedAt — the freshness
// contract: adding/removing/reordering either one changes what the generated
// invoice PDF would contain (photos are appended as pages, attachments after
// them), so DocumentActionsBar's "up to date" chip must go stale.
function touchInvoice(db: Database.Database, invoiceId: string, now: number): void {
  db.prepare('UPDATE invoices SET version = version + 1, updatedAt = ? WHERE id = ?').run(now, invoiceId);
}

const INVOICE_ATTACHMENTS: PdfAttachmentTable = {
  table: 'invoice_attachments', ownerColumn: 'invoiceId', ownerTable: 'invoices',
  notFoundMessage: 'Invoice not found', noun: 'invoice',
  NotFoundError, ValidationError,
  touch: (db, invoiceId) => touchInvoice(db, invoiceId, Date.now()),
};

export function addInvoicePhoto(db: Database.Database, invoiceId: string, fileId: string): void {
  const row = db.prepare('SELECT id FROM invoices WHERE id = ?').get(invoiceId) as { id: string } | undefined;
  if (!row) throw new NotFoundError('Invoice not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const exists = db.prepare('SELECT id FROM invoice_photos WHERE invoiceId = ? AND fileId = ?').get(invoiceId, fileId);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM invoice_photos WHERE invoiceId = ?').get(invoiceId) as any).m;
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO invoice_photos (id, invoiceId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), invoiceId, fileId, max + 1, Date.now());
    touchInvoice(db, invoiceId, Date.now());
  });
  tx();
}

export function removeInvoicePhoto(db: Database.Database, invoiceId: string, fileId: string): void {
  const tx = db.transaction(() => {
    const r = db.prepare('DELETE FROM invoice_photos WHERE invoiceId = ? AND fileId = ?').run(invoiceId, fileId);
    if (r.changes > 0) touchInvoice(db, invoiceId, Date.now());
  });
  tx();
}

export function addInvoiceAttachment(db: Database.Database, invoiceId: string, fileId: string): void {
  addPdfAttachment(db, INVOICE_ATTACHMENTS, invoiceId, fileId);
}

export function updateInvoiceAttachment(db: Database.Database, invoiceId: string, fileId: string, patch: { sortOrder: number }): void {
  updatePdfAttachment(db, INVOICE_ATTACHMENTS, invoiceId, fileId, patch);
}

export function removeInvoiceAttachment(db: Database.Database, invoiceId: string, fileId: string): void {
  removePdfAttachment(db, INVOICE_ATTACHMENTS, invoiceId, fileId);
}

export function deleteInvoice(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    // Its payments go with it, and their attachment rows before them.
    db.prepare("DELETE FROM payment_attachments WHERE paymentId IN (SELECT id FROM payments WHERE targetType = 'invoice' AND targetId = ?)").run(id);
    db.prepare("DELETE FROM payments WHERE targetType = 'invoice' AND targetId = ?").run(id);
    db.prepare('DELETE FROM invoice_lines WHERE invoiceId = ?').run(id);
    db.prepare('DELETE FROM invoice_photos WHERE invoiceId = ?').run(id);
    db.prepare('DELETE FROM invoice_attachments WHERE invoiceId = ?').run(id);
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
  });
  tx();
}

interface PaymentInput { date?: number | null; amount?: number; method?: string | null; note?: string | null; }

// A payment targets an invoice OR an AIA pay application (polymorphic, migration 13).
// invoiceStatusChange: the paid invoice's new status when this payment
// settled it (syncInvoicePaidStatus), else null — routes broadcast it.
export function recordPayment(db: Database.Database, targetType: string, targetId: string, input: PaymentInput): {
  id: string; invoiceStatusChange: InvoiceStatusChange | null;
} {
  if (!(PAYMENT_TARGET_TYPES as readonly string[]).includes(targetType)) {
    throw new ValidationError(`Invalid payment target type: ${targetType}`);
  }
  const table = targetType === 'invoice' ? 'invoices' : 'aia_pay_apps';
  const target = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(targetId);
  if (!target) throw new NotFoundError(targetType === 'invoice' ? 'Invoice not found' : 'Pay application not found');
  if (!Number.isFinite(input.amount) || (input.amount as number) <= 0) throw new ValidationError('Payment amount must be a positive number');
  const id = crypto.randomUUID();
  const now = Date.now();
  let invoiceStatusChange: InvoiceStatusChange | null = null;
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO payments (id, targetType, targetId, date, amount, method, note, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, targetType, targetId, input.date ?? now, input.amount, input.method ?? null, input.note ?? null, now);
    touchPaymentTarget(db, targetType, targetId, now);
    if (targetType === 'invoice') invoiceStatusChange = syncInvoicePaidStatus(db, targetId);
  });
  tx();
  return { id, invoiceStatusChange };
}

// The invoice PDF and the pay-app G702 both print Paid-to-date and Balance, so
// a payment changes what a generated document should say even though nothing on
// the invoice/pay-app row itself moved. Without this stamp the up-to-date chip
// stays green and Send reuses a stored file whose totals are already wrong
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
function touchPaymentTarget(db: Database.Database, targetType: string, targetId: string, now: number): void {
  // targetType is validated against PAYMENT_TARGET_TYPES before it ever reaches
  // here (and on the way into the row we read back), so the table name is ours.
  const table = targetType === 'invoice' ? 'invoices' : 'aia_pay_apps';
  db.prepare(`UPDATE ${table} SET updatedAt = ? WHERE id = ?`).run(now, targetId);
}

// Returns the paid invoice's status change when deleting the payment reopened
// its balance (a 'paid' invoice back to 'sent'), else null.
export function deletePayment(db: Database.Database, id: string): InvoiceStatusChange | null {
  let invoiceStatusChange: InvoiceStatusChange | null = null;
  const tx = db.transaction(() => {
    // Read the target before the row goes away — the deletion changes the same
    // Paid/Balance figures the insert does.
    const row = db.prepare('SELECT targetType, targetId FROM payments WHERE id = ?').get(id) as
      { targetType: string; targetId: string } | undefined;
    db.prepare('DELETE FROM payment_attachments WHERE paymentId = ?').run(id);
    db.prepare('DELETE FROM payments WHERE id = ?').run(id);
    if (row) touchPaymentTarget(db, row.targetType, row.targetId, Date.now());
    if (row?.targetType === 'invoice') invoiceStatusChange = syncInvoicePaidStatus(db, row.targetId);
  });
  tx();
  return invoiceStatusChange;
}

// Edits a recorded payment's date, amount, method and note; what it paid
// (targetType/targetId) never moves — paying a different record is a delete
// and a new payment. Validated like recordPayment. An omitted (or null) date
// keeps the one it has: a recorded payment always has one (recordPayment
// defaults it to now). Blank method/note are stored as NULL.
//
// Paid/Balance on the target's generated PDF come from the amounts alone, so
// only an amount change stamps the target out of date the way a record or a
// delete does. A date, method or note fix leaves its PDF current (the same
// reasoning as saveInvoice's notes-only exemption).
//
// An amount change can settle the paid invoice or reopen its balance; the
// status change that follows (syncInvoicePaidStatus) is returned, else null.
export function updatePayment(db: Database.Database, id: string, input: PaymentInput): InvoiceStatusChange | null {
  let invoiceStatusChange: InvoiceStatusChange | null = null;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT targetType, targetId, date, amount, method, note FROM payments WHERE id = ?').get(id) as
      { targetType: string; targetId: string; date: number | null; amount: number; method: string | null; note: string | null } | undefined;
    if (!row) throw new NotFoundError('Payment not found');
    const amount = input.amount === undefined ? row.amount : input.amount;
    if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('Payment amount must be a positive number');
    if (input.date != null && !Number.isFinite(input.date)) throw new ValidationError('Payment date must be a timestamp');
    const method = input.method === undefined ? row.method
      : (typeof input.method === 'string' && input.method.trim() ? input.method.trim() : null);
    const note = input.note === undefined ? row.note : normalizeNotes(input.note);
    db.prepare('UPDATE payments SET date = ?, amount = ?, method = ?, note = ? WHERE id = ?')
      .run(input.date ?? row.date, amount, method, note, id);
    if (toCents(amount) !== toCents(row.amount)) {
      touchPaymentTarget(db, row.targetType, row.targetId, Date.now());
      if (row.targetType === 'invoice') invoiceStatusChange = syncInvoicePaidStatus(db, row.targetId);
    }
  });
  tx();
  return invoiceStatusChange;
}

// What a payment paid, in words: 'Invoice 1001' / 'Application #3'. Expects
// the payment as `p`, its invoice as `i` and its pay application as `a`.
const PAYMENT_TARGET_LABEL_SQL = `CASE
    WHEN p.targetType = 'invoice' THEN
      CASE WHEN i.number IS NOT NULL AND i.number <> '' THEN 'Invoice ' || i.number ELSE 'Invoice' END
    WHEN p.targetType = 'payapp' THEN 'Application #' || a.number
    ELSE NULL
  END`;
const PAYMENT_TARGET_JOINS = `LEFT JOIN invoices i ON p.targetType = 'invoice' AND p.targetId = i.id
    LEFT JOIN aia_pay_apps a ON p.targetType = 'payapp' AND p.targetId = a.id`;

// All payments across a project's invoices AND pay applications, with a resolved
// human label per target. Money fields are passed through (amount REAL dollars).
// attachmentCount drives the paperclip on the Payments tab's rows.
export function listProjectPayments(db: Database.Database, projectId: string): any[] {
  return db.prepare(`
    SELECT p.id, p.targetType, p.targetId, p.date, p.amount, p.method, p.note, p.createdAt,
           ${PAYMENT_TARGET_LABEL_SQL} AS targetLabel,
           (SELECT COUNT(*) FROM payment_attachments pa WHERE pa.paymentId = p.id) AS attachmentCount
    FROM payments p
    ${PAYMENT_TARGET_JOINS}
    WHERE (p.targetType = 'invoice' AND p.targetId IN (SELECT id FROM invoices WHERE projectId = ?))
       OR (p.targetType = 'payapp' AND p.targetId IN (SELECT id FROM aia_pay_apps WHERE projectId = ?))
    ORDER BY p.date DESC, p.createdAt DESC, p.rowid DESC
  `).all(projectId, projectId) as any[];
}

// Payments carry no projectId of their own (migration 13); it is whichever
// record they paid's. Null for an unknown payment or one whose target is gone.
export function paymentProjectId(db: Database.Database, id: string): string | null {
  const row = db.prepare(`SELECT COALESCE(i.projectId, a.projectId) AS projectId FROM payments p ${PAYMENT_TARGET_JOINS} WHERE p.id = ?`)
    .get(id) as { projectId: string | null } | undefined;
  return row?.projectId ?? null;
}

// ── Payment attachments (migration 43) ───────────────────────────────────────
// Photos and PDFs on a payment: a check image, a receipt, remittance advice,
// an ACH confirmation. One table holds both; the file's mime tells them apart.
// They show on the payment ONLY — never in the invoice editor's payment list,
// on an invoice/pay app PDF or in a report — so attaching or removing one
// changes no generated document and stamps nothing on the payment's target.
const isPaymentAttachmentMime = (mime: unknown): boolean =>
  typeof mime === 'string' && (mime.startsWith('image/') || mime === 'application/pdf');

export interface PaymentAttachmentRow {
  id: string; fileId: string; sortOrder: number;
  // The file's own row (null for a file deleted since): enough to tell a photo
  // from a PDF, list it, and open it in the document viewer.
  name: string | null; mime: string | null; size: number | null;
  kind: string | null; createdAt: number | null; versionNumber: number | null;
}

function listPaymentAttachments(db: Database.Database, paymentId: string): PaymentAttachmentRow[] {
  return db.prepare(`SELECT pa.id, pa.fileId, pa.sortOrder, f.name, f.mime, f.size, f.kind, f.createdAt, f.versionNumber
    FROM payment_attachments pa LEFT JOIN files f ON f.id = pa.fileId
    WHERE pa.paymentId = ? ORDER BY pa.sortOrder, pa.createdAt`).all(paymentId) as PaymentAttachmentRow[];
}

// One payment for its detail view: the row, what it paid (targetLabel), the
// project it belongs to, and its attachments.
export function getPayment(db: Database.Database, id: string): any | null {
  const row = db.prepare(`
    SELECT p.id, p.targetType, p.targetId, p.date, p.amount, p.method, p.note, p.createdAt,
           ${PAYMENT_TARGET_LABEL_SQL} AS targetLabel,
           COALESCE(i.projectId, a.projectId) AS projectId
    FROM payments p
    ${PAYMENT_TARGET_JOINS}
    WHERE p.id = ?
  `).get(id) as any;
  if (!row) return null;
  return { ...row, attachments: listPaymentAttachments(db, id) };
}

function requirePayment(db: Database.Database, paymentId: string): void {
  if (!db.prepare('SELECT id FROM payments WHERE id = ?').get(paymentId)) throw new NotFoundError('Payment not found');
}

// Any stored photo or PDF can be attached — one uploaded from the payment, or
// one already in the app (it is linked, not copied or re-typed). Attaching a
// file the payment already has is a no-op.
export function addPaymentAttachment(db: Database.Database, paymentId: string, fileId: unknown): void {
  requirePayment(db, paymentId);
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const f = db.prepare('SELECT mime FROM files WHERE id = ?').get(fileId) as { mime: string } | undefined;
  if (!f) throw new NotFoundError('File not found');
  if (!isPaymentAttachmentMime(f.mime)) throw new ValidationError('Only photos and PDFs can be attached to a payment');
  if (db.prepare('SELECT 1 FROM payment_attachments WHERE paymentId = ? AND fileId = ?').get(paymentId, fileId)) return;
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM payment_attachments WHERE paymentId = ?').get(paymentId) as { m: number }).m;
  db.prepare('INSERT INTO payment_attachments (id, paymentId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), paymentId, fileId, max + 1, Date.now());
}

// Unlinks the file from the payment; the file itself stays in Documents, as a
// record's removed photo does. Removing one that isn't attached is a no-op.
export function removePaymentAttachment(db: Database.Database, paymentId: string, fileId: string): void {
  requirePayment(db, paymentId);
  db.prepare('DELETE FROM payment_attachments WHERE paymentId = ? AND fileId = ?').run(paymentId, fileId);
}

// Status-only change (draft→sent→paid or back). Version-checked like saveInvoice
// but leaves lines untouched. This is the manual pick, so it is not run through
// autoInvoiceStatus: a hand-set status stands until the next payment change or
// line edit applies the rule.
export function setInvoiceStatus(db: Database.Database, id: string, status: string): { version: number; status: string } {
  if (!(INVOICE_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid invoice status: ${status}`);
  let out = { version: 0, status };
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version, status FROM invoices WHERE id = ?').get(id) as { version: number; status: string } | undefined;
    if (!row) throw new NotFoundError('Invoice not found');
    // Re-sending an invoice that is already 'sent' asks for the status it
    // already has. Writing it anyway would bump updatedAt, which is exactly the
    // "is the stored PDF still current?" clock — the chip would flip to
    // out-of-date the instant the send succeeded and could never go back.
    if (row.status === status) {
      out = { version: row.version, status };
      return;
    }
    const newVersion = row.version + 1;
    db.prepare('UPDATE invoices SET status = ?, version = ?, updatedAt = ? WHERE id = ?').run(status, newVersion, Date.now(), id);
    out = { version: newVersion, status };
  });
  tx();
  return out;
}

// Change Orders mirror the invoice stack (Phase 9): line items + photos + a
// versioned editable record + a lump-sum amount. The canonical persisted total
// stays in change_orders.amount (REAL dollars) = (Σ line cents + lump-sum cents)/100,
// written server-side on save, so billingSummary's contract-total sum and
// aiaStore.syncChangeOrders (both read `amount`) keep working UNCHANGED with zero
// cents drift (round(amount*100) === totalCents — exact for integer cents).
interface ChangeOrderInput {
  number?: string;
  date?: number | null;
  title?: string | null;
  description?: string;
  lumpSumAmount?: number;
  scheduleImpactDays?: number | null;
  // back-compat: legacy `amount` is ignored (amount is recomputed from lines+lump)
  amount?: number;
  status?: string;
  lines?: LineInput[];
}

// title is free-text; blank/whitespace-only is stored as NULL so display and
// syncChangeOrders' fallback-to-description both see "no title" the same way.
// A non-string value (a raw JSON body can send anything) is treated the same
// as absent rather than thrown — title is optional/display-only, like
// `description`, not a field with money-math correctness implications
// (compare `lumpSumAmount`, which does throw ValidationError on bad input).
function normalizeTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  return trimmed === '' ? null : trimmed;
}

// A change_orders row as it is read for display and editing, plus its
// totalCents (Σ line cents + lump-sum cents). A change order made before
// migration 14 keeps its value only in `amount`: it has no line rows and the
// $0 lumpSumAmount that migration's new column defaulted to. Summed as stored
// it reads as $0, and the editor (which fills its Lump sum field from
// lumpSumAmount) would save it back as $0 — dropping it from the contract
// total. So such a row is read as a lump sum of its amount: it shows its real
// value, and saving it unchanged writes the same amount back. Migration 47
// moved the existing rows' value into lumpSumAmount; this keeps any row still
// in that shape from ever reading as $0. Every other change order (lines, a
// lump sum, or $0 throughout) reads exactly as stored.
function readChangeOrderRow(db: Database.Database, row: any): any {
  const lines = db.prepare('SELECT qty, unitPrice FROM change_order_lines WHERE changeOrderId = ?').all(row.id) as any[];
  const amountOnly = lines.length === 0 && toCents(row.lumpSumAmount) === 0 && toCents(row.amount) !== 0;
  const lumpSumAmount = amountOnly ? row.amount : row.lumpSumAmount;
  return { ...row, lumpSumAmount, totalCents: sumCents(lines) + toCents(lumpSumAmount) };
}

function writeChangeOrderLines(db: Database.Database, changeOrderId: string, lines: LineInput[]): void {
  db.prepare('DELETE FROM change_order_lines WHERE changeOrderId = ?').run(changeOrderId);
  const ins = db.prepare('INSERT INTO change_order_lines (id, changeOrderId, description, qty, unitPrice, sortOrder) VALUES (?, ?, ?, ?, ?, ?)');
  lines.forEach((l, i) => ins.run(crypto.randomUUID(), changeOrderId, l.description ?? '', Number(l.qty) || 0, Number(l.unitPrice) || 0, i));
}

export function getChangeOrder(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM change_orders WHERE id = ?').get(id) as any;
  if (!row) return null;
  const co = readChangeOrderRow(db, row);
  const lines = db.prepare('SELECT id, description, qty, unitPrice, sortOrder FROM change_order_lines WHERE changeOrderId = ? ORDER BY sortOrder').all(id);
  const photos = db.prepare('SELECT id, fileId, sortOrder FROM change_order_photos WHERE changeOrderId = ? ORDER BY sortOrder, createdAt').all(id);
  const attachments = listPdfAttachments(db, CHANGE_ORDER_ATTACHMENTS, id);
  return { ...co, lines, photos, attachments, lumpSumCents: toCents(co.lumpSumAmount) };
}

export function listChangeOrders(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM change_orders WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC').all(projectId) as any[];
  return rows.map(r => readChangeOrderRow(db, r));
}

// Next per-project CO number: parse integers out of existing numbers, take the
// max + 1, zero-padded to 3 (e.g. '001'). Honors an explicit input.number.
function nextChangeOrderNumber(db: Database.Database, projectId: string): string {
  const rows = db.prepare('SELECT number FROM change_orders WHERE projectId = ?').all(projectId) as { number: string | null }[];
  let max = 0;
  for (const r of rows) {
    const m = String(r.number ?? '').match(/\d+/);
    if (m) max = Math.max(max, parseInt(m[0], 10));
  }
  return String(max + 1).padStart(3, '0');
}

export function createChangeOrder(db: Database.Database, projectId: string, input: ChangeOrderInput): { id: string; version: number } {
  requireProject(db, projectId);
  const lines = validateLines(input.lines);
  if (input.lumpSumAmount !== undefined && !Number.isFinite(input.lumpSumAmount)) throw new ValidationError('lumpSumAmount must be a finite number');
  if (input.status !== undefined && !(CHANGE_ORDER_STATUSES as readonly string[]).includes(input.status)) {
    throw new ValidationError(`Invalid change order status: ${input.status}`);
  }
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    const number = input.number ?? nextChangeOrderNumber(db, projectId);
    const lumpSumCents = toCents(input.lumpSumAmount);
    const amount = (sumCents(lines) + lumpSumCents) / 100;
    const now = Date.now();
    db.prepare('INSERT INTO change_orders (id, projectId, number, title, description, amount, status, version, lumpSumAmount, scheduleImpactDays, date, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
      .run(id, projectId, number, normalizeTitle(input.title), input.description ?? null, amount, input.status ?? 'draft', Number(input.lumpSumAmount) || 0, input.scheduleImpactDays ?? null, input.date ?? null, now, now);
    writeChangeOrderLines(db, id, lines);
  });
  tx();
  return { id, version: 1 };
}

// Version-checked editable save (like saveInvoice). Replaces lines, recomputes
// and stores `amount` = (Σ line cents + lump-sum cents)/100, bumps version.
// Does NOT change status (that's a separate PATCH via setChangeOrderStatus).
export function saveChangeOrder(db: Database.Database, id: string, input: ChangeOrderInput & { version?: number }): { version: number } {
  const lines = validateLines(input.lines);
  if (!Number.isInteger(input.version) || (input.version as number) < 1) {
    throw new ValidationError('Missing or invalid version — reload the change order');
  }
  if (input.lumpSumAmount !== undefined && !Number.isFinite(input.lumpSumAmount)) throw new ValidationError('lumpSumAmount must be a finite number');
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM change_orders WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Change order not found');
    if (row.version !== input.version) throw new ConflictError(`Change order changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    const lumpSumCents = toCents(input.lumpSumAmount);
    const amount = (sumCents(lines) + lumpSumCents) / 100;
    db.prepare('UPDATE change_orders SET number = ?, date = ?, title = ?, description = ?, lumpSumAmount = ?, scheduleImpactDays = ?, amount = ?, version = ?, updatedAt = ? WHERE id = ?')
      .run(input.number ?? null, input.date ?? null, normalizeTitle(input.title), input.description ?? null, Number(input.lumpSumAmount) || 0, input.scheduleImpactDays ?? null, amount, newVersion, Date.now(), id);
    writeChangeOrderLines(db, id, lines);
  });
  tx();
  return { version: newVersion };
}

export function setChangeOrderStatus(db: Database.Database, id: string, status: string): { status: string; version: number } {
  if (!(CHANGE_ORDER_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid change order status: ${status}`);
  const row = db.prepare('SELECT version, status FROM change_orders WHERE id = ?').get(id) as { version: number; status: string } | undefined;
  if (!row) throw new NotFoundError('Change order not found');
  // Same no-op guard as setInvoiceStatus: a re-send of an already-sent CO must
  // not touch updatedAt, or the generated-PDF chip goes stale on every send.
  if (row.status === status) return { status, version: row.version ?? 1 };
  const newVersion = (row.version ?? 1) + 1;
  db.prepare('UPDATE change_orders SET status = ?, version = ?, updatedAt = ? WHERE id = ?').run(status, newVersion, Date.now(), id);
  return { status, version: newVersion };
}

export function addChangeOrderPhoto(db: Database.Database, changeOrderId: string, fileId: string): void {
  const row = db.prepare('SELECT version FROM change_orders WHERE id = ?').get(changeOrderId) as { version: number } | undefined;
  if (!row) throw new NotFoundError('Change order not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  const exists = db.prepare('SELECT id FROM change_order_photos WHERE changeOrderId = ? AND fileId = ?').get(changeOrderId, fileId);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM change_order_photos WHERE changeOrderId = ?').get(changeOrderId) as any).m;
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO change_order_photos (id, changeOrderId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), changeOrderId, fileId, max + 1, Date.now());
    db.prepare('UPDATE change_orders SET version = version + 1, updatedAt = ? WHERE id = ?').run(Date.now(), changeOrderId);
  });
  tx();
}

export function removeChangeOrderPhoto(db: Database.Database, changeOrderId: string, fileId: string): void {
  const tx = db.transaction(() => {
    const r = db.prepare('DELETE FROM change_order_photos WHERE changeOrderId = ? AND fileId = ?').run(changeOrderId, fileId);
    if (r.changes > 0) db.prepare('UPDATE change_orders SET version = version + 1, updatedAt = ? WHERE id = ?').run(Date.now(), changeOrderId);
  });
  tx();
}

// PDF attachments, appended to the generated change order after its photos.
// Same freshness rule as the photos above (and the invoice's attachments):
// version + updatedAt move, so the stored PDF reads out of date.
const CHANGE_ORDER_ATTACHMENTS: PdfAttachmentTable = {
  table: 'change_order_attachments', ownerColumn: 'changeOrderId', ownerTable: 'change_orders',
  notFoundMessage: 'Change order not found', noun: 'change order',
  NotFoundError, ValidationError,
  touch: (db, changeOrderId) => {
    db.prepare('UPDATE change_orders SET version = version + 1, updatedAt = ? WHERE id = ?').run(Date.now(), changeOrderId);
  },
};

export function addChangeOrderAttachment(db: Database.Database, changeOrderId: string, fileId: string): void {
  addPdfAttachment(db, CHANGE_ORDER_ATTACHMENTS, changeOrderId, fileId);
}

export function updateChangeOrderAttachment(db: Database.Database, changeOrderId: string, fileId: string, patch: { sortOrder: number }): void {
  updatePdfAttachment(db, CHANGE_ORDER_ATTACHMENTS, changeOrderId, fileId, patch);
}

export function removeChangeOrderAttachment(db: Database.Database, changeOrderId: string, fileId: string): void {
  removePdfAttachment(db, CHANGE_ORDER_ATTACHMENTS, changeOrderId, fileId);
}

export function deleteChangeOrder(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    // A synced SOV line is a row a finalized pay app has already computed
    // from — deleting it out from under a locked SOV would change history.
    // A CO with no synced line (never synced, or synced only pre-lock and
    // since removed) is not load-bearing for any locked computation, so it
    // still deletes freely.
    const co = db.prepare('SELECT projectId FROM change_orders WHERE id = ?').get(id) as { projectId: string } | undefined;
    if (co) {
      const syncedLine = db.prepare('SELECT id FROM aia_sov_lines WHERE changeOrderId = ?').get(id);
      if (syncedLine) assertSovEditable(db, co.projectId);
    }
    db.prepare('DELETE FROM change_order_lines WHERE changeOrderId = ?').run(id);
    db.prepare('DELETE FROM change_order_photos WHERE changeOrderId = ?').run(id);
    db.prepare('DELETE FROM change_order_attachments WHERE changeOrderId = ?').run(id);
    // Remove the synced AIA SOV line for this CO so deleting a CO never leaves an
    // orphan schedule-of-values line (correctness fix over the prior behavior).
    db.prepare('DELETE FROM aia_sov_lines WHERE changeOrderId = ?').run(id);
    db.prepare('DELETE FROM change_orders WHERE id = ?').run(id);
  });
  tx();
}

// Contract rollup + invoice aggregates for a project (spec §4.1). All cents.
//
// CONTRACT TOTAL = baseContractCents + approvedChangeCents, where the base is
// the AIA Schedule of Values original lines (isChangeOrder=0) when an SOV
// exists, else the legacy projects.contractValue. Approved change orders are
// added ONCE via change_orders — the CO SOV lines (isChangeOrder=1) are NOT
// summed into the base, so there is no double-count.
export function billingSummary(db: Database.Database, projectId: string, billedDocs?: BilledDocument[]): {
  sovOriginalCents: number; hasSov: boolean;
  baseContractCents: number; approvedChangeCents: number;
  contractTotalCents: number; contractValueCents: number;
  invoiceTotalCents: number; invoicedCents: number;
  paid: { invoicesCents: number; payAppsCents: number };
  paidCents: number;
  invoiceOutstandingCents: number; outstandingCents: number;
  invoiceCount: number; changeOrderCount: number;
  payAppBilledCents: number; payAppOutstandingCents: number; payAppPaidCents: number;
  invoiceBilledCents: number; invoicePaidCents: number; invoiceOutstandingBilledCents: number;
} {
  const proj = db.prepare('SELECT contractValue FROM projects WHERE id = ?').get(projectId) as { contractValue: number | null } | undefined;

  // SOV original (non-CO) lines drive the base when an SOV exists.
  const sovOriginalCents = (db.prepare(
    "SELECT COALESCE(SUM(scheduledValueCents), 0) v FROM aia_sov_lines WHERE projectId = ? AND isChangeOrder = 0 AND lineType = 'item'"
  ).get(projectId) as { v: number }).v;
  const sovCount = (db.prepare('SELECT COUNT(*) c FROM aia_sov_lines WHERE projectId = ?').get(projectId) as { c: number }).c;
  const hasSov = sovCount > 0;
  const baseContractCents = hasSov ? sovOriginalCents : toCents(proj?.contractValue ?? 0);

  const approvedRows = db.prepare(`SELECT amount FROM change_orders WHERE projectId = ? AND status = 'approved'`).all(projectId) as { amount: number }[];
  const approvedChangeCents = approvedRows.reduce((a, r) => a + toCents(r.amount), 0);
  const contractTotalCents = baseContractCents + approvedChangeCents;

  const invoices = listInvoices(db, projectId);
  const invoiceTotalCents = invoices.reduce((a, i) => a + i.totalCents, 0);
  const changeOrderCount = (db.prepare('SELECT COUNT(*) c FROM change_orders WHERE projectId = ?').get(projectId) as any).c;

  // Paid splits: payments scoped to this project's invoices vs its pay-apps.
  // amount is REAL dollars, so each row is rounded to cents before summing.
  const invoicePayments = db.prepare(
    `SELECT amount FROM payments WHERE targetType = 'invoice' AND targetId IN (SELECT id FROM invoices WHERE projectId = ?)`
  ).all(projectId) as { amount: number }[];
  const payAppPayments = db.prepare(
    `SELECT amount FROM payments WHERE targetType = 'payapp' AND targetId IN (SELECT id FROM aia_pay_apps WHERE projectId = ?)`
  ).all(projectId) as { amount: number }[];
  const paid = {
    invoicesCents: invoicePayments.reduce((a, p) => a + toCents(p.amount), 0),
    payAppsCents: payAppPayments.reduce((a, p) => a + toCents(p.amount), 0),
  };

  const invoiceOutstandingCents = invoiceTotalCents - paid.invoicesCents;

  // Contract (pay-app) and invoice-leg billed/paid/outstanding — both derived
  // from the SAME listBilledDocuments() list (finalized pay apps' G702 L8 net
  // of retainage, and non-draft invoices), the same population the customer
  // ledger and project-list figures use. `billedDocs` lets hot callers that
  // already fetched this list once (customerOverview, listProjectSummaries)
  // pass it in instead of triggering a second DB pass — one source of truth,
  // one ledger read.
  //
  // These are net-of-drafts: a draft invoice/pay app is not yet billed, so it
  // is excluded here. The legacy invoiceTotalCents/invoiceOutstandingCents
  // fields above stay draft-inclusive (pre-existing behavior, unchanged) —
  // callers wanting the customer-ledger-consistent figures should use these
  // new fields instead.
  const docs = billedDocs ?? listBilledDocuments(db, projectId);
  const payAppDocs = docs.filter(d => d.kind === 'payapp');
  const payAppBilledCents = payAppDocs.reduce((a, d) => a + d.totalCents, 0);
  const payAppPaidCents = payAppDocs.reduce((a, d) => a + d.paidCents, 0);
  const payAppOutstandingCents = payAppDocs.reduce((a, d) => a + d.balanceCents, 0);

  const invoiceDocs = docs.filter(d => d.kind === 'invoice');
  const invoiceBilledCents = invoiceDocs.reduce((a, d) => a + d.totalCents, 0);
  const invoicePaidCents = invoiceDocs.reduce((a, d) => a + d.paidCents, 0);
  const invoiceOutstandingBilledCents = invoiceDocs.reduce((a, d) => a + d.balanceCents, 0);

  return {
    sovOriginalCents,
    hasSov,
    baseContractCents,
    approvedChangeCents,
    contractTotalCents,
    contractValueCents: contractTotalCents, // back-compat (SOV-derived total)
    invoiceTotalCents,
    invoicedCents: invoiceTotalCents, // back-compat
    paid,
    paidCents: paid.invoicesCents, // back-compat (payments against invoices)
    invoiceOutstandingCents,
    outstandingCents: invoiceOutstandingCents, // back-compat
    invoiceCount: invoices.length,
    changeOrderCount,
    payAppBilledCents,
    payAppOutstandingCents,
    payAppPaidCents,
    invoiceBilledCents,
    invoicePaidCents,
    invoiceOutstandingBilledCents,
  };
}

// ── Billed documents (customer + project-list money figures) ─────────────────
//
// billingSummary's invoice aggregates are INVOICE-ONLY, so a project billed
// through AIA progress billing reports nothing outstanding there. Every figure
// that spans a whole project or customer — the customers sidebar, the customer
// overview rollup and its per-project rows, the projects board — goes through
// the helpers below instead, so Invoiced, Paid and Outstanding are always
// computed over the same population: every BILLED document, invoice or pay
// application alike.
//
// "Billed" means not a draft. A draft invoice or draft pay app has not been
// sent to anyone, so it must not move any of the three figures.

export interface BilledDocument {
  kind: 'invoice' | 'payapp';
  id: string;
  number: string | number | null;
  // Invoices carry an epoch number; a pay app's applicationDate is a
  // 'YYYY-MM-DD' TEXT column. Both are passed through as stored.
  date: string | number | null;
  status: string;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}

export function listBilledDocuments(db: Database.Database, projectId: string): BilledDocument[] {
  const docs: BilledDocument[] = [];

  for (const inv of listInvoices(db, projectId)) {
    if (inv.status === 'draft') continue;
    docs.push({
      kind: 'invoice', id: inv.id, number: inv.number ?? null, date: inv.date ?? null,
      status: inv.status, totalCents: inv.totalCents, paidCents: inv.paidCents,
      balanceCents: inv.balanceCents,
    });
  }

  // A pay application's billed amount is its G702 line 8 (current payment due):
  // the amount that application actually asks for, which is what payments
  // recorded against it settle. 'finalized' is the pay-app analog of a sent
  // invoice; 'draft' apps are skipped by the same rule as draft invoices.
  for (const app of listPayAppRows(db, projectId)) {
    if (app.status === 'draft') continue;
    const totalCents = computeG702(db, app.id).L8currentPaymentDueCents;
    const paidCents = paidCentsFor(db, 'payapp', app.id);
    docs.push({
      kind: 'payapp', id: app.id, number: app.number, date: app.applicationDate ?? null,
      status: app.status, totalCents, paidCents, balanceCents: totalCents - paidCents,
    });
  }

  return docs;
}

export function projectBillingTotals(db: Database.Database, projectId: string): {
  invoicedCents: number; paidCents: number; outstandingCents: number;
} {
  let invoicedCents = 0;
  let paidCents = 0;
  for (const doc of listBilledDocuments(db, projectId)) {
    invoicedCents += doc.totalCents;
    paidCents += doc.paidCents;
  }
  return { invoicedCents, paidCents, outstandingCents: invoicedCents - paidCents };
}

export function projectOutstandingCents(db: Database.Database, projectId: string): number {
  return projectBillingTotals(db, projectId).outstandingCents;
}
