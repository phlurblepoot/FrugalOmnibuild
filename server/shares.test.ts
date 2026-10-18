// Share links (ONLYOFFICE Phase 7): expiry (7/30/90 days or never, 30 by
// default), stopping a link, older links that never expire, several files
// under one link, who may share what, and every public route turning an
// expired or stopped link away with its reason.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putBuffer } from './files';
import { registerShareRoutes } from './shareRoutes';
import { registerOnlyofficeRoutes } from './onlyoffice/routes';
import { activeSharesForFile, createShare, parseExpiryDays, revokeShare } from './shares';

const ENV = {
  ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com',
  ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice',
  APP_INTERNAL_URL: 'http://app:3000',
  ONLYOFFICE_JWT_SECRET: 'oo-secret',
};
const DAY = 86_400_000;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let db: Database.Database;
let dir: string;
let as: { id: string; role: string };
let app: express.Express;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-shares-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','noah','x','admin'), ('u2','maria','x','user')`).run();
  putBuffer(db, dir, 'doc1', Buffer.from('docx bytes'), DOCX, { projectId: 'p1', kind: 'document', name: 'Scope.docx' });
  putBuffer(db, dir, 'pdf1', Buffer.from('%PDF-1.7'), 'application/pdf', { projectId: 'p1', kind: 'takeoff-print', name: 'Bid set.pdf' });
  putBuffer(db, dir, 'inv1', Buffer.from('%PDF inv'), 'application/pdf', { projectId: 'p1', kind: 'invoice', name: 'Invoice 7.pdf' });
  putBuffer(db, dir, 'sig1', Buffer.from('png'), 'image/png', { kind: 'signature', name: 'My signature.png', createdBy: 'u1' });
  putBuffer(db, dir, 'img1', Buffer.from('png'), 'image/png', { kind: 'plan', name: 'A1.png' });
  as = { id: 'u1', role: 'admin' };
  app = express();
  app.use(express.json());
  const authenticateToken = (req: any, _res: any, next: any) => { req.user = as; next(); };
  registerShareRoutes(app, { db, dataDir: dir, env: ENV, authenticateToken });
  registerOnlyofficeRoutes(app, {
    env: ENV, appJwtSecret: 'app-secret', authenticateToken, requireAdmin: authenticateToken, db, dataDir: dir,
    broadcastChange: () => {}, fetch: (async () => new Response('nf', { status: 404 })) as typeof fetch,
  });
});

const make = (body: object) => request(app).post('/api/shares').send(body);
const text = (r: request.Response) => (Buffer.isBuffer(r.body) ? r.body.toString() : r.text);
const binary = (r: request.Test) => r.buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

describe('expiry', () => {
  it('lasts 30 days unless told 7, 90 or never, and nothing else', async () => {
    const before = Date.now();
    const d = (await make({ type: 'file', resourceId: 'doc1', name: 'Scope' })).body;
    expect(d.expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(d.expiresAt).toBeLessThan(before + 30 * DAY + 60_000);
    expect((await make({ type: 'file', resourceId: 'doc1', expiresInDays: 7 })).body.expiresAt).toBeLessThan(before + 8 * DAY);
    expect((await make({ type: 'file', resourceId: 'doc1', expiresInDays: 90 })).body.expiresAt).toBeGreaterThan(before + 89 * DAY);
    expect((await make({ type: 'file', resourceId: 'doc1', expiresInDays: null })).body.expiresAt).toBeNull();
    expect((await make({ type: 'file', resourceId: 'doc1', expiresInDays: 45 })).status).toBe(400);
    expect(() => parseExpiryDays('forever')).toThrow();
  });

  it('never reuses an old link', async () => {
    const a = (await make({ type: 'file', resourceId: 'doc1' })).body.id;
    const b = (await make({ type: 'file', resourceId: 'doc1' })).body.id;
    expect(a).not.toBe(b);
  });

  it('a link can be given a new expiry, counted from now, or made permanent', async () => {
    const { id } = (await make({ type: 'file', resourceId: 'doc1', expiresInDays: 7 })).body;
    const r = await request(app).patch(`/api/shares/${id}`).send({ expiresInDays: 90 });
    expect(r.body.expiresAt).toBeGreaterThan(Date.now() + 89 * DAY);
    expect((await request(app).patch(`/api/shares/${id}`).send({ expiresInDays: null })).body.expiresAt).toBeNull();
    expect((await request(app).patch(`/api/shares/${id}`).send({})).status).toBe(400);
  });
});

describe('public routes turn away expired and stopped links', () => {
  const expire = (id: string) => db.prepare('UPDATE shares SET expiresAt = ? WHERE id = ?').run(Date.now() - 1000, id);

  it('an expired link: 410 with the reason, on every route', async () => {
    const one = (await make({ type: 'file', resourceId: 'pdf1', name: 'Bid set' })).body.id;
    const many = (await make({ type: 'files', fileIds: ['doc1', 'pdf1'], name: 'Two docs' })).body.id;
    const pages = (await make({ type: 'pages', resourceId: JSON.stringify([{ imageId: 'img1', name: 'A1' }]), name: 'Plans' })).body.id;
    for (const id of [one, many, pages]) expire(id);
    const info = await request(app).get(`/api/share/${one}/info`);
    expect([info.status, info.body.code, info.body.error]).toEqual([410, 'expired', 'This link has expired.']);
    for (const url of [`/api/share/${one}`, `/api/share/${one}/viewer`, `/api/share/${many}/file/0`, `/api/share/${many}/viewer/0`,
      `/api/share/${pages}/image/0`, `/api/share/${pages}/page-info/0`, `/api/share/${many}/info`]) {
      expect((await request(app).get(url)).status, url).toBe(410);
    }
  });

  it('a stopped link says it was turned off; an unknown one that it doesn’t exist', async () => {
    const { id } = (await make({ type: 'file', resourceId: 'pdf1' })).body;
    expect((await request(app).delete(`/api/shares/${id}`)).status).toBe(200);
    const info = await request(app).get(`/api/share/${id}/info`);
    expect([info.status, info.body.code]).toEqual([410, 'revoked']);
    expect(text(await request(app).get(`/api/share/${id}`))).toMatch(/turned off/);
    expect((await request(app).get('/api/share/nope/info')).body.code).toBe('missing');
    expect((await request(app).delete('/api/shares/nope')).status).toBe(404);
  });

  it('links made before expiry existed keep working, never expire, and can be stopped', async () => {
    db.prepare("INSERT INTO shares (id, type, resourceId, name, createdAt) VALUES ('old1', 'printout', 'pdf1', 'Old bid set', 1)").run();
    expect((await request(app).get('/api/share/old1/info')).body).toMatchObject({ type: 'printout', name: 'Old bid set', expiresAt: null });
    expect(text(await binary(request(app).get('/api/share/old1')))).toBe('%PDF-1.7');
    expect(activeSharesForFile(db, 'pdf1').map(s => s.id)).toContain('old1');
    revokeShare(db, 'old1');
    expect((await request(app).get('/api/share/old1')).status).toBe(410);
  });
});

describe('several documents under one link', () => {
  it('lists them, serves each, and opens each in the viewer', async () => {
    const { id } = (await make({ type: 'files', fileIds: ['doc1', 'pdf1', 'doc1'], name: 'For the GC' })).body;
    const info = (await request(app).get(`/api/share/${id}/info`)).body;
    expect(info).toMatchObject({ type: 'files', name: 'For the GC', count: 2 });
    expect(info.files).toEqual([
      { name: 'Scope.docx', mime: DOCX, size: 10, viewer: true },
      { name: 'Bid set.pdf', mime: 'application/pdf', size: 8, viewer: true },
    ]);
    const second = await binary(request(app).get(`/api/share/${id}/file/1`));
    expect([second.headers['content-type'], text(second)]).toEqual(['application/pdf', '%PDF-1.7']);
    expect((await request(app).get(`/api/share/${id}/file/1?download=1`)).headers['content-disposition']).toContain('Bid set.pdf');
    expect((await request(app).get(`/api/share/${id}/file/5`)).status).toBe(404);
    // Any name downloads (a hand-built header throws on an en dash).
    putBuffer(db, dir, 'dash1', Buffer.from('%PDF rev 3'), 'application/pdf', { projectId: 'p1', kind: 'document', name: 'Bid set – Rev 3.pdf' });
    const dash = (await make({ type: 'file', resourceId: 'dash1' })).body.id;
    const got = await binary(request(app).get(`/api/share/${dash}?download=1`));
    expect([got.status, got.headers['content-type'], text(got)]).toEqual([200, 'application/pdf', '%PDF rev 3']);
    expect(got.headers['content-disposition']).toContain("filename*=UTF-8''Bid%20set%20%E2%80%93%20Rev%203.pdf");
    const v = await request(app).get(`/api/share/${id}/viewer/0`);
    expect([v.status, v.body.config.document.title, v.body.config.editorConfig.mode]).toEqual([200, 'Scope.docx', 'view']);
    expect(v.body.config.document.url).toBe(`http://app:3000/api/share/${id}/file/0`);
    expect((await request(app).get(`/api/share/${id}/viewer`)).status).toBe(404);
    expect((await request(app).get(`/api/share/${id}`)).status).toBe(404);
  });

  it("shows in each file's links list, and stopping it stops it for all", async () => {
    const { id } = (await make({ type: 'files', fileIds: ['doc1', 'pdf1'], name: 'For the GC' })).body;
    await make({ type: 'file', resourceId: 'doc1', name: 'Scope' });
    const forPdf = (await request(app).get('/api/shares?fileId=pdf1')).body.shares;
    expect(forPdf).toEqual([expect.objectContaining({ id, type: 'files', fileCount: 2, createdByName: 'noah' })]);
    expect((await request(app).get('/api/shares?fileId=doc1')).body.shares).toHaveLength(2);
    await request(app).delete(`/api/shares/${id}`);
    expect((await request(app).get('/api/shares?fileId=pdf1')).body.shares).toEqual([]);
  });

  it('needs at least one, and no more than fifty', async () => {
    expect((await make({ type: 'files', fileIds: [] })).status).toBe(400);
    const ids = Array.from({ length: 51 }, (_, i) => `f${i}`);
    expect((await make({ type: 'files', fileIds: ids })).status).toBe(400);
  });
});

describe('who may share what', () => {
  it('only what you can see; never signatures, templates or stamps', async () => {
    as = { id: 'u2', role: 'user' };
    expect((await make({ type: 'file', resourceId: 'inv1' })).status).toBe(404);
    expect((await make({ type: 'files', fileIds: ['doc1', 'inv1'] })).status).toBe(404);
    expect((await make({ type: 'file', resourceId: 'doc1' })).status).toBe(200);
    as = { id: 'u1', role: 'admin' };
    expect((await make({ type: 'file', resourceId: 'inv1' })).status).toBe(200);
    expect((await make({ type: 'file', resourceId: 'sig1' })).status).toBe(404);
    expect((await make({ type: 'file', resourceId: 'missing' })).status).toBe(404);
    expect((await make({ type: 'whatever', resourceId: 'doc1' })).status).toBe(400);
  });

  it("links to what someone can't see stay out of their reach: not listed, changed or stopped", async () => {
    const inv = (await make({ type: 'file', resourceId: 'inv1', name: 'Invoice' })).body.id;
    const mixed = (await make({ type: 'files', fileIds: ['doc1', 'inv1'], name: 'With the invoice' })).body.id;
    const plain = (await make({ type: 'file', resourceId: 'doc1', name: 'Scope' })).body.id;
    as = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/shares?fileId=inv1')).status).toBe(404);
    expect((await request(app).get('/api/shares?fileId=doc1')).body.shares.map((s: { id: string }) => s.id)).toEqual([plain]);
    for (const id of [inv, mixed]) {
      expect((await request(app).patch(`/api/shares/${id}`).send({ expiresInDays: null })).status).toBe(404);
      expect((await request(app).delete(`/api/shares/${id}`)).status).toBe(404);
    }
    expect((await request(app).delete(`/api/shares/${plain}`)).status).toBe(200);
    as = { id: 'u1', role: 'admin' };
    expect((await request(app).get(`/api/share/${inv}/info`)).status).toBe(200);
    expect((await request(app).get('/api/shares?fileId=doc1')).body.shares.map((s: { id: string }) => s.id)).toEqual([mixed]);
  });

  it('keeps plan-page links working as before', async () => {
    const page = createShare(db, { type: 'page', resourceId: 'img1', name: 'A1' });
    expect(text(await binary(request(app).get(`/api/share/${page.id}`)))).toBe('png');
    const pages = (await make({ type: 'pages', resourceId: JSON.stringify([{ imageId: 'img1', name: 'A1', pageNumber: 'A-101' }]), name: 'Plans' })).body.id;
    expect((await request(app).get(`/api/share/${pages}/info`)).body).toMatchObject({ type: 'pages', count: 1 });
    expect((await request(app).get(`/api/share/${pages}/page-info/0`)).body).toEqual({ name: 'A1', pageNumber: 'A-101' });
    expect((await make({ type: 'pages', resourceId: '[]' })).status).toBe(400);
  });
});
