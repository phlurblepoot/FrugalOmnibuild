// server/dashboardStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { createInvoice, setInvoiceStatus, recordPayment } from './billingStore';
import { createSovLine, savePayAppLines } from './aiaStore';
import { logActivity } from './activity';
import { dashboardAttention, dashboardMoney, projectHappenings, ageDays, agingBucket } from './dashboardStore';

const DAY = 24 * 60 * 60 * 1000;

function db(): Database.Database {
  const d = openDb(':memory:');
  runMigrations(d, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-dash-')), migrations);
  return d;
}

// Local YYYY-MM-DD offset from today — mirrors customerStore.test.ts's
// daysFromToday helper so task dueDate comparisons aren't UTC/local-drift flaky.
function daysFromToday(offsetDays: number): string {
  const dt = new Date();
  dt.setDate(dt.getDate() + offsetDays);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

describe('dashboardAttention', () => {
  let d: Database.Database;
  beforeEach(() => { d = db(); });

  it('flags an overdue task with red severity', () => {
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, version, createdAt) VALUES (?, ?, 'todo', ?, 1, ?)`)
      .run('t1', 'Follow up with client', daysFromToday(-1), Date.now());
    const items = dashboardAttention(d, false);
    const item = items.find(i => i.itemId === 't1')!;
    expect(item).toBeTruthy();
    expect(item.type).toBe('overdue_task');
    expect(item.severity).toBe('red');
    expect(item.label).toBe('Follow up with client');
  });

  it('flags a bid due within 14 days as amber and a past-due bid as red', () => {
    d.prepare(`INSERT INTO projects (id, name, status, bidDueDate, version, createdAt) VALUES (?, ?, 'bidding', ?, 1, ?)`)
      .run('p-soon', 'Soon Bid', Date.now() + 5 * DAY, Date.now());
    d.prepare(`INSERT INTO projects (id, name, status, bidDueDate, version, createdAt) VALUES (?, ?, 'bidding', ?, 1, ?)`)
      .run('p-late', 'Late Bid', Date.now() - 2 * DAY, Date.now());
    const items = dashboardAttention(d, false);
    const soon = items.find(i => i.projectId === 'p-soon')!;
    const late = items.find(i => i.projectId === 'p-late')!;
    expect(soon.type).toBe('bid_due');
    expect(soon.severity).toBe('amber');
    expect(late.type).toBe('bid_due');
    expect(late.severity).toBe('red');
  });

  it('skips archived projects entirely', () => {
    d.prepare(`INSERT INTO projects (id, name, status, bidDueDate, meta, version, createdAt) VALUES (?, ?, 'bidding', ?, ?, 1, ?)`)
      .run('p-arch', 'Archived Bid', Date.now() - 2 * DAY, JSON.stringify({ archived: true }), Date.now());
    const items = dashboardAttention(d, false);
    expect(items.find(i => i.projectId === 'p-arch')).toBeUndefined();
  });

  it('flags an open RFI sent more than 7 days ago', () => {
    d.prepare(`INSERT INTO projects (id, name, status, version, createdAt) VALUES ('p1', 'Proj', 'in_progress', 1, ?)`).run(Date.now());
    d.prepare(`INSERT INTO rfis (id, projectId, number, title, status, sentAt, version, createdAt) VALUES (?, ?, ?, ?, 'open', ?, 1, ?)`)
      .run('rfi1', 'p1', 3, 'Ceiling height', Date.now() - 8 * DAY, Date.now());
    const items = dashboardAttention(d, false);
    const item = items.find(i => i.itemId === 'rfi1')!;
    expect(item).toBeTruthy();
    expect(item.type).toBe('stale_rfi');
    expect(item.label).toContain('RFI #3');
    expect(item.projectId).toBe('p1');
  });

  it('omits money items for non-admins', () => {
    d.prepare(`INSERT INTO projects (id, name, status, version, createdAt) VALUES ('p1', 'Proj', 'in_progress', 1, ?)`).run(Date.now());
    const inv = createInvoice(d, 'p1', { number: 'INV-1', date: Date.now() - 20 * DAY, lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] });
    setInvoiceStatus(d, inv.id, 'sent');

    const nonAdminItems = dashboardAttention(d, false);
    expect(nonAdminItems.find(i => i.type === 'aging_receivable')).toBeUndefined();

    const adminItems = dashboardAttention(d, true);
    const item = adminItems.find(i => i.type === 'aging_receivable')!;
    expect(item).toBeTruthy();
    expect(item.balanceCents).toBe(10000);
    expect(item.projectId).toBe('p1');
  });

  it('flags a pay app sitting in draft more than 5 days (admin only)', () => {
    d.prepare(`INSERT INTO projects (id, name, status, version, createdAt) VALUES ('p1', 'Proj', 'in_progress', 1, ?)`).run(Date.now());
    d.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES (?, ?, ?, 'draft', 1, ?)`)
      .run('app1', 'p1', 2, Date.now() - 6 * DAY);

    expect(dashboardAttention(d, false).find(i => i.type === 'draft_payapp')).toBeUndefined();

    const item = dashboardAttention(d, true).find(i => i.type === 'draft_payapp')!;
    expect(item).toBeTruthy();
    expect(item.label).toContain('Pay app #2');
    expect(item.projectId).toBe('p1');
  });

  it('draft pay app attention item carries balanceCents from computeG702 L8', () => {
    // Mirrors aiaStore.test.ts's "list figures" seed: a $1,000 SOV line at 50%
    // complete with default 10% retainage → L8 = round(100000*50%) - round(50000*10%)
    // = 50000 - 5000 = 45000c.
    d.prepare(`INSERT INTO projects (id, name, status, version, createdAt) VALUES ('p1', 'Proj', 'in_progress', 1, ?)`).run(Date.now());
    const { id: sov1 } = createSovLine(d, 'p1', { description: 'Framing', scheduledValueCents: 100000 });
    d.prepare(`INSERT INTO aia_pay_apps (id, projectId, number, status, version, createdAt) VALUES (?, ?, ?, 'draft', 1, ?)`)
      .run('app1', 'p1', 2, Date.now() - 6 * DAY);
    savePayAppLines(d, 'app1', [{ sovLineId: sov1, percentComplete: 50, storedMaterialsCents: 0 }], 1);

    const item = dashboardAttention(d, true).find(i => i.type === 'draft_payapp')!;
    expect(item).toBeTruthy();
    expect(item.balanceCents).toBe(45000);
  });

  it('sorts red before amber and caps at 20', () => {
    // 25 amber bid-due items (due in 1..25 days, all within the 14d window is not
    // needed — just make >20 total items so the cap is exercised) plus 2 red
    // overdue tasks that must sort first.
    for (let i = 0; i < 25; i++) {
      d.prepare(`INSERT INTO projects (id, name, status, bidDueDate, version, createdAt) VALUES (?, ?, 'bidding', ?, 1, ?)`)
        .run(`p-${i}`, `Bid ${i}`, Date.now() + (i % 14) * DAY, Date.now());
    }
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, version, createdAt) VALUES ('tA', 'A', 'todo', ?, 1, ?)`)
      .run(daysFromToday(-1), Date.now());
    d.prepare(`INSERT INTO tasks (id, title, status, dueDate, version, createdAt) VALUES ('tB', 'B', 'todo', ?, 1, ?)`)
      .run(daysFromToday(-2), Date.now());

    const items = dashboardAttention(d, false);
    expect(items.length).toBe(20);
    expect(items[0].severity).toBe('red');
    expect(items[1].severity).toBe('red');
    // once severities transition amber, dates must be ascending
    const firstAmberIdx = items.findIndex(i => i.severity === 'amber');
    expect(firstAmberIdx).toBeGreaterThan(-1);
    for (let i = firstAmberIdx; i < items.length - 1; i++) {
      expect(items[i].date).toBeLessThanOrEqual(items[i + 1].date);
    }
  });
});

describe('dashboardMoney', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
    d.prepare(`INSERT INTO projects (id, name, status, version, createdAt) VALUES ('p1', 'Proj', 'in_progress', 1, ?)`).run(Date.now());
  });

  it('aggregates outstanding/billed/paid from billed documents (draft-excluding)', () => {
    const inv = createInvoice(d, 'p1', { number: 'INV-1', date: Date.now(), lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] });
    setInvoiceStatus(d, inv.id, 'sent');
    recordPayment(d, 'invoice', inv.id, { amount: 40 });
    // draft invoice — must be ignored entirely
    createInvoice(d, 'p1', { number: 'INV-2', date: Date.now(), lines: [{ description: 'Ignore me', qty: 1, unitPrice: 999 }] });

    const money = dashboardMoney(d);
    expect(money.billedCents).toBe(10000);
    expect(money.paidCents).toBe(4000);
    expect(money.outstandingCents).toBe(6000);
  });

  it('returns last-6-month payment trend oldest-first', () => {
    const inv = createInvoice(d, 'p1', { number: 'INV-1', date: Date.now(), lines: [{ description: 'Work', qty: 1, unitPrice: 500 }] });
    setInvoiceStatus(d, inv.id, 'sent');
    const now = new Date();
    const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 10).getTime();
    recordPayment(d, 'invoice', inv.id, { amount: 100, date: twoMonthsAgo });
    recordPayment(d, 'invoice', inv.id, { amount: 50, date: Date.now() });

    const money = dashboardMoney(d);
    expect(money.trend).toHaveLength(6);
    // oldest first: month keys are ascending
    for (let i = 0; i < money.trend.length - 1; i++) {
      expect(money.trend[i].month < money.trend[i + 1].month).toBe(true);
    }
    const currentKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(money.trend[money.trend.length - 1].month).toBe(currentKey);
    expect(money.trend[money.trend.length - 1].paidCents).toBe(5000);
    const olderKey = `${new Date(twoMonthsAgo).getFullYear()}-${String(new Date(twoMonthsAgo).getMonth() + 1).padStart(2, '0')}`;
    const olderBucket = money.trend.find(t => t.month === olderKey)!;
    expect(olderBucket.paidCents).toBe(10000);
  });

  it('lists the 5 most recent payments with project names', () => {
    const inv = createInvoice(d, 'p1', { number: 'INV-1', date: Date.now(), lines: [{ description: 'Work', qty: 1, unitPrice: 1000 }] });
    setInvoiceStatus(d, inv.id, 'sent');
    for (let i = 0; i < 6; i++) {
      recordPayment(d, 'invoice', inv.id, { amount: 10 + i, date: Date.now() - i * 1000, method: 'check' });
    }
    const money = dashboardMoney(d);
    expect(money.recentPayments).toHaveLength(5);
    expect(money.recentPayments[0].projectName).toBe('Proj');
    expect(money.recentPayments[0].projectId).toBe('p1');
    // most recent (i=0, date closest to now) first — amount is on the wire as
    // integer cents (payments.amount is stored as real dollars in the DB).
    expect(money.recentPayments[0].amount).toBe(1000);
  });

  it('buckets aging over EVERY outstanding billed doc, not just >=14-day/top-20 attention items', () => {
    // Three outstanding invoices at 10/45/90 days old — the 10-day one is
    // younger than the attention feed's 14-day floor for aging_receivable,
    // so this proves dashboardMoney's aging is computed independently of
    // dashboardAttention rather than derived from it.
    const inv10 = createInvoice(d, 'p1', { number: 'INV-10', date: Date.now() - 10 * DAY, lines: [{ description: 'A', qty: 1, unitPrice: 100 }] });
    setInvoiceStatus(d, inv10.id, 'sent');
    const inv45 = createInvoice(d, 'p1', { number: 'INV-45', date: Date.now() - 45 * DAY, lines: [{ description: 'B', qty: 1, unitPrice: 200 }] });
    setInvoiceStatus(d, inv45.id, 'sent');
    const inv90 = createInvoice(d, 'p1', { number: 'INV-90', date: Date.now() - 90 * DAY, lines: [{ description: 'C', qty: 1, unitPrice: 300 }] });
    setInvoiceStatus(d, inv90.id, 'sent');

    const money = dashboardMoney(d);
    expect(money.aging).toEqual({ current: 10000, days31to60: 20000, days61plus: 30000 });
  });
});

// Shared with the Reports page's open-invoices report.
describe('ageDays / agingBucket', () => {
  it('counts whole days, never negative', () => {
    expect(ageDays(0, DAY - 1)).toBe(0);
    expect(ageDays(0, 30 * DAY + 5)).toBe(30);
    expect(ageDays(5 * DAY, 0)).toBe(0); // a future-dated document is current
  });
  it('buckets 0–30 / 31–60 / 61+ days', () => {
    expect([0, 30, 31, 60, 61, 400].map(agingBucket))
      .toEqual(['current', 'current', 'days31to60', 'days31to60', 'days61plus', 'days61plus']);
  });
});

describe('projectHappenings', () => {
  let d: Database.Database;
  beforeEach(() => {
    d = db();
    d.prepare(`INSERT INTO projects (id, name, status, version, createdAt) VALUES ('p1', 'Proj', 'in_progress', 1, ?)`).run(Date.now());
  });

  function linkThread(threadKey: string, opts: { subjectSnapshot?: string; createdAt: string; lastInboundDate?: string | null; lastOutboundDate?: string | null }) {
    d.prepare(`INSERT INTO mail_thread_links (id, threadKey, subjectSnapshot, firstDate, participantsJson, itemType, itemId, projectId, customerId, linkedByUserId, createdAt)
      VALUES (?, ?, ?, NULL, '[]', 'project', 'p1', 'p1', NULL, 'u1', ?)`)
      .run(`link-${threadKey}`, threadKey, opts.subjectSnapshot ?? null, opts.createdAt);
    if (opts.lastInboundDate !== undefined || opts.lastOutboundDate !== undefined) {
      d.prepare(`INSERT INTO mail_thread_reply_state (threadKey, lastInboundDate, lastOutboundDate, updatedAt) VALUES (?, ?, ?, ?)`)
        .run(threadKey, opts.lastInboundDate ?? null, opts.lastOutboundDate ?? null, new Date().toISOString());
    }
  }

  it('merges an activity row with a mail thread reply newer than the last outbound, sorted desc', () => {
    logActivity(d, { projectId: 'p1', userId: 'u1', type: 'note', message: 'Old note' });
    d.prepare(`UPDATE activity SET createdAt = ? WHERE projectId = 'p1'`).run(new Date('2026-01-01T00:00:00.000Z').getTime());

    linkThread('th1@tidewater.example', {
      subjectSnapshot: 'Invoice 12',
      createdAt: '2026-01-02T00:00:00.000Z',
      lastInboundDate: '2026-01-05T00:00:00.000Z',
      lastOutboundDate: null,
    });

    const items = projectHappenings(d, 'p1', 12);
    expect(items).toHaveLength(2);
    // mail item sorts first — its inbound date is newer than the activity row's.
    expect(items[0]).toMatchObject({
      kind: 'mail', id: 'th1@tidewater.example', message: 'Reply on "Invoice 12"',
      createdAt: new Date('2026-01-05T00:00:00.000Z').getTime(),
    });
    expect(items[1]).toMatchObject({ kind: 'activity', type: 'note', message: 'Old note' });
  });

  it('omits a thread whose last inbound is not newer than the last outbound (or the link itself)', () => {
    // Reply already answered: inbound predates outbound.
    linkThread('th-answered@tidewater.example', {
      subjectSnapshot: 'Answered',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastInboundDate: '2026-01-02T00:00:00.000Z',
      lastOutboundDate: '2026-01-03T00:00:00.000Z',
    });
    // No reply at all yet.
    linkThread('th-none@tidewater.example', { subjectSnapshot: 'No reply yet', createdAt: '2026-01-01T00:00:00.000Z' });

    const items = projectHappenings(d, 'p1', 12);
    expect(items.find(i => i.id === 'th-answered@tidewater.example')).toBeUndefined();
    expect(items.find(i => i.id === 'th-none@tidewater.example')).toBeUndefined();
  });

  it('caps merged items at limit', () => {
    for (let i = 0; i < 5; i++) {
      logActivity(d, { projectId: 'p1', userId: 'u1', type: 'note', message: `Note ${i}` });
    }
    const items = projectHappenings(d, 'p1', 3);
    expect(items).toHaveLength(3);
  });
});
