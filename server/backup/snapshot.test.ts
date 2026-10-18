import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { putBuffer } from '../files';
import { pathFor } from '../fileStore';
import { LocalStore } from './store';
import { takeSnapshot, listRuns, pruneTarget, BackupRunningError, type BackupProgress } from './snapshot';

let db: Database.Database; let dataDir: string; let root: string; let store: LocalStore;
const opts = { trigger: 'manual' as const, keep: 14, appVersion: '3.2.0', env: {} as NodeJS.ProcessEnv };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-data-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-bk-'));
  db = openDb(path.join(dataDir, 'app.db'));
  runMigrations(db, dataDir, migrations);
  fs.writeFileSync(path.join(dataDir, 'mail.key'), 'a'.repeat(64) + '\n');
  store = new LocalStore(root);
});

const addFile = (name: string, content: string) => putBuffer(db, dataDir, `id-${name}`, Buffer.from(content), 'text/plain', { kind: 'document', name }).id;

describe('takeSnapshot', () => {
  it('first run writes every object, the db, the mail key and a manifest that matches the files table', async () => {
    addFile('a', 'AAA'); addFile('b', 'BBBB');
    const r = await takeSnapshot(db, dataDir, store, opts);
    expect(r.objectsAdded).toBe(2);
    expect(r.warnings).toEqual([]);
    const m = await store.readManifest(r.snapshotId);
    expect(m.format).toBe(1);
    expect(m.schemaVersion).toBe(migrations[migrations.length - 1].version);
    expect(m.files.map(f => f.id).sort()).toEqual(['id-a', 'id-b']);
    expect(m.counts).toEqual({ files: 2, bytes: 7 });
    expect('sha256' in m.mailKey).toBe(true);
    const dir = store.snapshotDir(r.snapshotId);
    expect(fs.existsSync(path.join(dir, 'app.db'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'mail.key'), 'utf8')).toBe('a'.repeat(64) + '\n');
    for (const f of m.files) expect(fs.existsSync(store.objectPath(f.sha256))).toBe(true);
    const runs = listRuns(db);
    expect(runs[0]).toMatchObject({ target: 'local', trigger: 'manual', status: 'ok', snapshotId: r.snapshotId, objectsAdded: 2 });
  });

  it('a second run with no changes adds zero objects; a rewritten file adds exactly one new object', async () => {
    addFile('a', 'AAA');
    await takeSnapshot(db, dataDir, store, opts);
    const r2 = await takeSnapshot(db, dataDir, store, { ...opts, now: () => new Date(Date.now() + 1000) });
    expect(r2.objectsAdded).toBe(0);
    putBuffer(db, dataDir, 'id-a', Buffer.from('CHANGED'), 'text/plain', { kind: 'document', name: 'a' });
    const r3 = await takeSnapshot(db, dataDir, store, { ...opts, now: () => new Date(Date.now() + 2000) });
    expect(r3.objectsAdded).toBe(1);
    const m = await store.readManifest(r3.snapshotId);
    expect(fs.readFileSync(store.objectPath(m.files[0].sha256), 'utf8')).toBe('CHANGED');
    expect((await store.listObjects()).size).toBe(2);
  });

  it('a file whose bytes on disk do not match its row is skipped with a warning, not an error', async () => {
    addFile('a', 'AAA');
    fs.writeFileSync(pathFor(dataDir, 'id-a'), 'TAMPERED');
    const r = await takeSnapshot(db, dataDir, store, opts);
    expect(r.objectsAdded).toBe(0);
    expect(r.warnings[0]).toMatch(/id-a/);
    expect((await store.readManifest(r.snapshotId)).files).toEqual([]);
    expect(listRuns(db)[0].status).toBe('ok');
  });

  it('reports progress through every phase, never backwards, ending with every planned byte copied', async () => {
    // Bigger than one 64 KiB read, so it streams in several pieces.
    addFile('a', 'A'.repeat(200_000)); addFile('b', 'B'.repeat(3000));
    const seen: BackupProgress[] = [];
    const r = await takeSnapshot(db, dataDir, store, { ...opts, onProgress: p => seen.push(p) });
    expect(seen.every(p => p.runId === r.runId)).toBe(true);
    expect([...new Set(seen.map(p => p.phase))]).toEqual(['database', 'scanning', 'files', 'snapshot', 'pruning']);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].percent).toBeGreaterThanOrEqual(seen[i - 1].percent);
      expect(seen[i].bytesDone).toBeGreaterThanOrEqual(seen[i - 1].bytesDone);
    }
    const dbSize = (await store.readManifest(r.snapshotId)).db.size;
    // Planned up front: both new files and the database, before any copying.
    expect(seen.find(p => p.phase === 'files')).toMatchObject({ filesDone: 0, filesTotal: 2, bytesDone: 0, bytesTotal: 203_000 + dbSize });
    // Bytes are counted as they stream, not only when a whole file lands.
    expect(seen.some(p => p.phase === 'files' && ![0, 3000, 200_000, 203_000].includes(p.bytesDone))).toBe(true);
    expect(seen.at(-1)).toMatchObject({ phase: 'pruning', percent: 97, filesDone: 2, filesTotal: 2, bytesDone: 203_000 + dbSize, bytesTotal: 203_000 + dbSize });
  });

  it('a run with nothing new plans only the database, and a skipped file drops out of the totals', async () => {
    addFile('a', 'AAA');
    await takeSnapshot(db, dataDir, store, opts);
    addFile('b', 'BBBB');
    fs.writeFileSync(pathFor(dataDir, 'id-b'), 'TAMPERED');
    const seen: BackupProgress[] = [];
    const r = await takeSnapshot(db, dataDir, store, { ...opts, now: () => new Date(Date.now() + 1000), onProgress: p => seen.push(p) });
    const dbSize = (await store.readManifest(r.snapshotId)).db.size;
    expect(seen.find(p => p.phase === 'files')).toMatchObject({ filesTotal: 1, bytesTotal: 4 + dbSize });
    expect(seen.at(-1)).toMatchObject({ percent: 97, filesDone: 0, filesTotal: 0, bytesDone: dbSize, bytesTotal: dbSize });
  });

  it('a progress listener that throws does not fail the backup', async () => {
    addFile('a', 'AAA');
    const r = await takeSnapshot(db, dataDir, store, { ...opts, onProgress: () => { throw new Error('listener broke'); } });
    expect(listRuns(db)[0]).toMatchObject({ status: 'ok', snapshotId: r.snapshotId });
  });

  it('mail key from the environment is recorded as source env and not written', async () => {
    const r = await takeSnapshot(db, dataDir, store, { ...opts, env: { MAIL_SECRET_KEY: 'b'.repeat(64) } });
    expect((await store.readManifest(r.snapshotId)).mailKey).toEqual({ source: 'env' });
    expect(fs.existsSync(path.join(store.snapshotDir(r.snapshotId), 'mail.key'))).toBe(false);
  });

  it('refuses a concurrent run on the same target and records a failed run on error', async () => {
    db.prepare(`INSERT INTO backup_runs (id, target, trigger, startedAt, status) VALUES ('x', 'local', 'manual', ?, 'running')`).run(Date.now());
    await expect(takeSnapshot(db, dataDir, store, opts)).rejects.toThrow(BackupRunningError);
    db.prepare('DELETE FROM backup_runs').run();
    const broken = { ...store, listObjects: async () => { throw new Error('disk gone'); } } as any;
    await expect(takeSnapshot(db, dataDir, broken, opts)).rejects.toThrow('disk gone');
    expect(listRuns(db)[0]).toMatchObject({ status: 'error', error: 'disk gone' });
  });

  it('prune sweeps up the manifest-less folder a failed earlier run left behind, but never the current one', async () => {
    // A Drive (or local) run that dies after app.db lands leaves a whole
    // database in a folder with no manifest.json. Every listing ignores it, so
    // it used to sit there for ever — one leaked copy per failed night.
    addFile('a', 'AAA');
    fs.mkdirSync(path.join(root, 'snapshots', '20250101-000000'), { recursive: true });
    fs.writeFileSync(path.join(root, 'snapshots', '20250101-000000', 'app.db'), 'leaked');
    fs.mkdirSync(path.join(root, 'snapshots', '29990101-000000'), { recursive: true });
    fs.writeFileSync(path.join(root, 'snapshots', '29990101-000000', 'app.db'), 'from the future');
    expect(await store.listIncompleteSnapshots()).toEqual(['20250101-000000', '29990101-000000']);

    const r = await takeSnapshot(db, dataDir, store, opts);
    expect(fs.existsSync(path.join(root, 'snapshots', '20250101-000000'))).toBe(false);
    // Newer than the run that just finished: not this run's to judge.
    expect(fs.existsSync(path.join(root, 'snapshots', '29990101-000000'))).toBe(true);
    expect(fs.existsSync(store.snapshotDir(r.snapshotId))).toBe(true);
  });

  it('prune keeps the newest N snapshots and only objects they reference', async () => {
    addFile('a', 'AAA');
    const r1 = await takeSnapshot(db, dataDir, store, { ...opts, keep: 99 });
    putBuffer(db, dataDir, 'id-a', Buffer.from('V2'), 'text/plain', { kind: 'document', name: 'a' });
    const r2 = await takeSnapshot(db, dataDir, store, { ...opts, keep: 99, now: () => new Date(Date.now() + 1000) });
    const res = await pruneTarget(store, 1);
    expect(res).toEqual({ snapshotsDeleted: 1, objectsDeleted: 1 });
    expect((await store.listSnapshots()).map(s => s.id)).toEqual([r2.snapshotId]);
    expect(fs.existsSync(store.snapshotDir(r1.snapshotId))).toBe(false);
    expect((await store.listObjects()).size).toBe(1);
  });
});
