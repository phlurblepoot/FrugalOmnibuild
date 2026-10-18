// server/billingStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putBuffer } from './files';
import {
  toCents, sumCents, listInvoices, getInvoice, createInvoice, saveInvoice,
  deleteInvoice, ValidationError, ConflictError, NotFoundError,
  recordPayment, deletePayment, setInvoiceStatus, listProjectPayments, paidCentsFor,
  getPayment, updatePayment, paymentProjectId, addPaymentAttachment, removePaymentAttachment,
  addInvoicePhoto, removeInvoicePhoto, addInvoiceAttachment, updateInvoiceAttachment, removeInvoiceAttachment,
  listChangeOrders, getChangeOrder, createChangeOrder, saveChangeOrder, setChangeOrderStatus,
  deleteChangeOrder, addChangeOrderPhoto, removeChangeOrderPhoto, billingSummary,
  addChangeOrderAttachment, updateChangeOrderAttachment, removeChangeOrderAttachment,
  listBilledDocuments, autoInvoiceStatus, syncInvoicePaidStatus,
} from './billingStore';
import { createSovLine, listSovLines, createPayApp, savePayAppLines, setPayApp, lockSov, SovLockedError, deletePayApp } from './aiaStore';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-bill-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
});

const pdfFile = (id: string) => putBuffer(db, dir, id, Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'document', name: `${id}.pdf` });
const jpgFile = (id: string) => putBuffer(db, dir, id, Buffer.from('x'), 'image/jpeg', { projectId: 'p1', kind: 'invoice-photo', name: `${id}.jpg` });

describe('money helpers', () => {
  it('toCents rounds half-up to the nearest cent', () => {
    expect(toCents(10)).toBe(1000);
    expect(toCents(10.005)).toBe(1001); // 1000.5 → 1001
    expect(toCents(0.1 + 0.2)).toBe(30); // float 0.30000000000000004 → 30
  });
  it('sumCents adds line totals exactly with no float drift', () => {
    // 3 lines of 0.1 each → 0.30 exactly, not 0.30000000000000004
    expect(sumCents([{ qty: 1, unitPrice: 0.1 }, { qty: 1, unitPrice: 0.1 }, { qty: 1, unitPrice: 0.1 }])).toBe(30);
    expect(sumCents([{ qty: 2.5, unitPrice: 4 }])).toBe(1000); // 10.00
  });
});

describe('invoices', () => {
  it('createInvoice persists header + lines and computes totals in cents', () => {
    const r = createInvoice(db, 'p1', {
      number: 'INV-1', date: 100, terms: 'Net 30',
      lines: [{ description: 'A', qty: 2, unitPrice: 50 }, { description: 'B', qty: 1, unitPrice: 25.5 }],
    });
    expect(r.id).toBeTruthy();
    const inv = getInvoice(db, r.id)!;
    expect(inv.status).toBe('draft');
    expect(inv.version).toBe(1);
    expect(inv.lines).toHaveLength(2);
    expect(inv.totalCents).toBe(12550); // 100.00 + 25.50
    expect(inv.paidCents).toBe(0);
    expect(inv.balanceCents).toBe(12550);
  });

  it('saveInvoice is version-checked and replaces lines', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    const inv = getInvoice(db, id)!;
    const saved = saveInvoice(db, id, { ...inv, terms: 'Net 15', lines: [{ description: 'C', qty: 3, unitPrice: 5 }] });
    expect(saved.version).toBe(2);
    const reloaded = getInvoice(db, id)!;
    expect(reloaded.terms).toBe('Net 15');
    expect(reloaded.lines).toHaveLength(1);
    expect(reloaded.totalCents).toBe(1500);
  });

  it('saveInvoice rejects a stale version', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    const stale = getInvoice(db, id)!;
    saveInvoice(db, id, { ...stale }); // → v2
    expect(() => saveInvoice(db, id, { ...stale })).toThrow(ConflictError);
  });

  it('validates payloads', () => {
    expect(() => createInvoice(db, 'p1', { lines: 'nope' as any })).toThrow(ValidationError);
    expect(() => createInvoice(db, 'p1', { lines: [{ description: 'x', qty: -1, unitPrice: 1 }] })).toThrow(ValidationError);
    expect(() => createInvoice(db, 'nope', { lines: [] })).toThrow(NotFoundError);
  });

  it('rejects non-finite line amounts (Infinity from 1e400)', () => {
    expect(() => createInvoice(db, 'p1', { lines: [{ description: 'x', qty: 1e400, unitPrice: 1 }] })).toThrow(ValidationError);
    expect(() => createInvoice(db, 'p1', { lines: [{ description: 'x', qty: 1, unitPrice: Infinity }] })).toThrow(ValidationError);
  });

  it('listInvoices returns slim rows newest-first with totals', () => {
    createInvoice(db, 'p1', { number: 'INV-1', date: 1, lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    createInvoice(db, 'p1', { number: 'INV-2', date: 2, lines: [{ description: 'B', qty: 1, unitPrice: 20 }] });
    const list = listInvoices(db, 'p1');
    expect(list.map(i => i.number)).toEqual(['INV-2', 'INV-1']);
    expect(list[0].totalCents).toBe(2000);
    expect(list[0].lines).toBeUndefined(); // slim
  });

  it('deleteInvoice removes the invoice, its lines and payments', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    deleteInvoice(db, id);
    expect(getInvoice(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM invoice_lines').get() as any).c).toBe(0);
  });

  it('notes defaults to null and round-trips through create + save', () => {
    const created = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    expect(getInvoice(db, created.id)!.notes).toBeNull();

    const withNotes = createInvoice(db, 'p1', { number: 'INV-2', lines: [], notes: 'Called re: revised scope' });
    expect(getInvoice(db, withNotes.id)!.notes).toBe('Called re: revised scope');

    const inv = getInvoice(db, withNotes.id)!;
    const saved = saveInvoice(db, withNotes.id, { ...inv, notes: 'Updated after the walkthrough' });
    expect(saved.version).toBe(2);
    expect(getInvoice(db, withNotes.id)!.notes).toBe('Updated after the walkthrough');

    // Blank/whitespace-only notes normalize to null, same as change-order title.
    const cleared = saveInvoice(db, withNotes.id, { ...getInvoice(db, withNotes.id)!, notes: '   ' });
    expect(cleared.version).toBe(3);
    expect(getInvoice(db, withNotes.id)!.notes).toBeNull();
  });
});

describe('invoice numbering — universal autofill', () => {
  it('assigns "1001" to the very first invoice ever, when number is empty', () => {
    const { id } = createInvoice(db, 'p1', { number: '', lines: [] });
    expect(getInvoice(db, id)!.number).toBe('1001');
  });

  it('continues from the highest trailing integer already used anywhere, app-wide ("INV-1007" -> "1008")', () => {
    createInvoice(db, 'p1', { number: 'INV-1007', lines: [] });
    const { id } = createInvoice(db, 'p1', { lines: [] }); // number omitted entirely
    expect(getInvoice(db, id)!.number).toBe('1008');
  });

  it('keeps an explicitly provided number verbatim — no renumbering on save', () => {
    const { id } = createInvoice(db, 'p1', { number: '003', lines: [] });
    expect(getInvoice(db, id)!.number).toBe('003');
    const inv = getInvoice(db, id)!;
    const saved = saveInvoice(db, id, { ...inv, number: '003' });
    expect(saved.version).toBe(2);
    expect(getInvoice(db, id)!.number).toBe('003');
  });

  it('never reuses a number after the invoice holding it is deleted — the high-water counter survives', () => {
    const first = createInvoice(db, 'p1', { number: '', lines: [] });
    expect(getInvoice(db, first.id)!.number).toBe('1001');
    deleteInvoice(db, first.id);
    const second = createInvoice(db, 'p1', { number: '', lines: [] });
    expect(getInvoice(db, second.id)!.number).toBe('1002');
  });

  it('scans invoices at assignment time (not just the stored counter), so a later explicit number above it cannot collide', () => {
    const a = createInvoice(db, 'p1', { number: '', lines: [] }); // 1001
    const b = createInvoice(db, 'p1', { number: '', lines: [] }); // 1002
    expect(getInvoice(db, a.id)!.number).toBe('1001');
    // Explicitly jump one invoice's number far above the counter via a save.
    saveInvoice(db, b.id, { ...getInvoice(db, b.id)!, number: '5000' });
    const c = createInvoice(db, 'p1', { number: '', lines: [] });
    expect(getInvoice(db, c.id)!.number).toBe('5001');
  });
});

describe('invoice photos + attachments', () => {
  it('photos: idempotent add bumps version, remove bumps version', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    addInvoicePhoto(db, id, 'file-1');
    addInvoicePhoto(db, id, 'file-1'); // idempotent — no second row, no extra bump
    let inv = getInvoice(db, id)!;
    expect(inv.photos).toHaveLength(1);
    expect(inv.version).toBe(2); // 1 → +1 on the first add only
    addInvoicePhoto(db, id, 'file-2');
    inv = getInvoice(db, id)!;
    expect(inv.photos).toHaveLength(2);
    expect(inv.version).toBe(3);
    removeInvoicePhoto(db, id, 'file-1');
    inv = getInvoice(db, id)!;
    expect(inv.photos.map((p: any) => p.fileId)).toEqual(['file-2']);
    expect(inv.version).toBe(4);
  });

  it('photo add/remove bumps updatedAt (freshness contract)', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    const before = getInvoice(db, id)!.updatedAt;
    addInvoicePhoto(db, id, 'file-1');
    expect(getInvoice(db, id)!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('attachments must be PDFs and existing files; sortOrder assigns in add order', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    jpgFile('notpdf');
    expect(() => addInvoiceAttachment(db, id, 'notpdf')).toThrow(ValidationError);
    expect(() => addInvoiceAttachment(db, id, 'missing')).toThrow(NotFoundError);
    pdfFile('a1'); pdfFile('a2');
    addInvoiceAttachment(db, id, 'a1');
    addInvoiceAttachment(db, id, 'a1'); // idempotent
    addInvoiceAttachment(db, id, 'a2');
    let inv = getInvoice(db, id)!;
    expect(inv.attachments).toEqual([
      expect.objectContaining({ fileId: 'a1', sortOrder: 0, name: 'a1.pdf', mime: 'application/pdf' }),
      expect.objectContaining({ fileId: 'a2', sortOrder: 1, name: 'a2.pdf', mime: 'application/pdf' }),
    ]);
    expect(inv.version).toBe(3); // 1 -> +1 (a1) -> +1 (a2); the a1 repeat is a no-op

    updateInvoiceAttachment(db, id, 'a1', { sortOrder: 5 });
    inv = getInvoice(db, id)!;
    expect(inv.attachments.map((a: any) => a.fileId)).toEqual(['a2', 'a1']); // re-ordered by sortOrder
    expect(inv.version).toBe(4);

    removeInvoiceAttachment(db, id, 'a1');
    inv = getInvoice(db, id)!;
    expect(inv.attachments.map((a: any) => a.fileId)).toEqual(['a2']);
    expect(inv.version).toBe(5);
  });

  it('updateInvoiceAttachment on a file not attached to this invoice throws NotFoundError', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    expect(() => updateInvoiceAttachment(db, id, 'nope', { sortOrder: 0 })).toThrow(NotFoundError);
  });

  it('deleteInvoice cleans up photos and attachments', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    addInvoicePhoto(db, id, 'file-1');
    pdfFile('a1');
    addInvoiceAttachment(db, id, 'a1');
    deleteInvoice(db, id);
    expect(getInvoice(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM invoice_photos WHERE invoiceId = ?').get(id) as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM invoice_attachments WHERE invoiceId = ?').get(id) as any).c).toBe(0);
  });
});

describe('payments + status', () => {
  it('records and deletes payments; balance reflects them', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] });
    const p1 = recordPayment(db, 'invoice', id, { date: 1, amount: 40, method: 'check', note: 'deposit' });
    recordPayment(db, 'invoice', id, { date: 2, amount: 25.5, method: 'card' });
    let inv = getInvoice(db, id)!;
    expect(inv.paidCents).toBe(6550);
    expect(inv.balanceCents).toBe(3450);
    deletePayment(db, p1.id);
    inv = getInvoice(db, id)!;
    expect(inv.paidCents).toBe(2550);
  });

  it('rejects invalid payment amounts and unknown invoices', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    expect(() => recordPayment(db, 'invoice', id, { amount: -5 })).toThrow(ValidationError);
    expect(() => recordPayment(db, 'invoice', 'nope', { amount: 5 })).toThrow(NotFoundError);
  });

  it('rejects non-finite payment amounts', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    expect(() => recordPayment(db, 'invoice', id, { amount: 1e400 })).toThrow(ValidationError);
  });

  it('rejects bad target type and missing pay-app targets', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    expect(() => recordPayment(db, 'galaxy' as any, id, { amount: 5 })).toThrow(ValidationError);
    expect(() => recordPayment(db, 'payapp', 'nope', { amount: 5 })).toThrow(NotFoundError);
  });

  it('records payments against an AIA pay application and sums them', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 3, 'draft', 1, 1)").run();
    recordPayment(db, 'payapp', 'app1', { date: 1, amount: 1000, method: 'wire' });
    recordPayment(db, 'payapp', 'app1', { date: 2, amount: 250.25 });
    expect(paidCentsFor(db, 'payapp', 'app1')).toBe(125025);
    // invoice payments are isolated from payapp payments
    const inv = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    recordPayment(db, 'invoice', inv.id, { amount: 10 });
    expect(paidCentsFor(db, 'invoice', inv.id)).toBe(1000);
    expect(paidCentsFor(db, 'payapp', 'app1')).toBe(125025);
  });

  it('getInvoice shows only its own invoice payments', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 1, 'draft', 1, 1)").run();
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    recordPayment(db, 'invoice', id, { amount: 10 });
    recordPayment(db, 'payapp', 'app1', { amount: 99 });
    expect(getInvoice(db, id)!.payments).toHaveLength(1);
    expect(getInvoice(db, id)!.paidCents).toBe(1000);
  });

  it('deletePayApp removes its payments', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 1, 'draft', 1, 1)").run();
    recordPayment(db, 'payapp', 'app1', { amount: 50 });
    db.prepare('DELETE FROM aia_pay_apps WHERE id = ?').run('app1'); // standalone; cascade tested in aiaStore
    // listProjectPayments still excludes orphan-target rows that no longer match a project pay-app
    expect(listProjectPayments(db, 'p1')).toHaveLength(0);
  });

  it('listProjectPayments returns invoice + payapp payments with labels, newest-first', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 7, 'draft', 1, 1)").run();
    const inv = createInvoice(db, 'p1', { number: 'INV-9', lines: [] });
    recordPayment(db, 'invoice', inv.id, { date: 10, amount: 100 });
    recordPayment(db, 'payapp', 'app1', { date: 20, amount: 200 });
    const list = listProjectPayments(db, 'p1');
    expect(list).toHaveLength(2);
    // date DESC → payapp (20) first
    expect(list[0].targetType).toBe('payapp');
    expect(list[0].targetLabel).toBe('Application #7');
    expect(list[0].amount).toBe(200);
    expect(list[1].targetType).toBe('invoice');
    expect(list[1].targetLabel).toBe('Invoice INV-9');
  });

  it('setInvoiceStatus validates the value and bumps version', () => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', lines: [] });
    const r = setInvoiceStatus(db, id, 'sent');
    expect(r.version).toBe(2);
    expect(getInvoice(db, id)!.status).toBe('sent');
    expect(() => setInvoiceStatus(db, id, 'galactic')).toThrow(ValidationError);
  });
});

// Payment detail view, edits and attachments (spec
// docs/superpowers/specs/2026-10-06-payment-attachments-design.md).
describe('payment detail, edits and attachments (migration 43)', () => {
  const invoiceWithPayment = (amount = 40) => {
    const inv = createInvoice(db, 'p1', { number: 'INV-7', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] });
    const pay = recordPayment(db, 'invoice', inv.id, { date: 1000, amount, method: 'check', note: 'deposit' });
    return { invoiceId: inv.id, paymentId: pay.id };
  };
  const invoiceUpdatedAt = (id: string) => (db.prepare('SELECT updatedAt FROM invoices WHERE id = ?').get(id) as any).updatedAt;
  const attachmentRows = (paymentId: string) =>
    (db.prepare('SELECT COUNT(*) c FROM payment_attachments WHERE paymentId = ?').get(paymentId) as any).c;

  it('getPayment returns the payment, what it paid, its project and its attachments; null when unknown', () => {
    const { invoiceId, paymentId } = invoiceWithPayment();
    jpgFile('check');
    addPaymentAttachment(db, paymentId, 'check');
    expect(getPayment(db, paymentId)).toEqual(expect.objectContaining({
      id: paymentId, targetType: 'invoice', targetId: invoiceId, date: 1000, amount: 40,
      method: 'check', note: 'deposit', targetLabel: 'Invoice INV-7', projectId: 'p1',
      attachments: [expect.objectContaining({ fileId: 'check', sortOrder: 0, name: 'check.jpg', mime: 'image/jpeg', size: 1, kind: 'invoice-photo' })],
    }));
    expect(getPayment(db, 'nope')).toBeNull();
  });

  it('getPayment and paymentProjectId resolve a pay application target too', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 4, 'draft', 1, 1)").run();
    const { id } = recordPayment(db, 'payapp', 'app1', { amount: 500 });
    expect(getPayment(db, id)).toMatchObject({ targetLabel: 'Application #4', projectId: 'p1', attachments: [] });
    expect(paymentProjectId(db, id)).toBe('p1');
    expect(paymentProjectId(db, 'nope')).toBeNull();
  });

  it('attaches photos and PDFs in add order, idempotently', () => {
    const { paymentId } = invoiceWithPayment();
    jpgFile('front'); pdfFile('remit');
    addPaymentAttachment(db, paymentId, 'front');
    addPaymentAttachment(db, paymentId, 'remit');
    addPaymentAttachment(db, paymentId, 'front'); // no second row
    expect(getPayment(db, paymentId)!.attachments).toEqual([
      expect.objectContaining({ fileId: 'front', sortOrder: 0, mime: 'image/jpeg' }),
      expect.objectContaining({ fileId: 'remit', sortOrder: 1, mime: 'application/pdf', name: 'remit.pdf' }),
    ]);
    expect(attachmentRows(paymentId)).toBe(2);
  });

  it('refuses anything but a photo or a PDF, an unknown file, a blank fileId and an unknown payment', () => {
    const { paymentId } = invoiceWithPayment();
    putBuffer(db, dir, 'sheet', Buffer.from('x'), 'text/csv', { projectId: 'p1', kind: 'document', name: 'sheet.csv' });
    putBuffer(db, dir, 'doc', Buffer.from('x'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', { projectId: 'p1', kind: 'document', name: 'a.docx' });
    expect(() => addPaymentAttachment(db, paymentId, 'sheet')).toThrow(ValidationError);
    expect(() => addPaymentAttachment(db, paymentId, 'doc')).toThrow(ValidationError);
    expect(() => addPaymentAttachment(db, paymentId, 'missing')).toThrow(NotFoundError);
    expect(() => addPaymentAttachment(db, paymentId, '')).toThrow(ValidationError);
    jpgFile('ok');
    expect(() => addPaymentAttachment(db, 'no-such-payment', 'ok')).toThrow(NotFoundError);
    expect(attachmentRows(paymentId)).toBe(0);
  });

  it('removes an attachment (a missing one is a no-op); an unknown payment is NotFound', () => {
    const { paymentId } = invoiceWithPayment();
    jpgFile('a'); pdfFile('b');
    addPaymentAttachment(db, paymentId, 'a');
    addPaymentAttachment(db, paymentId, 'b');
    removePaymentAttachment(db, paymentId, 'a');
    removePaymentAttachment(db, paymentId, 'not-attached');
    expect(getPayment(db, paymentId)!.attachments.map((a: any) => a.fileId)).toEqual(['b']);
    expect(() => removePaymentAttachment(db, 'no-such-payment', 'b')).toThrow(NotFoundError);
    // Unlinked, not deleted: the file itself stays in Documents.
    expect(db.prepare('SELECT id FROM files WHERE id = ?').get('a')).toBeTruthy();
  });

  // Attachments live on the payment only — nothing a generated invoice or pay
  // app PDF prints changes, so the target's freshness clock must not move.
  it('attaching and removing leave the target invoice\'s updatedAt alone', async () => {
    const { invoiceId, paymentId } = invoiceWithPayment();
    const before = invoiceUpdatedAt(invoiceId);
    await new Promise(r => setTimeout(r, 2));
    jpgFile('a');
    addPaymentAttachment(db, paymentId, 'a');
    removePaymentAttachment(db, paymentId, 'a');
    expect(invoiceUpdatedAt(invoiceId)).toBe(before);
  });

  it('listProjectPayments counts each payment\'s attachments', () => {
    const { invoiceId, paymentId } = invoiceWithPayment();
    const other = recordPayment(db, 'invoice', invoiceId, { date: 2000, amount: 10 });
    jpgFile('a'); pdfFile('b');
    addPaymentAttachment(db, paymentId, 'a');
    addPaymentAttachment(db, paymentId, 'b');
    const byId = Object.fromEntries(listProjectPayments(db, 'p1').map(p => [p.id, p]));
    expect(byId[paymentId].attachmentCount).toBe(2);
    expect(byId[other.id].attachmentCount).toBe(0);
  });

  it('updatePayment edits date, amount, method and note; the target never moves', () => {
    const { invoiceId, paymentId } = invoiceWithPayment();
    updatePayment(db, paymentId, { date: 5000, amount: 60.25, method: 'ach', note: 'Final payment', targetId: 'other' } as any);
    expect(getPayment(db, paymentId)).toMatchObject({
      date: 5000, amount: 60.25, method: 'ach', note: 'Final payment', targetType: 'invoice', targetId: invoiceId,
    });
    expect(getInvoice(db, invoiceId)!.paidCents).toBe(6025);
  });

  it('updatePayment keeps what it is not given; a null date keeps the date; blank method/note clear to null', () => {
    const { paymentId } = invoiceWithPayment();
    updatePayment(db, paymentId, { note: 'only the note' });
    expect(getPayment(db, paymentId)).toMatchObject({ date: 1000, amount: 40, method: 'check', note: 'only the note' });
    updatePayment(db, paymentId, { date: null, method: '  ', note: '   ' });
    expect(getPayment(db, paymentId)).toMatchObject({ date: 1000, amount: 40, method: null, note: null });
  });

  it('updatePayment validates like recordPayment and 404s an unknown payment', () => {
    const { paymentId } = invoiceWithPayment();
    expect(() => updatePayment(db, paymentId, { amount: 0 })).toThrow(ValidationError);
    expect(() => updatePayment(db, paymentId, { amount: -5 })).toThrow(ValidationError);
    expect(() => updatePayment(db, paymentId, { amount: 1e400 })).toThrow(ValidationError);
    expect(() => updatePayment(db, paymentId, { amount: '50' as any })).toThrow(ValidationError);
    expect(() => updatePayment(db, paymentId, { date: 'yesterday' as any })).toThrow(ValidationError);
    expect(() => updatePayment(db, 'no-such-payment', { amount: 5 })).toThrow(NotFoundError);
    expect(getPayment(db, paymentId)).toMatchObject({ amount: 40, date: 1000 }); // nothing written
  });

  // Paid/Balance on the invoice PDF (and the pay app's) come from the amounts:
  // an amount edit stamps the target like a record/delete does; a date, method
  // or note fix leaves its PDF current.
  it('updatePayment stamps the target invoice only when the amount changes', async () => {
    const { invoiceId, paymentId } = invoiceWithPayment();
    const before = invoiceUpdatedAt(invoiceId);
    await new Promise(r => setTimeout(r, 2));
    updatePayment(db, paymentId, { date: 9000, method: 'card', note: 'fixed typo', amount: 40.001 }); // same cents
    expect(invoiceUpdatedAt(invoiceId)).toBe(before);
    await new Promise(r => setTimeout(r, 2));
    updatePayment(db, paymentId, { amount: 45 });
    expect(invoiceUpdatedAt(invoiceId)).toBeGreaterThan(before);
  });

  it('updatePayment stamps a pay application target on an amount change', async () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt, updatedAt) VALUES ('app1', 'p1', 3, 'draft', 1, 1, 1)").run();
    const { id } = recordPayment(db, 'payapp', 'app1', { amount: 500 });
    db.prepare("UPDATE aia_pay_apps SET updatedAt = 1 WHERE id = 'app1'").run();
    updatePayment(db, id, { amount: 750 });
    expect((db.prepare("SELECT updatedAt FROM aia_pay_apps WHERE id = 'app1'").get() as any).updatedAt).toBeGreaterThan(1);
    expect(paidCentsFor(db, 'payapp', 'app1')).toBe(75000);
  });

  it('deleting the payment, its invoice or its pay application removes its attachment rows', () => {
    jpgFile('a');
    const first = invoiceWithPayment();
    addPaymentAttachment(db, first.paymentId, 'a');
    deletePayment(db, first.paymentId);
    expect(attachmentRows(first.paymentId)).toBe(0);

    const second = invoiceWithPayment();
    addPaymentAttachment(db, second.paymentId, 'a');
    deleteInvoice(db, second.invoiceId);
    expect(attachmentRows(second.paymentId)).toBe(0);

    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 1, 'draft', 1, 1)").run();
    const third = recordPayment(db, 'payapp', 'app1', { amount: 5 });
    addPaymentAttachment(db, third.id, 'a');
    deletePayApp(db, 'app1');
    expect(attachmentRows(third.id)).toBe(0);
    // The photo itself is still a document — only the links went.
    expect(db.prepare('SELECT id FROM files WHERE id = ?').get('a')).toBeTruthy();
  });
});

// Invoices are marked paid automatically (spec
// docs/superpowers/specs/2026-10-06-reports-design.md): paid once payments
// cover the total, back to sent when a balance opens up again.
describe('automatic paid status', () => {
  const row = (id: string) => db.prepare('SELECT status, version, updatedAt FROM invoices WHERE id = ?').get(id) as
    { status: string; version: number; updatedAt: number };
  const sentInvoice = (unitPrice = 100) => {
    const { id } = createInvoice(db, 'p1', { number: 'INV-1', status: 'sent', lines: [{ description: 'A', qty: 1, unitPrice }] });
    return id;
  };

  it('autoInvoiceStatus: covered in full → paid; a paid one with a balance → sent; anything else kept', () => {
    expect(autoInvoiceStatus('sent', 10000, 10000)).toBe('paid');
    expect(autoInvoiceStatus('sent', 10000, 12000)).toBe('paid'); // overpaid
    expect(autoInvoiceStatus('draft', 10000, 10000)).toBe('paid');
    expect(autoInvoiceStatus('sent', 10000, 9999)).toBe('sent');
    expect(autoInvoiceStatus('paid', 10000, 9999)).toBe('sent');
    expect(autoInvoiceStatus('paid', 10000, 10000)).toBe('paid');
    // A $0 invoice is never "covered": its status is left as it is.
    expect(autoInvoiceStatus('sent', 0, 0)).toBe('sent');
    expect(autoInvoiceStatus('sent', 0, 500)).toBe('sent');
    expect(autoInvoiceStatus('paid', 0, 0)).toBe('paid');
    expect(autoInvoiceStatus('draft', 10000, 5000)).toBe('draft');
  });

  it('recording a payment that covers the total marks the invoice paid, and says so', () => {
    const id = sentInvoice();
    const r = recordPayment(db, 'invoice', id, { amount: 100 });
    expect(r.invoiceStatusChange).toEqual({ invoiceId: id, status: 'paid' });
    expect(getInvoice(db, id)).toMatchObject({ status: 'paid', balanceCents: 0 });
  });

  it('a partial payment leaves it sent; the one that completes it marks it paid (cents, no float drift)', () => {
    const { id } = createInvoice(db, 'p1', { status: 'sent', lines: [
      { description: 'a', qty: 1, unitPrice: 0.1 }, { description: 'b', qty: 1, unitPrice: 0.2 },
    ] }); // 30 cents
    expect(recordPayment(db, 'invoice', id, { amount: 0.1 }).invoiceStatusChange).toBeNull();
    expect(row(id).status).toBe('sent');
    expect(recordPayment(db, 'invoice', id, { amount: 0.2 }).invoiceStatusChange).toEqual({ invoiceId: id, status: 'paid' });
    expect(row(id).status).toBe('paid');
  });

  it('deleting a payment puts a paid invoice back to sent', () => {
    const id = sentInvoice();
    recordPayment(db, 'invoice', id, { amount: 60 });
    const last = recordPayment(db, 'invoice', id, { amount: 40 });
    expect(row(id).status).toBe('paid');
    expect(deletePayment(db, last.id)).toEqual({ invoiceId: id, status: 'sent' });
    expect(row(id).status).toBe('sent');
    expect(deletePayment(db, 'no-such-payment')).toBeNull();
  });

  it('reducing a payment puts it back to sent; raising it again marks it paid; a note edit changes nothing', () => {
    const id = sentInvoice();
    const pay = recordPayment(db, 'invoice', id, { amount: 100 });
    expect(updatePayment(db, pay.id, { note: 'check #1042' })).toBeNull();
    expect(row(id).status).toBe('paid');
    expect(updatePayment(db, pay.id, { amount: 99.99 })).toEqual({ invoiceId: id, status: 'sent' });
    expect(row(id).status).toBe('sent');
    expect(updatePayment(db, pay.id, { amount: 100 })).toEqual({ invoiceId: id, status: 'paid' });
    expect(row(id).status).toBe('paid');
  });

  it('a save that grows the lines past what was paid puts it back to sent; shrinking them to the payments marks it paid', () => {
    const id = sentInvoice();
    recordPayment(db, 'invoice', id, { amount: 100 });
    saveInvoice(db, id, { ...getInvoice(db, id)!, lines: [{ description: 'A', qty: 1, unitPrice: 100 }, { description: 'Extra', qty: 1, unitPrice: 25 }] });
    expect(getInvoice(db, id)).toMatchObject({ status: 'sent', balanceCents: 2500 });
    saveInvoice(db, id, { ...getInvoice(db, id)!, lines: [{ description: 'A', qty: 1, unitPrice: 100 }] });
    expect(getInvoice(db, id)).toMatchObject({ status: 'paid', balanceCents: 0 });
  });

  it('a fully paid draft is marked paid too; a partly paid draft stays a draft', () => {
    const { id } = createInvoice(db, 'p1', { lines: [{ description: 'A', qty: 1, unitPrice: 100 }] });
    recordPayment(db, 'invoice', id, { amount: 50 });
    expect(row(id).status).toBe('draft');
    recordPayment(db, 'invoice', id, { amount: 50 });
    expect(row(id).status).toBe('paid');
  });

  it('a manual status pick stands until the next payment or line change', () => {
    const id = sentInvoice();
    recordPayment(db, 'invoice', id, { amount: 40 });
    setInvoiceStatus(db, id, 'paid'); // marked paid by hand with $60 still owing
    expect(row(id).status).toBe('paid');
    recordPayment(db, 'invoice', id, { amount: 10 }); // the rule applies again
    expect(row(id).status).toBe('sent');
  });

  it('pay application payments never touch invoice statuses', () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 1, 'finalized', 1, 1)").run();
    expect(recordPayment(db, 'payapp', 'app1', { amount: 500 }).invoiceStatusChange).toBeNull();
  });

  // The automatic change doesn't bump version, so an invoice editor open
  // elsewhere can still save — and what it echoes back can't undo the change.
  it('leaves version and updatedAt alone, so an open editor still saves, without writing its stale status back', async () => {
    const id = sentInvoice();
    const loaded = getInvoice(db, id)!; // an editor opens the invoice while it is 'sent'
    await new Promise(r => setTimeout(r, 2));
    const pay = recordPayment(db, 'invoice', id, { amount: 100 });
    const afterPayment = row(id);
    expect(afterPayment.status).toBe('paid');
    expect(afterPayment.version).toBe(loaded.version);

    // A notes-only save from that editor: still version-checked OK, and the
    // 'sent' it carries is resolved back to 'paid' — nothing PDF-relevant moved.
    const saved = saveInvoice(db, id, { ...loaded, notes: 'Thanked them' });
    expect(saved.version).toBe(loaded.version + 1);
    expect(row(id)).toMatchObject({ status: 'paid', updatedAt: afterPayment.updatedAt });

    // The other way round: a payment deleted under an editor that loaded 'paid'.
    const reloaded = getInvoice(db, id)!;
    deletePayment(db, pay.id);
    expect(row(id)).toMatchObject({ status: 'sent', version: reloaded.version });
    saveInvoice(db, id, { ...reloaded, terms: 'Net 15' });
    expect(row(id).status).toBe('sent');
  });

  it('syncInvoicePaidStatus is a no-op for an unknown invoice and when nothing moved', () => {
    expect(syncInvoicePaidStatus(db, 'nope')).toBeNull();
    const id = sentInvoice();
    expect(syncInvoicePaidStatus(db, id)).toBeNull();
    db.prepare(`INSERT INTO payments (id, targetType, targetId, date, amount, createdAt) VALUES ('raw', 'invoice', ?, 1, 100, 1)`).run(id);
    expect(syncInvoicePaidStatus(db, id)).toEqual({ invoiceId: id, status: 'paid' });
  });
});

describe('change orders + contract rollup', () => {
  beforeEach(() => {
    db.prepare('UPDATE projects SET contractValue = ? WHERE id = ?').run(10000, 'p1'); // $10k base
  });

  it('creates change orders (draft by default) and rolls up only approved ones', () => {
    createChangeOrder(db, 'p1', { number: 'CO-1', description: 'Extra outlets', lumpSumAmount: 1500 });
    const co2 = createChangeOrder(db, 'p1', { number: 'CO-2', description: 'Demo', lumpSumAmount: 800 });
    expect(getChangeOrder(db, co2.id)!.status).toBe('draft'); // new lifecycle default
    let s = billingSummary(db, 'p1');
    expect(s.baseContractCents).toBe(1000000);
    expect(s.approvedChangeCents).toBe(0); // both draft
    expect(s.contractValueCents).toBe(1000000);

    setChangeOrderStatus(db, co2.id, 'approved');
    s = billingSummary(db, 'p1');
    expect(s.approvedChangeCents).toBe(80000);
    expect(s.contractValueCents).toBe(1080000); // base + approved CO
  });

  it('summary aggregates invoiced + paid + balance across invoices', () => {
    const inv = createInvoice(db, 'p1', { number: 'INV-1', status: 'sent', lines: [{ description: 'A', qty: 1, unitPrice: 500 }] });
    recordPayment(db, 'invoice', inv.id, { amount: 200 });
    const s = billingSummary(db, 'p1');
    expect(s.invoicedCents).toBe(50000);
    expect(s.paidCents).toBe(20000);
    expect(s.outstandingCents).toBe(30000);
    expect(s.invoiceCount).toBe(1);
  });

  it('validates and lists change orders newest-first', () => {
    expect(() => createChangeOrder(db, 'p1', { lumpSumAmount: 'x' as any })).toThrow(ValidationError);
    expect(() => setChangeOrderStatus(db, 'nope', 'approved')).toThrow(NotFoundError);
    createChangeOrder(db, 'p1', { number: 'CO-1', lumpSumAmount: 1, description: 'a' });
    createChangeOrder(db, 'p1', { number: 'CO-2', lumpSumAmount: 2, description: 'b' });
    expect(listChangeOrders(db, 'p1').map(c => c.number)).toEqual(['CO-2', 'CO-1']);
  });
});

describe('change orders — line items, lump sum, version, photos (Phase 9)', () => {
  beforeEach(() => {
    db.prepare('UPDATE projects SET contractValue = ? WHERE id = ?').run(10000, 'p1');
  });

  it('CO total = Σ lines (round-per-line) + lump sum; amount = totalCents/100 (exact)', () => {
    const { id } = createChangeOrder(db, 'p1', {
      number: '001',
      lumpSumAmount: 25.5,
      lines: [
        { description: 'A', qty: 2, unitPrice: 50 },     // 100.00
        { description: 'B', qty: 1, unitPrice: 25.5 },    // 25.50
        { description: 'C', qty: 3, unitPrice: 0.1 },     // 0.30 (round-per-line)
      ],
    });
    const co = getChangeOrder(db, id)!;
    expect(co.lumpSumCents).toBe(2550);
    expect(co.totalCents).toBe(10000 + 2550 + 30 + 2550); // lines 12580 + lump 2550 = 15130
    // amount is the canonical rolled-up dollars read by billingSummary + SOV sync.
    expect(co.amount).toBe(co.totalCents / 100);
    // The invariant: zero cents drift round-tripping dollars→cents.
    expect(Math.round(co.amount * 100)).toBe(co.totalCents);
  });

  it('approved CO amount flows into the contract total with no drift', () => {
    const { id } = createChangeOrder(db, 'p1', {
      lumpSumAmount: 0,
      lines: [{ description: 'X', qty: 3, unitPrice: 33.33 }], // 99.99
    });
    setChangeOrderStatus(db, id, 'approved');
    const co = getChangeOrder(db, id)!;
    expect(co.totalCents).toBe(9999);
    const s = billingSummary(db, 'p1');
    expect(s.approvedChangeCents).toBe(9999); // exact — billingSummary reads amount
    expect(s.contractTotalCents).toBe(1000000 + 9999);
  });

  it('saveChangeOrder is version-checked, replaces lines, recomputes amount, bumps version', () => {
    const { id } = createChangeOrder(db, 'p1', { number: '001', lumpSumAmount: 0, lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    const co = getChangeOrder(db, id)!;
    expect(co.version).toBe(1);
    const saved = saveChangeOrder(db, id, {
      version: co.version,
      number: 'CO-001',
      description: 'updated',
      lumpSumAmount: 100,
      scheduleImpactDays: 5,
      lines: [{ description: 'B', qty: 2, unitPrice: 5 }], // 10.00
    });
    expect(saved.version).toBe(2);
    const reloaded = getChangeOrder(db, id)!;
    expect(reloaded.number).toBe('CO-001');
    expect(reloaded.description).toBe('updated');
    expect(reloaded.scheduleImpactDays).toBe(5);
    expect(reloaded.lines).toHaveLength(1);
    expect(reloaded.totalCents).toBe(1000 + 10000); // lines 10.00 + lump 100.00
    expect(reloaded.amount).toBe(reloaded.totalCents / 100);
    expect(Math.round(reloaded.amount * 100)).toBe(reloaded.totalCents);
  });

  it('title round-trips through create and save, and blank/whitespace normalizes to null', () => {
    const { id } = createChangeOrder(db, 'p1', { number: '001', title: '  Kitchen electrical add  ', lumpSumAmount: 0 });
    let co = getChangeOrder(db, id)!;
    expect(co.title).toBe('Kitchen electrical add');

    const saved = saveChangeOrder(db, id, { version: co.version, title: '   ', lumpSumAmount: 0 });
    co = getChangeOrder(db, id)!;
    expect(saved.version).toBe(2);
    expect(co.title).toBeNull();

    const untitled = createChangeOrder(db, 'p1', { number: '002', lumpSumAmount: 0 });
    expect(getChangeOrder(db, untitled.id)!.title).toBeNull();
  });

  it('a non-string title (raw JSON body sent a number/object) is stored as null instead of throwing', () => {
    // title is optional/display-only, like description — malformed input is
    // normalized away rather than raising a 500 from calling .trim() on it.
    const created = createChangeOrder(db, 'p1', { number: '003', title: 42 as any, lumpSumAmount: 0 });
    expect(getChangeOrder(db, created.id)!.title).toBeNull();

    const co = getChangeOrder(db, created.id)!;
    const saved = saveChangeOrder(db, created.id, { version: co.version, title: { bad: true } as any, lumpSumAmount: 0 });
    expect(saved.version).toBe(2);
    expect(getChangeOrder(db, created.id)!.title).toBeNull();
  });

  it('saveChangeOrder throws ConflictError on a stale version', () => {
    const { id } = createChangeOrder(db, 'p1', { lumpSumAmount: 0 });
    saveChangeOrder(db, id, { version: 1, lumpSumAmount: 1 }); // now v2
    expect(() => saveChangeOrder(db, id, { version: 1, lumpSumAmount: 2 })).toThrow(ConflictError);
  });

  it('saveChangeOrder does NOT change status', () => {
    const { id } = createChangeOrder(db, 'p1', { lumpSumAmount: 0 });
    setChangeOrderStatus(db, id, 'approved'); // v2, approved
    const v = getChangeOrder(db, id)!.version;
    saveChangeOrder(db, id, { version: v, lumpSumAmount: 50 });
    expect(getChangeOrder(db, id)!.status).toBe('approved');
  });

  it('auto-numbers per project (001, 002, …) and honors an explicit override', () => {
    const a = createChangeOrder(db, 'p1', {});
    const b = createChangeOrder(db, 'p1', {});
    expect(getChangeOrder(db, a.id)!.number).toBe('001');
    expect(getChangeOrder(db, b.id)!.number).toBe('002');
    const c = createChangeOrder(db, 'p1', { number: 'CO-99' });
    expect(getChangeOrder(db, c.id)!.number).toBe('CO-99');
    // next sequence parses the max int across all numbers (99) → 100
    const d = createChangeOrder(db, 'p1', {});
    expect(getChangeOrder(db, d.id)!.number).toBe('100');
  });

  it('status validation accepts the new set and tolerates reading legacy pending rows', () => {
    const { id } = createChangeOrder(db, 'p1', {});
    expect(() => setChangeOrderStatus(db, id, 'sent')).not.toThrow();
    expect(() => setChangeOrderStatus(db, id, 'approved')).not.toThrow();
    expect(() => setChangeOrderStatus(db, id, 'rejected')).not.toThrow();
    expect(() => setChangeOrderStatus(db, id, 'pending')).toThrow(ValidationError); // not a valid new transition
    // A legacy pending row (written directly) must still READ without throwing.
    db.prepare("UPDATE change_orders SET status = 'pending' WHERE id = ?").run(id);
    expect(getChangeOrder(db, id)!.status).toBe('pending');
    expect(listChangeOrders(db, 'p1').find(c => c.id === id)!.status).toBe('pending');
  });

  it('photos: idempotent add bumps version, remove bumps version', () => {
    const { id } = createChangeOrder(db, 'p1', {});
    addChangeOrderPhoto(db, id, 'file-1');
    addChangeOrderPhoto(db, id, 'file-1'); // idempotent — no second row, no extra bump
    let co = getChangeOrder(db, id)!;
    expect(co.photos).toHaveLength(1);
    expect(co.version).toBe(2); // 1 → +1 on the first add only
    addChangeOrderPhoto(db, id, 'file-2');
    co = getChangeOrder(db, id)!;
    expect(co.photos).toHaveLength(2);
    expect(co.version).toBe(3);
    removeChangeOrderPhoto(db, id, 'file-1');
    co = getChangeOrder(db, id)!;
    expect(co.photos.map((p: any) => p.fileId)).toEqual(['file-2']);
    expect(co.version).toBe(4);
  });

  // Same contract as the invoice's attachments (and this CO's photos): PDFs
  // only, idempotent, appended in add order, and every change bumps version +
  // updatedAt so the generated change order reads out of date.
  it('attachments must be PDFs and existing files; sortOrder assigns in add order; each change bumps version', () => {
    const { id } = createChangeOrder(db, 'p1', {});
    jpgFile('notpdf');
    expect(() => addChangeOrderAttachment(db, id, 'notpdf')).toThrow(ValidationError);
    expect(() => addChangeOrderAttachment(db, id, 'missing')).toThrow(NotFoundError);
    expect(() => addChangeOrderAttachment(db, id, '')).toThrow(ValidationError);
    pdfFile('a1'); pdfFile('a2');
    expect(() => addChangeOrderAttachment(db, 'nope', 'a1')).toThrow(NotFoundError);
    expect(getChangeOrder(db, id)!.attachments).toEqual([]);
    addChangeOrderAttachment(db, id, 'a1');
    addChangeOrderAttachment(db, id, 'a1'); // idempotent
    addChangeOrderAttachment(db, id, 'a2');
    let co = getChangeOrder(db, id)!;
    expect(co.attachments).toEqual([
      expect.objectContaining({ fileId: 'a1', sortOrder: 0, name: 'a1.pdf', mime: 'application/pdf' }),
      expect.objectContaining({ fileId: 'a2', sortOrder: 1, name: 'a2.pdf', mime: 'application/pdf' }),
    ]);
    expect(co.version).toBe(3); // 1 -> +1 (a1) -> +1 (a2); the a1 repeat is a no-op

    updateChangeOrderAttachment(db, id, 'a1', { sortOrder: 5 });
    co = getChangeOrder(db, id)!;
    expect(co.attachments.map((a: any) => a.fileId)).toEqual(['a2', 'a1']);
    expect(co.version).toBe(4);
    expect(() => updateChangeOrderAttachment(db, id, 'nope', { sortOrder: 0 })).toThrow(NotFoundError);
    expect(() => updateChangeOrderAttachment(db, id, 'a1', { sortOrder: 1.5 })).toThrow(ValidationError);

    removeChangeOrderAttachment(db, id, 'a1');
    removeChangeOrderAttachment(db, id, 'a1'); // already gone: no bump
    co = getChangeOrder(db, id)!;
    expect(co.attachments.map((a: any) => a.fileId)).toEqual(['a2']);
    expect(co.version).toBe(5);
  });

  it('attachment changes move updatedAt (freshness contract)', () => {
    const { id } = createChangeOrder(db, 'p1', {});
    pdfFile('a1');
    db.prepare('UPDATE change_orders SET updatedAt = 1 WHERE id = ?').run(id);
    addChangeOrderAttachment(db, id, 'a1');
    expect(getChangeOrder(db, id)!.updatedAt).toBeGreaterThan(1);
    db.prepare('UPDATE change_orders SET updatedAt = 1 WHERE id = ?').run(id);
    updateChangeOrderAttachment(db, id, 'a1', { sortOrder: 3 });
    expect(getChangeOrder(db, id)!.updatedAt).toBeGreaterThan(1);
    db.prepare('UPDATE change_orders SET updatedAt = 1 WHERE id = ?').run(id);
    removeChangeOrderAttachment(db, id, 'a1');
    expect(getChangeOrder(db, id)!.updatedAt).toBeGreaterThan(1);
  });

  it('deleteChangeOrder cascades lines, photos, attachments, and the synced SOV line', () => {
    const { id } = createChangeOrder(db, 'p1', { lumpSumAmount: 0, lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    addChangeOrderPhoto(db, id, 'file-1');
    pdfFile('a1');
    addChangeOrderAttachment(db, id, 'a1');
    // Simulate a synced AIA SOV line keyed on this CO.
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, description, scheduledValueCents, isChangeOrder, changeOrderId, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, 1, ?, 0, 1, 1)'
    ).run('sov-co', 'p1', 'CO', 1000, id);
    deleteChangeOrder(db, id);
    expect(getChangeOrder(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM change_order_lines WHERE changeOrderId = ?').get(id) as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM change_order_photos WHERE changeOrderId = ?').get(id) as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM change_order_attachments WHERE changeOrderId = ?').get(id) as any).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM aia_sov_lines WHERE changeOrderId = ?').get(id) as any).c).toBe(0);
  });

  it('deleteChangeOrder throws SovLockedError when the SOV is locked and this CO has a synced SOV line, leaving everything intact', () => {
    const { id } = createChangeOrder(db, 'p1', { lumpSumAmount: 0, lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, description, scheduledValueCents, isChangeOrder, changeOrderId, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, 1, ?, 0, 1, 1)'
    ).run('sov-co', 'p1', 'CO', 1000, id);
    lockSov(db, 'p1', { userId: null, reason: 'manual' });
    expect(() => deleteChangeOrder(db, id)).toThrow(SovLockedError);
    expect(getChangeOrder(db, id)).not.toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM aia_sov_lines WHERE id = ?').get('sov-co') as any).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM change_order_lines WHERE changeOrderId = ?').get(id) as any).c).toBe(1);
  });

  it('deleteChangeOrder still deletes when the SOV is locked but this CO has no synced SOV line', () => {
    const { id } = createChangeOrder(db, 'p1', { lumpSumAmount: 0, lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    lockSov(db, 'p1', { userId: null, reason: 'manual' });
    expect(() => deleteChangeOrder(db, id)).not.toThrow();
    expect(getChangeOrder(db, id)).toBeNull();
  });

  it('deleteChangeOrder deletes the CO and its synced SOV line when the SOV is unlocked', () => {
    const { id } = createChangeOrder(db, 'p1', { lumpSumAmount: 0, lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, description, scheduledValueCents, isChangeOrder, changeOrderId, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, 1, ?, 0, 1, 1)'
    ).run('sov-co2', 'p1', 'CO', 1000, id);
    expect(() => deleteChangeOrder(db, id)).not.toThrow();
    expect(getChangeOrder(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM aia_sov_lines WHERE id = ?').get('sov-co2') as any).c).toBe(0);
  });
});

// A change order from before migration 14 still in its old shape (migration 47
// moves the ones that exist when it runs): no line rows, lumpSumAmount at the
// column's default 0, its value only in amount.
describe('change orders from before line items — value only in amount', () => {
  beforeEach(() => {
    db.prepare('UPDATE projects SET contractValue = ? WHERE id = ?').run(10000, 'p1'); // $10k base
    db.prepare(`INSERT INTO change_orders (id, projectId, number, description, amount, status, createdAt)
                VALUES ('legacy', 'p1', '001', 'Extra electrical', 1234.56, 'approved', 1)`).run();
  });

  it('reads as a lump sum of its amount: the list, the editor record and the PDF totals show its value', () => {
    expect(listChangeOrders(db, 'p1')).toMatchObject([{ id: 'legacy', amount: 1234.56, lumpSumAmount: 1234.56, totalCents: 123456 }]);
    expect(getChangeOrder(db, 'legacy')).toMatchObject({ amount: 1234.56, lumpSumAmount: 1234.56, lumpSumCents: 123456, totalCents: 123456, lines: [] });
    expect(billingSummary(db, 'p1').approvedChangeCents).toBe(123456);
    // Reading writes nothing.
    expect(db.prepare('SELECT lumpSumAmount, version FROM change_orders WHERE id = ?').get('legacy')).toEqual({ lumpSumAmount: 0, version: 1 });
  });

  it('saving it unchanged, as the editor does, keeps its amount and the contract total', () => {
    const before = billingSummary(db, 'p1').contractTotalCents;
    expect(before).toBe(1000000 + 123456);
    // The editor posts the record back with its Lump sum field, filled from lumpSumAmount.
    const co = getChangeOrder(db, 'legacy')!;
    saveChangeOrder(db, 'legacy', { ...co, lumpSumAmount: co.lumpSumAmount, lines: co.lines });
    expect(db.prepare('SELECT amount, lumpSumAmount, version FROM change_orders WHERE id = ?').get('legacy'))
      .toEqual({ amount: 1234.56, lumpSumAmount: 1234.56, version: 2 });
    expect(listChangeOrders(db, 'p1')[0].totalCents).toBe(123456);
    expect(billingSummary(db, 'p1').contractTotalCents).toBe(before);
  });

  it('an edit to it saves like any change order: new lines and lump sum, or cleared to $0', () => {
    let co = getChangeOrder(db, 'legacy')!;
    saveChangeOrder(db, 'legacy', { version: co.version, lumpSumAmount: 1000, lines: [{ description: 'A', qty: 2, unitPrice: 50 }] });
    expect(getChangeOrder(db, 'legacy')).toMatchObject({ amount: 1100, lumpSumAmount: 1000, totalCents: 110000 });
    co = getChangeOrder(db, 'legacy')!;
    saveChangeOrder(db, 'legacy', { version: co.version, lumpSumAmount: 0, lines: [] });
    expect(getChangeOrder(db, 'legacy')).toMatchObject({ amount: 0, lumpSumAmount: 0, totalCents: 0 });
    expect(billingSummary(db, 'p1').approvedChangeCents).toBe(0);
  });

  it('change orders with lines, a lump sum, or $0 throughout read exactly as stored', () => {
    const lined = createChangeOrder(db, 'p1', { lines: [{ description: 'A', qty: 2, unitPrice: 50 }] });
    const lump = createChangeOrder(db, 'p1', { lumpSumAmount: 75 });
    const zero = createChangeOrder(db, 'p1', {});
    expect(getChangeOrder(db, lined.id)).toMatchObject({ amount: 100, lumpSumAmount: 0, lumpSumCents: 0, totalCents: 10000 });
    expect(getChangeOrder(db, lump.id)).toMatchObject({ amount: 75, lumpSumAmount: 75, lumpSumCents: 7500, totalCents: 7500 });
    expect(getChangeOrder(db, zero.id)).toMatchObject({ amount: 0, lumpSumAmount: 0, lumpSumCents: 0, totalCents: 0 });
    expect(listChangeOrders(db, 'p1').filter(c => c.id !== 'legacy').map(c => [c.lumpSumAmount, c.totalCents]))
      .toEqual([[0, 0], [75, 7500], [0, 10000]]);
  });
});

describe('billingSummary — SOV-derived contract total', () => {
  const insSov = (id: string, valueCents: number, isCO = 0) =>
    db.prepare(
      'INSERT INTO aia_sov_lines (id, projectId, description, scheduledValueCents, isChangeOrder, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, 1)'
    ).run(id, 'p1', id, valueCents, isCO, 0);
  const insApprovedCO = (num: string, dollars: number) => {
    const co = createChangeOrder(db, 'p1', { number: num, lumpSumAmount: dollars });
    setChangeOrderStatus(db, co.id, 'approved');
  };

  it('derives base + total from the SOV when one exists, even if contractValue=0', () => {
    db.prepare('UPDATE projects SET contractValue = 0 WHERE id = ?').run('p1');
    insSov('s1', 10000000);
    insSov('s2', 5000000);
    insApprovedCO('CO-1', 10000); // $10,000 → 1,000,000 cents
    const s = billingSummary(db, 'p1');
    expect(s.hasSov).toBe(true);
    expect(s.sovOriginalCents).toBe(15000000);
    expect(s.baseContractCents).toBe(15000000);
    expect(s.approvedChangeCents).toBe(1000000);
    expect(s.contractTotalCents).toBe(16000000);
    expect(s.contractValueCents).toBe(16000000); // back-compat mirror
  });

  it('falls back to projects.contractValue when no SOV lines exist', () => {
    db.prepare('UPDATE projects SET contractValue = 200000 WHERE id = ?').run('p1'); // $200k
    insApprovedCO('CO-1', 10000); // $10k
    const s = billingSummary(db, 'p1');
    expect(s.hasSov).toBe(false);
    expect(s.sovOriginalCents).toBe(0);
    expect(s.baseContractCents).toBe(20000000);
    expect(s.contractTotalCents).toBe(21000000);
    expect(s.contractValueCents).toBe(21000000);
  });

  it('CO SOV lines (isChangeOrder=1) do not inflate the base or double-count', () => {
    db.prepare('UPDATE projects SET contractValue = 0 WHERE id = ?').run('p1');
    insSov('s1', 10000000); // original
    insSov('s2', 5000000); // original
    insSov('co-sov', 1000000, 1); // CO SOV line — must be ignored by base
    insApprovedCO('CO-1', 10000); // $10k via change_orders — the single source for the CO
    const s = billingSummary(db, 'p1');
    expect(s.sovOriginalCents).toBe(15000000); // CO SOV line excluded
    expect(s.baseContractCents).toBe(15000000);
    expect(s.approvedChangeCents).toBe(1000000);
    // total = original + approved change_orders ONCE (no +1,000,000 from co-sov)
    expect(s.contractTotalCents).toBe(16000000);
  });

  it('splits paid amounts across invoices vs pay-apps', () => {
    const inv = createInvoice(db, 'p1', { number: 'INV-1', status: 'sent', lines: [{ description: 'A', qty: 1, unitPrice: 5000 }] });
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES ('app1', 'p1', 1, 'draft', 1, 1)").run();
    recordPayment(db, 'invoice', inv.id, { amount: 2000 }); // $2,000
    recordPayment(db, 'payapp', 'app1', { amount: 1000 }); // $1,000
    const s = billingSummary(db, 'p1');
    expect(s.paid.invoicesCents).toBe(200000);
    expect(s.paid.payAppsCents).toBe(100000);
    expect(s.paidCents).toBe(200000); // back-compat = invoice payments
    expect(s.invoiceTotalCents).toBe(500000);
    expect(s.invoiceOutstandingCents).toBe(300000); // 500000 - 200000
    expect(s.outstandingCents).toBe(300000);
  });

  it('contract base from the SOV counts item lines only (headers/blanks are zero and excluded)', () => {
    createSovLine(db, 'p1', { description: 'Work', scheduledValueCents: 100000 });
    createSovLine(db, 'p1', { lineType: 'header', description: 'Section' });
    createSovLine(db, 'p1', { lineType: 'blank' });
    expect(billingSummary(db, 'p1').contractTotalCents).toBe(100000);
  });
});

describe('billingSummary — payAppBilledCents / payAppOutstandingCents (contract split)', () => {
  it('mixed project: finalized pay app (net of retainage) + sent invoice + draft invoice excluded', () => {
    // Pay app: $1,000 SOV line, 100% complete, 10% retainage, no prior app.
    //   completedToDateCents = 100000; retainage = round(100000*10%) = 10000
    //   L8 = (100000 - 10000) - previous(0) = 90000c
    createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    const app = createPayApp(db, 'p1', { retainagePercent: 10, storedRetainagePercent: 10 });
    const sov = listSovLines(db, 'p1');
    savePayAppLines(db, app.id, [{ sovLineId: sov[0].id, percentComplete: 100, storedMaterialsCents: 0 }], 1);
    setPayApp(db, app.id, { status: 'finalized' });
    recordPayment(db, 'payapp', app.id, { amount: 250 }); // 25000c of the 90000c billed

    // Sent invoice: $200 (20000c), $50 (5000c) paid.
    const inv = createInvoice(db, 'p1', { number: 'INV-1', status: 'sent', lines: [{ description: 'A', qty: 1, unitPrice: 200 }] });
    recordPayment(db, 'invoice', inv.id, { amount: 50 });

    // Draft invoice — not billed (excluded from listBilledDocuments/payApp
    // figures), but billingSummary's legacy invoiceTotalCents pre-existingly
    // sums ALL invoices including drafts, so it DOES land here — that's
    // existing behavior, unrelated to this change.
    createInvoice(db, 'p1', { number: 'INV-DRAFT', lines: [{ description: 'B', qty: 1, unitPrice: 999 }] });

    const s = billingSummary(db, 'p1');
    expect(s.payAppBilledCents).toBe(90000);
    expect(s.payAppOutstandingCents).toBe(65000); // 90000 - 25000
    expect(s.payAppPaidCents).toBe(25000);

    // Legacy invoice-only fields are unchanged by the new pay-app fields —
    // draft-INCLUSIVE (pre-existing behavior).
    expect(s.invoiceTotalCents).toBe(119900); // 20000 sent + 99900 draft (pre-existing behavior)
    expect(s.invoiceOutstandingCents).toBe(114900); // 119900 - 5000 paid
    expect(s.paid.payAppsCents).toBe(25000);

    // New invoice-leg fields are draft-EXCLUSIVE — only the sent invoice
    // counts, mirroring listBilledDocuments/the customer ledger.
    expect(s.invoiceBilledCents).toBe(20000);
    expect(s.invoicePaidCents).toBe(5000);
    expect(s.invoiceOutstandingBilledCents).toBe(15000); // 20000 - 5000

    // A caller that already fetched listBilledDocuments (customerOverview,
    // listProjectSummaries) can pass it in and get identical figures back,
    // without billingSummary re-querying the same rows.
    const docs = listBilledDocuments(db, 'p1');
    const s2 = billingSummary(db, 'p1', docs);
    expect(s2).toEqual(s);
  });

  it('is zero when the project has no finalized pay apps (draft apps excluded)', () => {
    createSovLine(db, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    createPayApp(db, 'p1', {}); // stays draft
    const s = billingSummary(db, 'p1');
    expect(s.payAppBilledCents).toBe(0);
    expect(s.payAppOutstandingCents).toBe(0);
  });
});

describe('updatedAt stamping', () => {
  it('saveInvoice and setInvoiceStatus bump updatedAt', async () => {
    const { id } = createInvoice(db, 'p1', { number: '1', lines: [] });
    const before = (getInvoice(db, id) as any).updatedAt;
    expect(typeof before).toBe('number');
    await new Promise(r => setTimeout(r, 2));
    saveInvoice(db, id, { ...getInvoice(db, id), version: 1, terms: 'net 30' });
    const afterSave = (getInvoice(db, id) as any).updatedAt;
    expect(afterSave).toBeGreaterThan(before);
    await new Promise(r => setTimeout(r, 2));
    setInvoiceStatus(db, id, 'sent');
    expect((getInvoice(db, id) as any).updatedAt).toBeGreaterThan(afterSave);
  });

  // Internal notes never print on the invoice PDF or go into invoice emails
  // (the owner's ruling), so a notes-only save must not flip the "up to date"
  // freshness chip — same reasoning as the RFI pendingReply exemption
  // (commit 5907997). version still bumps so live listeners refresh.
  it('a notes-only saveInvoice does not bump updatedAt, but bumps version', async () => {
    const { id } = createInvoice(db, 'p1', { number: '1', terms: 'net 30', lines: [{ description: 'A', qty: 1, unitPrice: 10 }] });
    const before = getInvoice(db, id) as any;
    await new Promise(r => setTimeout(r, 2));

    const afterNotes = saveInvoice(db, id, { ...before, notes: 'Left VM for the customer' });
    expect(afterNotes.version).toBe(before.version + 1);
    const reloaded = getInvoice(db, id) as any;
    expect(reloaded.notes).toBe('Left VM for the customer');
    expect(reloaded.updatedAt).toBe(before.updatedAt);

    // A real content change alongside a notes edit still bumps updatedAt.
    await new Promise(r => setTimeout(r, 2));
    const afterTerms = saveInvoice(db, id, { ...reloaded, terms: 'net 15', notes: 'and again' });
    expect(afterTerms.version).toBe(reloaded.version + 1);
    expect((getInvoice(db, id) as any).updatedAt).toBeGreaterThan(before.updatedAt);
  });

  it('saveChangeOrder and addChangeOrderPhoto bump updatedAt', async () => {
    const { id } = createChangeOrder(db, 'p1', { number: 'CO-1', lumpSumAmount: 100 });
    const before = (getChangeOrder(db, id) as any).updatedAt;
    expect(typeof before).toBe('number');
    await new Promise(r => setTimeout(r, 2));
    saveChangeOrder(db, id, { ...getChangeOrder(db, id), version: 1, description: 'updated' });
    const afterSave = (getChangeOrder(db, id) as any).updatedAt;
    expect(afterSave).toBeGreaterThan(before);
    await new Promise(r => setTimeout(r, 2));
    addChangeOrderPhoto(db, id, 'f1');
    expect((getChangeOrder(db, id) as any).updatedAt).toBeGreaterThan(afterSave);
  });

  // The invoice PDF and the pay-app G702 both print Paid-to-date and Balance,
  // so a payment is a change to what the stored document should say even though
  // no field on the invoice/pay-app row itself moved.
  it('recordPayment and deletePayment bump the target invoice updatedAt', async () => {
    const { id } = createInvoice(db, 'p1', { number: '1', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] });
    const before = (getInvoice(db, id) as any).updatedAt;
    await new Promise(r => setTimeout(r, 2));

    const pay = recordPayment(db, 'invoice', id, { amount: 40 });
    const afterAdd = (getInvoice(db, id) as any).updatedAt;
    expect(afterAdd).toBeGreaterThan(before);

    await new Promise(r => setTimeout(r, 2));
    deletePayment(db, pay.id);
    expect((getInvoice(db, id) as any).updatedAt).toBeGreaterThan(afterAdd);
  });

  it('recordPayment and deletePayment bump the target pay application updatedAt', async () => {
    db.prepare("INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt, updatedAt) VALUES ('app1', 'p1', 3, 'draft', 1, 1, 1)").run();
    const readAt = () => (db.prepare("SELECT updatedAt FROM aia_pay_apps WHERE id = 'app1'").get() as any).updatedAt;
    expect(readAt()).toBe(1);

    const pay = recordPayment(db, 'payapp', 'app1', { amount: 500 });
    const afterAdd = readAt();
    expect(afterAdd).toBeGreaterThan(1);

    await new Promise(r => setTimeout(r, 2));
    deletePayment(db, pay.id);
    expect(readAt()).toBeGreaterThan(afterAdd);
  });

  it('deletePayment on an unknown id is a no-op, not a crash', () => {
    expect(() => deletePayment(db, 'no-such-payment')).not.toThrow();
  });

  // Re-sending stamps nothing: updatedAt is the clock the "is the stored PDF
  // current?" chip reads, so a no-op status write would stale the very file the
  // send just mailed, with no way back to green.
  it('setInvoiceStatus leaves updatedAt and version alone when the status is unchanged', async () => {
    const { id } = createInvoice(db, 'p1', { number: '1', lines: [] });
    setInvoiceStatus(db, id, 'sent');
    const sent = getInvoice(db, id) as any;
    await new Promise(r => setTimeout(r, 2));

    const again = setInvoiceStatus(db, id, 'sent');
    const after = getInvoice(db, id) as any;
    expect(after.updatedAt).toBe(sent.updatedAt);
    expect(after.version).toBe(sent.version);
    expect(again).toEqual({ version: sent.version, status: 'sent' });
  });

  it('setChangeOrderStatus leaves updatedAt and version alone when the status is unchanged', async () => {
    const { id } = createChangeOrder(db, 'p1', { number: 'CO-1', lumpSumAmount: 100 });
    setChangeOrderStatus(db, id, 'sent');
    const sent = getChangeOrder(db, id) as any;
    await new Promise(r => setTimeout(r, 2));

    setChangeOrderStatus(db, id, 'sent');
    const after = getChangeOrder(db, id) as any;
    expect(after.updatedAt).toBe(sent.updatedAt);
    expect(after.version).toBe(sent.version);

    // A real transition still stamps.
    await new Promise(r => setTimeout(r, 2));
    setChangeOrderStatus(db, id, 'approved');
    expect((getChangeOrder(db, id) as any).updatedAt).toBeGreaterThan(sent.updatedAt);
  });
});
