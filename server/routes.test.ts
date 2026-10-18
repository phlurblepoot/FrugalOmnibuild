// server/routes.test.ts
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
import { createProject, loadProject } from './projectStore';
import { markRfiSent, setPendingReply, type RfiPendingReply } from './rfiStore';
import { createPayApp } from './aiaStore';
import { registerDataRoutes, registerEmailRoutes } from './routes';
import { MailCrypto } from './mail/crypto';
import * as accounts from './mail/accountStore';
import type { FakeMailProvider } from './mail/providers/fake';
import { getFakeProvider, resetFakes } from './mail/providers/fakeRegistry';
import { upsertFolders } from './mail/sync/engine';
import { stageUpload } from './mail/uploads';
import type { MailContext } from './mail/context';
import type { EntityChangedEvent } from './realtime/changeFeed';
import { putBuffer } from './files';
import { MEDIA_COOKIE } from './auth';

let db: Database.Database;
let dir: string;
let app: express.Express;

const PROJECT = {
  id: 'p1', name: 'Test Project', createdAt: 1, contractor: 'GC Co',
  pages: [{ id: 'pg1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
  takeoffs: [],
};

// Every daily report is filed under a crew; listing a project's crews makes
// its first one ("Crew 1").
const firstCrew = async (projectId = 'p1'): Promise<string> =>
  (await request(app).get(`/api/projects/${projectId}/daily-report-crews`)).body[0].id;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-rt-'));
  db = openDb(':memory:');
  // migration 31's smtp→mail-account transform is a no-op without a crypto box,
  // and warns when it skips — hand it one so migrations run clean and quiet.
  runMigrations(db, dir, migrations, { mailCrypto: new MailCrypto(Buffer.alloc(32, 7)) });
  app = express();
  app.use(express.json({ limit: '50mb' }));
  registerDataRoutes(app, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    // auth stubs: every request is an authenticated admin
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    verifyToken: (token: string) => (token === 'good-token' ? { id: 'u1', role: 'admin' } : null),
    broadcastChange: () => {},
  });
});

describe('projects routes', () => {
  it('POST + GET round-trip', async () => {
    const post = await request(app).post('/api/projects').send(PROJECT);
    expect(post.status).toBe(200);
    expect(post.body.version).toBe(1);
    const get = await request(app).get('/api/projects/p1');
    expect(get.status).toBe(200);
    expect(get.body.name).toBe('Test Project');
    expect(get.body.version).toBe(1);
  });

  it('PUT bumps version; stale PUT gets 409 and changes nothing', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const v1 = (await request(app).get('/api/projects/p1')).body;
    const ok = await request(app).put('/api/projects/p1').send({ ...v1, name: 'Renamed' });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    const stale = await request(app).put('/api/projects/p1').send({ ...v1, name: 'Clobber' });
    expect(stale.status).toBe(409);
    expect((await request(app).get('/api/projects/p1')).body.name).toBe('Renamed');
  });

  it('PUT with invalid payload gets 400', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const v1 = (await request(app).get('/api/projects/p1')).body;
    const res = await request(app).put('/api/projects/p1').send({ ...v1, pages: 'broken' });
    expect(res.status).toBe(400);
  });

  it('GET list returns aggregates newest-first; DELETE removes', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    // Nothing in it yet (no plan pages), so it can be deleted.
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2', createdAt: 2, pages: [] });
    const list = await request(app).get('/api/projects');
    expect(list.body.map((p: any) => p.id)).toEqual(['p2', 'p1']);
    await request(app).delete('/api/projects/p2').expect(200);
    expect((await request(app).get('/api/projects/p2')).status).toBe(404);
  });
});

describe('images compat routes', () => {
  const PNG = 'data:image/png;base64,' + Buffer.from('pngbytes').toString('base64');

  it('POST /api/images + GET /api/images/:id round-trips the dataURL', async () => {
    await request(app).post('/api/images').send({ id: 'i1', data: PNG }).expect(200);
    const res = await request(app).get('/api/images/i1');
    expect(res.body.data).toBe(PNG);
  });

  it('GET /api/images/:id/raw streams decoded bytes with mime', async () => {
    await request(app).post('/api/images').send({ id: 'i1', data: PNG });
    const res = await request(app).get('/api/images/i1/raw').set('Authorization', 'Bearer good-token');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.body.toString()).toBe('pngbytes');
  });

  it('POST /api/files/:id accepts raw binary', async () => {
    const res = await request(app)
      .post('/api/files/f1')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('pdfbytes'));
    expect(res.status).toBe(200);
    const get = await request(app).get('/api/images/f1');
    expect(get.body.data).toBe('data:application/pdf;base64,' + Buffer.from('pdfbytes').toString('base64'));
  });

  it('404s for unknown ids', async () => {
    expect((await request(app).get('/api/images/nope')).status).toBe(404);
    expect((await request(app).get('/api/images/nope/raw?token=good-token')).status).toBe(404);
  });
});

describe('GET /api/files/:id/content streaming', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/files/f1')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('0123456789'));
  });

  it('streams full content with Accept-Ranges', async () => {
    const res = await request(app).get('/api/files/f1/content?token=good-token');
    expect(res.status).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('10');
    expect(res.body.toString()).toBe('0123456789');
  });

  it('serves byte ranges with 206', async () => {
    const res = await request(app)
      .get('/api/files/f1/content?token=good-token')
      .set('Range', 'bytes=2-5');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.body.toString()).toBe('2345');
  });

  it('rejects missing/bad tokens', async () => {
    expect((await request(app).get('/api/files/f1/content')).status).toBe(401);
    expect((await request(app).get('/api/files/f1/content?token=bad')).status).toBe(401);
  });
});

// Photo and file links (spec docs/superpowers/specs/2026-10-07-file-link-security-design.md):
// /api/images/:id/raw, /thumb and /api/files/:id/content each ask who is
// signed in — the Authorization header, ?token= or the media cookie — and
// apply one per-file rule: a signature is its owner's, billing documents are
// admins'. Without a Document Server a thumb sends the browser on to /raw, so
// those requests follow one redirect.
describe('file links', () => {
  const viewers: Record<string, { id: string; username: string; role: string }> = {
    'admin-token': { id: 'u-admin', username: 'boss', role: 'admin' },
    'crew-token': { id: 'u-crew', username: 'crew', role: 'user' },
    'other-token': { id: 'u-other', username: 'other', role: 'user' },
  };
  const LINKS = {
    raw: (id: string) => `/api/images/${id}/raw`,
    thumb: (id: string) => `/api/images/${id}/thumb`,
    content: (id: string) => `/api/files/${id}/content`,
  };
  let media: express.Express;

  beforeEach(async () => {
    media = express();
    media.use(express.json());
    registerDataRoutes(media, {
      db,
      dataDir: dir,
      dbFile: path.join(dir, 'app.db'),
      // The real thing reads the Authorization header only (server/auth.ts).
      authenticateToken: (req: any, res: any, next: any) => {
        const user = viewers[String(req.headers.authorization ?? '').split(' ')[1]];
        if (!user) return res.status(401).json({ error: 'Authentication required' });
        req.user = user;
        next();
      },
      requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
      verifyToken: (token: string) => viewers[token] ?? null,
      broadcastChange: () => {},
    });
    const upload = (id: string, kind: string, mime: string) => request(app).post(`/api/files/${id}?kind=${kind}&name=${id}`)
      .set('Content-Type', mime).send(Buffer.from(`${id} bytes`));
    await upload('photo', 'issue-photo', 'image/jpeg');
    await upload('doc', 'document', 'application/pdf');
    await upload('inv', 'invoice', 'application/pdf');
    await upload('check', 'payment-attachment', 'image/jpeg');
    putBuffer(db, dir, 'sig', Buffer.from('sig bytes'), 'image/png', { kind: 'signature', name: 'Signature.png', createdBy: 'u-crew' });
  });

  /** A link's status for one viewer, signed in by the media cookie. */
  const statusFor = async (link: string, token: string) =>
    (await request(media).get(link).set('Cookie', `${MEDIA_COOKIE}=${token}`).redirects(1)).status;

  it('never let an uploaded SVG or HTML file run script on the app\'s origin', async () => {
    const upload = (id: string, mime: string, body: string) => request(app).post(`/api/files/${id}?kind=document&name=${id}`)
      .set('Content-Type', mime).send(Buffer.from(body));
    await upload('evil-svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await upload('evil-html', 'text/html', '<script>alert(localStorage.token)</script>');
    for (const link of [LINKS.raw, LINKS.content]) {
      for (const id of ['evil-svg', 'evil-html']) {
        const res = await request(media).get(link(id)).set('Authorization', 'Bearer crew-token');
        expect(res.status, `${link(id)}`).toBe(200);
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-security-policy']).toMatch(/^sandbox;/);
      }
      // A photo or a PDF opens normally (a sandboxed PDF wouldn't open at all).
      for (const id of ['photo', 'doc']) {
        const res = await request(media).get(link(id)).set('Authorization', 'Bearer crew-token');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-security-policy']).toBeUndefined();
      }
    }
  });

  it('refuse anyone not signed in, on every link', async () => {
    for (const link of Object.values(LINKS)) {
      expect((await request(media).get(link('photo'))).status).toBe(401);
      expect((await request(media).get(link('photo')).set('Authorization', 'Bearer nope')).status).toBe(401);
      expect((await request(media).get(`${link('photo')}?token=nope`)).status).toBe(401);
      expect((await request(media).get(link('photo')).set('Cookie', `${MEDIA_COOKIE}=nope`)).status).toBe(401);
      // Some other cookie is no sign-in either.
      expect((await request(media).get(link('photo')).set('Cookie', 'other=crew-token')).status).toBe(401);
    }
  });

  it('sign in by the Authorization header, ?token= or the media cookie', async () => {
    for (const link of Object.values(LINKS)) {
      const ways = [
        request(media).get(link('photo')).set('Authorization', 'Bearer crew-token'),
        request(media).get(`${link('photo')}?token=crew-token`),
        request(media).get(link('photo')).set('Cookie', `theme=dark; ${MEDIA_COOKIE}=crew-token`),
      ];
      for (const way of ways) {
        const res = await way.redirects(1);
        expect(res.status).toBe(200);
        expect(res.body.toString()).toBe('photo bytes');
      }
    }
  });

  it('keep billing documents to admins: anyone else gets a 404 on every link, as if they were not there', async () => {
    for (const link of Object.values(LINKS)) {
      for (const id of ['inv', 'check']) {
        expect(await statusFor(link(id), 'crew-token')).toBe(404);
        expect(await statusFor(link(id), 'admin-token')).toBe(200);
      }
      for (const id of ['photo', 'doc']) {
        expect(await statusFor(link(id), 'crew-token')).toBe(200);
        expect(await statusFor(link(id), 'admin-token')).toBe(200);
      }
    }
    // The JSON read the editors use follows the same rule.
    const json = (id: string, token: string) => request(media).get(`/api/images/${id}`).set('Authorization', `Bearer ${token}`);
    expect((await json('inv', 'crew-token')).status).toBe(404);
    expect((await json('check', 'crew-token')).status).toBe(404);
    expect((await json('inv', 'admin-token')).status).toBe(200);
    expect((await json('photo', 'crew-token')).status).toBe(200);
  });

  it('show a signature to its owner alone', async () => {
    for (const link of Object.values(LINKS)) {
      expect(await statusFor(link('sig'), 'crew-token')).toBe(200);
      expect(await statusFor(link('sig'), 'other-token')).toBe(404);
      expect(await statusFor(link('sig'), 'admin-token')).toBe(404);
    }
    expect((await request(media).get('/api/images/sig').set('Authorization', 'Bearer other-token')).status).toBe(404);
  });

  it('are cached privately, never by Cloudflare or another shared cache', async () => {
    const raw = await request(media).get(LINKS.raw('photo')).set('Cookie', `${MEDIA_COOKIE}=crew-token`);
    expect(raw.headers['cache-control']).toBe('private, max-age=31536000');
    // Content is replaced in place by a new version, so it is never reused unchecked.
    const content = await request(media).get(LINKS.content('doc')).set('Cookie', `${MEDIA_COOKIE}=crew-token`);
    expect(content.headers['cache-control']).toBe('private, no-cache');
    const range = await request(media).get(LINKS.content('doc')).set('Cookie', `${MEDIA_COOKIE}=crew-token`).set('Range', 'bytes=0-2');
    expect([range.status, range.headers['cache-control']]).toEqual([206, 'private, no-cache']);
  });

  it("send a thumb's browser on to the original with the same sign-in, ?v= and all", async () => {
    const viaCookie = await request(media).get(`${LINKS.thumb('photo')}?v=3`).set('Cookie', `${MEDIA_COOKIE}=crew-token`);
    expect([viaCookie.status, viaCookie.headers.location]).toEqual([302, '/api/images/photo/raw']);
    const original = await request(media).get(viaCookie.headers.location).set('Cookie', `${MEDIA_COOKIE}=crew-token`);
    expect([original.status, original.body.toString()]).toEqual([200, 'photo bytes']);
    // A ?token= has no cookie to fall back on, so it goes along.
    const viaQuery = await request(media).get(`${LINKS.thumb('photo')}?token=crew-token`);
    expect(viaQuery.headers.location).toBe('/api/images/photo/raw?token=crew-token');
    expect((await request(media).get(viaQuery.headers.location)).status).toBe(200);
  });
});

describe('storage + search + orphans', () => {
  it('orphan cleanup deletes only unreferenced files', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT,
      pages: [{ id: 'pg1', name: 'A1', imageId: 'used1', measurements: [], scaleConfig: null }],
    });
    const PNG = 'data:image/png;base64,' + Buffer.from('x').toString('base64');
    await request(app).post('/api/images').send({ id: 'used1', data: PNG });
    await request(app).post('/api/images').send({ id: 'orphan1', data: PNG });
    const orphans = await request(app).get('/api/storage/orphans');
    expect(orphans.body.count).toBe(1);
    const cleanup = await request(app).post('/api/storage/orphans/cleanup');
    expect(cleanup.body.deleted).toBe(1);
    expect((await request(app).get('/api/images/used1')).status).toBe(200);
    expect((await request(app).get('/api/images/orphan1')).status).toBe(404);
  });

  it('orphan cleanup spares standalone project document uploads', async () => {
    await request(app).post('/api/projects').send(PROJECT); // id 'p1'
    // A Documents upload: referenced ONLY by files.projectId, not by any project JSON
    await request(app).post('/api/files/doc1?projectId=p1&kind=document&name=Contract.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('contract'));
    const orphans = await request(app).get('/api/storage/orphans');
    expect(orphans.body.count).toBe(0); // doc1 is NOT an orphan
    await request(app).post('/api/storage/orphans/cleanup');
    expect((await request(app).get('/api/files/doc1/meta')).status).toBe(200); // survived
  });

  it('orphan cleanup spares a project-less task photo', async () => {
    // Task photos are deliberately project-less (a task outlives the project it
    // merely refers to), so files.projectId cannot vouch for them — only the
    // join table can.
    await request(app).post('/api/files/tphoto1?kind=task-photo&name=Photo.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('photo'));
    db.prepare('INSERT INTO task_photos (id, taskId, fileId, createdAt) VALUES (?, ?, ?, ?)')
      .run('tp1', 'task1', 'tphoto1', 1);

    expect((await request(app).get('/api/storage/orphans')).body.count).toBe(0);
    await request(app).post('/api/storage/orphans/cleanup');
    expect((await request(app).get('/api/files/tphoto1/meta')).status).toBe(200);
  });

  // What survives a cleanup, checked the way the button does it: count, clean
  // up, then look for each file.
  const survivors = async (ids: string[]) => {
    await request(app).post('/api/storage/orphans/cleanup');
    const alive: string[] = [];
    for (const id of ids) if ((await request(app).get(`/api/files/${id}/meta`)).status === 200) alive.push(id);
    return alive;
  };
  const PNG = 'data:image/png;base64,' + Buffer.from('x').toString('base64');

  it('orphan cleanup spares company, customer and loose documents the Documents page lists', async () => {
    // None has a project or anything pointing at it: each is still someone's
    // document, which they can see (and delete) on the Documents page.
    const cust = await request(app).post('/api/customers').send({ name: 'Acme GC' });
    const upload = (id: string, q: string) => request(app).post(`/api/files/${id}?${q}`)
      .set('Content-Type', 'application/pdf').send(Buffer.from(id));
    await upload('company1', 'kind=company-document&name=Insurance.pdf');
    await upload('cust1', `kind=document&customerId=${cust.body.id}&name=W9.pdf`);
    await upload('loose1', 'kind=document&name=Notes.pdf');
    await upload('archived1', 'kind=other&name=Old.pdf');
    await request(app).patch('/api/files/archived1').send({ archived: true });

    expect((await request(app).get('/api/storage/orphans')).body.count).toBe(0);
    expect(await survivors(['company1', 'cust1', 'loose1', 'archived1'])).toEqual(['company1', 'cust1', 'loose1', 'archived1']);
  });

  it('orphan cleanup spares the AIA template, but not one it replaced', async () => {
    const upload = (id: string) => request(app).post(`/api/files/${id}?kind=settings-asset&name=AIA.xlsx`)
      .set('Content-Type', 'application/octet-stream').send(Buffer.from(id));
    await upload('aia-old');
    await upload('aia-new');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('aiaTemplateFileId', 'aia-new')").run();

    expect((await request(app).get('/api/storage/orphans')).body.count).toBe(1);
    expect(await survivors(['aia-old', 'aia-new'])).toEqual(['aia-new']);
  });

  it('orphan cleanup spares files only an attachment or photo table names', async () => {
    // Unnamed and project-less, so hidden from Documents: only the join rows
    // vouch for them.
    const linked = ['inv-att', 'inv-photo', 'prop-att', 'prop-photo', 'co-att', 'rfi-att', 'iss-att', 'dr-att', 'pay-att'];
    for (const id of [...linked, 'loose-img']) {
      await request(app).post('/api/images').send({ id, data: PNG });
    }
    const link = (table: string, owner: string, fileId: string) =>
      db.prepare(`INSERT INTO ${table} (id, ${owner}, fileId, sortOrder, createdAt) VALUES (?, 'x1', ?, 0, 1)`).run(`${table}-${fileId}`, fileId);
    link('invoice_attachments', 'invoiceId', 'inv-att');
    link('invoice_photos', 'invoiceId', 'inv-photo');
    link('proposal_attachments', 'proposalId', 'prop-att');
    link('proposal_photos', 'proposalId', 'prop-photo');
    // Migration 42: an attached PDF is often filed under another project (or
    // none), so these join rows must vouch for it as well.
    link('change_order_attachments', 'changeOrderId', 'co-att');
    link('rfi_attachments', 'rfiId', 'rfi-att');
    link('issue_attachments', 'issueId', 'iss-att');
    link('daily_report_attachments', 'dailyReportId', 'dr-att');
    // Migration 43: a payment can link a photo or PDF filed anywhere.
    link('payment_attachments', 'paymentId', 'pay-att');

    expect((await request(app).get('/api/storage/orphans')).body.count).toBe(1);
    expect(await survivors([...linked, 'loose-img'])).toEqual(linked);
  });

  it('search finds projects, pages, and takeoffs from normalized tables', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT,
      name: 'Maple Office',
      pages: [{ id: 'pg1', name: 'Lobby Plan', imageId: '', measurements: [], scaleConfig: null }],
      takeoffs: [{ id: 't1', name: 'Drywall', color: '#fff', type: 'area' }],
    });
    const res = await request(app).get('/api/search?q=maple');
    expect(res.body.results.some((r: any) => r.type === 'project')).toBe(true);
    const res2 = await request(app).get('/api/search?q=lobby');
    expect(res2.body.results.some((r: any) => r.type === 'page')).toBe(true);
    const res3 = await request(app).get('/api/search?q=drywall');
    expect(res3.body.results.some((r: any) => r.type === 'takeoff')).toBe(true);
  });

  it('project storage endpoint reports file bytes', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const res = await request(app).get('/api/projects/p1/storage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalBytes');
    expect(res.body).toHaveProperty('imageBytes');
  });
});

describe('GET /api/projects/summary', () => {
  it('returns slim rows with counts and pageIds, no page payloads', async () => {
    await request(app).post('/api/projects').send({
      ...PROJECT,
      pages: [
        { id: 'pg1', name: 'A1', imageId: '', measurements: [], scaleConfig: null },
        { id: 'pg2', name: 'A2', imageId: '', measurements: [], scaleConfig: null },
      ],
      takeoffs: [{ id: 't1', name: 'Drywall', color: '#fff', type: 'area' }],
    });
    const res = await request(app).get('/api/projects/summary');
    expect(res.status).toBe(200);
    const row = res.body.find((r: any) => r.id === 'p1');
    expect(row).toMatchObject({
      name: 'Test Project', status: 'bidding', version: 1, archived: false,
      pageCount: 2, takeoffCount: 1, contractor: 'GC Co',
    });
    expect(row.pageIds.sort()).toEqual(['pg1', 'pg2']);
    expect(row.pages).toBeUndefined(); // slim — no aggregates
  });

  it('reflects the archived meta flag', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2', archived: true });
    const res = await request(app).get('/api/projects/summary');
    expect(res.body.find((r: any) => r.id === 'p2').archived).toBe(true);
  });
});

describe('PATCH /api/projects/:id', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT);
  });

  it('updates status and bumps version', async () => {
    const res = await request(app).patch('/api/projects/p1').send({ version: 1, status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, version: 2, status: 'in_progress' });
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.status).toBe('in_progress');
    expect(get.body.version).toBe(2);
  });

  it('updates name and archived flag', async () => {
    const res = await request(app).patch('/api/projects/p1')
      .send({ version: 1, name: 'Renamed', archived: true });
    expect(res.body.version).toBe(2);
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.name).toBe('Renamed');
    expect(get.body.archived).toBe(true);
  });

  it('un-archiving removes the meta key entirely', async () => {
    await request(app).patch('/api/projects/p1').send({ version: 1, archived: true });
    await request(app).patch('/api/projects/p1').send({ version: 2, archived: false });
    const get = await request(app).get('/api/projects/p1');
    expect(get.body.archived).toBeUndefined(); // legacy shape omits the key
  });

  it('rejects stale versions with 409 and changes nothing', async () => {
    await request(app).patch('/api/projects/p1').send({ version: 1, name: 'First' });
    const stale = await request(app).patch('/api/projects/p1').send({ version: 1, name: 'Clobber' });
    expect(stale.status).toBe(409);
    expect((await request(app).get('/api/projects/p1')).body.name).toBe('First');
  });

  it('rejects invalid payloads with 400', async () => {
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, status: 'galactic' })).status).toBe(400);
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, nonsense: true })).status).toBe(400);
    expect((await request(app).patch('/api/projects/p1').send({ status: 'in_progress' })).status).toBe(400); // no version
    expect((await request(app).patch('/api/projects/p1').send({ version: 1, name: '' })).status).toBe(400);
  });

  it('404s for unknown projects', async () => {
    expect((await request(app).patch('/api/projects/nope').send({ version: 1, name: 'X' })).status).toBe(404);
  });
});

describe('GET /api/activity', () => {
  it('records project create and status change events', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).patch('/api/projects/p1').send({ version: 1, status: 'in_progress' });
    const res = await request(app).get('/api/activity');
    expect(res.status).toBe(200);
    const types = res.body.items.map((i: any) => i.type);
    expect(types).toContain('project_created');
    expect(types).toContain('status_changed');
    const statusItem = res.body.items.find((i: any) => i.type === 'status_changed');
    expect(statusItem.projectName).toBe('Test Project');
  });
});

describe('GET /api/projects/:id/summary', () => {
  it('returns the single slim row', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    const res = await request(app).get('/api/projects/p1/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'p1', name: 'Test Project', status: 'bidding', version: 1 });
    expect(res.body.pages).toBeUndefined();
  });

  it('404s for unknown projects', async () => {
    expect((await request(app).get('/api/projects/nope/summary')).status).toBe(404);
  });

  it('includes contractValueCents (base + approved COs) and invoiceCount', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pc' });
    db.prepare('UPDATE projects SET contractValue = 5000 WHERE id = ?').run('pc');
    const co = await request(app).post('/api/projects/pc/change-orders').send({ number: 'CO-1', lumpSumAmount: 1000 });
    await request(app).patch(`/api/change-orders/${co.body.id}`).send({ status: 'approved' });
    await request(app).post('/api/projects/pc/invoices').send({ number: 'INV-1', lines: [] });
    const res = await request(app).get('/api/projects/pc/summary');
    expect(res.body.contractValueCents).toBe(600000); // 5000 + 1000
    expect(res.body.invoiceCount).toBe(1);
  });

  it('omits billing fields for non-admins', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pm' });
    // build a member-role app sharing the same db
    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
    const res = await request(memberApp).get('/api/projects/pm/summary');
    expect(res.status).toBe(200);
    expect(res.body.contractValueCents).toBeUndefined();
    expect(res.body.invoiceCount).toBeUndefined();
    expect(res.body.name).toBe(PROJECT.name); // non-pricing fields still present
  });

  it('includes openIssueCount (visible to all roles)', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pi' });
    await request(app).post('/api/projects/pi/issues').send({ title: 'A' });
    const i2 = await request(app).post('/api/projects/pi/issues').send({ title: 'B' });
    await request(app).patch(`/api/issues/${i2.body.id}`).send({ status: 'resolved' });
    const res = await request(app).get('/api/projects/pi/summary');
    expect(res.body.openIssueCount).toBe(1); // one open, one resolved
  });

  it('includes punchDone/punchTotal for non-admin users (ungated)', async () => {
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'pp' });
    const punch = await request(app).post('/api/projects/pp/punch').send({ description: 'Fix crack', area: 'Kitchen' });
    await request(app).patch(`/api/punch/${punch.body.id}`).send({ done: true });

    // non-admin 'user' app sharing the same db
    const userApp = express();
    userApp.use(express.json());
    registerDataRoutes(userApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u3', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });

    const res = await request(userApp).get('/api/projects/pp/summary');
    expect(res.status).toBe(200);
    expect(res.body.punchDone).toBe(1);
    expect(res.body.punchTotal).toBe(1);
  });
});

describe('GET /api/activity?projectId=', () => {
  it('filters the feed to one project', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).post('/api/projects').send({ ...PROJECT, id: 'p2', name: 'Other' });
    await request(app).patch('/api/projects/p1').send({ version: 1, status: 'in_progress' });
    const res = await request(app).get('/api/activity?projectId=p1');
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items) expect(item.projectId).toBe('p1');
  });
});

describe('project files', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT);
  });

  it('POST /api/files/:id labels uploads via query params', async () => {
    const res = await request(app)
      .post('/api/files/doc1?projectId=p1&kind=document&name=Contract.pdf')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('pdfbytes'));
    expect(res.status).toBe(200);
    const meta = await request(app).get('/api/files/doc1/meta');
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({
      id: 'doc1', projectId: 'p1', kind: 'document', name: 'Contract.pdf',
      mime: 'application/pdf', versionNumber: 1, parentFileId: null,
    });
    expect(res.body).toMatchObject({ success: true, fileId: 'doc1', versioned: false });
  });

  it('POST /api/files/:id versions the source document instead of adding a second row', async () => {
    const qs = 'projectId=p1&kind=invoice&sourceType=invoice&sourceId=inv-1&customerId=c1&name=Invoice%2012.pdf';
    const first = await request(app).post(`/api/files/gen1?${qs}`)
      .set('Content-Type', 'application/pdf').send(Buffer.from('v1'));
    expect(first.body).toMatchObject({ fileId: 'gen1', versioned: false });

    // a regenerate mints a new id client-side; it must land on the same document
    const second = await request(app).post(`/api/files/gen2?${qs}`)
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    expect(second.body).toMatchObject({ fileId: 'gen1', versioned: true });
    expect((await request(app).get('/api/files/gen2/meta')).status).toBe(404);

    const meta = await request(app).get('/api/files/gen1/meta');
    expect(meta.body).toMatchObject({ versionNumber: 2, sourceType: 'invoice', sourceId: 'inv-1', customerId: 'c1' });
    const versions = await request(app).get('/api/files/gen1/versions');
    expect(versions.body.map((v: any) => v.versionNumber)).toEqual([2, 1]);
  });

  it('GET /api/files/:id/meta 404s for unknown files', async () => {
    expect((await request(app).get('/api/files/nope/meta')).status).toBe(404);
  });
});

describe('file versions over HTTP', () => {
  beforeEach(async () => {
    await request(app).post('/api/files/f1?projectId=p1&kind=printout&name=Bid.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('v1'));
  });

  it('POST /versions archives and bumps; content endpoint serves the new bytes', async () => {
    const res = await request(app).post('/api/files/f1/versions')
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    expect(res.status).toBe(200);
    expect(res.body.versionNumber).toBe(2);
    const content = await request(app).get('/api/files/f1/content?token=good-token');
    expect(content.body.toString()).toBe('v2');
    const versions = await request(app).get('/api/files/f1/versions');
    expect(versions.body).toHaveLength(2);
    expect(versions.body[1].versionNumber).toBe(1);
  });

  it('404s when versioning an unknown file', async () => {
    expect((await request(app).post('/api/files/nope/versions')
      .set('Content-Type', 'application/pdf').send(Buffer.from('x'))).status).toBe(404);
  });

  it('orphan cleanup spares version history of referenced files', async () => {
    // reference f1 from a project printout
    await request(app).post('/api/projects').send({
      ...PROJECT, printouts: [{ id: 'po1', name: 'Bid set', fileId: 'f1', createdAt: 1 }],
    });
    await request(app).post('/api/files/f1/versions')
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    const cleanup = await request(app).post('/api/storage/orphans/cleanup');
    expect(cleanup.status).toBe(200);
    const versions = await request(app).get('/api/files/f1/versions');
    expect(versions.body).toHaveLength(2); // history survived
  });
});

// Only a project with nothing in it can be deleted; one with documents or
// records is archived instead (spec
// docs/superpowers/specs/2026-10-07-project-delete-guard-design.md).
describe('DELETE /api/projects/:id — only an empty project', () => {
  const EMPTY = { ...PROJECT, pages: [] };
  const HAS_DATA = 'This project has documents or records. Archive it instead.';
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;

  // An app whose every request is someone who isn't an admin, sharing the db.
  const memberApp = () => {
    const m = express();
    m.use(express.json());
    registerDataRoutes(m, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
    return m;
  };

  it('deletes an empty project as before: its scaffolding goes, the delete is logged and broadcast', async () => {
    const events: EntityChangedEvent[] = [];
    const a = express();
    a.use(express.json());
    registerDataRoutes(a, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      verifyToken: () => null,
      broadcastChange: (e: EntityChangedEvent) => { events.push(e); },
    });
    await request(a).post('/api/projects').send({
      ...EMPTY, planSets: [{ id: 'ps1', name: 'Rev A' }], takeoffs: [{ id: 't1', name: 'Drywall', type: 'area' }],
    }).expect(200);
    const crewId = await firstCrew(); // opening Daily Reports makes "Crew 1"

    expect((await request(a).get('/api/projects/p1/delete-check')).body).toEqual({ canDelete: true, summary: {} });
    await request(a).delete('/api/projects/p1').expect(200, { success: true });

    expect((await request(a).get('/api/projects/p1')).status).toBe(404);
    expect(count('SELECT COUNT(*) c FROM takeoffs WHERE projectId = ?', 'p1')).toBe(0);
    expect(count('SELECT COUNT(*) c FROM plan_sets WHERE projectId = ?', 'p1')).toBe(0);
    expect(count('SELECT COUNT(*) c FROM daily_report_crews WHERE id = ?', crewId)).toBe(0);
    expect(count(`SELECT COUNT(*) c FROM activity WHERE type = 'project_deleted' AND message = 'Project "Test Project" deleted'`)).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'project', id: 'p1', action: 'deleted' }));
  });

  it('refuses a project with a document: 409 project_has_data with what is in it, and nothing is removed', async () => {
    const events: EntityChangedEvent[] = [];
    const a = express();
    a.use(express.json());
    registerDataRoutes(a, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      verifyToken: () => null,
      broadcastChange: (e: EntityChangedEvent) => { events.push(e); },
    });
    await request(a).post('/api/projects').send(EMPTY);
    await request(a).post('/api/files/df1?projectId=p1&kind=document&name=D.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4'));
    events.length = 0;

    const res = await request(a).delete('/api/projects/p1');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'project_has_data', message: HAS_DATA, summary: { documents: 1 } });
    expect((await request(a).get('/api/projects/p1')).status).toBe(200);
    expect((await request(a).get('/api/files/df1/content?token=good-token')).status).not.toBe(404);
    expect(count('SELECT COUNT(*) c FROM files WHERE id = ?', 'df1')).toBe(1);
    expect(count(`SELECT COUNT(*) c FROM activity WHERE type = 'project_deleted'`)).toBe(0);
    expect(events.filter(e => e.action === 'deleted')).toEqual([]);
  });

  it('delete-check says so beforehand; an unknown project is a 404', async () => {
    await request(app).post('/api/projects').send(PROJECT); // one plan page
    await request(app).post('/api/projects/p1/issues').send({ title: 'Crack' });
    expect((await request(app).get('/api/projects/p1/delete-check')).body)
      .toEqual({ canDelete: false, summary: { planPages: 1, issues: 1 } });
    expect((await request(app).get('/api/projects/nope/delete-check')).status).toBe(404);
  });

  it('archiving does not make a project with data deletable', async () => {
    await request(app).post('/api/projects').send(PROJECT);
    await request(app).patch('/api/projects/p1').send({ version: 1, archived: true }).expect(200);
    expect((await request(app).delete('/api/projects/p1')).status).toBe(409);
    expect((await request(app).get('/api/projects/p1')).body.archived).toBe(true);
  });

  it('anyone signed in may still delete an empty project; others see admin-only kinds only as a count', async () => {
    await request(app).post('/api/projects').send(EMPTY);
    await request(app).post('/api/projects').send({ ...EMPTY, id: 'p2', createdAt: 2 });
    await request(app).post('/api/projects/p2/invoices').send({ number: 'INV-1', lines: [] });
    await request(app).post('/api/projects/p2/change-orders').send({ number: 'CO-1' });
    await request(app).post('/api/projects/p2/rfis').send({ title: 'Which finish?' });
    const m = memberApp();

    expect((await request(m).get('/api/projects/p2/delete-check')).body)
      .toEqual({ canDelete: false, summary: { rfis: 1, otherRecords: 2 } });
    expect((await request(m).delete('/api/projects/p2')).body)
      .toEqual({ error: 'project_has_data', message: HAS_DATA, summary: { rfis: 1, otherRecords: 2 } });
    // An admin is told exactly.
    expect((await request(app).delete('/api/projects/p2')).body.summary).toEqual({ invoices: 1, changeOrders: 1, rfis: 1 });

    await request(m).delete('/api/projects/p1').expect(200);
    expect((await request(app).get('/api/projects/p1')).status).toBe(404);
  });

  // The old cascade cases: each of these used to be wiped by a delete; now
  // each one stops it, and every row is still there afterwards.
  it('refuses a project with leftover editor drafts on its files, and keeps them', async () => {
    await request(app).post('/api/projects').send(EMPTY);
    await request(app).post('/api/files/df1?projectId=p1&kind=document&name=D.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('x'));
    db.prepare(`INSERT INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u1', 'df1', 'pdf', '{}', 1)`).run();
    expect((await request(app).delete('/api/projects/p1')).status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) c FROM drafts WHERE fileId = ?').get('df1')).toEqual({ c: 1 });
  });

  it('refuses a project with invoices, payments and change orders, and keeps them', async () => {
    await request(app).post('/api/projects').send(EMPTY);
    const inv = await request(app).post('/api/projects/p1/invoices')
      .send({ number: 'INV-1', date: 1, terms: 'Net 30', lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] });
    await request(app).post('/api/projects/p1/payments').send({ targetType: 'invoice', targetId: inv.body.id, date: 1, amount: 50, method: 'check' });
    await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-1', description: 'Extra', lumpSumAmount: 200 });
    const res = await request(app).delete('/api/projects/p1');
    expect(res.status).toBe(409);
    expect(res.body.summary).toEqual({ invoices: 1, payments: 1, changeOrders: 1 });
    expect(count('SELECT COUNT(*) c FROM invoices WHERE projectId = ?', 'p1')).toBe(1);
    expect(count('SELECT COUNT(*) c FROM invoice_lines WHERE invoiceId = ?', inv.body.id)).toBe(1);
    expect(count('SELECT COUNT(*) c FROM payments WHERE targetId = ?', inv.body.id)).toBe(1);
    expect(count('SELECT COUNT(*) c FROM change_orders WHERE projectId = ?', 'p1')).toBe(1);
  });

  it('refuses a project with payments on a pay application, and keeps their attachments', async () => {
    await request(app).post('/api/projects').send(EMPTY);
    await request(app).post('/api/files/chk1?projectId=p1&kind=payment-attachment&name=Check.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('jpg'));
    const payApp = (await request(app).post('/api/projects/p1/aia/pay-apps').send({})).body.id;
    const onApp = (await request(app).post('/api/projects/p1/payments').send({ targetType: 'payapp', targetId: payApp, amount: 20 })).body.id;
    await request(app).post(`/api/payments/${onApp}/attachments`).send({ fileId: 'chk1' }).expect(200);
    const res = await request(app).delete('/api/projects/p1');
    expect(res.status).toBe(409);
    expect(res.body.summary).toEqual({ documents: 1, payApps: 1, payments: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM payment_attachments').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM payments').get()).toEqual({ c: 1 });
  });

  it('refuses a project with change orders, issues, RFIs and daily reports, and keeps their attachments', async () => {
    await request(app).post('/api/projects').send(EMPTY);
    await request(app).post('/api/files/spec1?projectId=p1&kind=document&name=Spec.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4'));
    const co = (await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-1' })).body.id;
    const iss = (await request(app).post('/api/projects/p1/issues').send({ title: 'Crack' })).body.id;
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Which finish?' })).body.id;
    const crewId = await firstCrew();
    const dr = (await request(app).post('/api/projects/p1/daily-reports').send({ crewId, reportDate: '2026-08-20' })).body.id;
    await request(app).post(`/api/change-orders/${co}/attachments`).send({ fileId: 'spec1' }).expect(200);
    await request(app).post(`/api/issues/${iss}/attachments`).send({ fileId: 'spec1' }).expect(200);
    await request(app).post(`/api/rfis/${rfi}/attachments`).send({ fileId: 'spec1' }).expect(200);
    await request(app).post(`/api/daily-reports/${dr}/attachments`).send({ fileId: 'spec1' }).expect(200);

    const res = await request(app).delete('/api/projects/p1');
    expect(res.status).toBe(409);
    expect(res.body.summary).toEqual({ documents: 1, changeOrders: 1, rfis: 1, issues: 1, dailyReports: 1 });
    for (const [table, owner, id] of [
      ['change_order_attachments', 'changeOrderId', co], ['issue_attachments', 'issueId', iss],
      ['rfi_attachments', 'rfiId', rfi], ['daily_report_attachments', 'dailyReportId', dr],
    ]) {
      expect(db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${owner} = ?`).get(id), table).toEqual({ c: 1 });
    }
    expect(db.prepare('SELECT COUNT(*) c FROM daily_report_crews WHERE id = ?').get(crewId)).toEqual({ c: 1 });
  });

  it('refuses a project with issue and RFI photos, and keeps them', async () => {
    await request(app).post('/api/projects').send(EMPTY);
    const iss = await request(app).post('/api/projects/p1/issues').send({ title: 'Crack', description: 'Wall crack' });
    const rfi = await request(app).post('/api/projects/p1/rfis').send({ title: 'Detail question', question: 'Which finish?' });
    await request(app).post('/api/files/ph1?projectId=p1&kind=photo&name=p.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('img'));
    await request(app).post(`/api/issues/${iss.body.id}/photos`).send({ fileId: 'ph1' });
    await request(app).post(`/api/rfis/${rfi.body.id}/photos`).send({ fileId: 'ph1' });
    expect((await request(app).delete('/api/projects/p1')).status).toBe(409);
    expect(count('SELECT COUNT(*) c FROM issue_photos WHERE issueId = ?', iss.body.id)).toBe(1);
    expect(count('SELECT COUNT(*) c FROM rfi_photos WHERE rfiId = ?', rfi.body.id)).toBe(1);
  });
});

describe('billing routes', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('invoice create → get → status → list', async () => {
    const create = await request(app).post('/api/projects/p1/invoices')
      .send({ number: 'INV-1', date: 1, terms: 'Net 30', lines: [{ description: 'Work', qty: 2, unitPrice: 100 }] });
    expect(create.status).toBe(200);
    const id = create.body.id;
    const get = await request(app).get(`/api/invoices/${id}`);
    expect(get.body.totalCents).toBe(20000);
    expect(get.body.balanceCents).toBe(20000);
    const status = await request(app).patch(`/api/invoices/${id}`).send({ status: 'sent' });
    expect(status.status).toBe(200);
    const list = await request(app).get('/api/projects/p1/invoices');
    expect(list.body[0].status).toBe('sent');
  });

  it('save invoice is version-checked (409 on stale)', async () => {
    const create = await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [] });
    const id = create.body.id;
    const inv = (await request(app).get(`/api/invoices/${id}`)).body;
    const ok = await request(app).put(`/api/invoices/${id}`).send({ ...inv, terms: 'Net 15' });
    expect(ok.status).toBe(200);
    const stale = await request(app).put(`/api/invoices/${id}`).send({ ...inv, terms: 'Clobber' });
    expect(stale.status).toBe(409);
  });

  it('payments round-trip and affect balance', async () => {
    const id = (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] })).body.id;
    const pay = await request(app).post('/api/projects/p1/payments').send({ targetType: 'invoice', targetId: id, amount: 40, method: 'check' });
    expect(pay.status).toBe(200);
    expect((await request(app).get(`/api/invoices/${id}`)).body.balanceCents).toBe(6000);
    await request(app).delete(`/api/payments/${pay.body.id}`).expect(200);
    expect((await request(app).get(`/api/invoices/${id}`)).body.balanceCents).toBe(10000);
  });

  it('change orders + project billing summary rollup', async () => {
    // set a base contract value via PATCH project
    await request(app).patch('/api/projects/p1').send({ version: 1, /* contractValue not in patch — set directly */ });
    db.prepare('UPDATE projects SET contractValue = 10000 WHERE id = ?').run('p1');
    const co = await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-1', description: 'Extra', lumpSumAmount: 2000 });
    await request(app).patch(`/api/change-orders/${co.body.id}`).send({ status: 'approved' });
    const summary = await request(app).get('/api/projects/p1/billing-summary');
    expect(summary.body.contractValueCents).toBe(1200000); // 10000 + 2000
  });

  it('rejects non-admins with 403', async () => {
    // re-register routes with a requireAdmin that denies — simulate a member
    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'member' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
    expect((await request(memberApp).get('/api/projects/p1/invoices')).status).toBe(403);
    expect((await request(memberApp).post('/api/projects/p1/invoices').send({ lines: [] })).status).toBe(403);
  });

  it('invoice photo/attachment routes exist, admin-gated, and broadcast', async () => {
    const inv = (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-photos', lines: [] })).body;

    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'member' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
    expect((await request(memberApp).post(`/api/invoices/${inv.id}/photos`).send({ fileId: 'f1' })).status).toBe(403);
    expect((await request(memberApp).delete(`/api/invoices/${inv.id}/photos/f1`)).status).toBe(403);
    expect((await request(memberApp).post(`/api/invoices/${inv.id}/attachments`).send({ fileId: 'f1' })).status).toBe(403);
    expect((await request(memberApp).patch(`/api/invoices/${inv.id}/attachments/f1`).send({ sortOrder: 0 })).status).toBe(403);
    expect((await request(memberApp).delete(`/api/invoices/${inv.id}/attachments/f1`)).status).toBe(403);

    // As admin: the routes exist and mutate + broadcast (version bumps).
    const events: any[] = [];
    const adminApp = express();
    adminApp.use(express.json());
    registerDataRoutes(adminApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'a1', role: 'admin' }; next(); },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      verifyToken: () => null,
      broadcastChange: (e: any) => events.push(e),
    });
    const before = (await request(adminApp).get(`/api/invoices/${inv.id}`)).body.version;
    await request(adminApp).post(`/api/invoices/${inv.id}/photos`).send({ fileId: 'f1' }).expect(200);
    const after = (await request(adminApp).get(`/api/invoices/${inv.id}`)).body;
    expect(after.photos).toEqual([expect.objectContaining({ fileId: 'f1' })]);
    expect(after.version).toBe(before + 1);
    const photoEvent = events.find(e => e.type === 'invoice' && e.action === 'updated');
    expect(photoEvent).toBeTruthy();
    expect(typeof photoEvent.version).toBe('number');
  });
});

describe('unified project payment routes (admin-gated)', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('rejects non-admins with 403 on GET + POST', async () => {
    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'member' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
    expect((await request(memberApp).get('/api/projects/p1/payments')).status).toBe(403);
    expect((await request(memberApp).post('/api/projects/p1/payments').send({ targetType: 'invoice', targetId: 'x', amount: 1 })).status).toBe(403);
  });

  it('records payments against invoice and pay-app targets; lists both with labels', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices')
      .send({ number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] })).body.id;
    await request(app).post('/api/projects/p1/aia/sov').send({ description: 'Work', scheduledValueCents: 100000 });
    const appId = (await request(app).post('/api/projects/p1/aia/pay-apps').send({})).body.id;

    const payInv = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'invoice', targetId: invId, amount: 40, method: 'check' });
    expect(payInv.status).toBe(200);
    const payApp = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'payapp', targetId: appId, amount: 75, method: 'ach' });
    expect(payApp.status).toBe(200);

    const list = await request(app).get('/api/projects/p1/payments');
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(2);
    const labels = list.body.map((p: any) => p.targetLabel);
    expect(labels.some((l: string) => /INV-1/.test(l))).toBe(true);
    expect(labels.some((l: string) => /Application #1/.test(l))).toBe(true);
  });

  it('bad targetType → 400', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [] })).body.id;
    const res = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'bogus', targetId: invId, amount: 10 });
    expect(res.status).toBe(400);
  });

  it('missing/unknown targetId → 404', async () => {
    const res = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'invoice', targetId: 'does-not-exist', amount: 10 });
    expect(res.status).toBe(404);
  });

  it('amount <= 0 → 400', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [] })).body.id;
    const res = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'invoice', targetId: invId, amount: 0 });
    expect(res.status).toBe(400);
  });

  it('DELETE /api/payments/:id removes it', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [] })).body.id;
    const pay = await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'invoice', targetId: invId, amount: 25 });
    expect(pay.status).toBe(200);
    await request(app).delete(`/api/payments/${pay.body.id}`).expect(200);
    expect((await request(app).get('/api/projects/p1/payments')).body.length).toBe(0);
  });

  it('billing summary reflects paid splits (invoicesCents / payAppsCents)', async () => {
    const invId = (await request(app).post('/api/projects/p1/invoices')
      .send({ number: 'INV-1', lines: [{ description: 'A', qty: 1, unitPrice: 1000 }] })).body.id;
    await request(app).post('/api/projects/p1/aia/sov').send({ description: 'Work', scheduledValueCents: 100000 });
    const appId = (await request(app).post('/api/projects/p1/aia/pay-apps').send({})).body.id;

    await request(app).post('/api/projects/p1/payments').send({ targetType: 'invoice', targetId: invId, amount: 300 });
    await request(app).post('/api/projects/p1/payments').send({ targetType: 'payapp', targetId: appId, amount: 125 });

    const summary = await request(app).get('/api/projects/p1/billing-summary');
    expect(summary.status).toBe(200);
    expect(summary.body.paid.invoicesCents).toBe(30000);
    expect(summary.body.paid.payAppsCents).toBe(12500);
  });
});

// The payment detail view (spec
// docs/superpowers/specs/2026-10-06-payment-attachments-design.md).
describe('payment detail, edit and attachment routes (admin-gated)', () => {
  const events: EntityChangedEvent[] = [];
  let adminApp: express.Express;
  let invId: string;
  let payId: string;

  beforeEach(async () => {
    events.length = 0;
    await request(app).post('/api/projects').send(PROJECT); // id p1
    adminApp = express();
    adminApp.use(express.json());
    registerDataRoutes(adminApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'a1', role: 'admin' }; next(); },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      verifyToken: () => null,
      broadcastChange: (e: EntityChangedEvent) => { events.push(e); },
    });
    invId = (await request(app).post('/api/projects/p1/invoices')
      .send({ number: 'INV-5', lines: [{ description: 'A', qty: 1, unitPrice: 100 }] })).body.id;
    payId = (await request(app).post('/api/projects/p1/payments')
      .send({ targetType: 'invoice', targetId: invId, date: 1000, amount: 40, method: 'check' })).body.id;
    await request(app).post('/api/files/chk?projectId=p1&kind=payment-attachment&sourceType=payment&sourceId=x&name=Check.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('jpg'));
    await request(app).post('/api/files/remit?projectId=p1&kind=document&name=Remittance.pdf')
      .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4'));
    await request(app).post('/api/files/sheet?projectId=p1&kind=spreadsheet&name=Ledger.csv')
      .set('Content-Type', 'text/csv').send(Buffer.from('a,b'));
  });

  it('rejects non-admins with 403 on every payment route', async () => {
    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'member' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
    expect((await request(memberApp).get(`/api/payments/${payId}`)).status).toBe(403);
    expect((await request(memberApp).put(`/api/payments/${payId}`).send({ amount: 1 })).status).toBe(403);
    expect((await request(memberApp).post(`/api/payments/${payId}/attachments`).send({ fileId: 'chk' })).status).toBe(403);
    expect((await request(memberApp).delete(`/api/payments/${payId}/attachments/chk`)).status).toBe(403);
    expect((await request(memberApp).delete(`/api/payments/${payId}`)).status).toBe(403);
    expect((await request(app).get(`/api/payments/${payId}`)).body.amount).toBe(40); // nothing changed
  });

  it('GET returns the payment with its target label, project and attachments; 404 when unknown', async () => {
    await request(adminApp).post(`/api/payments/${payId}/attachments`).send({ fileId: 'chk' }).expect(200);
    await request(adminApp).post(`/api/payments/${payId}/attachments`).send({ fileId: 'remit' }).expect(200);
    const res = await request(adminApp).get(`/api/payments/${payId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: payId, targetType: 'invoice', targetId: invId, targetLabel: 'Invoice INV-5', projectId: 'p1', amount: 40 });
    expect(res.body.attachments).toEqual([
      expect.objectContaining({ fileId: 'chk', name: 'Check.jpg', mime: 'image/jpeg', kind: 'payment-attachment' }),
      expect.objectContaining({ fileId: 'remit', name: 'Remittance.pdf', mime: 'application/pdf', kind: 'document' }),
    ]);
    expect((await request(adminApp).get('/api/payments/nope')).status).toBe(404);
    // The project's list counts them for the row's paperclip.
    expect((await request(adminApp).get('/api/projects/p1/payments')).body[0].attachmentCount).toBe(2);
  });

  it('PUT edits the payment and broadcasts payment updated with its project', async () => {
    const res = await request(adminApp).put(`/api/payments/${payId}`).send({ date: 2000, amount: 55.5, method: 'ach', note: 'Wire ref 123' });
    expect(res.status).toBe(200);
    expect((await request(adminApp).get(`/api/payments/${payId}`)).body).toMatchObject({ date: 2000, amount: 55.5, method: 'ach', note: 'Wire ref 123' });
    expect((await request(adminApp).get(`/api/invoices/${invId}`)).body.paidCents).toBe(5550);
    expect(events).toEqual([expect.objectContaining({ type: 'payment', id: payId, projectId: 'p1', action: 'updated', byUserId: 'a1' })]);
  });

  it('PUT validates (400) and 404s an unknown payment, broadcasting nothing', async () => {
    expect((await request(adminApp).put(`/api/payments/${payId}`).send({ amount: 0 })).status).toBe(400);
    expect((await request(adminApp).put(`/api/payments/${payId}`).send({ amount: 'lots' })).status).toBe(400);
    expect((await request(adminApp).put('/api/payments/nope').send({ amount: 5 })).status).toBe(404);
    expect(events).toEqual([]);
  });

  it('POST/DELETE attachments link and unlink a photo or PDF and broadcast payment updated', async () => {
    await request(adminApp).post(`/api/payments/${payId}/attachments`).send({ fileId: 'chk' }).expect(200);
    await request(adminApp).delete(`/api/payments/${payId}/attachments/chk`).expect(200);
    expect((await request(adminApp).get(`/api/payments/${payId}`)).body.attachments).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({ type: 'payment', id: payId, projectId: 'p1', action: 'updated' }),
      expect.objectContaining({ type: 'payment', id: payId, projectId: 'p1', action: 'updated' }),
    ]);
  });

  it('attachment routes: 400 without a fileId or for a non-photo/PDF, 404 for an unknown payment or file', async () => {
    expect((await request(adminApp).post(`/api/payments/${payId}/attachments`).send({})).status).toBe(400);
    expect((await request(adminApp).post(`/api/payments/${payId}/attachments`).send({ fileId: 'sheet' })).status).toBe(400);
    expect((await request(adminApp).post(`/api/payments/${payId}/attachments`).send({ fileId: 'ghost' })).status).toBe(404);
    expect((await request(adminApp).post('/api/payments/nope/attachments').send({ fileId: 'chk' })).status).toBe(404);
    expect((await request(adminApp).delete('/api/payments/nope/attachments/chk')).status).toBe(404);
    expect(events).toEqual([]);
  });

  it('DELETE removes the payment and its attachment rows, broadcasting with the project resolved first', async () => {
    await request(adminApp).post(`/api/payments/${payId}/attachments`).send({ fileId: 'chk' }).expect(200);
    events.length = 0;
    await request(adminApp).delete(`/api/payments/${payId}`).expect(200);
    expect(db.prepare('SELECT COUNT(*) c FROM payment_attachments WHERE paymentId = ?').get(payId)).toEqual({ c: 0 });
    expect(events).toEqual([expect.objectContaining({ type: 'payment', id: payId, projectId: 'p1', action: 'deleted' })]);
  });
});

describe('AIA billing routes (admin-gated)', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('rejects non-admins with 403 (requireAdmin)', async () => {
    const memberApp = express();
    memberApp.use(express.json());
    registerDataRoutes(memberApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u2', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
    expect((await request(memberApp).get('/api/projects/p1/aia/sov')).status).toBe(403);
    expect((await request(memberApp).post('/api/projects/p1/aia/sov').send({ description: 'X', scheduledValueCents: 1 })).status).toBe(403);
    expect((await request(memberApp).get('/api/projects/p1/aia/settings')).status).toBe(403);
  });

  it('SOV create → list', async () => {
    const create = await request(app).post('/api/projects/p1/aia/sov')
      .send({ description: 'Drywall', scheduledValueCents: 50000 });
    expect(create.status).toBe(200);
    expect(create.body.id).toBeTruthy();
    const list = await request(app).get('/api/projects/p1/aia/sov');
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].description).toBe('Drywall');
    expect(list.body[0].scheduledValueCents).toBe(50000);
  });

  it('SOV seed replaces estimate lines', async () => {
    const seed = await request(app).post('/api/projects/p1/aia/sov/seed')
      .send({ lines: [
        { description: 'Framing', scheduledValueCents: 100000 },
        { description: 'Paint', scheduledValueCents: 25000 },
      ] });
    expect(seed.status).toBe(200);
    expect(seed.body.count).toBe(2);
    const list = await request(app).get('/api/projects/p1/aia/sov');
    expect(list.body.length).toBe(2);
    expect(list.body.map((l: any) => l.description)).toEqual(['Framing', 'Paint']);
  });

  it('SOV sync-change-orders appends approved COs as SOV lines', async () => {
    const co = await request(app).post('/api/projects/p1/change-orders')
      .send({ number: '1', description: 'Extra scope', lumpSumAmount: 300 });
    await request(app).patch(`/api/change-orders/${co.body.id}`).send({ status: 'approved' });
    const sync = await request(app).post('/api/projects/p1/aia/sov/sync-change-orders').send({});
    expect(sync.status).toBe(200);
    expect(sync.body.added).toBe(1);
    const list = await request(app).get('/api/projects/p1/aia/sov');
    const coLine = list.body.find((l: any) => l.isChangeOrder);
    expect(coLine).toBeTruthy();
    expect(coLine.scheduledValueCents).toBe(30000); // 300 * 100
    // idempotent
    const again = await request(app).post('/api/projects/p1/aia/sov/sync-change-orders').send({});
    expect(again.body.added).toBe(0);
  });

  it('PUT SOV line is version-checked (409 version_conflict on stale)', async () => {
    const id = (await request(app).post('/api/projects/p1/aia/sov')
      .send({ description: 'D', scheduledValueCents: 1000 })).body.id;
    const ok = await request(app).put(`/api/aia/sov/${id}`)
      .send({ description: 'D2', scheduledValueCents: 2000, version: 1 });
    expect(ok.status).toBe(200);
    const stale = await request(app).put(`/api/aia/sov/${id}`)
      .send({ description: 'Clobber', scheduledValueCents: 3000, version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('SOV lock: GET state, POST locks (manual, by caller), mutations 409 sov_locked, DELETE reopens', async () => {
    const line = await request(app).post('/api/projects/p1/aia/sov').send({ description: 'D', scheduledValueCents: 1000 });
    const unlocked = await request(app).get('/api/projects/p1/aia/sov/lock');
    expect(unlocked.status).toBe(200);
    expect(unlocked.body).toEqual({ locked: false, payAppCount: 0 });

    const lock = await request(app).post('/api/projects/p1/aia/sov/lock').send({});
    expect(lock.status).toBe(200);
    expect(lock.body.locked).toBe(true);
    expect(lock.body.reason).toBe('manual');
    expect(lock.body.lockedByUserId).toBe('u1');
    expect(lock.body.lockedByName).toBeNull(); // no users row in this harness

    const blocked = await request(app).put(`/api/aia/sov/${line.body.id}`).send({ description: 'E', scheduledValueCents: 1, version: 1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('sov_locked');
    expect((await request(app).post('/api/projects/p1/aia/sov').send({ description: 'X', scheduledValueCents: 1 })).status).toBe(409);
    expect((await request(app).delete(`/api/aia/sov/${line.body.id}`)).status).toBe(409);
    expect((await request(app).post('/api/projects/p1/aia/sov/seed').send({ lines: [] })).status).toBe(409);

    const reopen = await request(app).delete('/api/projects/p1/aia/sov/lock');
    expect(reopen.status).toBe(200);
    expect(reopen.body.locked).toBe(false);
    expect((await request(app).put(`/api/aia/sov/${line.body.id}`).send({ description: 'E', scheduledValueCents: 1, version: 1 })).status).toBe(200);
  });

  it('SOV lock: creating the first pay app locks it and payAppCount is reported', async () => {
    await request(app).post('/api/projects/p1/aia/sov').send({ description: 'D', scheduledValueCents: 1000 });
    await request(app).post('/api/projects/p1/aia/pay-apps').send({});
    const state = await request(app).get('/api/projects/p1/aia/sov/lock');
    expect(state.body.locked).toBe(true);
    expect(state.body.reason).toBe('pay-app');
    expect(state.body.payAppCount).toBe(1);
  });

  it('SOV lock: 404 for an unknown project', async () => {
    expect((await request(app).get('/api/projects/nope/aia/sov/lock')).status).toBe(404);
  });

  it('creating the first pay app also broadcasts aiaSov so an open SOV tab sees the auto-lock', async () => {
    await request(app).post('/api/projects/p1/aia/sov').send({ description: 'D', scheduledValueCents: 1000 });
    const events: any[] = [];
    const adminApp = express();
    adminApp.use(express.json());
    registerDataRoutes(adminApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'admin' }; next(); },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      verifyToken: () => null,
      broadcastChange: (e: any) => events.push(e),
    });
    await request(adminApp).post('/api/projects/p1/aia/pay-apps').send({}).expect(200);
    const sovEvent = events.find(e => e.type === 'aiaSov' && e.action === 'updated' && e.projectId === 'p1');
    expect(sovEvent).toBeTruthy();
  });

  it('DELETE change-order on a locked SOV with a synced SOV line is blocked 409 sov_locked', async () => {
    const co = await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-1', lumpSumAmount: 300 });
    await request(app).patch(`/api/change-orders/${co.body.id}`).send({ status: 'approved' });
    await request(app).post('/api/projects/p1/aia/sov/sync-change-orders').send({});
    await request(app).post('/api/projects/p1/aia/sov/lock').send({});
    const del = await request(app).delete(`/api/change-orders/${co.body.id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('sov_locked');
    expect((await request(app).get(`/api/change-orders/${co.body.id}`)).status).toBe(200);
  });

  it('PUT /aia/sov/order reorders contract lines; 400 on an incomplete list', async () => {
    const a = (await request(app).post('/api/projects/p1/aia/sov').send({ description: 'A', scheduledValueCents: 1 })).body.id;
    const b = (await request(app).post('/api/projects/p1/aia/sov').send({ description: 'B', scheduledValueCents: 1 })).body.id;
    expect((await request(app).put('/api/projects/p1/aia/sov/order').send({ ids: [b, a] })).status).toBe(200);
    expect((await request(app).get('/api/projects/p1/aia/sov')).body.map((l: any) => l.description)).toEqual(['B', 'A']);
    expect((await request(app).put('/api/projects/p1/aia/sov/order').send({ ids: [a] })).status).toBe(400);
  });

  it('POST /aia/sov/:id/split returns the header and children; 400 on bad percents; 409 version_conflict on stale', async () => {
    const id = (await request(app).post('/api/projects/p1/aia/sov').send({ itemNo: '1', description: 'Drywall', scheduledValueCents: 1000 })).body.id;
    const bad = await request(app).post(`/api/aia/sov/${id}/split`).send({ version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 49 }] });
    expect(bad.status).toBe(400);
    const stale = await request(app).post(`/api/aia/sov/${id}/split`).send({ version: 3, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
    const ok = await request(app).post(`/api/aia/sov/${id}/split`).send({ version: 1, parts: [{ description: 'a', percent: 50 }, { description: 'b', percent: 50 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.header.lineType).toBe('header');
    expect(ok.body.children.map((c: any) => c.scheduledValueCents)).toEqual([500, 500]);
    expect((await request(app).get('/api/projects/p1/aia/sov')).body.length).toBe(3);
  });

  it('POST /aia/sov with insertBeforeId inserts in front of the target', async () => {
    await request(app).post('/api/projects/p1/aia/sov').send({ description: 'A', scheduledValueCents: 1 });
    const b = (await request(app).post('/api/projects/p1/aia/sov').send({ description: 'B', scheduledValueCents: 1 })).body.id;
    expect((await request(app).post('/api/projects/p1/aia/sov').send({ lineType: 'header', description: 'H', insertBeforeId: b })).status).toBe(200);
    expect((await request(app).get('/api/projects/p1/aia/sov')).body.map((l: any) => l.description)).toEqual(['A', 'H', 'B']);
  });

  it('pay app create → get returns app, lines, g702, g703', async () => {
    await request(app).post('/api/projects/p1/aia/sov')
      .send({ description: 'Work', scheduledValueCents: 100000 });
    const create = await request(app).post('/api/projects/p1/aia/pay-apps').send({});
    expect(create.status).toBe(200);
    expect(create.body.id).toBeTruthy();
    expect(create.body.number).toBe(1);
    const list = await request(app).get('/api/projects/p1/aia/pay-apps');
    expect(list.body.length).toBe(1);
    const get = await request(app).get(`/api/aia/pay-apps/${create.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.app).toBeTruthy();
    expect(Array.isArray(get.body.lines)).toBe(true);
    expect(Array.isArray(get.body.g703)).toBe(true);
    expect(get.body.g702).toHaveProperty('L1originalContractCents');
    expect(get.body.g702.L1originalContractCents).toBe(100000);
  });

  it('GET unknown pay app → 404', async () => {
    expect((await request(app).get('/api/aia/pay-apps/nope')).status).toBe(404);
  });

  it('PUT pay app lines is version-checked (200 then 409 on stale)', async () => {
    const sovId = (await request(app).post('/api/projects/p1/aia/sov')
      .send({ description: 'Work', scheduledValueCents: 100000 })).body.id;
    const appId = (await request(app).post('/api/projects/p1/aia/pay-apps').send({})).body.id;
    const ok = await request(app).put(`/api/aia/pay-apps/${appId}/lines`)
      .send({ version: 1, lines: [{ sovLineId: sovId, percentComplete: 50, storedMaterialsCents: 0 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    const stale = await request(app).put(`/api/aia/pay-apps/${appId}/lines`)
      .send({ version: 1, lines: [{ sovLineId: sovId, percentComplete: 75, storedMaterialsCents: 0 }] });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('new pay app defaults storedRetainagePercent to retainagePercent, ignoring legacy stored settings', async () => {
    // Legacy projects still carry a distinct storedRetainagePercent in
    // aiaSettings from the two-rate era; the single-rate world must not let
    // that leak into new apps — they should snapshot 15/15, not 15/10.
    await request(app).put('/api/projects/p1/aia/settings')
      .send({ retainagePercent: 15, storedRetainagePercent: 10 });
    const create = await request(app).post('/api/projects/p1/aia/pay-apps').send({});
    expect(create.status).toBe(200);
    const get = await request(app).get(`/api/aia/pay-apps/${create.body.id}`);
    expect(get.body.app.retainagePercent).toBe(15);
    expect(get.body.app.storedRetainagePercent).toBe(15);
  });

  it('aia/settings round-trips via project meta', async () => {
    const empty = await request(app).get('/api/projects/p1/aia/settings');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({});
    const put = await request(app).put('/api/projects/p1/aia/settings')
      .send({ retainagePercent: 5, storedRetainagePercent: 0, architect: 'AOR Inc' });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/projects/p1/aia/settings');
    expect(get.body.retainagePercent).toBe(5);
    expect(get.body.storedRetainagePercent).toBe(0);
    expect(get.body.architect).toBe('AOR Inc');
    // survives a project reload
    expect(loadProject(db, 'p1').aiaSettings.retainagePercent).toBe(5);
  });
});

describe('issue routes', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('create → list (ISS number) → get → status', async () => {
    const create = await request(app).post('/api/projects/p1/issues').send({ title: 'Crack', description: 'Wall crack near door' });
    expect(create.status).toBe(200);
    expect(create.body.number).toBe(1);
    const list = await request(app).get('/api/projects/p1/issues');
    expect(list.body[0].number).toBe(1);
    const get = await request(app).get(`/api/issues/${create.body.id}`);
    expect(get.body.title).toBe('Crack');
    expect(get.body.status).toBe('open');
    const patch = await request(app).patch(`/api/issues/${create.body.id}`).send({ status: 'resolved' });
    expect(patch.status).toBe(200);
    expect((await request(app).get(`/api/issues/${create.body.id}`)).body.status).toBe('resolved');
  });

  it('save body is version-checked (409 on stale)', async () => {
    const id = (await request(app).post('/api/projects/p1/issues').send({ title: 'A' })).body.id;
    const iss = (await request(app).get(`/api/issues/${id}`)).body;
    expect((await request(app).put(`/api/issues/${id}`).send({ ...iss, title: 'A2' })).status).toBe(200);
    expect((await request(app).put(`/api/issues/${id}`).send({ ...iss, title: 'Clobber' })).status).toBe(409);
  });

  it('photos: link → appears in get → unlink', async () => {
    const id = (await request(app).post('/api/projects/p1/issues').send({ title: 'A' })).body.id;
    await request(app).post('/api/files/ph1?projectId=p1&kind=photo&name=p.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    await request(app).post(`/api/issues/${id}/photos`).send({ fileId: 'ph1' }).expect(200);
    expect((await request(app).get(`/api/issues/${id}`)).body.photos.map((p: any) => p.fileId)).toEqual(['ph1']);
    await request(app).delete(`/api/issues/${id}/photos/ph1`).expect(200);
    expect((await request(app).get(`/api/issues/${id}`)).body.photos).toHaveLength(0);
  });

  it('validates and 404s', async () => {
    expect((await request(app).post('/api/projects/p1/issues').send({ title: '' })).status).toBe(400);
    expect((await request(app).get('/api/issues/nope')).status).toBe(404);
    expect((await request(app).patch('/api/issues/nope').send({ status: 'open' })).status).toBe(404);
  });
});

describe('rfi routes', () => {
  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  it('create → number 1, then 2 (per project); 400 with no title; 404 unknown project', async () => {
    const c1 = await request(app).post('/api/projects/p1/rfis').send({ title: 'First question' });
    expect(c1.status).toBe(200);
    expect(c1.body.number).toBe(1);
    const c2 = await request(app).post('/api/projects/p1/rfis').send({ title: 'Second question' });
    expect(c2.status).toBe(200);
    expect(c2.body.number).toBe(2);
    expect((await request(app).post('/api/projects/p1/rfis').send({ title: '' })).status).toBe(400);
    expect((await request(app).post('/api/projects/nope/rfis').send({ title: 'X' })).status).toBe(404);
  });

  it('create stores specRef/drawingRef/attention/responseNeededBy (GET returns them)', async () => {
    const create = await request(app).post('/api/projects/p1/rfis').send({
      title: 'Finish clarification',
      specRef: '09 30 00',
      drawingRef: 'A-501',
      attention: 'Architect',
      responseNeededBy: '2026-08-01',
    });
    expect(create.status).toBe(200);
    const get = await request(app).get(`/api/rfis/${create.body.id}`);
    expect(get.status).toBe(200);
    expect(get.body.specRef).toBe('09 30 00');
    expect(get.body.drawingRef).toBe('A-501');
    expect(get.body.attention).toBe('Architect');
    expect(get.body.responseNeededBy).toBe('2026-08-01');
  });

  it('GET unknown id → 404', async () => {
    expect((await request(app).get('/api/rfis/nope')).status).toBe(404);
  });

  it('PUT round-trip bumps version; stale version → 409 with code version_conflict', async () => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'A' })).body.id;
    const rfi = (await request(app).get(`/api/rfis/${id}`)).body;
    const ok = await request(app).put(`/api/rfis/${id}`).send({ ...rfi, title: 'A2' });
    expect(ok.status).toBe(200);
    expect(ok.body.success).toBe(true);
    expect(ok.body.version).toBe(rfi.version + 1);
    const stale = await request(app).put(`/api/rfis/${id}`).send({ ...rfi, title: 'Clobber' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('PATCH status → answered ok; bogus → 400; PATCH to closed succeeds', async () => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'A' })).body.id;
    const answered = await request(app).patch(`/api/rfis/${id}`).send({ status: 'answered' });
    expect(answered.status).toBe(200);
    expect((await request(app).get(`/api/rfis/${id}`)).body.status).toBe('answered');
    const bogus = await request(app).patch(`/api/rfis/${id}`).send({ status: 'bogus' });
    expect(bogus.status).toBe(400);
    const closed = await request(app).patch(`/api/rfis/${id}`).send({ status: 'closed' });
    expect(closed.status).toBe(200);
    expect((await request(app).get(`/api/rfis/${id}`)).body.status).toBe('closed');
  });

  it('DELETE removes; photos: POST without fileId → 400, POST+DELETE round-trip, photoCount in list', async () => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'A' })).body.id;
    const badPhoto = await request(app).post(`/api/rfis/${id}/photos`).send({});
    expect(badPhoto.status).toBe(400);
    await request(app).post('/api/files/ph1?projectId=p1&kind=photo&name=p.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    await request(app).post(`/api/rfis/${id}/photos`).send({ fileId: 'ph1' }).expect(200);
    let list = await request(app).get('/api/projects/p1/rfis');
    expect(list.body.find((r: any) => r.id === id).photoCount).toBe(1);
    await request(app).delete(`/api/rfis/${id}/photos/ph1`).expect(200);
    list = await request(app).get('/api/projects/p1/rfis');
    expect(list.body.find((r: any) => r.id === id).photoCount).toBe(0);
    await request(app).delete(`/api/rfis/${id}`).expect(200);
    expect((await request(app).get(`/api/rfis/${id}`)).status).toBe(404);
  });

  it('POST /api/rfis/:id/response handles missing input, text, file, closed RFI, and unknown id', async () => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'A' })).body.id;

    expect((await request(app).post(`/api/rfis/${id}/response`).send({})).status).toBe(400);

    const textRes = await request(app).post(`/api/rfis/${id}/response`).send({ text: 'Per detail 5/A-501' });
    expect(textRes.status).toBe(200);
    const afterText = (await request(app).get(`/api/rfis/${id}`)).body;
    expect(afterText.status).toBe('answered');
    expect(afterText.answeredAt).toBeTruthy();
    expect(afterText.responseText).toBe('Per detail 5/A-501');

    const fileRes = await request(app).post(`/api/rfis/${id}/response`).send({ fileId: 'file-1' });
    expect(fileRes.status).toBe(200);
    expect((await request(app).get(`/api/rfis/${id}`)).body.responseFileId).toBe('file-1');

    await request(app).patch(`/api/rfis/${id}`).send({ status: 'closed' });
    const closedRes = await request(app).post(`/api/rfis/${id}/response`).send({ text: 'Additional note' });
    expect(closedRes.status).toBe(200);
    expect((await request(app).get(`/api/rfis/${id}`)).body.status).toBe('closed');

    expect((await request(app).post('/api/rfis/nope/response').send({ text: 'x' })).status).toBe(404);
  });
});

describe('rfi pending-reply routes', () => {
  let broadcasts: EntityChangedEvent[];
  // RFIs are field work: the accept/dismiss routes must work for a non-admin,
  // so this app's stub user is a member and requireAdmin refuses outright.
  let memberApp: express.Express;

  const PENDING: RfiPendingReply = {
    threadKey: 'rfi-thread@birchwood.example', accountId: 'acct-1', mailMessageId: 'mm1', messageIdHeader: 'm1@tidewater.example',
    from: { addr: 'gc@tidewater.example', name: 'Mike' }, date: '2026-08-28T10:00:00.000Z', text: 'Corridor is 9ft',
    attachments: [{ attId: 'a1', name: 'sketch.pdf', mime: 'application/pdf', size: 9 }], receivedAt: '2026-08-28T10:00:01.000Z',
  };

  beforeEach(async () => {
    broadcasts = [];
    memberApp = express();
    memberApp.use(express.json({ limit: '50mb' }));
    registerDataRoutes(memberApp, {
      db,
      dataDir: dir,
      dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role: 'member' }; next(); },
      requireAdmin: (_req: any, res: any) => res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: ev => { broadcasts.push(ev); },
    });
    await request(app).post('/api/projects').send(PROJECT); // id p1
  });

  const stageReply = async (): Promise<string> => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Corridor height?' })).body.id;
    markRfiSent(db, id);
    setPendingReply(db, id, PENDING);
    return id;
  };

  it('accept promotes the emailed reply, logs the activity and clears the pending reply', async () => {
    const id = await stageReply();
    const res = await request(memberApp).post(`/api/rfis/${id}/pending-reply/accept`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'answered' });
    const after = (await request(app).get(`/api/rfis/${id}`)).body;
    expect(after.status).toBe('answered');
    expect(after.responseText).toBe('Corridor is 9ft');
    expect(after.responseSource).toBe('email');
    expect(after.responseMessageIdHeader).toBe('m1@tidewater.example');
    expect(after.answeredAt).toBeTruthy();
    expect(after.pendingReply).toBeNull();
    expect((db.prepare(`SELECT message FROM activity WHERE type = 'rfi_answered'`).all() as any[]).map(r => r.message)).toEqual(['RFI RFI-001 answered via email']);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ type: 'rfi', id, projectId: 'p1', version: after.version, action: 'updated', byUserId: 'u1' });
  });

  it('accept honours edited text and a response file', async () => {
    const id = await stageReply();
    const res = await request(memberApp).post(`/api/rfis/${id}/pending-reply/accept`).send({ text: 'Corridor is 9\'-0" per RFI reply', fileId: 'file-1' });
    expect(res.status).toBe(200);
    const after = (await request(app).get(`/api/rfis/${id}`)).body;
    expect(after.responseText).toBe('Corridor is 9\'-0" per RFI reply');
    expect(after.responseFileId).toBe('file-1');
    expect(after.pendingReply).toBeNull();
  });

  it('dismiss clears the pending reply and leaves the RFI unanswered', async () => {
    const id = await stageReply();
    const res = await request(memberApp).post(`/api/rfis/${id}/pending-reply/dismiss`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    const after = (await request(app).get(`/api/rfis/${id}`)).body;
    expect(after.pendingReply).toBeNull();
    expect(after.status).toBe('sent');
    expect(after.responseText ?? null).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) c FROM activity WHERE type = 'rfi_answered'`).get()).toEqual({ c: 0 });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({ type: 'rfi', id, projectId: 'p1', version: after.version, action: 'updated', byUserId: 'u1' });
  });

  it('409 when nothing is pending, 404 for an unknown RFI', async () => {
    const id = (await request(app).post('/api/projects/p1/rfis').send({ title: 'No reply yet' })).body.id;
    const accept = await request(memberApp).post(`/api/rfis/${id}/pending-reply/accept`).send({});
    const dismiss = await request(memberApp).post(`/api/rfis/${id}/pending-reply/dismiss`).send({});
    expect(accept.status).toBe(409);
    expect(dismiss.status).toBe(409);
    // Both routes carry the same marker: the client uses it to tell "someone
    // else already handled this" from a request that simply failed.
    expect(accept.body.code).toBe('no_pending_reply');
    expect(dismiss.body.code).toBe('no_pending_reply');
    expect((await request(memberApp).post('/api/rfis/nope/pending-reply/accept').send({})).status).toBe(404);
    expect((await request(memberApp).post('/api/rfis/nope/pending-reply/dismiss').send({})).status).toBe(404);
    expect(broadcasts).toEqual([]);
  });

  it('a dismissed reply cannot then be accepted', async () => {
    const id = await stageReply();
    await request(memberApp).post(`/api/rfis/${id}/pending-reply/dismiss`).send({}).expect(200);
    expect((await request(memberApp).post(`/api/rfis/${id}/pending-reply/accept`).send({})).status).toBe(409);
  });
});

// PDF attachments on change orders, RFIs, issues and daily reports (migration
// 42). Each set of routes sits behind the same gate as that record's photo
// routes: change orders are admin-only, the field records are not.
describe('PDF attachment routes', () => {
  let broadcasts: EntityChangedEvent[];
  let memberApp: express.Express;

  beforeEach(async () => {
    broadcasts = [];
    memberApp = express();
    memberApp.use(express.json({ limit: '50mb' }));
    registerDataRoutes(memberApp, {
      db,
      dataDir: dir,
      dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'm1', role: 'member' }; next(); },
      requireAdmin: (_req: any, res: any) => res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: ev => { broadcasts.push(ev); },
    });
    await request(app).post('/api/projects').send(PROJECT); // id p1
    for (const id of ['spec1', 'spec2']) {
      await request(app).post(`/api/files/${id}?projectId=p1&kind=document&name=${id}.pdf`)
        .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF-1.4'));
    }
    await request(app).post('/api/files/img1?projectId=p1&kind=photo&name=p.jpg')
      .set('Content-Type', 'image/jpeg').send(Buffer.from('img'));
  });

  const FIELD_RECORDS = [
    { label: 'issues', base: '/api/issues', type: 'issue', create: async () => (await request(app).post('/api/projects/p1/issues').send({ title: 'Crack' })).body.id },
    { label: 'RFIs', base: '/api/rfis', type: 'rfi', create: async () => (await request(app).post('/api/projects/p1/rfis').send({ title: 'Which finish?' })).body.id },
    { label: 'daily reports', base: '/api/daily-reports', type: 'dailyReport', create: async () => (await request(app).post('/api/projects/p1/daily-reports').send({ crewId: await firstCrew(), reportDate: '2026-08-20' })).body.id },
  ] as const;

  for (const rec of FIELD_RECORDS) {
    it(`${rec.label}: a member can add, reorder and remove; each change broadcasts without a version`, async () => {
      const id = await rec.create();
      const before = (await request(app).get(`${rec.base}/${id}`)).body;

      await request(memberApp).post(`${rec.base}/${id}/attachments`).send({ fileId: 'spec1' }).expect(200);
      await request(memberApp).post(`${rec.base}/${id}/attachments`).send({ fileId: 'spec2' }).expect(200);
      let got = (await request(app).get(`${rec.base}/${id}`)).body;
      expect(got.attachments).toEqual([
        expect.objectContaining({ fileId: 'spec1', sortOrder: 0, name: 'spec1.pdf', mime: 'application/pdf' }),
        expect.objectContaining({ fileId: 'spec2', sortOrder: 1, name: 'spec2.pdf' }),
      ]);
      // Like the photos: updatedAt moved (the generated PDF is now out of
      // date), version did not (a dirty editor elsewhere can still save).
      expect(got.version).toBe(before.version);
      expect(got.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);

      await request(memberApp).patch(`${rec.base}/${id}/attachments/spec1`).send({ sortOrder: 5 }).expect(200);
      got = (await request(app).get(`${rec.base}/${id}`)).body;
      expect(got.attachments.map((a: any) => a.fileId)).toEqual(['spec2', 'spec1']);

      await request(memberApp).delete(`${rec.base}/${id}/attachments/spec2`).expect(200);
      got = (await request(app).get(`${rec.base}/${id}`)).body;
      expect(got.attachments.map((a: any) => a.fileId)).toEqual(['spec1']);
      expect(got.version).toBe(before.version);

      expect(broadcasts).toHaveLength(4);
      for (const ev of broadcasts) {
        expect(ev).toMatchObject({ type: rec.type, id, projectId: 'p1', action: 'updated', byUserId: 'm1' });
        expect(ev).not.toHaveProperty('version');
      }
    });

    it(`${rec.label}: refuses a non-PDF (400), an unknown file or record (404), a missing fileId or bad sortOrder (400)`, async () => {
      const id = await rec.create();
      expect((await request(memberApp).post(`${rec.base}/${id}/attachments`).send({ fileId: 'img1' })).status).toBe(400);
      expect((await request(memberApp).post(`${rec.base}/${id}/attachments`).send({ fileId: 'nope' })).status).toBe(404);
      expect((await request(memberApp).post(`${rec.base}/${id}/attachments`).send({})).status).toBe(400);
      expect((await request(memberApp).post(`${rec.base}/nope/attachments`).send({ fileId: 'spec1' })).status).toBe(404);
      expect((await request(memberApp).patch(`${rec.base}/${id}/attachments/spec1`).send({ sortOrder: 0 })).status).toBe(404);
      await request(memberApp).post(`${rec.base}/${id}/attachments`).send({ fileId: 'spec1' }).expect(200);
      expect((await request(memberApp).patch(`${rec.base}/${id}/attachments/spec1`).send({ sortOrder: 'first' })).status).toBe(400);
      expect((await request(app).get(`${rec.base}/${id}`)).body.attachments).toHaveLength(1);
    });
  }

  it('change orders: admin-gated like their photos, and each change broadcasts the bumped version', async () => {
    const id = (await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-1' })).body.id;
    expect((await request(memberApp).post(`/api/change-orders/${id}/attachments`).send({ fileId: 'spec1' })).status).toBe(403);
    expect((await request(memberApp).patch(`/api/change-orders/${id}/attachments/spec1`).send({ sortOrder: 0 })).status).toBe(403);
    expect((await request(memberApp).delete(`/api/change-orders/${id}/attachments/spec1`)).status).toBe(403);

    const events: EntityChangedEvent[] = [];
    const adminApp = express();
    adminApp.use(express.json());
    registerDataRoutes(adminApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'a1', role: 'admin' }; next(); },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
      verifyToken: () => null,
      broadcastChange: ev => { events.push(ev); },
    });
    const before = (await request(adminApp).get(`/api/change-orders/${id}`)).body.version;
    expect((await request(adminApp).post(`/api/change-orders/${id}/attachments`).send({ fileId: 'img1' })).status).toBe(400);
    expect((await request(adminApp).post(`/api/change-orders/${id}/attachments`).send({})).status).toBe(400);
    await request(adminApp).post(`/api/change-orders/${id}/attachments`).send({ fileId: 'spec1' }).expect(200);
    await request(adminApp).post(`/api/change-orders/${id}/attachments`).send({ fileId: 'spec2' }).expect(200);
    await request(adminApp).patch(`/api/change-orders/${id}/attachments/spec2`).send({ sortOrder: -1 }).expect(200);
    let got = (await request(adminApp).get(`/api/change-orders/${id}`)).body;
    expect(got.attachments.map((a: any) => a.fileId)).toEqual(['spec2', 'spec1']);
    expect(got.version).toBe(before + 3);
    await request(adminApp).delete(`/api/change-orders/${id}/attachments/spec1`).expect(200);
    got = (await request(adminApp).get(`/api/change-orders/${id}`)).body;
    expect(got.attachments.map((a: any) => a.fileId)).toEqual(['spec2']);
    expect(got.version).toBe(before + 4);
    expect(events.map(e => e.version)).toEqual([before + 1, before + 2, before + 3, before + 4]);
    for (const ev of events) expect(ev).toMatchObject({ type: 'changeOrder', id, projectId: 'p1', action: 'updated' });
  });
});

describe('punch routes', () => {
  let userApp: express.Express;

  beforeEach(async () => {
    await request(app).post('/api/projects').send(PROJECT); // id p1

    // A second app wired with a non-admin 'user' role — proves punch is NOT admin-gated
    userApp = express();
    userApp.use(express.json());
    registerDataRoutes(userApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u2', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
  });

  it('non-admin user CAN POST and GET punch items (not admin-gated)', async () => {
    const create = await request(userApp).post('/api/projects/p1/punch')
      .send({ description: 'Touch up paint', area: 'Kitchen' });
    expect(create.status).toBe(200);
    expect(create.body.id).toBeTruthy();
    const list = await request(userApp).get('/api/projects/p1/punch');
    expect(list.status).toBe(200);
    expect(list.body.some((item: any) => item.description === 'Touch up paint')).toBe(true);
  });

  it('PUT with stale version returns 409 with code version_conflict', async () => {
    const id = (await request(app).post('/api/projects/p1/punch').send({ description: 'Fix door', area: 'Entry' })).body.id;
    const res = await request(app).put(`/api/punch/${id}`).send({ description: 'Updated', version: 99 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('version_conflict');
  });

  it('PATCH with done:true marks item done (200)', async () => {
    const id = (await request(app).post('/api/projects/p1/punch').send({ description: 'Caulk tub', area: 'Bath' })).body.id;
    const res = await request(app).patch(`/api/punch/${id}`).send({ done: true });
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/punch/${id}`)).body.done).toBe(1);
  });

  it('PATCH without done boolean returns 400', async () => {
    const id = (await request(app).post('/api/projects/p1/punch').send({ description: 'Sand walls' })).body.id;
    const res = await request(app).patch(`/api/punch/${id}`).send({ area: 'Hall' });
    expect(res.status).toBe(400);
  });

  it('POST /api/punch/:id/photos links photo; GET shows it; invalid stage → 400', async () => {
    const id = (await request(app).post('/api/projects/p1/punch').send({ description: 'Install fixture' })).body.id;
    const add = await request(app).post(`/api/punch/${id}/photos`).send({ fileId: 'f1', stage: 'before' });
    expect(add.status).toBe(200);
    const get = await request(app).get(`/api/punch/${id}`);
    expect(get.body.photos.some((p: any) => p.fileId === 'f1')).toBe(true);
    const bad = await request(app).post(`/api/punch/${id}/photos`).send({ fileId: 'f2', stage: 'invalid' });
    expect(bad.status).toBe(400);
  });
});

describe('users-list + task routes (auth-only, not admin-gated)', () => {
  let userApp: express.Express;

  beforeEach(() => {
    // Seed real users so /api/users/list and assignee validation have rows
    db.prepare("INSERT INTO users (id, username, password, role) VALUES ('u1','alice','secret','admin'),('u2','bob','hunter2','user')").run();

    // Non-admin 'user' app — every task route must work here (NOT admin-gated)
    userApp = express();
    userApp.use(express.json());
    registerDataRoutes(userApp, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u2', role: 'user' }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      verifyToken: () => null,
      broadcastChange: () => {},
    });
  });

  it('GET /api/users/list (non-admin) returns roster with no password leaked', async () => {
    const res = await request(userApp).get('/api/users/list');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    for (const row of res.body) {
      expect(row).toHaveProperty('id');
      expect(row).toHaveProperty('username');
      expect(row).toHaveProperty('role');
      expect(row).not.toHaveProperty('password');
    }
  });

  it('POST /api/tasks (non-admin) creates a task — not admin-gated', async () => {
    const res = await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Fix door' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();
  });

  it('GET /api/tasks (non-admin) lists tasks with assigneeUsername (null when unassigned)', async () => {
    const create = await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Fix door' });
    const list = await request(userApp).get('/api/tasks');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    const row = list.body.find((t: any) => t.id === create.body.id);
    expect(row).toBeTruthy();
    expect(row.assigneeUsername).toBeNull();
  });

  it('POST /api/tasks with a real assignee → 200; bogus assignee → 400', async () => {
    const ok = await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Assigned', assigneeUserId: 'u1' });
    expect(ok.status).toBe(200);
    const get = await request(userApp).get(`/api/tasks/${ok.body.id}`);
    expect(get.body.assigneeUsername).toBe('alice');
    const bad = await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Bad', assigneeUserId: 'nope' });
    expect(bad.status).toBe(400);
  });

  it('POST /api/tasks with a projectId derives+returns the project customer + names', async () => {
    db.prepare("INSERT INTO customers (id, name, createdAt) VALUES ('c1','Acme',0)").run();
    db.prepare("INSERT INTO projects (id, name, customerId, version, createdAt) VALUES ('pr1','Plaza','c1',1,0)").run();
    // A mismatched client customerId must be ignored — the project dictates the customer.
    const ok = await request(userApp).post('/api/tasks').send({ title: 'On project', projectId: 'pr1', customerId: 'bogus' });
    expect(ok.status).toBe(200);
    const get = await request(userApp).get(`/api/tasks/${ok.body.id}`);
    expect(get.body.projectId).toBe('pr1');
    expect(get.body.customerId).toBe('c1');
    expect(get.body.projectName).toBe('Plaza');
    expect(get.body.customerName).toBe('Acme');
    // Unknown project id is rejected at the route.
    const bad = await request(userApp).post('/api/tasks').send({ title: 'Bad', projectId: 'nope' });
    expect(bad.status).toBe(400);
  });

  it('GET /api/tasks?projectId= and ?customerId= filter the list', async () => {
    db.prepare("INSERT INTO customers (id, name, createdAt) VALUES ('c1','Acme',0),('c2','Globex',0)").run();
    db.prepare("INSERT INTO projects (id, name, customerId, version, createdAt) VALUES ('pr1','Plaza','c1',1,0)").run();
    await request(userApp).post('/api/tasks').send({ title: 'onPr1', projectId: 'pr1' });
    await request(userApp).post('/api/tasks').send({ title: 'onC2', customerId: 'c2' });
    await request(userApp).post('/api/tasks').send({ title: 'unlinked' });
    const byProject = await request(userApp).get('/api/tasks?projectId=pr1');
    expect(byProject.body.map((t: any) => t.title)).toEqual(['onPr1']);
    const byCustomer = await request(userApp).get('/api/tasks?customerId=c1');
    expect(byCustomer.body.map((t: any) => t.title)).toEqual(['onPr1']); // derived from pr1
    const byCustomer2 = await request(userApp).get('/api/tasks?customerId=c2');
    expect(byCustomer2.body.map((t: any) => t.title)).toEqual(['onC2']);
  });

  it('PUT /api/tasks/:id with stale version 99 → 409 version_conflict', async () => {
    const id = (await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Door' })).body.id;
    const res = await request(userApp).put(`/api/tasks/${id}`).send({ title: 'Door', version: 99 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('version_conflict');
  });

  it('PATCH /api/tasks/:id status: valid → 200; bad → 400; missing → 400', async () => {
    const id = (await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Door' })).body.id;
    expect((await request(userApp).patch(`/api/tasks/${id}`).send({ status: 'in_progress' })).status).toBe(200);
    expect((await request(userApp).patch(`/api/tasks/${id}`).send({ status: 'nope' })).status).toBe(400);
    expect((await request(userApp).patch(`/api/tasks/${id}`).send({})).status).toBe(400);
  });

  it('POST /api/tasks/:id/photos: valid stage → 200, appears in GET; bad stage → 400', async () => {
    const id = (await request(userApp).post('/api/tasks').send({ category: 'Shop', title: 'Door' })).body.id;
    const add = await request(userApp).post(`/api/tasks/${id}/photos`).send({ fileId: 'f1', stage: 'before' });
    expect(add.status).toBe(200);
    const bad = await request(userApp).post(`/api/tasks/${id}/photos`).send({ fileId: 'f1', stage: 'sideways' });
    expect(bad.status).toBe(400);
    const get = await request(userApp).get(`/api/tasks/${id}`);
    expect(get.body.photos.some((p: any) => p.fileId === 'f1')).toBe(true);
  });
});

describe('email send routes', () => {
  // The item send routes now go through server/mail/sendService, so the transport
  // under test is a FakeMailProvider bound to a real mail account for u1 —
  // provider.sent replaces the old nodemailer transporter stub.
  let emailApp: express.Express;
  let ctx: MailContext;
  let acct: accounts.MailAccountRow;
  let provider: FakeMailProvider;
  let broadcasts: EntityChangedEvent[];
  const mailCrypto = new MailCrypto(Buffer.alloc(32, 7));

  const buildEmailApp = (role: 'admin' | 'member', userId = 'u1') => {
    const a = express();
    a.use(express.json({ limit: '50mb' }));
    registerEmailRoutes(a, {
      db,
      authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: userId, role }; next(); },
      requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
      broadcastChange: () => {},
      mailCtx: ctx,
    });
    return a;
  };

  beforeEach(async () => {
    resetFakes();
    // mail_accounts.userId is a real FK — the send routes' stub user must exist.
    db.prepare("INSERT OR IGNORE INTO users (id, username, password, role) VALUES ('u1', 'u1', 'x', 'admin')").run();
    broadcasts = [];
    ctx = { db, dataDir: dir, crypto: mailCrypto, providerFactory: a => getFakeProvider(a.id), broadcastChange: ev => { broadcasts.push(ev); } };
    acct = accounts.createAccount(db, mailCrypto, {
      userId: 'u1', provider: 'fake', emailAddress: 'noreply@example.com', displayName: 'Frugal', auth: { refreshToken: 'r' },
    });
    provider = getFakeProvider(acct.id);
    upsertFolders(db, acct.id, provider.folders);
    emailApp = buildEmailApp('admin');
    // emailApp only has the email routes; create the project + files via the data-routes app (shared db).
    await request(app).post('/api/projects').send(PROJECT);
    // Primary PDF + two extra attachments, stored with metadata
    await request(app).post('/api/files/primary?projectId=p1&kind=invoice&name=primary.pdf').set('Content-Type', 'application/pdf').send(Buffer.from('PDFPRIMARY'));
    await request(app).post('/api/files/extra1?projectId=p1&kind=email-attachment&name=Spec.pdf').set('Content-Type', 'application/pdf').send(Buffer.from('SPECBYTES'));
    await request(app).post('/api/files/extra2?projectId=p1&kind=email-attachment&name=Photo.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('JPEGBYTES'));
  });

  const makeInvoice = async () =>
    (await request(app).post('/api/projects/p1/invoices').send({ number: 'INV-1', lines: [{ description: 'Work', qty: 1, unitPrice: 100 }] })).body.id;

  const addrs = (list: { addr: string }[]) => list.map(a => a.addr);
  const names = (list: { name: string }[]) => list.map(a => a.name);

  it('invoice send: accepts cc/bcc/subject/body + multiple attachments; forwards them; marks sent', async () => {
    const id = await makeInvoice();
    const before = (await request(app).get(`/api/invoices/${id}`)).body.updatedAt;
    await new Promise(r => setTimeout(r, 2));
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({
      to: 'client@example.com',
      cc: ' cc@example.com ',
      bcc: 'bcc@example.com',
      subject: 'Custom Subject',
      body: 'Custom body text',
      fileId: 'primary',
      attachmentFileIds: ['extra1', 'extra2'],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, accountId: acct.id, effectsSkipped: [] });
    expect(res.body.threadKey).toBeTruthy();
    expect(provider.sent).toHaveLength(1);
    const m = provider.sent[0];
    expect(addrs(m.to)).toEqual(['client@example.com']);
    expect(addrs(m.cc)).toEqual(['cc@example.com']);   // trimmed
    expect(addrs(m.bcc)).toEqual(['bcc@example.com']);
    expect(m.subject).toBe('Custom Subject');
    expect(m.text).toBe('Custom body text');
    expect(m.html).toBe('<p>Custom body text</p>');
    expect(m.from).toEqual({ addr: 'noreply@example.com', name: 'Frugal' });
    // primary + two extras, named from metadata
    expect(names(m.attachments)).toEqual(['INV-1.pdf', 'Spec.pdf', 'Photo.jpg']);
    expect(m.attachments[0].content.toString()).toBe('PDFPRIMARY');
    expect(m.attachments[1].mime).toBe('application/pdf');
    expect(m.attachments[2].mime).toBe('image/jpeg');
    // status side-effect fired (inside sendService → applySendEffects)
    const after = (await request(app).get(`/api/invoices/${id}`)).body;
    expect(after.status).toBe('sent');
    expect(after.updatedAt).toBeGreaterThan(before);
    // and the thread is linked back to the invoice
    expect(db.prepare('SELECT itemType, itemId FROM mail_thread_links WHERE threadKey = ?').all(res.body.threadKey))
      .toEqual([{ itemType: 'invoice', itemId: id }]);
  });

  it('pay app send (ONLYOFFICE Phase 4): the workbook first, its PDF along, the thread linked to the pay app', async () => {
    const { id, number } = createPayApp(db, 'p1', {});
    await request(app).post(`/api/files/wb?projectId=p1&kind=payapp-export&sourceType=payapp&sourceId=${id}&name=${encodeURIComponent(`Pay App #${number} — G702.xlsx`)}`)
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from('XLSXBYTES'));
    await request(app).post(`/api/files/pdf?projectId=p1&kind=payapp-pdf&sourceType=payapp&sourceId=${id}&name=${encodeURIComponent(`Pay App #${number} — G702.pdf`)}`)
      .set('Content-Type', 'application/pdf').send(Buffer.from('PDFBYTES'));
    const res = await request(emailApp).post(`/api/aia/pay-apps/${id}/send`).send({ to: 'gc@example.com', fileId: 'wb', attachmentFileIds: ['pdf'] });
    expect(res.status).toBe(200);
    const m = provider.sent[0];
    expect(names(m.attachments)).toEqual([`Pay App #${number} — G702.xlsx`, `Pay App #${number} — G702.pdf`]);
    expect(m.subject).toBe(`Application for Payment #${number} — Test Project`);
    expect(db.prepare('SELECT itemType, itemId FROM mail_thread_links WHERE threadKey = ?').all(res.body.threadKey))
      .toEqual([{ itemType: 'payApp', itemId: id }]);
    expect((await request(buildEmailApp('member')).post(`/api/aia/pay-apps/${id}/send`).send({ to: 'x@y.z', fileId: 'wb' })).status).toBe(403);
    expect((await request(emailApp).post('/api/aia/pay-apps/nope/send').send({ to: 'x@y.z', fileId: 'wb' })).status).toBe(404);
  });

  it('lien release send: default subject and file name, thread linked, release marked sent', async () => {
    const created = (await request(app).post('/api/projects/p1/lien-releases').send({
      paymentType: 'progress', conditional: true, lienorName: 'Birchwood', customerName: 'Acme', ownerName: 'Jane',
      propertyDescription: 'Lot 4', amountCents: 50000, throughDate: '2026-09-30', releaseDate: '2026-10-15', signerName: 'Noah',
    })).body;
    await request(app).post(`/api/files/lr?projectId=p1&kind=lien-release&sourceType=lien-release&sourceId=${created.id}&name=LR.pdf`)
      .set('Content-Type', 'application/pdf').send(Buffer.from('LRBYTES'));
    const res = await request(emailApp).post(`/api/lien-releases/${created.id}/send`).send({ to: 'gc@example.com', fileId: 'lr' });
    expect(res.status).toBe(200);
    const m = provider.sent[0];
    expect(names(m.attachments)).toEqual(['LR-1 Conditional Progress Release.pdf']);
    expect(m.subject).toBe('Conditional Waiver and Release of Lien upon Progress Payment — Test Project');
    expect(m.text).toBe('Please find attached our conditional waiver and release of lien for Test Project.');
    expect(db.prepare('SELECT itemType, itemId FROM mail_thread_links WHERE threadKey = ?').all(res.body.threadKey))
      .toEqual([{ itemType: 'lienRelease', itemId: created.id }]);
    expect((await request(app).get(`/api/lien-releases/${created.id}`)).body.status).toBe('sent');
    expect((await request(buildEmailApp('member')).post(`/api/lien-releases/${created.id}/send`).send({ to: 'x@y.z', fileId: 'lr' })).status).toBe(403);
    expect((await request(emailApp).post('/api/lien-releases/nope/send').send({ to: 'x@y.z', fileId: 'lr' })).status).toBe(404);
  });

  it('invoice send: blank cc/bcc parse to empty lists; falls back to default subject/body; single attachment', async () => {
    const id = await makeInvoice();
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({
      to: 'client@example.com', cc: '   ', bcc: '', subject: '   ', body: undefined, fileId: 'primary',
    });
    expect(res.status).toBe(200);
    const m = provider.sent[0];
    expect(m.cc).toEqual([]);
    expect(m.bcc).toEqual([]);
    expect(m.subject).toBe('Invoice INV-1');
    expect(m.text).toBe('Please find the attached invoice.');
    expect(m.attachments).toHaveLength(1);
  });

  it('invoice send: legacy "message" still works as the body alias', async () => {
    const id = await makeInvoice();
    await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary', message: 'legacy body' });
    expect(provider.sent[0].text).toBe('legacy body');
  });

  it('invoice send: an explicit html body is used verbatim; plain text is escaped', async () => {
    const id = await makeInvoice();
    await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary', html: '<p>Hi <b>there</b></p>' });
    expect(provider.sent[0].html).toBe('<p>Hi <b>there</b></p>');
    const id2 = await makeInvoice();
    await request(emailApp).post(`/api/invoices/${id2}/send`).send({ to: 'a@b.com', fileId: 'primary', body: 'a < b & c\nsecond line' });
    expect(provider.sent[1].html).toBe('<p>a &lt; b &amp; c<br>second line</p>');
  });

  it('invoice send: unresolved attachment ids are skipped silently', async () => {
    const id = await makeInvoice();
    await request(emailApp).post(`/api/invoices/${id}/send`).send({
      to: 'a@b.com', fileId: 'primary', attachmentFileIds: ['extra1', 'does-not-exist', 'extra2'],
    });
    expect(names(provider.sent[0].attachments)).toEqual(['INV-1.pdf', 'Spec.pdf', 'Photo.jpg']);
  });

  it('invoice send: requires to + fileId', async () => {
    const id = await makeInvoice();
    expect((await request(emailApp).post(`/api/invoices/${id}/send`).send({ fileId: 'primary' })).status).toBe(400);
    expect((await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com' })).status).toBe(400);
  });

  it('invoice send: a `to` with no parseable address is refused with 400', async () => {
    const id = await makeInvoice();
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'not an address', fileId: 'primary' });
    expect(res.status).toBe(400);
    expect(provider.sent).toHaveLength(0);
  });

  it('invoice send: accountId picks a specific account; another user\'s is not reachable', async () => {
    const id = await makeInvoice();
    const second = accounts.createAccount(db, mailCrypto, { userId: 'u1', provider: 'fake', emailAddress: 'second@example.com', auth: { refreshToken: 'r' } });
    upsertFolders(db, second.id, getFakeProvider(second.id).folders);
    const ok = await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary', accountId: second.id });
    expect(ok.status).toBe(200);
    expect(ok.body.accountId).toBe(second.id);
    expect(getFakeProvider(second.id).sent).toHaveLength(1);
    expect(provider.sent).toHaveLength(0);   // the default account was not used
    // an account owned by someone else is invisible
    db.prepare("INSERT OR IGNORE INTO users (id, username, password, role) VALUES ('u2', 'u2', 'x', 'admin')").run();
    const theirs = accounts.createAccount(db, mailCrypto, { userId: 'u2', provider: 'fake', emailAddress: 'them@example.com', auth: { refreshToken: 'r' } });
    const id2 = await makeInvoice();
    const denied = await request(emailApp).post(`/api/invoices/${id2}/send`).send({ to: 'a@b.com', fileId: 'primary', accountId: theirs.id });
    expect(denied.status).toBe(409);
    expect(getFakeProvider(theirs.id).sent).toHaveLength(0);
  });

  it('invoice send: broadcasts carry the sender\'s x-session-id', async () => {
    const id = await makeInvoice();
    const res = await request(emailApp).post(`/api/invoices/${id}/send`)
      .set('x-session-id', 's1').send({ to: 'a@b.com', fileId: 'primary' });
    expect(res.status).toBe(200);
    // the item's own change event ...
    const invoiceEv = broadcasts.find(b => b.type === 'invoice' && b.id === id);
    expect(invoiceEv).toMatchObject({ byUserId: 'u1', bySessionId: 's1' });
    // ... and the mail thread the sent copy created
    expect(broadcasts.find(b => b.type === 'mailThread')).toMatchObject({ bySessionId: 's1' });
    // no header → no session attribution (every viewer refetches)
    broadcasts.length = 0;
    const id2 = await makeInvoice();
    await request(emailApp).post(`/api/invoices/${id2}/send`).send({ to: 'a@b.com', fileId: 'primary' });
    expect(broadcasts.find(b => b.type === 'invoice')?.bySessionId).toBeUndefined();
  });

  it('invoice send: an unusable default account is skipped for a usable one', async () => {
    const id = await makeInvoice();
    // acct is the default; park it in needs_review the way migration 31 leaves
    // a converted SMTP config, then add a healthy second account.
    accounts.updateAccount(db, acct.id, { status: 'needs_review' });
    const good = accounts.createAccount(db, mailCrypto, { userId: 'u1', provider: 'fake', emailAddress: 'good@example.com', auth: { refreshToken: 'r' } });
    upsertFolders(db, good.id, getFakeProvider(good.id).folders);
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary' });
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe(good.id);
    expect(provider.sent).toHaveLength(0);
    // with no usable account at all, the send is refused rather than silently
    // going out through the broken default
    accounts.updateAccount(db, good.id, { status: 'auth_error' });
    const id2 = await makeInvoice();
    const denied = await request(emailApp).post(`/api/invoices/${id2}/send`).send({ to: 'a@b.com', fileId: 'primary' });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toMatch(/No usable mail account/);
  });

  it('invoice send: an explicitly chosen but unusable account is refused, not swapped', async () => {
    const id = await makeInvoice();
    accounts.updateAccount(db, acct.id, { status: 'auth_error' });
    const good = accounts.createAccount(db, mailCrypto, { userId: 'u1', provider: 'fake', emailAddress: 'good@example.com', auth: { refreshToken: 'r' } });
    upsertFolders(db, good.id, getFakeProvider(good.id).folders);
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary', accountId: acct.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/auth error/);
    expect(getFakeProvider(good.id).sent).toHaveLength(0);
  });

  it('invoice send: non-admin gets 403', async () => {
    const id = await makeInvoice();
    const memberApp = buildEmailApp('member');
    expect((await request(memberApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary' })).status).toBe(403);
  });

  it('no mail account: send is refused with 409 and no side-effect', async () => {
    const id = await makeInvoice();
    accounts.deleteAccount(db, acct.id);
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/No usable mail account/);
    expect(provider.sent).toHaveLength(0);
    expect((await request(app).get(`/api/invoices/${id}`)).body.status).not.toBe('sent');
  });

  it('a provider failure is a 502 that leaks no provider text, and fires no side-effect', async () => {
    const id = await makeInvoice();
    provider.failNextWith(new Error('imap.secret-host.internal refused: bad password'));
    const res = await request(emailApp).post(`/api/invoices/${id}/send`).send({ to: 'a@b.com', fileId: 'primary' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Mail provider request failed');
    expect((await request(app).get(`/api/invoices/${id}`)).body.status).not.toBe('sent');
  });

  it('change-order send: default subject/name + cc/bcc + extras; admin-gated', async () => {
    const co = (await request(app).post('/api/projects/p1/change-orders').send({ number: 'CO-9', description: 'Extra work', lumpSumAmount: 100 })).body;
    const res = await request(emailApp).post(`/api/change-orders/${co.id}/send`).send({
      to: 'gc@example.com', cc: 'pm@example.com', fileId: 'primary', attachmentFileIds: ['extra1'],
    });
    expect(res.status).toBe(200);
    const m = provider.sent[0];
    expect(m.subject).toBe('Change Order Request CO-9');
    expect(addrs(m.cc)).toEqual(['pm@example.com']);
    expect(names(m.attachments)).toEqual(['CO-CO-9.pdf', 'Spec.pdf']);
    expect((await request(app).get(`/api/change-orders/${co.id}`)).body.status).toBe('sent');
    // non-admin blocked
    const memberApp = buildEmailApp('member');
    expect((await request(memberApp).post(`/api/change-orders/${co.id}/send`).send({ to: 'a@b.com', fileId: 'primary' })).status).toBe(403);
  });

  it('issue send: authenticated non-admin allowed; default ISS subject/name; cc/bcc + extras', async () => {
    const iss = (await request(app).post('/api/projects/p1/issues').send({ title: 'Crack' })).body;
    const memberApp = buildEmailApp('member'); // NOT admin-gated
    const res = await request(memberApp).post(`/api/issues/${iss.id}/send`).send({
      to: 'gc@example.com', bcc: 'log@example.com', fileId: 'primary', attachmentFileIds: ['extra2'],
    });
    expect(res.status).toBe(200);
    const m = provider.sent[0];
    expect(m.subject).toBe('Issue ISS-001 — Crack');
    expect(addrs(m.bcc)).toEqual(['log@example.com']);
    expect(names(m.attachments)).toEqual(['ISS-001.pdf', 'Photo.jpg']);
  });

  it('punch send: any authenticated user; links the thread to the project', async () => {
    const memberApp = buildEmailApp('member');
    const res = await request(memberApp).post('/api/projects/p1/send-punch').send({ to: 'gc@example.com', fileId: 'primary' });
    expect(res.status).toBe(200);
    expect(provider.sent[0].subject).toBe('Punch List Report');
    expect(names(provider.sent[0].attachments)).toEqual(['punch-list.pdf']);
    expect(db.prepare('SELECT itemType, itemId FROM mail_thread_links WHERE threadKey = ?').all(res.body.threadKey))
      .toEqual([{ itemType: 'punch', itemId: 'p1' }]);
    expect(db.prepare(`SELECT type FROM activity WHERE type = 'punch_sent'`).all()).toHaveLength(1);
  });

  it('rfi send: authenticated non-admin allowed; default RFI subject/name; cc/bcc + extras', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceiling height' })).body;
    const memberApp = buildEmailApp('member'); // NOT admin-gated
    const res = await request(memberApp).post(`/api/rfis/${rfi.id}/send`).send({
      to: 'gc@example.com', bcc: 'log@example.com', fileId: 'primary', attachmentFileIds: ['extra2'],
    });
    expect(res.status).toBe(200);
    const m = provider.sent[0];
    expect(m.subject).toBe('RFI RFI-001 — Ceiling height');
    expect(addrs(m.bcc)).toEqual(['log@example.com']);
    expect(names(m.attachments)).toEqual(['RFI-001.pdf', 'Photo.jpg']);
  });

  // The composer's "Attach file" stages the bytes before the send, exactly as
  // it does for a plain mail — an item send has to carry them through or the
  // user's attachment disappears silently between Send and the mailbox.
  it('rfi send: staged uploadIds ride along with the generated document', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceiling height' })).body;
    const { uploadId } = stageUpload(dir, 'Sketch.png', 'image/png', Buffer.from('PNGBYTES'));
    const res = await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({
      to: 'gc@example.com', fileId: 'primary', attachmentFileIds: ['extra1'], uploadIds: [uploadId],
    });
    expect(res.status).toBe(200);
    expect(names(provider.sent[0].attachments)).toEqual(['RFI-001.pdf', 'Spec.pdf', 'Sketch.png']);
  });

  it('rfi send: requires to + fileId; 404 for unknown rfi', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceiling height' })).body;
    expect((await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({ fileId: 'primary' })).status).toBe(400);
    expect((await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({ to: 'a@b.com' })).status).toBe(400);
    expect((await request(emailApp).post('/api/rfis/nope/send').send({ to: 'a@b.com', fileId: 'primary' })).status).toBe(404);
  });

  it('rfi send: explicit subject/cc/bcc/body pass through; extra attachmentFileIds appended', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceiling height' })).body;
    const res = await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({
      to: 'client@example.com',
      cc: ' cc@example.com ',
      bcc: 'bcc@example.com',
      subject: 'Custom Subject',
      body: 'Custom body text',
      fileId: 'primary',
      attachmentFileIds: ['extra1', 'extra2'],
    });
    expect(res.status).toBe(200);
    const m = provider.sent[0];
    expect(addrs(m.to)).toEqual(['client@example.com']);
    expect(addrs(m.cc)).toEqual(['cc@example.com']);
    expect(addrs(m.bcc)).toEqual(['bcc@example.com']);
    expect(m.subject).toBe('Custom Subject');
    expect(m.text).toBe('Custom body text');
    expect(names(m.attachments)).toEqual(['RFI-001.pdf', 'Spec.pdf', 'Photo.jpg']);
  });

  it('POST /api/rfis/:id/send sends via the mail account, links the thread, marks sent', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceilings' })).body;
    const res = await request(emailApp).post(`/api/rfis/${rfi.id}/send`)
      .send({ to: 'gc@tidewater.example', fileId: 'primary', subject: 'RFI-001', body: 'See attached' });
    expect(res.status).toBe(200);
    expect(res.body.threadKey).toBeTruthy();
    expect(res.body.accountId).toBe(acct.id);
    expect(provider.sent[0].attachments[0].name).toBe('RFI-001.pdf');
    expect((await request(app).get(`/api/rfis/${rfi.id}`)).body.status).toBe('sent');
    expect(db.prepare('SELECT itemType FROM mail_thread_links WHERE threadKey = ?').all(res.body.threadKey))
      .toEqual([{ itemType: 'rfi' }]);
    // the sent copy is indexed locally so it shows up in the mail UI
    expect(db.prepare('SELECT sentFromApp FROM mail_messages WHERE id = ?').get(res.body.messageId))
      .toEqual({ sentFromApp: 1 });
  });

  it('POST /api/rfis/:id/send with no mail account → 409', async () => {
    accounts.deleteAccount(db, acct.id);
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'x' })).body;
    expect((await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({ to: 'a@b.com', fileId: 'primary' })).status).toBe(409);
  });

  // One date can hold a report per crew, so the crew is in the subject and
  // the attachment's name.
  it('daily report send: default subject + crew-and-date filename when jobName is blank', async () => {
    const dr = (await request(app).post('/api/projects/p1/daily-reports').send({ crewId: await firstCrew(), reportDate: '2026-08-20' })).body;
    const res = await request(emailApp).post(`/api/daily-reports/${dr.id}/send`).send({ to: 'gc@example.com', fileId: 'primary' });
    expect(res.status).toBe(200);
    const m = provider.sent[0];
    expect(m.subject).toBe('Daily Report — 2026-08-20 — Crew 1');
    expect(names(m.attachments)).toEqual(['DailyReport-Crew-1-2026-08-20.pdf']);
    expect(db.prepare(`SELECT message FROM activity WHERE type = 'daily_report_sent'`).get())
      .toEqual({ message: 'Daily report 2026-08-20 (Crew 1) emailed to gc@example.com' });
  });

  it('daily report send: sanitizes jobName and the crew name into the attachment filename', async () => {
    const crew = (await request(app).post('/api/projects/p1/daily-report-crews').send({ name: 'Smith / Sons' })).body;
    const dr = (await request(app).post('/api/projects/p1/daily-reports')
      .send({ crewId: crew.id, reportDate: '2026-08-20', jobName: 'Dunmore Heights: "Unit 4"' })).body;
    const res = await request(emailApp).post(`/api/daily-reports/${dr.id}/send`).send({ to: 'gc@example.com', fileId: 'primary' });
    expect(res.status).toBe(200);
    const m = provider.sent[0];
    expect(m.subject).toBe('Daily Report — 2026-08-20 — Smith / Sons — Dunmore Heights: "Unit 4"');
    expect(names(m.attachments)).toEqual(['DailyReport-Dunmore-Heights-Unit-4-Smith-Sons-2026-08-20.pdf']);
  });

  it('rfi send: marks rfi sent with sentAt set after send', async () => {
    const rfi = (await request(app).post('/api/projects/p1/rfis').send({ title: 'Ceiling height' })).body;
    expect((await request(app).get(`/api/rfis/${rfi.id}`)).body.status).toBe('open');
    const res = await request(emailApp).post(`/api/rfis/${rfi.id}/send`).send({ to: 'a@b.com', fileId: 'primary' });
    expect(res.status).toBe(200);
    const after = (await request(app).get(`/api/rfis/${rfi.id}`)).body;
    expect(after.status).toBe('sent');
    expect(typeof after.sentAt).toBe('number');
  });

  describe('POST /api/proposals/:id/send', () => {
    it('sends the proposal PDF, marks sent with sentTo, logs proposal_sent, 409s a second send', async () => {
      const c = await request(app).post('/api/projects/p1/proposals').send({});
      const up = await request(app).post('/api/files/gen?projectId=p1&kind=proposal&name=Proposal.pdf&sourceType=proposal&sourceId=' + c.body.id)
        .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
      await request(app).post(`/api/proposals/${c.body.id}/file`).send({ fileId: up.body.fileId });
      const res = await request(emailApp).post(`/api/proposals/${c.body.id}/send`).send({ to: 'gc@x.com', cc: 'me@x.com', subject: 'Our proposal', body: 'hi', fileId: up.body.fileId });
      expect(res.status).toBe(200);
      expect(res.body.version).toBeGreaterThan(0);
      expect(addrs(provider.sent[0].to)).toEqual(['gc@x.com']);
      expect(provider.sent[0].attachments[0].name).toMatch(/\.pdf$/);
      const row = db.prepare('SELECT status, sentTo FROM proposals WHERE id = ?').get(c.body.id) as any;
      expect(row.status).toBe('sent');
      expect(JSON.parse(row.sentTo)).toEqual({ to: 'gc@x.com', cc: 'me@x.com', subject: 'Our proposal' });
      expect(db.prepare(`SELECT type FROM activity WHERE type = 'proposal_sent'`).all()).toHaveLength(1);
      const again = await request(emailApp).post(`/api/proposals/${c.body.id}/send`).send({ to: 'gc@x.com', subject: 's', fileId: up.body.fileId });
      expect(again.status).toBe(409);
    });

    // The attachment must arrive named as the document is named in Documents,
    // not a generic Proposal.pdf. proposalFileName() stores no extension, so
    // the route adds one.
    it('names the attachment after the stored document, adding .pdf when it has no extension', async () => {
      const c = await request(app).post('/api/projects/p1/proposals').send({});
      const name = 'Proposal – Test Project – 2026-08-28';
      const up = await request(app).post(`/api/files/gen-named?projectId=p1&kind=proposal&name=${encodeURIComponent(name)}&sourceType=proposal&sourceId=${c.body.id}`)
        .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
      await request(app).post(`/api/proposals/${c.body.id}/file`).send({ fileId: up.body.fileId });
      const res = await request(emailApp).post(`/api/proposals/${c.body.id}/send`).send({ to: 'gc@x.com', subject: 's', fileId: up.body.fileId });
      expect(res.status).toBe(200);
      expect(provider.sent[0].attachments[0].name).toBe(`${name}.pdf`);
    });

    it('keeps an extension the stored name already has', async () => {
      const c = await request(app).post('/api/projects/p1/proposals').send({});
      const up = await request(app).post(`/api/files/gen-ext?projectId=p1&kind=proposal&name=Bid.pdf&sourceType=proposal&sourceId=${c.body.id}`)
        .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
      await request(app).post(`/api/proposals/${c.body.id}/file`).send({ fileId: up.body.fileId });
      await request(emailApp).post(`/api/proposals/${c.body.id}/send`).send({ to: 'gc@x.com', subject: 's', fileId: up.body.fileId });
      expect(provider.sent[0].attachments[0].name).toBe('Bid.pdf');
    });

    it('does not mark sent when the provider rejects the message', async () => {
      const c = await request(app).post('/api/projects/p1/proposals').send({});
      const up = await request(app).post('/api/files/gen2?projectId=p1&kind=proposal&name=P.pdf').set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
      await request(app).post(`/api/proposals/${c.body.id}/file`).send({ fileId: up.body.fileId });
      provider.failNextWith(new Error('mailbox unavailable'));
      const res = await request(emailApp).post(`/api/proposals/${c.body.id}/send`).send({ to: 'gc@x.com', subject: 's', fileId: up.body.fileId });
      expect(res.status).toBe(502);
      expect((db.prepare('SELECT status FROM proposals WHERE id = ?').get(c.body.id) as any).status).toBe('draft');
    });
  });
});

describe('customers routes', () => {
  it('POST creates a customer, GET list returns it, GET by id works', async () => {
    const post = await request(app).post('/api/customers').send({
      name: 'Acme Corp', phone: '555-1234',
      emails: { general: 'info@acme.com' },
    });
    expect(post.status).toBe(200);
    expect(post.body.name).toBe('Acme Corp');
    const id = post.body.id;

    const list = await request(app).get('/api/customers');
    expect(list.status).toBe(200);
    // migrations seed an "Unassigned" customer; we added one more
    const names = list.body.map((c: any) => c.name);
    expect(names).toContain('Acme Corp');

    const get = await request(app).get(`/api/customers/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.emails.general).toBe('info@acme.com');
  });

  it('PUT updates a customer', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'Old Name' });
    const id = post.body.id;
    const put = await request(app).put(`/api/customers/${id}`).send({ name: 'New Name', emails: {} });
    expect(put.status).toBe(200);
    expect(put.body.name).toBe('New Name');
  });

  it('DELETE removes a customer with no projects', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'To Delete' });
    const id = post.body.id;
    const del = await request(app).delete(`/api/customers/${id}`);
    expect(del.status).toBe(200);
    expect((await request(app).get(`/api/customers/${id}`)).status).toBe(404);
  });

  it('DELETE customer with projects returns 409', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'Has Projects' });
    const cid = post.body.id;
    // createProject stores customerId when it is in the payload
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc1', customerId: cid,
    });
    const del = await request(app).delete(`/api/customers/${cid}`);
    expect(del.status).toBe(409);
  });

  it('PUT rename propagates to every owned project.contractor', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'Old Co' });
    const cid = post.body.id;
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc-rn-1', customerId: cid,
      pages: [{ id: 'pg-rn-1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc-rn-2', customerId: cid, contractor: 'Stale Name',
      pages: [{ id: 'pg-rn-2', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });

    const put = await request(app).put(`/api/customers/${cid}`).send({ name: 'New Co Name', emails: {} });
    expect(put.status).toBe(200);

    expect((await request(app).get('/api/projects/pc-rn-1')).body.contractor).toBe('New Co Name');
    expect((await request(app).get('/api/projects/pc-rn-2')).body.contractor).toBe('New Co Name');
  });

  it('PUT without a name change leaves project.contractor alone', async () => {
    const post = await request(app).post('/api/customers').send({ name: 'Same Co' });
    const cid = post.body.id;
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc-nc-1', customerId: cid, contractor: 'Hand-typed GC',
      pages: [{ id: 'pg-nc-1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });

    // A phone edit is not a rename — contractor must survive it verbatim.
    const put = await request(app).put(`/api/customers/${cid}`).send({ name: 'Same Co', phone: '555-0100', emails: {} });
    expect(put.status).toBe(200);
    expect((await request(app).get('/api/projects/pc-nc-1')).body.contractor).toBe('Hand-typed GC');
  });

  it('PUT on the Unassigned bucket never stamps its name onto project.contractor', async () => {
    // The migration seeds customer-unassigned; its name is a placeholder, not a
    // company, and it must never reach a project (contractor feeds document PDFs).
    await request(app).post('/api/projects').send({
      ...PROJECT, id: 'pc-un-1', customerId: 'customer-unassigned', contractor: '',
      pages: [{ id: 'pg-un-1', name: 'A1', imageId: '', measurements: [], scaleConfig: null }],
    });

    const put = await request(app).put('/api/customers/customer-unassigned').send({ name: 'Unassigned Renamed', emails: {} });
    expect(put.status).toBe(200);
    expect((await request(app).get('/api/projects/pc-un-1')).body.contractor).toBe('');
  });

  describe('GET /api/customers/summary and /:id/overview', () => {
    let userApp: express.Express;

    beforeEach(() => {
      // A second app wired with a non-admin 'user' role — proves money fields are gated.
      userApp = express();
      userApp.use(express.json());
      registerDataRoutes(userApp, {
        db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
        authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u2', role: 'user' }; next(); },
        requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
        verifyToken: () => null,
        broadcastChange: () => {},
      });
    });

    it('summary includes outstandingCents for admin, omits it for non-admin', async () => {
      const post = await request(app).post('/api/customers').send({ name: 'Billed Co' });
      const cid = post.body.id;
      await request(app).post('/api/projects').send({ ...PROJECT, id: 'pc-sum-1', customerId: cid });
      await request(app).post('/api/projects/pc-sum-1/invoices').send({ number: 'INV-1', status: 'sent', lines: [{ description: 'Work', qty: 1, unitPrice: 40 }] });

      const admin = await request(app).get('/api/customers/summary');
      expect(admin.status).toBe(200);
      const adminRow = admin.body.find((r: any) => r.id === cid);
      expect(adminRow.outstandingCents).toBe(4000);
      expect(adminRow.projectCounts).toEqual({ bidding: 1, inProgress: 0, archived: 0 });

      const nonAdmin = await request(userApp).get('/api/customers/summary');
      expect(nonAdmin.status).toBe(200);
      const nonAdminRow = nonAdmin.body.find((r: any) => r.id === cid);
      expect(nonAdminRow.outstandingCents).toBeUndefined();
    });

    it('overview includes billing/attention money items for admin, omits them for non-admin; 404 for unknown id', async () => {
      const post = await request(app).post('/api/customers').send({ name: 'Overview Co' });
      const cid = post.body.id;
      await request(app).post('/api/projects').send({ ...PROJECT, id: 'pc-ov-1', customerId: cid });
      await request(app).post('/api/projects/pc-ov-1/invoices').send({ number: 'INV-1', status: 'sent', lines: [{ description: 'Work', qty: 1, unitPrice: 40 }] });

      const admin = await request(app).get(`/api/customers/${cid}/overview`);
      expect(admin.status).toBe(200);
      expect(admin.body.customer.id).toBe(cid);
      expect(admin.body.billing.outstandingCents).toBe(4000);
      expect(admin.body.billing.ledger).toHaveLength(1);

      const nonAdmin = await request(userApp).get(`/api/customers/${cid}/overview`);
      expect(nonAdmin.status).toBe(200);
      expect(nonAdmin.body.billing).toBeUndefined();
      expect(nonAdmin.body.attention.some((a: any) => a.type === 'outstanding_invoice')).toBe(false);

      expect((await request(app).get('/api/customers/does-not-exist/overview')).status).toBe(404);
    });
  });
});
