import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { takeSnapshot } from './snapshot';
import { restoreSnapshot, isFreshInstall, RestoreRefusedError } from './restore';
import crypto from 'crypto';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const treeHashes = (dataDir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(dataDir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } };
  walk(path.join(dataDir, 'files'));
  return out;
};

let srcDir: string; let srcDb: Database.Database; let store: LocalStore;
beforeEach(() => {
  srcDir = tmp('ft-src-'); srcDb = openDb(path.join(srcDir, 'app.db')); runMigrations(srcDb, srcDir, migrations);
  fs.writeFileSync(path.join(srcDir, 'mail.key'), 'k'.repeat(64) + '\n');
  srcDb.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Job', 1);
  putBuffer(srcDb, srcDir, 'f-1', Buffer.from('plan pdf'), 'application/pdf', { kind: 'document', name: 'plan.pdf', projectId: 'p1' });
  putBuffer(srcDb, srcDir, 'f-2', Buffer.from('photo'), 'image/png', { kind: 'photo', name: 'p.png', projectId: 'p1' });
  store = new LocalStore(tmp('ft-bk-'));
});

describe('isFreshInstall', () => {
  it('is true only for the default admin alone with no projects and no files', () => {
    const dir = tmp('ft-fresh-'); const db = openDb(path.join(dir, 'app.db')); runMigrations(db, dir, migrations);
    db.prepare("INSERT INTO users (id, username, password, role) VALUES ('admin-id-123', 'admin', 'x', 'admin')").run();
    expect(isFreshInstall(db)).toBe(true);
    db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p', 'x', 1);
    expect(isFreshInstall(db)).toBe(false);
    db.prepare('DELETE FROM projects').run();
    db.prepare("INSERT INTO users (id, username, password, role) VALUES ('u2', 'bob', 'x', 'user')").run();
    expect(isFreshInstall(db)).toBe(false);
  });
});

describe('restoreSnapshot', () => {
  it('rebuilds files/ hash-for-hash, writes mail.key and app.db.restored, and finish() closes/renames/exits', async () => {
    const snap = await takeSnapshot(srcDb, srcDir, store, { trigger: 'manual', keep: 5, appVersion: '3.2.0', env: {} });
    const dst = tmp('ft-dst-');
    fs.writeFileSync(path.join(dst, 'mail.key'), 'fresh-key\n'); fs.writeFileSync(path.join(dst, 'app.db'), 'fresh-db');
    const closeDb = vi.fn(); const exit = vi.fn();
    const r = await restoreSnapshot(store, snap.snapshotId, { dataDir: dst, closeDb, exit });
    expect(r.files).toBe(2);
    expect(treeHashes(dst)).toEqual(treeHashes(srcDir));
    expect(fs.readFileSync(path.join(dst, 'mail.key'), 'utf8')).toBe('k'.repeat(64) + '\n');
    // The key seals every stored mail credential; loadMailCrypto creates it
    // 0600 and a restore must not hand it back more widely readable.
    expect(fs.statSync(path.join(dst, 'mail.key')).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dst, 'app.db.restored'))).toBe(true);
    expect(fs.readFileSync(path.join(dst, 'app.db'), 'utf8')).toBe('fresh-db'); // untouched until finish
    expect(closeDb).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
    r.finish();
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(fs.existsSync(path.join(dst, 'app.db.restored'))).toBe(false);
    const restored = openDb(path.join(dst, 'app.db'));
    expect((restored.prepare('SELECT COUNT(*) c FROM projects').get() as any).c).toBe(1);
    expect((restored.prepare('SELECT COUNT(*) c FROM files').get() as any).c).toBe(2);
  });

  it('refuses a newer schema and an unknown format before writing anything', async () => {
    const snap = await takeSnapshot(srcDb, srcDir, store, { trigger: 'manual', keep: 5, appVersion: '3.2.0', env: {} });
    const mp = path.join(store.snapshotDir(snap.snapshotId), 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8')); m.schemaVersion = 999; fs.writeFileSync(mp, JSON.stringify(m));
    const dst = tmp('ft-dst-');
    await expect(restoreSnapshot(store, snap.snapshotId, { dataDir: dst, closeDb: vi.fn(), exit: vi.fn() })).rejects.toThrow(RestoreRefusedError);
    expect(fs.existsSync(path.join(dst, 'files'))).toBe(false);
    m.schemaVersion = 1; m.format = 2; fs.writeFileSync(mp, JSON.stringify(m));
    await expect(restoreSnapshot(store, snap.snapshotId, { dataDir: dst, closeDb: vi.fn(), exit: vi.fn() })).rejects.toThrow(RestoreRefusedError);
  });

  it('a corrupt object aborts before the database is touched', async () => {
    const snap = await takeSnapshot(srcDb, srcDir, store, { trigger: 'manual', keep: 5, appVersion: '3.2.0', env: {} });
    const m = await store.readManifest(snap.snapshotId);
    fs.writeFileSync(store.objectPath(m.files[0].sha256), 'corrupt');
    const dst = tmp('ft-dst-'); fs.writeFileSync(path.join(dst, 'app.db'), 'fresh-db');
    await expect(restoreSnapshot(store, snap.snapshotId, { dataDir: dst, closeDb: vi.fn(), exit: vi.fn() })).rejects.toThrow(/hash/);
    expect(fs.existsSync(path.join(dst, 'app.db.restored'))).toBe(false);
    expect(fs.readFileSync(path.join(dst, 'app.db'), 'utf8')).toBe('fresh-db');
  });
});
