// server/reportRoutes.test.ts — the Reports page's API: admin-only, filters
// from the query string (spec docs/superpowers/specs/2026-10-06-reports-design.md).
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { registerDataRoutes } from './routes';
import { reportFiltersFromQuery } from './reportRoutes';
import { createInvoice, recordPayment, createChangeOrder, setChangeOrderStatus } from './billingStore';
import { createSovLine, createPayApp, savePayAppLines, setPayApp } from './aiaStore';

let db: Database.Database;
let dir: string;

const buildApp = (role: 'admin' | 'user') => {
  const a = express();
  a.use(express.json());
  registerDataRoutes(a, {
    db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role, username: 'nick' }; next(); },
    requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
    verifyToken: () => null,
    broadcastChange: () => {},
  });
  return a;
};
let app: express.Express;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-rrt-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  db.prepare(`INSERT INTO customers (id, name, createdAt, updatedAt) VALUES ('c1', 'Acme', 1, 1)`).run();
  db.prepare(`INSERT INTO projects (id, name, customerId, meta, createdAt) VALUES ('p1', 'Dunmore', 'c1', '{}', 1), ('p2', 'Archived', NULL, '{"archived":true}', 1)`).run();
  app = buildApp('admin');
});

describe('report routes', () => {
  const ROUTES = ['/api/reports/options', '/api/reports/open-invoices', '/api/reports/payments', '/api/reports/change-orders', '/api/reports/retainage'];

  it('every report route is admin-only', async () => {
    const member = buildApp('user');
    for (const r of ROUTES) expect((await request(member).get(r)).status, r).toBe(403);
    for (const r of ROUTES) expect((await request(app).get(r)).status, r).toBe(200);
  });

  it('open invoices: rows, totals and buckets; includeArchived=0 leaves archived projects out', async () => {
    const now = Date.now();
    createInvoice(db, 'p1', { number: '1001', status: 'sent', date: now - 40 * 86400000, lines: [{ description: 'x', qty: 1, unitPrice: 120 }] });
    createInvoice(db, 'p2', { number: '1002', status: 'sent', date: now, lines: [{ description: 'x', qty: 1, unitPrice: 80 }] });
    const all = (await request(app).get('/api/reports/open-invoices')).body;
    expect(all.rows.map((r: any) => r.document)).toEqual(['Invoice 1001', 'Invoice 1002']);
    expect(all.rows[0]).toMatchObject({ projectName: 'Dunmore', customerName: 'Acme', daysOutstanding: 40, bucket: 'days31to60', balanceCents: 12000 });
    expect(all.totals.balanceCents).toBe(20000);
    expect(all.buckets).toEqual({ current: 8000, days31to60: 12000, days61plus: 0, undated: 0 });
    const active = (await request(app).get('/api/reports/open-invoices?includeArchived=0')).body;
    expect(active.rows.map((r: any) => r.document)).toEqual(['Invoice 1001']);
    expect((await request(app).get('/api/reports/open-invoices?projectId=p2')).body.totals.balanceCents).toBe(8000);
  });

  it('payments: the from/to range; a bad date is a 400', async () => {
    const inv = createInvoice(db, 'p1', { number: '1001', status: 'sent', lines: [{ description: 'x', qty: 1, unitPrice: 500 }] }).id;
    recordPayment(db, 'invoice', inv, { date: Date.UTC(2026, 9, 1), amount: 100, method: 'check' });
    recordPayment(db, 'invoice', inv, { date: Date.UTC(2026, 8, 30), amount: 50 });
    const res = await request(app).get('/api/reports/payments?from=2026-10-01&to=2026-10-31');
    expect(res.body.rows).toEqual([expect.objectContaining({ date: '2026-10-01', target: 'Invoice 1001', method: 'check', amountCents: 10000 })]);
    expect(res.body.totals).toEqual({ count: 1, amountCents: 10000 });
    const bad = await request(app).get('/api/reports/payments?from=yesterday');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/YYYY-MM-DD/);
  });

  it('change orders: the status filter; an unknown status is a 400', async () => {
    const sent = createChangeOrder(db, 'p1', { number: '001', title: 'Soffit', lumpSumAmount: 900 }).id;
    setChangeOrderStatus(db, sent, 'sent');
    createChangeOrder(db, 'p1', { number: '002', title: 'Patch', lumpSumAmount: 100 });
    const res = await request(app).get('/api/reports/change-orders?status=sent');
    expect(res.body.rows.map((r: any) => r.title)).toEqual(['Soffit']);
    expect(res.body.byStatus.sent).toEqual({ count: 1, amountCents: 90000, scheduleImpactDays: 0 });
    expect((await request(app).get('/api/reports/change-orders?status=maybe')).status).toBe(400);
    expect((await request(app).get('/api/reports/change-orders')).body.totals.count).toBe(2);
  });

  it('retainage: one row per project with a finalized pay application', async () => {
    const sov = createSovLine(db, 'p1', { description: 'Plaster', scheduledValueCents: 1000000 }).id;
    const pa = createPayApp(db, 'p1', { applicationDate: '2026-09-30' });
    savePayAppLines(db, pa.id, [{ sovLineId: sov, percentComplete: 50, storedMaterialsCents: 0 }], 1);
    setPayApp(db, pa.id, { status: 'finalized' });
    const res = await request(app).get('/api/reports/retainage?customerId=c1');
    expect(res.body.rows).toEqual([expect.objectContaining({ projectName: 'Dunmore', payAppNumber: 1, completedStoredCents: 500000, retainageHeldCents: 50000 })]);
  });

  it('options: the project and customer pickers', async () => {
    const res = await request(app).get('/api/reports/options');
    expect(res.body.projects.map((p: any) => [p.id, p.archived])).toEqual([['p2', true], ['p1', false]]);
    expect(res.body.customers).toContainEqual({ id: 'c1', name: 'Acme' });
  });

  it('reportFiltersFromQuery: blank and repeated parameters count as absent; includeArchived=0/false turns archived off', () => {
    expect(reportFiltersFromQuery({ projectId: '', customerId: ['a', 'b'] as any, status: ' sent ' })).toEqual({
      projectId: undefined, customerId: undefined, includeArchived: undefined, from: undefined, to: undefined, status: 'sent',
    });
    expect(reportFiltersFromQuery({ includeArchived: '0' }).includeArchived).toBe(false);
    expect(reportFiltersFromQuery({ includeArchived: 'false' }).includeArchived).toBe(false);
    expect(reportFiltersFromQuery({ includeArchived: '1' }).includeArchived).toBe(true);
  });
});
