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
let events: any[];

const buildApp = (role: 'admin' | 'user') => {
  const a = express();
  a.use(express.json({ limit: '50mb' }));
  registerDataRoutes(a, {
    db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: 'u1', role, username: 'nick' }; next(); },
    requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
    verifyToken: () => null,
    broadcastChange: (ev) => events.push(ev),
  });
  return a;
};
let app: express.Express;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-prt-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  events = [];
  db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1', 'Job A', 1, 1, 1, '{}')`).run();
  db.prepare(`INSERT INTO takeoffs (id, projectId, name, type, color, sortOrder, attrs) VALUES ('t1', 'p1', 'Stucco', 'area', '#fff', 0, '{}')`).run();
  app = buildApp('admin');
});

const uploadPdf = async (id: string) => {
  const res = await request(app).post(`/api/files/${id}?projectId=p1&kind=document&name=${id}.pdf`).set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
  expect(res.status).toBe(200);
  return res.body.fileId as string;
};

describe('proposal routes', () => {
  it('non-admin gets 403 on every proposal route', async () => {
    const u = buildApp('user');
    expect((await request(u).get('/api/projects/p1/proposals')).status).toBe(403);
    expect((await request(u).post('/api/projects/p1/proposals').send({})).status).toBe(403);
    expect((await request(u).get('/api/proposals/outstanding')).status).toBe(403);
    expect((await request(u).get('/api/proposals/x')).status).toBe(403);
  });

  it('create seeded from takeoffs, list, get, save, delete; broadcasts + activity', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({ takeoffIds: ['t1'] });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ number: 1, version: 1 });
    const id = c.body.id;
    expect(events.at(-1)).toMatchObject({ type: 'proposal', id, projectId: 'p1', action: 'created' });
    expect(db.prepare(`SELECT type FROM activity WHERE projectId = 'p1'`).all()).toEqual([{ type: 'proposal_created' }]);

    const list = await request(app).get('/api/projects/p1/proposals');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id, number: 1, status: 'draft', totalCents: 0 });

    const g = await request(app).get(`/api/proposals/${id}`);
    expect(g.body.lines[0]).toMatchObject({ kind: 'takeoff', takeoffId: 't1', description: 'Stucco' });

    const s = await request(app).put(`/api/proposals/${id}`).send({ version: 1, title: 'T', lines: [{ kind: 'manual', description: 'x', amountCents: 100 }] });
    expect(s.status).toBe(200);
    expect(s.body.version).toBe(2);
    const stale = await request(app).put(`/api/proposals/${id}`).send({ version: 1, title: 'old' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');

    const d = await request(app).delete(`/api/proposals/${id}`);
    expect(d.status).toBe(200);
    expect((await request(app).get(`/api/proposals/${id}`)).status).toBe(404);
  });

  it('outstanding lists sent proposals; :id route does not swallow "outstanding"', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({ validUntil: '2026-09-15' });
    const fid = await uploadPdf('gen');
    await request(app).post(`/api/proposals/${c.body.id}/file`).send({ fileId: fid });
    db.prepare(`UPDATE proposals SET status = 'sent', sentAt = 5 WHERE id = ?`).run(c.body.id);
    const o = await request(app).get('/api/proposals/outstanding');
    expect(o.status).toBe(200);
    expect(o.body).toEqual([expect.objectContaining({ id: c.body.id, projectName: 'Job A', validUntil: '2026-09-15' })]);
  });

  it('photos + attachments routes; attachments must be PDFs; locked after sent → 409 locked', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({});
    const id = c.body.id;
    const att = await uploadPdf('spec');
    expect((await request(app).post(`/api/proposals/${id}/attachments`).send({ fileId: att })).status).toBe(200);
    const img = await request(app).post('/api/files/img?projectId=p1&kind=proposal-photo&name=a.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    expect((await request(app).post(`/api/proposals/${id}/attachments`).send({ fileId: img.body.fileId })).status).toBe(400);
    expect((await request(app).post(`/api/proposals/${id}/photos`).send({ fileId: img.body.fileId })).status).toBe(200);
    expect((await request(app).patch(`/api/proposals/${id}/photos/${img.body.fileId}`).send({ caption: 'cap' })).status).toBe(200);
    const g = await request(app).get(`/api/proposals/${id}`);
    expect(g.body.photos[0].caption).toBe('cap');
    expect(g.body.attachments[0]).toMatchObject({ fileId: att, name: 'spec.pdf' });

    db.prepare(`UPDATE proposals SET status = 'sent' WHERE id = ?`).run(id);
    const locked = await request(app).delete(`/api/proposals/${id}/photos/${img.body.fileId}`);
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('locked');
  });

  it('status accepted/declined from sent only, logs activity', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({});
    expect((await request(app).post(`/api/proposals/${c.body.id}/status`).send({ status: 'accepted' })).status).toBe(400);
    db.prepare(`UPDATE proposals SET status = 'sent' WHERE id = ?`).run(c.body.id);
    const signed = await uploadPdf('signed');
    const r = await request(app).post(`/api/proposals/${c.body.id}/status`).send({ status: 'accepted', signedFileId: signed });
    expect(r.status).toBe(200);
    expect((await request(app).get(`/api/proposals/${c.body.id}`)).body).toMatchObject({ status: 'accepted', signedFileId: signed });
    expect(db.prepare(`SELECT type FROM activity WHERE projectId = 'p1' ORDER BY rowid`).all().map((x: any) => x.type)).toEqual(['proposal_created', 'proposal_accepted']);
  });

  it('delete removes the generated file row and its bytes too', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({});
    const id = c.body.id;
    const up = await request(app).post(`/api/files/gen?projectId=p1&kind=proposal&name=Proposal.pdf&sourceType=proposal&sourceId=${id}`)
      .set('Content-Type', 'application/pdf').send(Buffer.from('%PDF'));
    expect(up.status).toBe(200);
    const fid = up.body.fileId as string;
    expect((await request(app).post(`/api/proposals/${id}/file`).send({ fileId: fid })).status).toBe(200);
    expect(fsSync.existsSync(pathFor(dir, fid))).toBe(true);

    const d = await request(app).delete(`/api/proposals/${id}`);
    expect(d.status).toBe(200);

    expect(db.prepare('SELECT 1 FROM files WHERE id = ?').get(fid)).toBeUndefined();
    expect((await request(app).get(`/api/files/${fid}/meta`)).status).toBe(404);
    expect(fsSync.existsSync(pathFor(dir, fid))).toBe(false);
  });

  it('revise via POST with revisedFromId + carry flags', async () => {
    const c = await request(app).post('/api/projects/p1/proposals').send({});
    const img = await request(app).post('/api/files/img?projectId=p1&kind=proposal-photo&name=a.jpg').set('Content-Type', 'image/jpeg').send(Buffer.from('x'));
    await request(app).post(`/api/proposals/${c.body.id}/photos`).send({ fileId: img.body.fileId });
    const r = await request(app).post('/api/projects/p1/proposals').send({ revisedFromId: c.body.id, carryPhotos: false });
    expect(r.body.number).toBe(2);
    const g = await request(app).get(`/api/proposals/${r.body.id}`);
    expect(g.body.revisedFromNumber).toBe(1);
    expect(g.body.photos).toEqual([]);
  });
});
