// server/lienReleaseRoutes.test.ts — admin-only lien release API (spec §6.7)
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

let db: Database.Database;
let dir: string;
let events: any[];

const buildApp = (role: 'admin' | 'user') => {
  const a = express();
  a.use(express.json());
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

const body = (over: Record<string, unknown> = {}) => ({
  paymentType: 'progress', conditional: true,
  lienorName: 'Birchwood Plaster', customerName: 'Acme', ownerName: 'Jane', propertyDescription: 'Lot 4',
  amountCents: 50000, throughDate: '2026-09-30', releaseDate: '2026-10-15', signerName: 'Noah', signerTitle: 'Owner',
  ...over,
});

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-lrt-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  events = [];
  db.prepare(`INSERT INTO projects (id, name, createdAt, version, updatedAt, meta) VALUES ('p1', 'Job A', 1, 1, 1, '{}')`).run();
  app = buildApp('admin');
});

describe('lien release routes', () => {
  it('non-admin gets 403 on every route', async () => {
    const u = buildApp('user');
    for (const [method, url] of [
      ['get', '/api/projects/p1/lien-releases'],
      ['get', '/api/projects/p1/lien-releases/prefill'],
      ['post', '/api/projects/p1/lien-releases'],
      ['get', '/api/lien-releases/x'],
      ['put', '/api/lien-releases/x'],
      ['patch', '/api/lien-releases/x/status'],
      ['post', '/api/lien-releases/x/unconditional'],
      ['delete', '/api/lien-releases/x'],
    ] as const) {
      const res = await (request(u) as any)[method](url).send({});
      expect(res.status, `${method} ${url}`).toBe(403);
    }
  });

  it('creates, reads, lists, saves, and broadcasts', async () => {
    const c = await request(app).post('/api/projects/p1/lien-releases').send(body());
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ number: '1', version: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'lienRelease', id: c.body.id, projectId: 'p1', action: 'created' });

    const g = await request(app).get(`/api/lien-releases/${c.body.id}`);
    expect(g.body).toMatchObject({ conditional: true, conditionKind: 'funds', status: 'draft', amountCents: 50000 });
    expect((await request(app).get('/api/projects/p1/lien-releases')).body).toHaveLength(1);

    const s = await request(app).put(`/api/lien-releases/${c.body.id}`).send({ ...body({ amountCents: 60000 }), version: 1 });
    expect(s.body).toEqual({ success: true, version: 2 });
    expect(events.at(-1)).toMatchObject({ type: 'lienRelease', action: 'updated', version: 2 });
    expect((await request(app).get('/api/lien-releases/nope')).status).toBe(404);
    expect((await request(app).get('/api/projects/nope/lien-releases')).body).toEqual([]);
  });

  it('answers 400 for invalid input and 409 for a stale version', async () => {
    const bad = await request(app).post('/api/projects/p1/lien-releases').send(body({ throughDate: '2026-12-01' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Through date/);
    expect((await request(app).post('/api/projects/nope/lien-releases').send(body())).status).toBe(404);

    const c = await request(app).post('/api/projects/p1/lien-releases').send(body());
    await request(app).put(`/api/lien-releases/${c.body.id}`).send({ ...body(), version: 1 });
    const stale = await request(app).put(`/api/lien-releases/${c.body.id}`).send({ ...body(), version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('version_conflict');
  });

  it('voids, restores from void, refuses delete once sent or void, and deletes a draft', async () => {
    const c = await request(app).post('/api/projects/p1/lien-releases').send(body());
    const id = c.body.id;
    expect((await request(app).patch(`/api/lien-releases/${id}/status`).send({ status: 'sent' })).status).toBe(400);
    expect((await request(app).patch(`/api/lien-releases/${id}/status`).send({ status: 'draft' })).status).toBe(400);
    expect((await request(app).patch(`/api/lien-releases/${id}/status`).send({ status: 'void' })).status).toBe(200);
    const del = await request(app).delete(`/api/lien-releases/${id}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('locked');
    expect((await request(app).patch(`/api/lien-releases/${id}/status`).send({ status: 'draft' })).status).toBe(200);
    expect((await request(app).delete(`/api/lien-releases/${id}`)).status).toBe(200);
    expect(events.at(-1)).toMatchObject({ action: 'deleted', id });
    expect((await request(app).delete(`/api/lien-releases/${id}`)).status).toBe(404);
  });

  it('makes an unconditional release from a conditional one', async () => {
    const c = await request(app).post('/api/projects/p1/lien-releases').send(body());
    const u = await request(app).post(`/api/lien-releases/${c.body.id}/unconditional`);
    expect(u.status).toBe(200);
    expect(u.body.number).toBe('2');
    const row = (await request(app).get(`/api/lien-releases/${u.body.id}`)).body;
    expect(row).toMatchObject({ conditional: false, supersedesId: c.body.id });
    expect((await request(app).post(`/api/lien-releases/${u.body.id}/unconditional`)).status).toBe(400);
  });

  it('serves prefill defaults from query parameters', async () => {
    const res = await request(app).get('/api/projects/p1/lien-releases/prefill?paymentType=final&conditional=0');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paymentType: 'final', conditional: false, throughDate: null, signerName: 'nick' });
    expect((await request(app).get('/api/projects/p1/lien-releases/prefill?paymentType=bogus')).status).toBe(400);
    expect((await request(app).get('/api/projects/nope/lien-releases/prefill')).status).toBe(404);
  });
});
