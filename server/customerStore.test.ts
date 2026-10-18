import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listCustomers, getCustomer, saveCustomer, deleteCustomer, mergeCustomers, listProjectsForCustomer,
  customerSummaries, customerOverview,
} from './customerStore';
import { createInvoice, setInvoiceStatus, recordPayment } from './billingStore';
import { createSovLine, listSovLines, createPayApp, savePayAppLines, setPayApp } from './aiaStore';

function db(): Database.Database {
  const d = openDb(':memory:');
  runMigrations(d, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-cust-')), migrations);
  return d;
}

describe('customerStore', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('creates, reads, updates, lists', () => {
    saveCustomer(d, { id: 'c1', name: 'Acme', phone: '555', emails: { accounting: { to: 'ap@acme.com' }, estimating: { to: 'est@acme.com', cc: 'boss@acme.com' } } });
    const c = getCustomer(d, 'c1');
    expect(c!.name).toBe('Acme');
    expect(c!.emails.accounting!.to).toBe('ap@acme.com');
    expect(c!.emails.estimating!.cc).toBe('boss@acme.com');
    saveCustomer(d, { id: 'c1', name: 'Acme LLC', emails: { general: { to: 'info@acme.com' } } });
    expect(getCustomer(d, 'c1')!.name).toBe('Acme LLC');
    // migrations seed an "Unassigned" customer; we added one more
    expect(listCustomers(d).map(c2 => c2.id)).toContain('c1');
  });

  it('blocks deleting a customer that still owns projects', () => {
    saveCustomer(d, { id: 'c1', name: 'Acme', emails: {} as any });
    d.prepare('INSERT INTO projects (id, customerId) VALUES (?, ?)').run('p1', 'c1');
    expect(() => deleteCustomer(d, 'c1')).toThrow(/project/i);
    d.prepare('UPDATE projects SET customerId = NULL WHERE id = ?').run('p1');
    expect(() => deleteCustomer(d, 'c1')).not.toThrow();
  });

  it('merges: moves projects, fills blank target fields, deletes sources', () => {
    saveCustomer(d, { id: 'target', name: 'Acme', emails: { accounting: { to: 'ap@acme.com' } } });
    saveCustomer(d, { id: 'dup', name: 'Acme Inc', phone: '999', emails: { general: { to: 'info@acme.com' }, accounting: { to: 'other@x.com' } } });
    d.prepare('INSERT INTO projects (id, customerId) VALUES (?, ?)').run('p1', 'dup');
    mergeCustomers(d, 'target', ['dup']);
    expect(getCustomer(d, 'dup')).toBeNull();
    expect(listProjectsForCustomer(d, 'target').map((p: any) => p.id)).toContain('p1');
    const t = getCustomer(d, 'target')!;
    expect(t.phone).toBe('999');
    expect(t.emails.accounting!.to).toBe('ap@acme.com');
    expect(t.emails.general!.to).toBe('info@acme.com');
  });
});

// Local YYYY-MM-DD offset from today — mirrors customerStore's todayStr()
// comparison base. Using toISOString() (UTC) here would drift a day off
// local "today" depending on timezone and time of day, making these
// fixtures flaky rather than date-robust.
function daysFromToday(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('customerSummaries / customerOverview', () => {
  let d: Database.Database;
  let cid: string;
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    d = db();
    const c = saveCustomer(d, { id: 'cust-1', name: 'Acme', contactName: 'Jo', phone: '555-1', emails: {} as any });
    cid = c.id;

    // bidding project with bidDueDate 10 days out
    d.prepare(`INSERT INTO projects (id, name, customerId, status, bidDueDate, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('p-bid', 'Bid Project', cid, 'bidding', Date.now() + 10 * DAY, Date.now());

    // in_progress project with a sent, unpaid $100 invoice
    d.prepare(`INSERT INTO projects (id, name, customerId, status, version, createdAt) VALUES (?, ?, ?, ?, 1, ?)`)
      .run('p-prog', 'Active Project', cid, 'in_progress', Date.now());
    const inv = createInvoice(d, 'p-prog', { number: 'INV-1', date: Date.now(), lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] });
    setInvoiceStatus(d, inv.id, 'sent');

    // archived project — also carries a sent, unpaid invoice, which must NOT
    // leak into outstanding totals / ledger / attention for non-archived rollups.
    d.prepare(`INSERT INTO projects (id, name, customerId, status, meta, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('p-arch', 'Archived Project', cid, 'in_progress', JSON.stringify({ archived: true }), Date.now());
    const archInv = createInvoice(d, 'p-arch', { number: 'INV-ARCH', date: Date.now(), lines: [{ description: 'Old work', qty: 1, unitPrice: 50 }] });
    setInvoiceStatus(d, archInv.id, 'sent');

    // tasks: one overdue (yesterday, todo), one done (should not count as open)
    const yesterday = daysFromToday(-1);
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, customerId, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('t-overdue', 'Call back', 'todo', yesterday, cid, Date.now());
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, customerId, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('t-done', 'Finished', 'done', yesterday, cid, Date.now());
  });

  it('customerSummaries rolls up project counts, task counts, and outstanding cents (archived excluded)', () => {
    const rows = customerSummaries(d, true);
    const row = rows.find(r => r.id === cid)!;
    expect(row.projectCounts).toEqual({ bidding: 1, inProgress: 1, archived: 1 });
    expect(row.openTaskCount).toBe(1);
    expect(row.overdueTaskCount).toBe(1);
    expect(row.outstandingCents).toBe(10000); // only p-prog's $100 — archived $50 excluded
  });

  it('customerSummaries omits outstandingCents when includeBilling is false', () => {
    const rows = customerSummaries(d, false);
    const row = rows.find(r => r.id === cid)!;
    expect(row.outstandingCents).toBeUndefined();
  });

  it('overdue comparison crosses month boundaries correctly (not a same-month fluke)', () => {
    // 40 days always crosses at least one month boundary, whatever "today" is.
    const old = daysFromToday(-40);
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, customerId, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('t-old', 'Old overdue', 'todo', old, cid, Date.now());
    const row = customerSummaries(d, false).find(r => r.id === cid)!;
    expect(row.overdueTaskCount).toBe(2); // t-overdue (yesterday) + t-old (40 days ago)
  });

  it('customerOverview returns projects, billing ledger, attention, and task counts (admin)', () => {
    const ov = customerOverview(d, cid, true)!;
    expect(ov.customer.id).toBe(cid);
    expect(ov.projects.map((p: any) => p.id).sort()).toEqual(['p-arch', 'p-bid', 'p-prog']);
    expect(ov.taskCounts).toEqual({ open: 1, overdue: 1 });

    // billing rollup + ledger exclude the archived project's invoice
    expect(ov.billing.outstandingCents).toBe(10000);
    expect(ov.billing.ledger).toHaveLength(1);
    expect(ov.billing.ledger[0]).toMatchObject({ projectId: 'p-prog', kind: 'invoice', balanceCents: 10000 });

    const types = ov.attention.map((a: any) => a.type).sort();
    expect(types).toEqual(['bid_due', 'outstanding_invoice', 'overdue_task']);
    expect(ov.attention.find((a: any) => a.type === 'outstanding_invoice')!.projectId).toBe('p-prog');
  });

  it('customerOverview omits billing and money-attention for non-admin', () => {
    const ov = customerOverview(d, cid, false)!;
    expect(ov.billing).toBeUndefined();
    const types = ov.attention.map((a: any) => a.type);
    expect(types).not.toContain('outstanding_invoice');
    expect(types).toContain('overdue_task');
    expect(types).toContain('bid_due');
  });

  it('returns null for an unknown customer', () => {
    expect(customerOverview(d, 'nope', true)).toBeNull();
  });

  it('an overdue task tied to an archived project is excluded from counts and attention; the same task tied to a live project counts', () => {
    const yesterday = daysFromToday(-1);
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, customerId, projectId, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      .run('t-arch-task', 'Archived project task', 'todo', yesterday, cid, 'p-arch', Date.now());

    // baseline already has 1 overdue/open task (t-overdue, no projectId) — the
    // archived-project task must NOT add to it.
    const before = customerSummaries(d, false).find(r => r.id === cid)!;
    expect(before.overdueTaskCount).toBe(1);
    expect(before.openTaskCount).toBe(1);

    const ovBefore = customerOverview(d, cid, false)!;
    expect(ovBefore.taskCounts).toEqual({ open: 1, overdue: 1 });
    expect(ovBefore.attention.some((a: any) => a.taskId === 't-arch-task')).toBe(false);

    // Retarget the same task to a live project — it must now count.
    d.prepare(`UPDATE tasks SET projectId = ? WHERE id = ?`).run('p-prog', 't-arch-task');
    const after = customerSummaries(d, false).find(r => r.id === cid)!;
    expect(after.overdueTaskCount).toBe(2);
    expect(after.openTaskCount).toBe(2);

    const ovAfter = customerOverview(d, cid, false)!;
    expect(ovAfter.taskCounts).toEqual({ open: 2, overdue: 2 });
    expect(ovAfter.attention.some((a: any) => a.taskId === 't-arch-task')).toBe(true);
  });

  // An AIA-billed project has no invoices at all — its money lives in pay
  // applications — so every figure below used to read $0 for it.
  it('a finalized pay app counts toward outstanding in summaries, the rollup, the project row, and the ledger', () => {
    d.prepare(`INSERT INTO projects (id, name, customerId, status, version, createdAt) VALUES (?, ?, ?, ?, 1, ?)`)
      .run('p-aia', 'AIA Project', cid, 'in_progress', Date.now());
    // $1,000 of scheduled value, billed 100% with retainage off so line 8
    // (current payment due) is exactly the scheduled value — no rounding.
    createSovLine(d, 'p-aia', { description: 'Framing', scheduledValueCents: 100000 });
    const app = createPayApp(d, 'p-aia', { applicationDate: '2026-08-01', retainagePercent: 0, storedRetainagePercent: 0 });
    const sov = listSovLines(d, 'p-aia');
    savePayAppLines(d, app.id, [{ sovLineId: sov[0].id, percentComplete: 100, storedMaterialsCents: 0 }], 1);

    // While it's still a draft it is not billed, so nothing moves.
    expect(customerSummaries(d, true).find(r => r.id === cid)!.outstandingCents).toBe(10000);
    expect(customerOverview(d, cid, true)!.billing.ledger.some((l: any) => l.kind === 'payapp')).toBe(false);

    setPayApp(d, app.id, { status: 'finalized' });
    recordPayment(d, 'payapp', app.id, { amount: 250 }); // $250 of the $1,000

    // p-prog's unpaid $100 invoice + the pay app's $750 balance.
    expect(customerSummaries(d, true).find(r => r.id === cid)!.outstandingCents).toBe(85000);

    const ov = customerOverview(d, cid, true)!;
    expect(ov.projects.find((p: any) => p.id === 'p-aia').outstandingCents).toBe(75000);
    // All three legs cover the same documents: $100 invoice + $1,000 pay app.
    expect(ov.billing.invoicedCents).toBe(110000);
    expect(ov.billing.paidCents).toBe(25000);
    expect(ov.billing.outstandingCents).toBe(85000);

    // Split: contract (payapp) leg is the $1,000 pay app; invoices leg is the
    // $100 sent invoice. Each combined figure above equals the two legs summed.
    expect(ov.billing.contract).toEqual({ billedCents: 100000, paidCents: 25000, outstandingCents: 75000 });
    expect(ov.billing.invoices).toEqual({ invoicedCents: 10000, paidCents: 0, outstandingCents: 10000 });
    expect(ov.billing.contract.billedCents + ov.billing.invoices.invoicedCents).toBe(ov.billing.invoicedCents);
    expect(ov.billing.contract.paidCents + ov.billing.invoices.paidCents).toBe(ov.billing.paidCents);
    expect(ov.billing.contract.outstandingCents + ov.billing.invoices.outstandingCents).toBe(ov.billing.outstandingCents);

    const payAppRow = ov.billing.ledger.find((l: any) => l.kind === 'payapp');
    expect(payAppRow).toMatchObject({
      projectId: 'p-aia', number: 1, status: 'finalized',
      totalCents: 100000, paidCents: 25000, balanceCents: 75000,
    });
    expect(ov.attention.filter((a: any) => a.type === 'outstanding_invoice').map((a: any) => a.label))
      .toContain('Application #1 — AIA Project');
  });

  it('a fully paid invoice stays in the ledger with a zero balance; a draft never appears', () => {
    const paid = createInvoice(d, 'p-prog', { number: 'INV-PAID', date: Date.now(), lines: [{ description: 'Done', qty: 1, unitPrice: 200 }] });
    setInvoiceStatus(d, paid.id, 'paid');
    recordPayment(d, 'invoice', paid.id, { amount: 200 });
    createInvoice(d, 'p-prog', { number: 'INV-DRAFT', date: Date.now(), lines: [{ description: 'Not sent', qty: 1, unitPrice: 999 }] });

    const ov = customerOverview(d, cid, true)!;
    expect(ov.billing.ledger.find((l: any) => l.number === 'INV-PAID')).toMatchObject({
      kind: 'invoice', status: 'paid', totalCents: 20000, paidCents: 20000, balanceCents: 0,
    });
    expect(ov.billing.ledger.some((l: any) => l.number === 'INV-DRAFT')).toBe(false);

    // The paid invoice adds to Invoiced and Paid equally, so Outstanding is
    // unchanged; the draft moves none of the three.
    expect(ov.billing.invoicedCents).toBe(30000);
    expect(ov.billing.paidCents).toBe(20000);
    expect(ov.billing.outstandingCents).toBe(10000);
    // A zero-balance document is not something to chase.
    expect(ov.attention.filter((a: any) => a.type === 'outstanding_invoice')).toHaveLength(1);
  });

  it('a bidding project with a past-due bidDueDate still appears in attention, flagged overdue', () => {
    d.prepare(`INSERT INTO projects (id, name, customerId, status, bidDueDate, version, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)`)
      .run('p-bid-late', 'Late Bid', cid, 'bidding', Date.now() - DAY, Date.now());

    const ov = customerOverview(d, cid, false)!;
    const late = ov.attention.find((a: any) => a.type === 'bid_due' && a.projectId === 'p-bid-late');
    expect(late).toBeDefined();
    expect(late.overdue).toBe(true);

    // The existing upcoming bid (p-bid, +10 days) must NOT carry the overdue flag.
    const upcoming = ov.attention.find((a: any) => a.type === 'bid_due' && a.projectId === 'p-bid');
    expect(upcoming.overdue).toBeUndefined();
  });

  it('customerOverview.billing.aging buckets outstanding docs by age (current/31-60/61+)', () => {
    // beforeEach already seeded p-prog with a sent, unpaid $100 invoice dated
    // "now" — that one lands in `current` alongside the 10-day invoice below.
    const inv10 = createInvoice(d, 'p-prog', { number: 'INV-10D', date: Date.now() - 10 * DAY, lines: [{ description: 'A', qty: 1, unitPrice: 200 }] });
    setInvoiceStatus(d, inv10.id, 'sent');
    const inv45 = createInvoice(d, 'p-prog', { number: 'INV-45D', date: Date.now() - 45 * DAY, lines: [{ description: 'B', qty: 1, unitPrice: 300 }] });
    setInvoiceStatus(d, inv45.id, 'sent');
    const inv90 = createInvoice(d, 'p-prog', { number: 'INV-90D', date: Date.now() - 90 * DAY, lines: [{ description: 'C', qty: 1, unitPrice: 400 }] });
    setInvoiceStatus(d, inv90.id, 'sent');

    const ov = customerOverview(d, cid, true)!;
    expect(ov.billing.aging).toEqual({
      current: 30000,      // p-prog's original $100 (age 0) + the $200 10-day-old invoice
      days31to60: 30000,   // the $300 45-day-old invoice
      days61plus: 40000,   // the $400 90-day-old invoice
    });
  });

  it('customerOverview.billing.aging is undefined for non-admin (no billing object at all)', () => {
    const ov = customerOverview(d, cid, false)!;
    expect(ov.billing).toBeUndefined();
  });
});
