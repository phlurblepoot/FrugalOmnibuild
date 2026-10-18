import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { putBuffer } from '../files';
import { pathFor } from '../fileStore';
import { MailCrypto } from '../mail/crypto';
import { registerBackupRoutes, type BackupRouteDeps } from './routes';
import { unpackSnapshotZip } from './zip';
import { LocalStore } from './store';

let db: Database.Database; let dataDir: string; let root: string; let app: express.Express; let events: any[];
const crypto = new MailCrypto(Buffer.alloc(32, 9));

const mkApp = (over: Partial<BackupRouteDeps> = {}, user: any = { id: 'u1', role: 'admin' }) => {
  const a = express(); a.use(express.json());
  registerBackupRoutes(a, {
    db, dataDir, backupRoot: root, backupRootIsDefault: false, appVersion: '3.2.0', env: {}, publicUrl: null, jwtSecret: 's',
    mailCrypto: crypto,
    authenticateToken: (req: any, res: any, next: any) => { if (!user) return res.status(401).json({ error: 'Authentication required' }); req.user = user; next(); },
    requireAdmin: (req: any, res: any, next: any) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }),
    verifyToken: () => user, broadcastChange: e => events.push(e), closeDb: () => {}, exit: () => {}, ...over,
  });
  return a;
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-d-')); root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-r-'));
  db = openDb(path.join(dataDir, 'app.db')); runMigrations(db, dataDir, migrations);
  fs.writeFileSync(path.join(dataDir, 'mail.key'), 'k'.repeat(64) + '\n');
  db.prepare("INSERT INTO users (id, username, password, role) VALUES ('admin-id-123', 'admin', 'x', 'admin')").run();
  events = []; app = mkApp();
});

describe('backup admin routes', () => {
  it('status reports the root, defaults, no runs yet, and no drive', async () => {
    const r = await request(app).get('/api/backup/status');
    expect(r.status).toBe(200);
    const off = { enabled: false, hour: 2, minute: 0 };
    expect(r.body).toMatchObject({ root: root, rootIsDefault: false, drive: { connected: false }, schedule: { local: off, drive: off }, keep: { local: 14, drive: 14 }, running: null, progress: [] });
    expect(r.body.lastRun).toEqual({ local: null, drive: null });
    expect(r.body.nextRunAt).toEqual({ local: null, drive: null });
    expect(r.body.setup).toEqual({ publicUrl: null, googleClientId: false, googleClientSecret: false, redirectUris: null });
  });

  it('status gives the setup guide the exact redirect URIs the Drive sign-in will use', async () => {
    const a = mkApp({ publicUrl: 'https://takeoff.example.com/', env: { GOOGLE_OAUTH_CLIENT_ID: 'cid' } });
    expect((await request(a).get('/api/backup/status')).body.setup).toEqual({
      publicUrl: 'https://takeoff.example.com/', googleClientId: true, googleClientSecret: false,
      redirectUris: { backup: 'https://takeoff.example.com/api/backup/drive/callback', restore: 'https://takeoff.example.com/api/setup/restore/drive/callback' },
    });
  });

  it('progress lists a run while it is going and is empty once it finishes', async () => {
    putBuffer(db, dataDir, 'f1', Buffer.from('x'), 'text/plain', { kind: 'document', name: 'x' });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    // The run's listing (the first one made) waits on the test, so the run
    // can be caught mid-way; the status route's own listing goes straight through.
    const orig = LocalStore.prototype.listObjects;
    let listings = 0;
    LocalStore.prototype.listObjects = async function (this: LocalStore) { if (listings++ === 0) await gate; return orig.call(this); };
    const a = mkApp();
    try {
      const r = await request(a).post('/api/backup/run').send({ target: 'local' });
      expect(r.status).toBe(202);
      // The database copy runs first; wait for the run to reach the gated listing.
      let mid = await request(a).get('/api/backup/progress');
      for (let i = 0; i < 100 && mid.body[0]?.phase !== 'scanning'; i++) {
        await new Promise(res => setTimeout(res, 20));
        mid = await request(a).get('/api/backup/progress');
      }
      expect(mid.status).toBe(200);
      expect(mid.body).toHaveLength(1);
      expect(mid.body[0]).toMatchObject({ runId: r.body.runId, target: 'local', trigger: 'manual', phase: 'scanning', percent: 4 });
      expect((await request(a).get('/api/backup/status')).body.progress).toHaveLength(1);
      release();
      await new Promise(res => setTimeout(res, 300));
      expect((await request(a).get('/api/backup/progress')).body).toEqual([]);
      expect((await request(a).get('/api/backup/runs')).body[0]).toMatchObject({ status: 'ok' });
    } finally { LocalStore.prototype.listObjects = orig; release(); }
  });

  it('a run left marked running by a restart is closed as interrupted, so the next run is not refused', async () => {
    db.prepare(`INSERT INTO backup_runs (id, target, trigger, startedAt, status) VALUES ('stale', 'local', 'schedule', ?, 'running')`).run(Date.now() - 60_000);
    const a = mkApp();
    expect((await request(a).get('/api/backup/status')).body.running).toBeNull();
    expect((await request(a).get('/api/backup/runs')).body[0]).toMatchObject({ id: 'stale', status: 'error', error: expect.stringMatching(/interrupted/i) });
    expect((await request(a).post('/api/backup/run').send({ target: 'local' })).status).toBe(202);
  });

  it('run → 202 then the run shows ok, a snapshot lists, and a backupRun event was broadcast', async () => {
    putBuffer(db, dataDir, 'f1', Buffer.from('x'), 'text/plain', { kind: 'document', name: 'x' });
    const r = await request(app).post('/api/backup/run').send({ target: 'local' });
    expect(r.status).toBe(202); expect(r.body.runId).toBeTruthy();
    await new Promise(res => setTimeout(res, 300));
    const runs = await request(app).get('/api/backup/runs');
    expect(runs.body[0]).toMatchObject({ status: 'ok', target: 'local', objectsAdded: 1 });
    const snaps = await request(app).get('/api/backup/snapshots?target=local');
    expect(snaps.body.length).toBe(1);
    expect(events.some(e => e.type === 'backupRun')).toBe(true);
  });

  it('a second run while one is running → 409 backup_running', async () => {
    db.prepare(`INSERT INTO backup_runs (id, target, trigger, startedAt, status) VALUES ('x', 'local', 'manual', ?, 'running')`).run(Date.now());
    const r = await request(app).post('/api/backup/run').send({ target: 'local' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('backup_running');
  });

  it("a snapshot's warnings can be read back, each matched to its file and project", async () => {
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Main St Remodel', 1);
    putBuffer(db, dataDir, 'f-gone', Buffer.from('x'), 'application/pdf', { kind: 'document', name: 'plans.pdf', projectId: 'p1' });
    fs.rmSync(pathFor(dataDir, 'f-gone'));
    await request(app).post('/api/backup/run').send({ target: 'local' });
    await new Promise(res => setTimeout(res, 300));
    const snap = (await request(app).get('/api/backup/snapshots?target=local')).body[0];
    expect(snap.warnings).toBe(1);
    const r = await request(app).get(`/api/backup/snapshots/${snap.id}/warnings?target=local`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ message: 'file f-gone skipped: not on disk', fileId: 'f-gone', fileName: 'plans.pdf', projectName: 'Main St Remodel' }]);
    expect((await request(app).get(`/api/backup/snapshots/${snap.id}/warnings?target=drive`)).status).toBe(400);
    expect((await request(app).get('/api/backup/snapshots/nope/warnings?target=local')).status).toBe(400);
    expect((await request(app).get('/api/backup/snapshots/20200101-000000/warnings?target=local')).status).toBe(502);
  });

  it('download streams a zip that unpacks to the same snapshot', async () => {
    putBuffer(db, dataDir, 'f1', Buffer.from('hello'), 'text/plain', { kind: 'document', name: 'x' });
    await request(app).post('/api/backup/run').send({ target: 'local' });
    await new Promise(res => setTimeout(res, 300));
    const id = (await request(app).get('/api/backup/snapshots?target=local')).body[0].id;
    const r = await request(app).get(`/api/backup/snapshots/${id}/download`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', d => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/zip/);
    const zipPath = path.join(root, 'dl.zip'); fs.writeFileSync(zipPath, r.body);
    const into = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-un-'));
    expect((await unpackSnapshotZip(zipPath, into)).snapshotId).toBe(id);
    expect((await new LocalStore(into).readManifest(id)).files.length).toBe(1);
  });

  it('settings round-trip with clamping; non-admin gets 403 everywhere', async () => {
    const r = await request(app).put('/api/backup/settings').send({ schedule: { local: { enabled: true, hour: 23, minute: 30 }, drive: { enabled: true, hour: 99, minute: -5 } }, keep: { local: 0, drive: 9999 } });
    expect(r.status).toBe(200);
    expect((await request(app).get('/api/backup/status')).body).toMatchObject({
      schedule: { local: { enabled: true, hour: 23, minute: 30 }, drive: { enabled: true, hour: 23, minute: 0 } }, keep: { local: 1, drive: 365 },
    });
    // One half alone leaves the other where it was.
    await request(app).put('/api/backup/settings').send({ schedule: { drive: { enabled: false, hour: 4, minute: 15 } } });
    expect((await request(app).get('/api/backup/status')).body.schedule).toEqual({ local: { enabled: true, hour: 23, minute: 30 }, drive: { enabled: false, hour: 4, minute: 15 } });
    const member = mkApp({}, { id: 'u2', role: 'user' });
    for (const [m, p] of [['get', '/api/backup/status'], ['post', '/api/backup/run'], ['get', '/api/backup/runs'], ['get', '/api/backup/progress'], ['get', '/api/backup/snapshots/20260912-020000/warnings?target=local'], ['put', '/api/backup/settings']] as const) {
      expect((await (request(member) as any)[m](p).send({})).status).toBe(403);
    }
  });
});

describe('setup mode + restore', () => {
  const asDefaultAdmin = () => mkApp({}, { id: 'admin-id-123', role: 'admin' });

  it('GET /api/setup/state is public and flips once data exists', async () => {
    const pub = mkApp({}, null);
    expect((await request(pub).get('/api/setup/state')).body).toEqual({ fresh: true });
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p', 'x', 1);
    expect((await request(pub).get('/api/setup/state')).body).toEqual({ fresh: false });
  });

  it('restore routes 409 not_fresh once data exists, and 403 for a non-default user even when fresh', async () => {
    const a = asDefaultAdmin();
    expect((await request(a).get('/api/setup/restore/sources')).status).toBe(200);
    expect((await request(mkApp({}, { id: 'u9', role: 'admin' })).get('/api/setup/restore/sources')).status).toBe(403);
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p', 'x', 1);
    const r = await request(a).get('/api/setup/restore/sources');
    expect(r.status).toBe(409); expect(r.body.code).toBe('not_fresh');
  });

  it('sources lists local snapshots; upload unpacks a zip; restore rebuilds and calls finish (closeDb + exit) after responding', async () => {
    // Build a snapshot from a populated source db in another dir, then restore it into this fresh one.
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-src-')); const srcDb = openDb(path.join(srcDir, 'app.db')); runMigrations(srcDb, srcDir, migrations);
    fs.writeFileSync(path.join(srcDir, 'mail.key'), 'k'.repeat(64) + '\n');
    srcDb.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Job', 1);
    putBuffer(srcDb, srcDir, 'f-1', Buffer.from('plan'), 'application/pdf', { kind: 'document', name: 'plan.pdf', projectId: 'p1' });
    const { takeSnapshot } = await import('./snapshot');
    const snap = await takeSnapshot(srcDb, srcDir, new LocalStore(root), { trigger: 'manual', keep: 5, appVersion: '3.2.0', env: {} });

    const closeDb = vi.fn(); const exit = vi.fn();
    const a = mkApp({ closeDb, exit }, { id: 'admin-id-123', role: 'admin' });
    const sources = await request(a).get('/api/setup/restore/sources');
    expect(sources.body.local.map((s: any) => s.id)).toEqual([snap.snapshotId]);
    expect(sources.body.root).toBe(root);

    // upload path
    const zipPath = path.join(root, 'u.zip');
    const { streamSnapshotZip } = await import('./zip');
    await streamSnapshotZip(new LocalStore(root), snap.snapshotId, fs.createWriteStream(zipPath));
    await new Promise(r => setTimeout(r, 100));
    const up = await request(a).post('/api/setup/restore/upload').set('Content-Type', 'application/octet-stream').send(fs.readFileSync(zipPath));
    expect(up.status).toBe(200); expect(up.body.snapshotId).toBe(snap.snapshotId); expect(up.body.summary.counts.files).toBe(1);

    const r = await request(a).post('/api/setup/restore').send({ source: 'upload', uploadId: up.body.uploadId, snapshotId: snap.snapshotId });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ restarting: true, files: 1 });
    await new Promise(res => setTimeout(res, 50));
    expect(closeDb).toHaveBeenCalledTimes(1); expect(exit).toHaveBeenCalledWith(0);
    expect(fs.existsSync(pathFor(dataDir, 'f-1'))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'mail.key'), 'utf8')).toBe('k'.repeat(64) + '\n');

    // A restore takes minutes on real data and ends with the process exiting.
    // A second request — an impatient click, a reload — must be refused, not
    // raced onto the same staging paths.
    const again = await request(a).post('/api/setup/restore').send({ source: 'upload', uploadId: up.body.uploadId, snapshotId: snap.snapshotId });
    expect(again.status).toBe(409); expect(again.body.code).toBe('restore_running');
  });

  it('restore of a newer-schema snapshot → 400 with both versions named', async () => {
    const st = new LocalStore(root);
    const dir = st.snapshotDir('20260901-000000'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.db'), 'x');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: 1, createdAt: 1, appVersion: '9', schemaVersion: 999, db: { size: 1, sha256: 'x' }, mailKey: { source: 'env' }, files: [], counts: { files: 0, bytes: 0 }, warnings: [] }));
    const a = asDefaultAdmin();
    const r = await request(a).post('/api/setup/restore').send({ source: 'local', snapshotId: '20260901-000000' });
    expect(r.status).toBe(400); expect(r.body.error).toMatch(/999/);
    // A refused restore left the server exactly as it was, so the guard has
    // to be released — otherwise one bad zip locks restore out for good.
    const retry = await request(a).post('/api/setup/restore').send({ source: 'local', snapshotId: '20260901-000000' });
    expect(retry.status).toBe(400);
  });
});

describe('drive routes', () => {
  it('start redirects to Google with the drive.file scope; disconnect clears the connection; setup start requires fresh', async () => {
    const a = mkApp({ publicUrl: 'https://app.example', env: { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 's' } });
    const r = await request(a).get('/api/backup/drive/start');
    expect(r.status).toBe(302); expect(r.headers.location).toMatch(/drive\.file/); expect(r.headers.location).toMatch(/backup%2Fdrive%2Fcallback/);
    expect((await request(a).delete('/api/backup/drive')).status).toBe(200);
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p', 'x', 1);
    expect((await request(mkApp({ publicUrl: 'https://app.example', env: { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 's' } }, { id: 'admin-id-123', role: 'admin' })).get('/api/setup/restore/drive/start')).status).toBe(409);
  });
  it('callback with a mail-oauth state is refused (redirects with error)', async () => {
    const { signState } = await import('../mail/oauth');
    const a = mkApp({ publicUrl: 'https://app.example' });
    const r = await request(a).get(`/api/backup/drive/callback?code=c&state=${signState('s', { userId: 'u', provider: 'google', verifier: 'v' })}`);
    expect(r.status).toBe(302); expect(r.headers.location).toMatch(/tab=backup&error=/);
  });
});
