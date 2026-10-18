// server/documents.test.ts
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
import { pathFor } from './fileStore';

let db: Database.Database;
let dir: string;
let app: express.Express;

const PROJECT = { id: 'p1', name: 'Test Project', createdAt: 1, pages: [], takeoffs: [] };

const buildApp = (role: 'admin' | 'user', userId = 'u1') => {
  const a = express();
  a.use(express.json({ limit: '50mb' }));
  registerDataRoutes(a, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: userId, role }; next(); },
    requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
    verifyToken: () => null,
    broadcastChange: () => {},
  });
  return a;
};

// Uploads through the real POST /api/files/:id path so tests exercise the
// same code that production upload/generate call sites use.
const upload = async (
  id: string,
  opts: { projectId?: string; kind?: string; name?: string; customerId?: string; sourceType?: string; sourceId?: string } = {},
  body = 'x'
) => {
  const qs = Object.entries(opts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  const res = await request(app).post(`/api/files/${id}${qs ? `?${qs}` : ''}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from(body));
  expect(res.status).toBe(200);
  return res.body.fileId as string;
};

// Backdates createdAt so ordering/paging tests aren't racing the clock.
const setCreatedAt = (fileId: string, ts: number) => {
  db.prepare('UPDATE files SET createdAt = ? WHERE id = ?').run(ts, fileId);
};

beforeEach(async () => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-docs-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  app = buildApp('admin');
  await request(app).post('/api/projects').send(PROJECT);
});

describe('GET /api/documents — filters', () => {
  it('multi-project filter returns only files from the listed projects', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2' });
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p3' });
    const a = await upload('a', { projectId: 'p1', kind: 'document', name: 'A.pdf' });
    const b = await upload('b', { projectId: 'p2', kind: 'document', name: 'B.pdf' });
    await upload('c', { projectId: 'p3', kind: 'document', name: 'C.pdf' });

    const res = await request(app).get('/api/documents?projectIds=p1,p2');
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: any) => r.id).sort()).toEqual([a, b].sort());
  });

  it('multi-kind filter returns only the listed kinds', async () => {
    await upload('d', { projectId: 'p1', kind: 'document', name: 'D.pdf' });
    await upload('s', { projectId: 'p1', kind: 'spreadsheet', name: 'S.xlsx' });
    await upload('o', { projectId: 'p1', kind: 'other', name: 'O.bin' });

    const res = await request(app).get('/api/documents?kinds=document,spreadsheet');
    expect(res.body.rows.map((r: any) => r.kind).sort()).toEqual(['document', 'spreadsheet']);
  });

  it('customer-only file (no project) is matched by customerIds', async () => {
    await request(app).post('/api/customers').send({ id: 'cust1', name: 'Acme' });
    const fid = await upload('cf1', { kind: 'document', name: 'Loose.pdf', customerId: 'cust1' });

    const res = await request(app).get('/api/documents?customerIds=cust1');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([fid]);
    expect(res.body.rows[0].projectId).toBeNull();
    expect(res.body.rows[0].customerId).toBe('cust1');
  });

  it('customerIds also matches files attributed via the owning project', async () => {
    await request(app).post('/api/customers').send({ id: 'cust2', name: 'Beta Co' });
    // customerId isn't in patchProject's field whitelist — set it directly.
    db.prepare('UPDATE projects SET customerId = ? WHERE id = ?').run('cust2', 'p1');
    const fid = await upload('pf1', { projectId: 'p1', kind: 'document', name: 'ViaProject.pdf' });

    const res = await request(app).get('/api/documents?customerIds=cust2');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([fid]);
    expect(res.body.rows[0].customerName).toBe('Beta Co');
  });

  it('q filters by case-insensitive name substring', async () => {
    const fid = await upload('q1', { projectId: 'p1', kind: 'document', name: 'Contract Final.pdf' });
    await upload('q2', { projectId: 'p1', kind: 'document', name: 'Unrelated.pdf' });

    const res = await request(app).get('/api/documents?q=contract');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([fid]);
  });

  it('archived toggle is exclusive: default excludes archived, archived=1 shows ONLY archived', async () => {
    const live = await upload('live1', { projectId: 'p1', kind: 'document', name: 'Live.pdf' });
    const arch = await upload('arch1', { projectId: 'p1', kind: 'document', name: 'Archived.pdf' });
    await request(app).patch(`/api/files/${arch}`).send({ archived: true });

    const defaultRes = await request(app).get('/api/documents');
    expect(defaultRes.body.rows.map((r: any) => r.id)).toEqual([live]);

    const archivedRes = await request(app).get('/api/documents?archived=1');
    expect(archivedRes.body.rows.map((r: any) => r.id)).toEqual([arch]);
    expect(archivedRes.body.rows[0].archived).toBe(true);
  });

  it('paging respects limit/offset while total reflects the full filtered set', async () => {
    for (let i = 0; i < 5; i++) {
      const id = await upload(`p${i}`, { projectId: 'p1', kind: 'document', name: `Doc${i}.pdf` });
      setCreatedAt(id, 1000 + i); // ascending creation; DESC order expected
    }
    const res = await request(app).get('/api/documents?limit=2&offset=1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.rows).toHaveLength(2);
    // newest-first: p4,p3,p2,p1,p0 -> offset 1, limit 2 => p3,p2
    expect(res.body.rows.map((r: any) => r.id)).toEqual(['p3', 'p2']);
  });

  it('clamps paging: limit to [1,500] and a negative offset to 0', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await upload(`p${i}`, { projectId: 'p1', kind: 'document', name: `Doc${i}.pdf` });
      setCreatedAt(id, 1000 + i);
    }
    // SQLite reads a negative LIMIT as "no limit" — clamped to 1 instead.
    const tooSmall = await request(app).get('/api/documents?limit=-1');
    expect(tooSmall.body.rows).toHaveLength(1);
    // Over the cap the request still answers, just capped (3 rows exist).
    const tooBig = await request(app).get('/api/documents?limit=999999');
    expect(tooBig.body.rows).toHaveLength(3);
    // A negative offset would otherwise be a SQL error / silent skip.
    const negOffset = await request(app).get('/api/documents?offset=-5');
    expect(negOffset.body.rows.map((r: any) => r.id)).toEqual(['p2', 'p1', 'p0']);
  });

  it('always excludes plan and settings-asset kinds, and version rows', async () => {
    await upload('plan1', { projectId: 'p1', kind: 'plan', name: 'raster.png' });
    await upload('sa1', { kind: 'settings-asset', name: 'template.xlsx' });
    const live = await upload('v1', { projectId: 'p1', kind: 'document', name: 'V.pdf' });
    await request(app).post(`/api/files/${live}/versions`).set('Content-Type', 'application/octet-stream').send(Buffer.from('v2'));

    const res = await request(app).get('/api/documents');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([live]);
  });
});

describe('GET /api/documents — clutter exclusions (spec 2026-08-17-documents-clutter-design)', () => {
  it('default view hides both unassigned (no project + no name) rows and page-referenced files, regardless of kind', async () => {
    // Unassigned: no projectId, no name.
    const unassigned = await upload('unassigned1', { kind: 'other' });
    // A visible, normal upload for contrast.
    const visible = await upload('visible1', { projectId: 'p1', kind: 'document', name: 'Visible.pdf' });
    // A page-referenced file uploaded under an ordinary kind (not 'plan') —
    // the NOT-EXISTS check is label-independent, so this must still be hidden.
    const pageAsset = await upload('pageasset1', { projectId: 'p1', kind: 'document', name: 'raster.png' });
    db.prepare(`
      INSERT INTO pages (id, projectId, name, pageNumber, sortOrder, imageId, thumbnailId)
      VALUES ('pg1', 'p1', 'Sheet 1', '1', 0, ?, NULL)
    `).run(pageAsset);

    const res = await request(app).get('/api/documents');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([visible]);
    expect(res.body.rows.map((r: any) => r.id)).not.toContain(unassigned);
    expect(res.body.rows.map((r: any) => r.id)).not.toContain(pageAsset);
  });

  it('page-referenced file hidden via thumbnailId too, and even under kind=plan (belt-and-suspenders with ALWAYS_EXCLUDED_KINDS)', async () => {
    const thumbAsset = await upload('thumbasset1', { projectId: 'p1', kind: 'plan', name: 'thumb.png' });
    db.prepare(`
      INSERT INTO pages (id, projectId, name, pageNumber, sortOrder, imageId, thumbnailId)
      VALUES ('pg2', 'p1', 'Sheet 2', '2', 0, NULL, ?)
    `).run(thumbAsset);

    const res = await request(app).get('/api/documents');
    expect(res.body.rows.map((r: any) => r.id)).not.toContain(thumbAsset);
  });

  it('unassigned=1 (admin) shows ONLY the unassigned class, and page-asset exclusion still applies', async () => {
    const unassignedA = await upload('unassignedA', { kind: 'other' });
    const unassignedB = await upload('unassignedB', { kind: 'document' });
    const visible = await upload('visibleX', { projectId: 'p1', kind: 'document', name: 'Visible.pdf' });
    // Unassigned-shaped but ALSO page-referenced — must stay hidden even in
    // the unassigned view (page-asset exclusion is unconditional).
    const unassignedPageAsset = await upload('unassignedPage', { kind: 'other' });
    db.prepare(`
      INSERT INTO pages (id, projectId, name, pageNumber, sortOrder, imageId, thumbnailId)
      VALUES ('pg3', 'p1', 'Sheet 3', '3', 0, ?, NULL)
    `).run(unassignedPageAsset);

    const res = await request(app).get('/api/documents?unassigned=1');
    expect(res.body.rows.map((r: any) => r.id).sort()).toEqual([unassignedA, unassignedB].sort());
    expect(res.body.rows.map((r: any) => r.id)).not.toContain(visible);
    expect(res.body.rows.map((r: any) => r.id)).not.toContain(unassignedPageAsset);
  });

  it('a non-admin sending unassigned=1 gets the normal (non-unassigned) view — the param is ignored', async () => {
    await upload('unassignedC', { kind: 'other' });
    const visible = await upload('visibleY', { projectId: 'p1', kind: 'document', name: 'Visible.pdf' });

    const userApp = buildApp('user', 'u3');
    const res = await request(userApp).get('/api/documents?unassigned=1');
    expect(res.body.rows.map((r: any) => r.id)).toEqual([visible]);
  });

  it('unassigned view is exclusive with archived and takes precedence when both params are set', async () => {
    const unassignedLive = await upload('unassignedLive', { kind: 'other' });
    const unassignedArchived = await upload('unassignedArchived', { kind: 'other' });
    await request(app).patch(`/api/files/${unassignedArchived}`).send({ archived: true });

    // Both params set: unassigned wins, and it shows BOTH archived and
    // non-archived unassigned rows (its own view, not narrowed by archived).
    const res = await request(app).get('/api/documents?unassigned=1&archived=1');
    expect(res.body.rows.map((r: any) => r.id).sort()).toEqual([unassignedArchived, unassignedLive].sort());
  });
});

describe('GET /api/documents — role exclusion', () => {
  it('non-admin excludes invoice/payapp-export/change-order/proposal but keeps change-order-photo and takeoff-print', async () => {
    await upload('inv', { projectId: 'p1', kind: 'invoice', name: 'Inv.pdf' });
    await upload('pae', { projectId: 'p1', kind: 'payapp-export', name: 'PayApp.xlsx' });
    await upload('co', { projectId: 'p1', kind: 'change-order', name: 'CO.pdf' });
    await upload('prop', { projectId: 'p1', kind: 'proposal', name: 'Proposal.pdf' });
    const cop = await upload('cop', { projectId: 'p1', kind: 'change-order-photo', name: 'photo.jpg' });
    const po = await upload('po', { projectId: 'p1', kind: 'takeoff-print', name: 'Printout.pdf' });

    const adminRes = await request(app).get('/api/documents');
    expect(adminRes.body.rows.map((r: any) => r.id).sort()).toEqual(['co', 'cop', 'inv', 'pae', 'po', 'prop'].sort());

    const userApp = buildApp('user', 'u2');
    const userRes = await request(userApp).get('/api/documents');
    expect(userRes.body.rows.map((r: any) => r.id).sort()).toEqual([cop, po].sort());
  });
});

// A check image carries the customer's bank details (migration 43): hidden
// from non-admins everywhere the billing kinds are.
describe('payment attachments are admin-only', () => {
  it('hides a payment-attachment from a non-admin\'s list and by-source lookup, and 404s their PATCH/DELETE', async () => {
    const chk = await upload('chk', { projectId: 'p1', kind: 'payment-attachment', sourceType: 'payment', sourceId: 'pay-1', name: 'Check.jpg' });
    const visible = await upload('vis', { projectId: 'p1', kind: 'document', name: 'Visible.pdf' });

    expect((await request(app).get('/api/documents')).body.rows.map((r: any) => r.id).sort()).toEqual([chk, visible].sort());

    const userApp = buildApp('user', 'u2');
    expect((await request(userApp).get('/api/documents')).body.rows.map((r: any) => r.id)).toEqual([visible]);
    const bySource = await request(userApp).get('/api/documents/by-source?sourceType=payment&kind=payment-attachment&sourceIds=pay-1');
    expect(bySource.body).toEqual({ 'pay-1': null });
    expect((await request(userApp).patch(`/api/files/${chk}`).send({ archived: true })).status).toBe(404);
    expect((await request(userApp).delete(`/api/files/${chk}`)).status).toBe(404);
  });
});

describe('GET /api/documents — source label resolution', () => {
  it('resolves invoice, payapp, change-order and task labels with hrefs', async () => {
    const inv = await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-12', lines: [] });
    const invFid = await upload('inv-f', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: inv.body.id, name: 'Invoice.pdf' });

    const co = await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-3', lumpSumAmount: 100 });
    const coFid = await upload('co-f', { projectId: 'p1', kind: 'change-order', sourceType: 'change-order', sourceId: co.body.id, name: 'CO.pdf' });

    const payApp = await request(app).post('/api/projects/p1/aia/pay-apps').send({});
    const payFid = await upload('pay-f', { projectId: 'p1', kind: 'payapp-export', sourceType: 'payapp', sourceId: payApp.body.id, name: 'PayApp.xlsx' });

    const task = await request(app).post('/api/tasks').send({ title: 'Order fixtures', projectId: 'p1' });
    const taskFid = await upload('task-f', { projectId: 'p1', kind: 'task-photo', sourceType: 'task', sourceId: task.body.id, name: 'task.jpg' });

    const res = await request(app).get('/api/documents');
    const byId = Object.fromEntries(res.body.rows.map((r: any) => [r.id, r]));

    expect(byId[invFid].source).toEqual({ type: 'invoice', id: inv.body.id, label: 'Invoice #INV-12', href: '/project/p1/billing?tab=invoices' });
    expect(byId[coFid].source).toEqual({ type: 'change-order', id: co.body.id, label: 'CO #CO-3', href: '/project/p1/billing?tab=change-orders' });
    expect(byId[payFid].source).toEqual({ type: 'payapp', id: payApp.body.id, label: `Pay App #${payApp.body.number}`, href: '/project/p1/billing?tab=pay-apps' });
    expect(byId[taskFid].source).toEqual({ type: 'task', id: task.body.id, label: 'Order fixtures', href: '/tasks?projectId=p1' });
  });

  it('resolves punch-report (sourceId=projectId, whole-list) and punch-photo (sourceId=item) differently under the same sourceType', async () => {
    const item = await request(app).post('/api/projects/p1/punch').send({ description: 'Fix crack', area: 'Kitchen' });

    const reportFid = await upload('punch-rep', { projectId: 'p1', kind: 'punch-report', sourceType: 'punch', sourceId: 'p1', name: 'Punch.pdf' });
    const photoFid = await upload('punch-photo1', { projectId: 'p1', kind: 'punch-photo', sourceType: 'punch', sourceId: item.body.id, name: 'photo.jpg' });

    const res = await request(app).get('/api/documents');
    const byId = Object.fromEntries(res.body.rows.map((r: any) => [r.id, r]));

    expect(byId[reportFid].source).toEqual({ type: 'punch', id: 'p1', label: 'Punch list', href: '/project/p1/punch' });
    expect(byId[photoFid].source).toEqual({ type: 'punch', id: item.body.id, label: 'Fix crack', href: '/project/p1/punch' });
  });

  it('resolves a takeoff-print label from the file\'s own name, with a Takeoffs-tab href', async () => {
    const fid = await upload('po-f', { projectId: 'p1', kind: 'takeoff-print', sourceType: 'takeoff-print', sourceId: 'po-1', name: 'Printout.pdf' });

    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === fid);
    expect(row.source).toEqual({ type: 'takeoff-print', id: 'po-1', label: 'Printout.pdf', href: '/project/p1/takeoff' });
  });

  // One date can hold a report per crew (migration 45): the crew names the
  // report too, and the link opens that crew's tab.
  it('resolves a dailyReport label (Daily Report — <date> — <crew>) with an href to its crew\'s tab', async () => {
    const crewId = (await request(app).get('/api/projects/p1/daily-report-crews')).body[0].id;
    const sub = (await request(app).post('/api/projects/p1/daily-report-crews').send({ name: 'Smith & Sons' })).body;
    const dr = await request(app).post('/api/projects/p1/daily-reports').send({ crewId, reportDate: '2026-08-20' });
    const subDr = await request(app).post('/api/projects/p1/daily-reports').send({ crewId: sub.id, reportDate: '2026-08-20' });
    const pdfFid = await upload('dr-pdf', { projectId: 'p1', kind: 'daily-report', sourceType: 'dailyReport', sourceId: dr.body.id, name: 'DailyReport.pdf' });
    const photoFid = await upload('dr-photo', { projectId: 'p1', kind: 'daily-report-photo', sourceType: 'dailyReport', sourceId: dr.body.id, name: 'photo.jpg' });
    const subFid = await upload('dr-sub-pdf', { projectId: 'p1', kind: 'daily-report', sourceType: 'dailyReport', sourceId: subDr.body.id, name: 'DailyReport-sub.pdf' });

    const res = await request(app).get('/api/documents');
    const byId = Object.fromEntries(res.body.rows.map((r: any) => [r.id, r]));

    const href = `/project/p1/daily-reports?crew=${crewId}`;
    expect(byId[pdfFid].source).toEqual({ type: 'dailyReport', id: dr.body.id, label: 'Daily Report — 2026-08-20 — Crew 1', href });
    expect(byId[photoFid].source).toEqual({ type: 'dailyReport', id: dr.body.id, label: 'Daily Report — 2026-08-20 — Crew 1', href });
    expect(byId[subFid].source).toEqual({
      type: 'dailyReport', id: subDr.body.id, label: 'Daily Report — 2026-08-20 — Smith & Sons',
      href: `/project/p1/daily-reports?crew=${sub.id}`,
    });
  });

  it('a daily report whose crew is gone keeps its date label and links to the page', async () => {
    const crewId = (await request(app).get('/api/projects/p1/daily-report-crews')).body[0].id;
    const dr = await request(app).post('/api/projects/p1/daily-reports').send({ crewId, reportDate: '2026-08-20' });
    const fid = await upload('dr-orphan', { projectId: 'p1', kind: 'daily-report', sourceType: 'dailyReport', sourceId: dr.body.id, name: 'DailyReport.pdf' });
    db.prepare('DELETE FROM daily_report_crews WHERE id = ?').run(crewId);

    const row = (await request(app).get('/api/documents')).body.rows.find((r: any) => r.id === fid);
    expect(row.source).toEqual({ type: 'dailyReport', id: dr.body.id, label: 'Daily Report — 2026-08-20', href: '/project/p1/daily-reports' });
  });

  it('resolves a payment attachment to what the payment paid, linking to that payment on the Payments tab', async () => {
    const inv = await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-12', lines: [] });
    const onInvoice = await request(app).post('/api/projects/p1/payments').send({ targetType: 'invoice', targetId: inv.body.id, amount: 10 });
    const payApp = await request(app).post('/api/projects/p1/aia/pay-apps').send({});
    const onPayApp = await request(app).post('/api/projects/p1/payments').send({ targetType: 'payapp', targetId: payApp.body.id, amount: 20 });
    const chk = await upload('chk-f', { projectId: 'p1', kind: 'payment-attachment', sourceType: 'payment', sourceId: onInvoice.body.id, name: 'Check.jpg' });
    const ach = await upload('ach-f', { projectId: 'p1', kind: 'payment-attachment', sourceType: 'payment', sourceId: onPayApp.body.id, name: 'ACH.pdf' });
    const gone = await upload('gone-f', { projectId: 'p1', kind: 'payment-attachment', sourceType: 'payment', sourceId: 'deleted-payment', name: 'Old.jpg' });

    const res = await request(app).get('/api/documents');
    const byId = Object.fromEntries(res.body.rows.map((r: any) => [r.id, r]));
    expect(byId[chk].source).toEqual({
      type: 'payment', id: onInvoice.body.id, label: 'Payment — Invoice #INV-12',
      href: `/project/p1/billing?tab=payments&open=${onInvoice.body.id}`,
    });
    expect(byId[ach].source).toEqual({
      type: 'payment', id: onPayApp.body.id, label: `Payment — Pay App #${payApp.body.number}`,
      href: `/project/p1/billing?tab=payments&open=${onPayApp.body.id}`,
    });
    expect(byId[gone].source).toEqual({ type: 'payment', id: 'deleted-payment', label: 'Payment Attachment', href: null });
  });

  it('falls back to a generic kind-based label with null href for a dangling sourceId', async () => {
    const fid = await upload('dangling', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'no-such-invoice', name: 'Ghost.pdf' });

    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === fid);
    expect(row.source).toEqual({ type: 'invoice', id: 'no-such-invoice', label: 'Invoice', href: null });
  });

  it('a nameless takeoff-print falls back to the generic kind label', async () => {
    const fid = await upload('nameless-po', { projectId: 'p1', kind: 'takeoff-print', sourceType: 'takeoff-print', sourceId: 'po-2' });

    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === fid);
    expect(row.source).toEqual({ type: 'takeoff-print', id: 'po-2', label: 'Takeoff Print', href: '/project/p1/takeoff' });
  });

  // Files saved out of an email attachment (sourceType 'mailMessage'). The
  // resolver gives them a label + deep link back to the thread; the client
  // keys `deletable` off `source.type` (documentsPolicy.ts), so the resolved
  // shape here is what decides whether the Documents page offers Delete on
  // them — see the DELETE block below for the server-side rule it mirrors.
  const seedMailMessage = (over: { id?: string; subject?: string } = {}) => {
    const id = over.id ?? 'mm-1';
    db.prepare(`INSERT OR IGNORE INTO users (id, username, password, role) VALUES ('u1','u1','x','admin')`).run();
    db.prepare(`INSERT OR IGNORE INTO mail_accounts (id, userId, provider, emailAddress, authBlob, indexedSince, createdAt, updatedAt)
      VALUES ('acct-1','u1','imap','pm@birchwoodplaster.example','{}','2026-08-01','2026-08-01','2026-08-01')`).run();
    db.prepare(`INSERT INTO mail_messages (id, accountId, providerMessageId, threadKey, subject, date, createdAt, updatedAt)
      VALUES (?, 'acct-1', ?, 'thr-9', ?, '2026-08-28', '2026-08-28', '2026-08-28')`)
      .run(id, `p-${id}`, over.subject ?? 'RE: Corridor ceiling height');
    return id;
  };

  it('resolves a mailMessage label from the subject, with a mail thread deep link', async () => {
    const mid = seedMailMessage();
    const fid = await upload('mail-att', { projectId: 'p1', kind: 'email-attachment', sourceType: 'mailMessage', sourceId: mid, name: 'ceiling-detail.pdf' });

    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === fid);
    expect(row.source).toEqual({
      type: 'mailMessage', id: mid,
      label: 'RE: Corridor ceiling height',
      // Per-ROW href (account + thread key off the message), not the file's
      // projectId; `_` is the mail page's no-folder-filter segment.
      href: '/mail/acct-1/_/thr-9',
    });
  });

  // Several attachments off ONE email are now several live rows sharing the
  // same (mailMessage, id) source — the resolver labels each row on its own,
  // so every one of them lists with its own name and the same deep link.
  it('lists every attachment saved from one message as its own row', async () => {
    const mid = seedMailMessage({ id: 'mm-multi', subject: 'Signed COR-4 + site photos' });
    const src = { projectId: 'p1', kind: 'document', sourceType: 'mailMessage', sourceId: mid };
    const a = await upload('mm-a', { ...src, name: 'COR-4 signed.pdf' });
    const b = await upload('mm-b', { ...src, name: 'site-1.jpg' });
    const c = await upload('mm-c', { ...src, name: 'site-2.jpg' });

    const res = await request(app).get('/api/documents');
    const rows = [a, b, c].map(id => res.body.rows.find((r: any) => r.id === id));
    expect(rows.map((r: any) => r.name)).toEqual(['COR-4 signed.pdf', 'site-1.jpg', 'site-2.jpg']);
    for (const r of rows) {
      expect(r.source).toEqual({ type: 'mailMessage', id: mid, label: 'Signed COR-4 + site photos', href: '/mail/acct-1/_/thr-9' });
      expect(r.versionNumber).toBe(1); // its own document, not a version of a sibling
    }
  });

  it('a subject-less mail message falls back to a generic label, still linked', async () => {
    const mid = seedMailMessage({ id: 'mm-2', subject: '   ' });
    const fid = await upload('mail-att2', { projectId: 'p1', kind: 'email-attachment', sourceType: 'mailMessage', sourceId: mid, name: 'x.pdf' });

    const res = await request(app).get('/api/documents');
    expect(res.body.rows.find((r: any) => r.id === fid).source)
      .toEqual({ type: 'mailMessage', id: mid, label: 'Email message', href: '/mail/acct-1/_/thr-9' });
  });

  // Deliberately NOT source:null. Disconnecting the account cascades the
  // messages away, but the file row keeps its sourceType — and deleteDocument()
  // reads that column, so a null source here would put the Delete button back
  // in front of a 409. Same shape as every other resolver's miss branch.
  it('keeps a mailMessage source (generic label, no href) when the message row is gone', async () => {
    const mid = seedMailMessage({ id: 'mm-3' });
    const fid = await upload('mail-att3', { projectId: 'p1', kind: 'document', sourceType: 'mailMessage', sourceId: mid, name: 'orphan.pdf' });
    db.prepare('DELETE FROM mail_messages WHERE id = ?').run(mid);

    const res = await request(app).get('/api/documents');
    expect(res.body.rows.find((r: any) => r.id === fid).source)
      .toEqual({ type: 'mailMessage', id: mid, label: 'Email message', href: null });

    // A saved attachment is a COPY of what the email still holds, so the
    // server lets it go even though the source row it points at is gone.
    const del = await request(app).delete(`/api/files/${fid}`);
    expect(del.status).toBe(200);
  });

  it('files with no sourceType have source: null', async () => {
    const fid = await upload('loose', { projectId: 'p1', kind: 'document', name: 'Loose.pdf' });
    const res = await request(app).get('/api/documents');
    expect(res.body.rows.find((r: any) => r.id === fid).source).toBeNull();
  });
});

describe('PATCH /api/files/:id', () => {
  it('archives and un-archives any visible row, including a system-generated one', async () => {
    const fid = await upload('gen', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-x', name: 'Inv.pdf' });
    const on = await request(app).patch(`/api/files/${fid}`).send({ archived: true });
    expect(on.status).toBe(200);
    expect(on.body.archived).toBe(true); // normalized to boolean, matching GET /api/documents
    const off = await request(app).patch(`/api/files/${fid}`).send({ archived: false });
    expect(off.body.archived).toBe(false);
  });

  it('404s a billing-kind row for a non-admin (not 409 — must not confirm existence)', async () => {
    const fid = await upload('gen-billing', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-role', name: 'Inv.pdf' });
    const userApp = buildApp('user', 'u2');
    const res = await request(userApp).patch(`/api/files/${fid}`).send({ archived: true });
    expect(res.status).toBe(404);
    // untouched — the admin app still sees it un-archived
    expect((await request(app).get(`/api/files/${fid}/meta`)).body.archived).toBe(0);
  });

  it('a non-admin can still archive a visible (non-billing) row', async () => {
    const fid = await upload('up-visible', { projectId: 'p1', kind: 'document', name: 'X.pdf' });
    const userApp = buildApp('user', 'u2');
    const res = await request(userApp).patch(`/api/files/${fid}`).send({ archived: true });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
  });

  it('409s a kind change on a system-generated row', async () => {
    const fid = await upload('gen2', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-y', name: 'Inv.pdf' });
    const res = await request(app).patch(`/api/files/${fid}`).send({ kind: 'document' });
    expect(res.status).toBe(409);
  });

  it('allows kind changes between direct-upload kinds', async () => {
    const fid = await upload('up1', { projectId: 'p1', kind: 'document', name: 'X.pdf' });
    const res = await request(app).patch(`/api/files/${fid}`).send({ kind: 'other' });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('other');
  });

  it('validates a custom:<id> kind against settings.documentTypes', async () => {
    const fid = await upload('up2', { projectId: 'p1', kind: 'document', name: 'X.pdf' });

    const bad = await request(app).patch(`/api/files/${fid}`).send({ kind: 'custom:warranty' });
    expect(bad.status).toBe(400);

    // /api/settings is registered at the app root (server.ts), not by
    // registerDataRoutes — write the key directly, same shape the real
    // POST /api/settings handler would persist.
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('documentTypes', JSON.stringify([{ id: 'warranty', label: 'Warranty' }]));
    const good = await request(app).patch(`/api/files/${fid}`).send({ kind: 'custom:warranty' });
    expect(good.status).toBe(200);
    expect(good.body.kind).toBe('custom:warranty');
  });

  it('404s for an unknown file', async () => {
    const res = await request(app).patch('/api/files/nope').send({ archived: true });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/files/:id', () => {
  it('409s a sourced (generated/attached) row', async () => {
    const fid = await upload('gen3', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-z', name: 'Inv.pdf' });
    const res = await request(app).delete(`/api/files/${fid}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
    expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(200); // untouched
  });

  it('409s a non-direct-upload kind even without a source (defensive)', async () => {
    const fid = await upload('plan-src', { projectId: 'p1', kind: 'plan-source', name: 'raw.pdf' });
    const res = await request(app).delete(`/api/files/${fid}`);
    expect(res.status).toBe(409);
  });

  it('404s a billing-kind row for a non-admin (uniform with PATCH; the row would 409 for admin)', async () => {
    const fid = await upload('gen-del', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-del', name: 'Inv.pdf' });
    const userApp = buildApp('user', 'u2');
    const res = await request(userApp).delete(`/api/files/${fid}`);
    expect(res.status).toBe(404);
    expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(200); // untouched
  });

  it('deletes a loose direct upload and wipes its version rows + bytes', async () => {
    const fid = await upload('loose2', { projectId: 'p1', kind: 'document', name: 'D.pdf' }, 'v1');
    await request(app).post(`/api/files/${fid}/versions`).set('Content-Type', 'application/octet-stream').send(Buffer.from('v2'));
    const versionsBefore = await request(app).get(`/api/files/${fid}/versions`);
    expect(versionsBefore.body).toHaveLength(2);
    const historicalId = versionsBefore.body[1].id;

    const res = await request(app).delete(`/api/files/${fid}`);
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(404);
    expect((await request(app).get(`/api/files/${historicalId}/meta`)).status).toBe(404);
    expect(fsSync.existsSync(pathFor(dir, fid))).toBe(false);
    expect(fsSync.existsSync(pathFor(dir, historicalId))).toBe(false);
  });

  it('404s for an unknown file', async () => {
    const res = await request(app).delete('/api/files/nope');
    expect(res.status).toBe(404);
  });

  // Attachments saved out of an email are COPIES — the message still holds
  // the original — so a mailMessage-sourced row with a person-picked (or the
  // default 'email-attachment') kind is deletable here, unlike a generated
  // document whose source record owns it. A system kind under the same
  // source is still refused: nothing about the container source changes what
  // an 'rfi' or 'invoice' row is.
  describe('mailMessage-sourced copies', () => {
    const seedMessage = (id: string) => {
      db.prepare(`INSERT OR IGNORE INTO users (id, username, password, role) VALUES ('u1','u1','x','admin')`).run();
      db.prepare(`INSERT OR IGNORE INTO mail_accounts (id, userId, provider, emailAddress, authBlob, indexedSince, createdAt, updatedAt)
        VALUES ('acct-1','u1','imap','pm@birchwoodplaster.example','{}','2026-08-01','2026-08-01','2026-08-01')`).run();
      db.prepare(`INSERT INTO mail_messages (id, accountId, providerMessageId, threadKey, subject, date, createdAt, updatedAt)
        VALUES (?, 'acct-1', ?, 'thr-9', 'Attachments', '2026-08-28', '2026-08-28', '2026-08-28')`).run(id, `p-${id}`);
      return id;
    };

    it('deletes a mailMessage-sourced direct-upload kind row and wipes its bytes', async () => {
      const mid = seedMessage('mm-del-1');
      const fid = await upload('mm-del-doc', { projectId: 'p1', kind: 'document', sourceType: 'mailMessage', sourceId: mid, name: 'signed.pdf' }, 'bytes');
      expect(fsSync.existsSync(pathFor(dir, fid))).toBe(true);

      const res = await request(app).delete(`/api/files/${fid}`);
      expect(res.status).toBe(200);
      expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(404);
      expect(fsSync.existsSync(pathFor(dir, fid))).toBe(false);
    });

    it('deletes the default email-attachment kind and a custom kind under a mailMessage source', async () => {
      const mid = seedMessage('mm-del-2');
      db.prepare(`INSERT INTO settings (key, value) VALUES ('documentTypes', ?)`).run(JSON.stringify([{ id: 'warranty', label: 'Warranty' }]));
      const att = await upload('mm-del-att', { projectId: 'p1', kind: 'email-attachment', sourceType: 'mailMessage', sourceId: mid, name: 'a.pdf' });
      const custom = await upload('mm-del-custom', { projectId: 'p1', kind: 'custom:warranty', sourceType: 'mailMessage', sourceId: mid, name: 'w.pdf' });

      expect((await request(app).delete(`/api/files/${att}`)).status).toBe(200);
      expect((await request(app).delete(`/api/files/${custom}`)).status).toBe(200);
      expect((await request(app).get(`/api/files/${att}/meta`)).status).toBe(404);
      expect((await request(app).get(`/api/files/${custom}/meta`)).status).toBe(404);
    });

    it('still 409s a system kind (rfi) even under a mailMessage source', async () => {
      const mid = seedMessage('mm-del-3');
      const fid = await upload('mm-del-rfi', { projectId: 'p1', kind: 'rfi', sourceType: 'mailMessage', sourceId: mid, name: 'rfi.pdf' });

      const res = await request(app).delete(`/api/files/${fid}`);
      expect(res.status).toBe(409);
      expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(200); // untouched
    });

    it('a non-admin still gets 404 for a billing kind under a mailMessage source', async () => {
      const mid = seedMessage('mm-del-4');
      const fid = await upload('mm-del-inv', { projectId: 'p1', kind: 'invoice', sourceType: 'mailMessage', sourceId: mid, name: 'inv.pdf' });
      const userApp = buildApp('user', 'u2');
      expect((await request(userApp).delete(`/api/files/${fid}`)).status).toBe(404);
      expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(200); // untouched
    });
  });

  // Takeoff prints/exports are generated (sourceType set) but no record owns
  // them, so DELETE must go through — otherwise they can never be removed.
  it('deletes a takeoff print despite its sourceType, wiping every version\'s bytes', async () => {
    const fid = await upload('tp1', { projectId: 'p1', kind: 'takeoff-print', sourceType: 'takeoff-print', sourceId: 'po-1', name: 'Takeoff Print – Test – 2026-08-28' }, 'v1');
    await request(app).post(`/api/files/${fid}/versions`).set('Content-Type', 'application/octet-stream').send(Buffer.from('v2'));
    const historicalId = (await request(app).get(`/api/files/${fid}/versions`)).body[1].id;

    const res = await request(app).delete(`/api/files/${fid}`);
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(404);
    expect(fsSync.existsSync(pathFor(dir, fid))).toBe(false);
    expect(fsSync.existsSync(pathFor(dir, historicalId))).toBe(false);
  });

  it('deletes a takeoff export too', async () => {
    const fid = await upload('tx1', { projectId: 'p1', kind: 'takeoff-export', sourceType: 'takeoff-print', sourceId: 'po-2', name: 'Takeoff Export – Test – 2026-08-28' });
    expect((await request(app).delete(`/api/files/${fid}`)).status).toBe(200);
  });

  it('still refuses a historical VERSION of a takeoff print directly', async () => {
    const fid = await upload('tp2', { projectId: 'p1', kind: 'takeoff-print', sourceType: 'takeoff-print', sourceId: 'po-3', name: 'T.pdf' }, 'v1');
    await request(app).post(`/api/files/${fid}/versions`).set('Content-Type', 'application/octet-stream').send(Buffer.from('v2'));
    const historicalId = (await request(app).get(`/api/files/${fid}/versions`)).body[1].id;
    expect((await request(app).delete(`/api/files/${historicalId}`)).status).toBe(409);
  });

  it('a proposal-kind document is still owned by its proposal and 409s', async () => {
    db.prepare(`INSERT INTO proposals (id, projectId, number, status, createdAt, updatedAt) VALUES ('pr-del', 'p1', 1, 'draft', 1, 1)`).run();
    const fid = await upload('prop-del', { projectId: 'p1', kind: 'proposal', sourceType: 'proposal', sourceId: 'pr-del', name: 'Proposal.pdf' });
    const res = await request(app).delete(`/api/files/${fid}`);
    expect(res.status).toBe(409);
    expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(200);
  });
});

// Migration 25 exists because the listing's page-asset NOT EXISTS was
// O(files × pages) without these indexes (2.7s COUNT at 20k files / 6k pages).
describe('pages asset indexes (migration 25)', () => {
  it('creates idx_pages_imageId and idx_pages_thumbnailId', () => {
    const names = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pages'`
    ).all() as { name: string }[]).map(r => r.name);
    expect(names).toContain('idx_pages_imageId');
    expect(names).toContain('idx_pages_thumbnailId');
  });

  it('the page-asset NOT EXISTS predicate is served by both indexes, not a scan', () => {
    // Mirrors the predicate in server/documents.ts listDocuments. If either
    // index is dropped (or the OR stops being MULTI-INDEX-able), the plan
    // degrades to `SCAN pg`, and this fails.
    const plan = (db.prepare(`
      EXPLAIN QUERY PLAN SELECT COUNT(*) FROM files f
      WHERE NOT EXISTS (SELECT 1 FROM pages pg WHERE pg.imageId = f.id OR pg.thumbnailId = f.id)
    `).all() as { detail: string }[]).map(r => r.detail).join('\n');
    expect(plan).toContain('idx_pages_imageId');
    expect(plan).toContain('idx_pages_thumbnailId');
    expect(plan).not.toMatch(/SCAN pg\b/);
  });
});

describe('proposal rework kinds', () => {
  const insertProposal = (id: string, number: number, projectId = 'p1') =>
    db.prepare(`INSERT INTO proposals (id, projectId, number, status, createdAt, updatedAt) VALUES (?, ?, ?, 'draft', 1, 1)`).run(id, projectId, number);

  it('resolves a proposal document to "Proposal #n" with an editor href', async () => {
    insertProposal('prop-1', 3);
    await upload('f1', { projectId: 'p1', kind: 'proposal', name: 'Proposal – Test – 2026-08-28', sourceType: 'proposal', sourceId: 'prop-1' });
    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === 'f1');
    expect(row.source).toEqual({ type: 'proposal', id: 'prop-1', label: 'Proposal #3', href: '/project/p1/proposal/prop-1' });
  });

  it('resolves a takeoff-print to its own name with the Takeoffs-tab href', async () => {
    await upload('f2', { projectId: 'p1', kind: 'takeoff-print', name: 'Takeoff Print – Test – 2026-08-28', sourceType: 'takeoff-print', sourceId: 'po-9' });
    const res = await request(app).get('/api/documents');
    const row = res.body.rows.find((r: any) => r.id === 'f2');
    expect(row.source).toEqual({ type: 'takeoff-print', id: 'po-9', label: 'Takeoff Print – Test – 2026-08-28', href: '/project/p1/takeoff' });
  });

  it('hides proposal + proposal-signed from non-admins but shows takeoff prints', async () => {
    insertProposal('prop-1', 1);
    await upload('f1', { projectId: 'p1', kind: 'proposal', name: 'p', sourceType: 'proposal', sourceId: 'prop-1' });
    await upload('f2', { projectId: 'p1', kind: 'proposal-signed', name: 's', sourceType: 'proposal', sourceId: 'prop-1' });
    await upload('f3', { projectId: 'p1', kind: 'takeoff-print', name: 't', sourceType: 'takeoff-print', sourceId: 'po-1' });
    const res = await request(buildApp('user')).get('/api/documents');
    const ids = res.body.rows.map((r: any) => r.id);
    expect(ids).not.toContain('f1');
    expect(ids).not.toContain('f2');
    expect(ids).toContain('f3');
  });

  it('accepts company-document as a direct-upload kind with no project', async () => {
    await upload('f4', { kind: 'company-document', name: 'Warranty.pdf' });
    const res = await request(app).get('/api/documents?kinds=company-document');
    expect(res.body.rows.map((r: any) => r.id)).toEqual(['f4']);
    // and it can be re-typed / deleted like any direct upload
    const del = await request(app).delete('/api/files/f4');
    expect(del.status).toBe(200);
  });

  it('filters by mime prefix', async () => {
    await request(app).post('/api/files/pdf1?projectId=p1&kind=document&name=a.pdf').set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
    await request(app).post('/api/files/img1?projectId=p1&kind=photo&name=a.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    const pdfs = await request(app).get('/api/documents?mimes=application/pdf');
    expect(pdfs.body.rows.map((r: any) => r.id)).toEqual(['pdf1']);
    const imgs = await request(app).get('/api/documents?mimes=image/');
    expect(imgs.body.rows.map((r: any) => r.id)).toEqual(['img1']);
  });

  it('refuses to delete a file referenced by a proposal (photo, attachment, pdf, signed)', async () => {
    insertProposal('prop-1', 1);
    await upload('att', { projectId: 'p1', kind: 'document', name: 'spec.pdf' });
    db.prepare(`INSERT INTO proposal_attachments (id, proposalId, fileId, sortOrder, createdAt) VALUES ('a1', 'prop-1', 'att', 0, 1)`).run();
    const res = await request(app).delete('/api/files/att');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/proposal/i);
    await upload('ph', { projectId: 'p1', kind: 'photo', name: 'x.jpg' });
    db.prepare(`INSERT INTO proposal_photos (id, proposalId, fileId, sortOrder, createdAt) VALUES ('p1x', 'prop-1', 'ph', 0, 1)`).run();
    expect((await request(app).delete('/api/files/ph')).status).toBe(409);
  });
});

describe('by-source lookup', () => {
  it('returns the live document for a source triple, 404 when none', async () => {
    const fid = await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'Invoice-1.pdf', sourceType: 'invoice', sourceId: 'inv-1' });
    const hit = await request(app).get('/api/documents/by-source?sourceType=invoice&sourceId=inv-1&kind=invoice');
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ id: fid, name: 'Invoice-1.pdf', versionNumber: 1 });
    expect((await request(app).get('/api/documents/by-source?sourceType=invoice&sourceId=nope&kind=invoice')).status).toBe(404);
  });
  it('hides admin-only kinds from non-admins and batches', async () => {
    await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' });
    await upload('f2', { projectId: 'p1', kind: 'issue-report', name: 'b', sourceType: 'issue', sourceId: 'is-1' });
    const user = buildApp('user');
    expect((await request(user).get('/api/documents/by-source?sourceType=invoice&sourceId=inv-1&kind=invoice')).status).toBe(404);
    const batch = await request(app).get('/api/documents/by-source?sourceType=invoice&kind=invoice&sourceIds=inv-1,inv-2');
    expect(batch.body['inv-1'].id).toBe('f1');
    expect(batch.body['inv-2']).toBeNull();
    const batchUser = await request(user).get('/api/documents/by-source?sourceType=invoice&kind=invoice&sourceIds=inv-1');
    expect(batchUser.body['inv-1']).toBeNull();
  });
  it('after a versioned regenerate the lookup returns the same id with the new version', async () => {
    const a = await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v1');
    const b = await upload('f9', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v2');
    expect(b).toBe(a);
    const hit = await request(app).get('/api/documents/by-source?sourceType=invoice&sourceId=inv-1&kind=invoice');
    expect(hit.body.versionNumber).toBe(2);
  });
});
