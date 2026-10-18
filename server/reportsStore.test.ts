// server/reportsStore.test.ts — the Reports page's four reports (spec
// docs/superpowers/specs/2026-10-06-reports-design.md).
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { createInvoice, recordPayment, setInvoiceStatus, createChangeOrder, setChangeOrderStatus, billingSummary } from './billingStore';
import { createSovLine, createPayApp, savePayAppLines, setPayApp, computeG702 } from './aiaStore';
import { dashboardMoney } from './dashboardStore';
import {
  openInvoicesReport, paymentsReport, changeOrdersReport, retainageReport, reportFilterOptions, ValidationError,
} from './reportsStore';
import { useTimeZone } from '../src/test/timeZone';

const DAY = 24 * 60 * 60 * 1000;
// Noon UTC, so day arithmetic below never straddles a date line.
const NOW = Date.UTC(2026, 9, 6, 12);

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-rep-')), migrations);
  db.prepare(`INSERT INTO customers (id, name, createdAt, updatedAt) VALUES ('c1', 'Acme Builders', 1, 1), ('c2', 'Beta GC', 1, 1)`).run();
  const proj = db.prepare('INSERT INTO projects (id, name, customerId, meta, createdAt) VALUES (?, ?, ?, ?, 1)');
  proj.run('p1', 'Dunmore Heights', 'c1', '{}');
  proj.run('p2', 'Hartwell', 'c2', '{}');
  proj.run('p3', 'Old Job', 'c1', JSON.stringify({ archived: true }));
});

// A billed (sent) invoice dated `ageInDays` before NOW, for `dollars`.
const sentInvoice = (projectId: string, number: string, dollars: number, ageInDays: number | null) =>
  createInvoice(db, projectId, {
    number, status: 'sent', date: ageInDays == null ? null : NOW - ageInDays * DAY,
    lines: [{ description: 'Work', qty: 1, unitPrice: dollars }],
  }).id;

// A finalized pay application on a one-line $10,000 SOV, `pct` complete.
const finalizedPayApp = (projectId: string, pct: number, applicationDate: string | null, retainagePercent = 10) => {
  const sov = (db.prepare('SELECT id FROM aia_sov_lines WHERE projectId = ?').get(projectId) as { id: string } | undefined)?.id
    ?? createSovLine(db, projectId, { itemNo: '1', description: 'Plaster', scheduledValueCents: 1000000 }).id;
  const app = createPayApp(db, projectId, { applicationDate, retainagePercent });
  savePayAppLines(db, app.id, [{ sovLineId: sov, percentComplete: pct, storedMaterialsCents: 0 }], 1);
  setPayApp(db, app.id, { status: 'finalized' });
  return app;
};

describe('openInvoicesReport', () => {
  it('lists every billed invoice and pay app with a balance, whatever its status says', () => {
    const open = sentInvoice('p1', '1001', 500, 10);
    const paid = sentInvoice('p1', '1002', 100, 10);
    recordPayment(db, 'invoice', paid, { amount: 100 }); // fully paid — gone
    createInvoice(db, 'p1', { number: '1003', date: NOW, lines: [{ description: 'Draft', qty: 1, unitPrice: 50 }] }); // draft — not billed
    const handMarked = sentInvoice('p2', '2001', 300, 5);
    recordPayment(db, 'invoice', handMarked, { amount: 100 });
    setInvoiceStatus(db, handMarked, 'paid'); // marked paid by hand, $200 still owing
    const app = finalizedPayApp('p2', 50, '2026-09-01'); // L8 = $5,000 − 10% = $4,500

    const r = openInvoicesReport(db, {}, NOW);
    expect(r.rows.map(x => [x.document, x.projectName, x.customerName, x.status, x.balanceCents])).toEqual([
      ['Pay App #1', 'Hartwell', 'Beta GC', 'finalized', 450000],
      ['Invoice 1001', 'Dunmore Heights', 'Acme Builders', 'sent', 50000],
      ['Invoice 2001', 'Hartwell', 'Beta GC', 'paid', 20000],
    ]);
    expect(r.rows[0]).toMatchObject({ kind: 'payapp', id: app.id, date: '2026-09-01', totalCents: 450000, paidCents: 0 });
    expect(r.rows[1]).toMatchObject({ kind: 'invoice', id: open, date: '2026-09-26', daysOutstanding: 10, bucket: 'current' });
  });

  it('ages from the document date into the dashboard\'s buckets, oldest first, with per-bucket subtotals', () => {
    sentInvoice('p1', 'A', 100, 30);   // last day of 0–30
    sentInvoice('p1', 'B', 200, 31);   // 31–60
    sentInvoice('p1', 'C', 300, 60);
    sentInvoice('p1', 'D', 400, 61);   // 61+
    sentInvoice('p1', 'E', 50, null);  // no date: no age, no dated bucket
    const r = openInvoicesReport(db, { projectId: 'p1' }, NOW);
    expect(r.rows.map(x => [x.document, x.daysOutstanding, x.bucket])).toEqual([
      ['Invoice D', 61, 'days61plus'], ['Invoice C', 60, 'days31to60'], ['Invoice B', 31, 'days31to60'],
      ['Invoice A', 30, 'current'], ['Invoice E', null, null],
    ]);
    expect(r.buckets).toEqual({ current: 10000, days31to60: 50000, days61plus: 40000, undated: 5000 });
    expect(r.totals).toEqual({ count: 5, totalCents: 105000, paidCents: 0, balanceCents: 105000 });
  });

  it('agrees with the dashboard\'s Outstanding and Aging once archived projects are left out', () => {
    const now = Date.now();
    createInvoice(db, 'p1', { number: '1', status: 'sent', date: now - 3 * DAY, lines: [{ description: 'x', qty: 1, unitPrice: 0.1 }] });
    const part = createInvoice(db, 'p2', { number: '2', status: 'sent', date: now - 45 * DAY, lines: [{ description: 'x', qty: 3, unitPrice: 33.33 }] }).id;
    recordPayment(db, 'invoice', part, { amount: 0.2 });
    createInvoice(db, 'p3', { number: '3', status: 'sent', date: now - 90 * DAY, lines: [{ description: 'x', qty: 1, unitPrice: 70 }] });
    finalizedPayApp('p2', 25, null);

    const money = dashboardMoney(db);
    const r = openInvoicesReport(db, { includeArchived: false }, now);
    const { undated, ...dated } = r.buckets;
    expect(dated).toEqual(money.aging);
    expect(r.totals.balanceCents).toBe(money.outstandingCents);
    expect(undated).toBe(225000); // the undated pay app: in Outstanding, in no dated bucket

    // Archived projects are in by default — money owed on them is still owed.
    expect(openInvoicesReport(db, {}, now).rows.map(x => x.projectName)).toContain('Old Job');
  });

  it('filters by project and by customer', () => {
    sentInvoice('p1', '1', 100, 1);
    sentInvoice('p2', '2', 100, 1);
    sentInvoice('p3', '3', 100, 1);
    expect(openInvoicesReport(db, { projectId: 'p2' }, NOW).rows.map(x => x.document)).toEqual(['Invoice 2']);
    expect(openInvoicesReport(db, { customerId: 'c1' }, NOW).rows.map(x => x.document).sort()).toEqual(['Invoice 1', 'Invoice 3']);
    expect(openInvoicesReport(db, { customerId: 'c1', includeArchived: false }, NOW).rows.map(x => x.document)).toEqual(['Invoice 1']);
    expect(openInvoicesReport(db, { customerId: 'nobody' }, NOW).rows).toEqual([]);
  });
});

describe('paymentsReport', () => {
  const day = (iso: string) => new Date(iso).getTime(); // what the date box stores: UTC midnight
  beforeEach(() => {
    const inv = sentInvoice('p1', '1001', 1000, 30);
    const app = finalizedPayApp('p2', 50, '2026-09-01');
    recordPayment(db, 'invoice', inv, { date: day('2026-09-30'), amount: 0.1, method: 'check', note: 'deposit' });
    recordPayment(db, 'invoice', inv, { date: day('2026-10-01'), amount: 0.2, method: 'ach' });
    recordPayment(db, 'payapp', app.id, { date: day('2026-10-31'), amount: 250.5, method: 'wire', note: 'App 1' });
    recordPayment(db, 'payapp', app.id, { date: day('2026-11-01'), amount: 99 });
  });

  it('lists payments in the range (both ends inclusive), newest first, with what they paid and a cents total', () => {
    const r = paymentsReport(db, { from: '2026-10-01', to: '2026-10-31' });
    expect(r.rows.map(x => [x.date, x.target, x.projectName, x.customerName, x.method, x.note, x.amountCents])).toEqual([
      ['2026-10-31', 'Pay App #1', 'Hartwell', 'Beta GC', 'wire', 'App 1', 25050],
      ['2026-10-01', 'Invoice 1001', 'Dunmore Heights', 'Acme Builders', 'ach', null, 20],
    ]);
    expect(r.totals).toEqual({ count: 2, amountCents: 25070 });
    // Attachments stay on the payment — never in a report.
    expect(Object.keys(r.rows[0])).not.toContain('attachments');
  });

  it('open-ended ranges and no range at all; project and customer filters', () => {
    expect(paymentsReport(db, { from: '2026-10-01' }).totals.count).toBe(3);
    expect(paymentsReport(db, { to: '2026-09-30' }).rows.map(x => x.amountCents)).toEqual([10]);
    const all = paymentsReport(db);
    expect(all.totals).toEqual({ count: 4, amountCents: 10 + 20 + 25050 + 9900 });
    expect(paymentsReport(db, { projectId: 'p1' }).totals.amountCents).toBe(30); // 0.1 + 0.2, no float drift
    expect(paymentsReport(db, { customerId: 'c2' }).rows.every(x => x.targetType === 'payapp')).toBe(true);
  });

  describe('on a server west of UTC', () => {
    useTimeZone('America/Los_Angeles');

    it('keeps each picked day, and files a payment stamped "now" under the server\'s local day', () => {
      const inv = sentInvoice('p2', '2001', 100, 30);
      recordPayment(db, 'invoice', inv, { date: Date.UTC(2026, 9, 21, 3, 30), amount: 5 }); // Oct 20, 8:30pm in Los Angeles
      expect(paymentsReport(db, { from: '2026-10-01', to: '2026-10-31' }).rows.map(x => [x.date, x.amountCents])).toEqual([
        ['2026-10-31', 25050], ['2026-10-20', 500], ['2026-10-01', 20],
      ]);
    });
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(() => paymentsReport(db, { from: 'last month' })).toThrow(ValidationError);
    expect(() => paymentsReport(db, { to: '10/31/2026' })).toThrow(ValidationError);
  });
});

describe('changeOrdersReport', () => {
  beforeEach(() => {
    const co = (projectId: string, number: string, title: string, dollars: number, status: string, impact: number | null = null) => {
      const { id } = createChangeOrder(db, projectId, { number, title, lumpSumAmount: dollars, scheduleImpactDays: impact, date: Date.UTC(2026, 8, 15) });
      if (status !== 'draft') setChangeOrderStatus(db, id, status);
      return id;
    };
    co('p1', '002', 'Extra soffit', 1200, 'sent', 3);
    co('p1', '001', 'Patch wall', 300.1, 'approved');
    co('p2', '001', 'Night work', 800, 'sent', 2);
    co('p2', '002', 'Wrong color', 150, 'rejected');
    co('p2', '003', 'Scaffold', 0.2, 'draft', 1);
    // A legacy row from before the draft/sent/approved/rejected lifecycle.
    db.prepare(`INSERT INTO change_orders (id, projectId, number, title, description, amount, status, createdAt)
                VALUES ('legacy', 'p1', '000', NULL, 'Old extra', 75, 'pending', 1)`).run();
  });

  it('lists every change order by project then number, with per-status totals; legacy pending counts as draft', () => {
    const r = changeOrdersReport(db);
    expect(r.rows.map(x => [x.projectName, x.number, x.title, x.status, x.statusGroup, x.amountCents, x.scheduleImpactDays])).toEqual([
      ['Dunmore Heights', '000', 'Old extra', 'pending', 'draft', 7500, null],
      ['Dunmore Heights', '001', 'Patch wall', 'approved', 'approved', 30010, null],
      ['Dunmore Heights', '002', 'Extra soffit', 'sent', 'sent', 120000, 3],
      ['Hartwell', '001', 'Night work', 'sent', 'sent', 80000, 2],
      ['Hartwell', '002', 'Wrong color', 'rejected', 'rejected', 15000, null],
      ['Hartwell', '003', 'Scaffold', 'draft', 'draft', 20, 1],
    ]);
    expect(r.rows[1].date).toBe('2026-09-15');
    expect(r.byStatus).toEqual({
      draft: { count: 2, amountCents: 7520, scheduleImpactDays: 1 },
      sent: { count: 2, amountCents: 200000, scheduleImpactDays: 5 },
      approved: { count: 1, amountCents: 30010, scheduleImpactDays: 0 },
      rejected: { count: 1, amountCents: 15000, scheduleImpactDays: 0 },
    });
    expect(r.totals).toEqual({ count: 6, amountCents: 252530, scheduleImpactDays: 6 });
    // Approved amounts are what the contract total adds.
    expect(changeOrdersReport(db, { projectId: 'p1', status: 'approved' }).totals.amountCents)
      .toBe(billingSummary(db, 'p1').approvedChangeCents);
  });

  it('filters by status ("waiting on approval" = sent) and by project/customer', () => {
    const sent = changeOrdersReport(db, { status: 'sent' });
    expect(sent.rows.map(x => x.title)).toEqual(['Extra soffit', 'Night work']);
    expect(sent.totals).toEqual({ count: 2, amountCents: 200000, scheduleImpactDays: 5 });
    expect(sent.byStatus.approved.count).toBe(0);
    expect(changeOrdersReport(db, { status: 'draft' }).rows.map(x => x.number)).toEqual(['000', '003']);
    expect(changeOrdersReport(db, { customerId: 'c2', status: 'rejected' }).rows.map(x => x.title)).toEqual(['Wrong color']);
    expect(() => changeOrdersReport(db, { status: 'pending' })).toThrow(ValidationError);
  });
});

describe('retainageReport', () => {
  it('reads the latest non-draft pay application\'s G702: contract sum, completed & stored, retainage held and released', () => {
    finalizedPayApp('p1', 40, '2026-08-31');
    const second = finalizedPayApp('p1', 60, '2026-09-30');
    setPayApp(db, second.id, { releasedRetainagePoints: 4 }); // 10% → 6%
    createPayApp(db, 'p1', { applicationDate: '2026-10-31' }); // a draft after it doesn't count
    finalizedPayApp('p2', 100, '2026-09-15', 5);
    createPayApp(db, 'p3', {}); // only a draft: no row

    const g = computeG702(db, second.id);
    const r = retainageReport(db);
    expect(r.rows.map(x => [x.projectName, x.payAppNumber, x.applicationDate])).toEqual([
      ['Dunmore Heights', 2, '2026-09-30'], ['Hartwell', 1, '2026-09-15'],
    ]);
    expect(r.rows[0]).toMatchObject({
      payAppId: second.id,
      contractSumCents: g.L3contractSumToDateCents, completedStoredCents: g.L4totalCompletedStoredCents,
      retainageHeldCents: g.L5retainageCents, retainagePercent: 10, releasedPoints: 4, retainageMode: 'uniform',
    });
    expect(r.rows[0]).toMatchObject({ contractSumCents: 1000000, completedStoredCents: 600000, retainageHeldCents: 36000, retainageReleasedCents: 24000 });
    expect(r.rows[1]).toMatchObject({ completedStoredCents: 1000000, retainageHeldCents: 50000, retainageReleasedCents: 0 });
    expect(r.totals).toEqual({ contractSumCents: 2000000, completedStoredCents: 1600000, retainageHeldCents: 86000, retainageReleasedCents: 24000 });
  });

  it('filters by project and customer, and can leave archived projects out', () => {
    finalizedPayApp('p1', 50, null);
    finalizedPayApp('p3', 50, null);
    expect(retainageReport(db, { customerId: 'c1' }).rows.map(x => x.projectName)).toEqual(['Dunmore Heights', 'Old Job']);
    expect(retainageReport(db, { customerId: 'c1', includeArchived: false }).rows.map(x => x.projectName)).toEqual(['Dunmore Heights']);
    expect(retainageReport(db, { projectId: 'p2' }).rows).toEqual([]);
  });
});

describe('reportFilterOptions', () => {
  it('lists projects (with customer and archived flag) and customers by name', () => {
    expect(reportFilterOptions(db)).toEqual({
      projects: [
        { id: 'p1', name: 'Dunmore Heights', customerId: 'c1', archived: false },
        { id: 'p2', name: 'Hartwell', customerId: 'c2', archived: false },
        { id: 'p3', name: 'Old Job', customerId: 'c1', archived: true },
      ],
      customers: expect.arrayContaining([{ id: 'c1', name: 'Acme Builders' }, { id: 'c2', name: 'Beta GC' }]),
    });
  });
});
