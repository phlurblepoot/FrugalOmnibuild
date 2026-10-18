import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildManifest } from './migrate-manifest';
import {
  openReadOnly,
  tableExists,
  count,
  legacyCounts,
  newCounts,
  listFiles,
} from './lib/dataStats';

let tmpRoot: string;
let dataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-manifest-'));
  dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Hand-create the migration-1 base schema (legacy / un-normalized). */
function makeLegacyDb(dbFile: string): void {
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
    CREATE TABLE images (id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE templates (id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE bids (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, password TEXT, role TEXT);
    CREATE TABLE notes (id TEXT PRIMARY KEY, projectId TEXT, data TEXT, createdAt INTEGER, updatedAt INTEGER);
    CREATE TABLE checklists (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER);
    CREATE TABLE email_accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE time_entries (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL, projectId TEXT,
      clockIn INTEGER NOT NULL, clockOut INTEGER, description TEXT, createdAt INTEGER NOT NULL
    );
  `);

  const insProject = db.prepare('INSERT INTO projects (id, data, createdAt) VALUES (?, ?, ?)');
  insProject.run('p1', JSON.stringify({ id: 'p1', name: 'Alpha' }), 1);
  insProject.run('p2', JSON.stringify({ id: 'p2', name: 'Beta' }), 2);

  const insImage = db.prepare('INSERT INTO images (id, data) VALUES (?, ?)');
  insImage.run('img1', 'data:image/png;base64,AAA');
  insImage.run('img2', 'data:image/png;base64,BBB');
  insImage.run('img3', 'data:image/png;base64,CCC');

  // One checklist blob with 2 items.
  db.prepare('INSERT INTO checklists (id, data, createdAt) VALUES (?, ?, ?)').run(
    'cl1',
    JSON.stringify({ name: 'Punch', items: [{ id: 'i1', description: 'a' }, { id: 'i2', description: 'b' }] }),
    1
  );

  db.close();
}

/**
 * Hand-create a representative slice of the normalized (migrated) schema and
 * record the applied schema version. Only the tables the assertions touch are
 * created; count() guards the rest.
 */
function makeMigratedDb(dbFile: string): void {
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL, name TEXT, appliedAt INTEGER NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT, createdAt INTEGER, name TEXT, status TEXT);
    CREATE TABLE pages (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT);
    CREATE TABLE takeoffs (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT);
    CREATE TABLE files (id TEXT PRIMARY KEY, projectId TEXT, name TEXT, mime TEXT, size INTEGER, sha256 TEXT, kind TEXT, createdAt INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, category TEXT, title TEXT, createdAt INTEGER);
  `);
  db.prepare('INSERT INTO schema_version (version, name, appliedAt) VALUES (?, ?, ?)').run(11, 'tasks', 1);

  // 3 projects (normalized: data may be null), 4 pages, 2 takeoffs, 2 files.
  const insP = db.prepare("INSERT INTO projects (id, data, createdAt, name, status) VALUES (?, NULL, ?, ?, 'estimating')");
  insP.run('p1', 1, 'A');
  insP.run('p2', 2, 'B');
  insP.run('p3', 3, 'C');

  const insPg = db.prepare('INSERT INTO pages (id, projectId, name) VALUES (?, ?, ?)');
  insPg.run('pg1', 'p1', '1');
  insPg.run('pg2', 'p1', '2');
  insPg.run('pg3', 'p2', '1');
  insPg.run('pg4', 'p3', '1');

  const insT = db.prepare('INSERT INTO takeoffs (id, projectId, name) VALUES (?, ?, ?)');
  insT.run('t1', 'p1', 'Walls');
  insT.run('t2', 'p2', 'Ceiling');

  const insF = db.prepare(
    "INSERT INTO files (id, projectId, name, mime, size, sha256, kind, createdAt) VALUES (?, ?, ?, 'image/png', ?, ?, 'plan', 1)"
  );
  insF.run('file-aaaa', 'p1', 'plan.png', 10, 'sha-a');
  insF.run('file-bbbb', 'p2', 'plan2.png', 20, 'sha-b');

  db.close();
}

describe('dataStats guards', () => {
  it('count() returns 0 for an absent table', () => {
    const dbFile = path.join(dataDir, 'app.db');
    const db = new Database(dbFile);
    db.exec('CREATE TABLE only_one (id TEXT)');
    db.close();

    const ro = openReadOnly(dbFile);
    expect(tableExists(ro, 'only_one')).toBe(true);
    expect(tableExists(ro, 'does_not_exist')).toBe(false);
    expect(count(ro, 'does_not_exist')).toBe(0);
    expect(count(ro, 'only_one')).toBe(0);
    ro.close();
  });

  it('newCounts on a db missing every normalized table returns all-zero', () => {
    const dbFile = path.join(dataDir, 'app.db');
    const db = new Database(dbFile);
    db.exec('CREATE TABLE unrelated (id TEXT)');
    db.close();

    const ro = openReadOnly(dbFile);
    const nc = newCounts(ro);
    expect(nc.projects).toBe(0);
    expect(nc.files).toBe(0);
    expect(nc.tasks).toBe(0);
    ro.close();
  });
});

describe('legacyCounts (early-SQLite legacy)', () => {
  it('counts un-normalized projects, images, checklists and checklist items', () => {
    const dbFile = path.join(dataDir, 'app.db');
    makeLegacyDb(dbFile);

    const ro = openReadOnly(dbFile);
    const lc = legacyCounts(dataDir, ro);
    ro.close();

    expect(lc.projectsUnnormalized).toBe(2);
    expect(lc.images).toBe(3);
    expect(lc.checklists).toBe(1);
    expect(lc.checklistItems).toBe(2);
    expect(lc.bids).toBe(0);
    expect(lc.email_accounts).toBe(0);
    expect(lc.users).toBe(0);
  });

  it('counts JSON-dir legacy when no app.db is present', () => {
    fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects', 'a.json'), '{"id":"a"}');
    fs.writeFileSync(path.join(dataDir, 'projects', 'b.json'), '{"id":"b"}');
    fs.mkdirSync(path.join(dataDir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'images', 'x.txt'), 'blob');
    fs.writeFileSync(path.join(dataDir, 'templates.json'), JSON.stringify([{ id: 't1' }, { id: 't2' }, { id: 't3' }]));

    const lc = legacyCounts(dataDir, null);
    expect(lc.jsonProjects).toBe(2);
    expect(lc.jsonImages).toBe(1);
    expect(lc.jsonTemplates).toBe(3);
  });
});

describe('newCounts (migrated db)', () => {
  it('counts normalized projects/pages/takeoffs/files', () => {
    const dbFile = path.join(dataDir, 'app.db');
    makeMigratedDb(dbFile);

    const ro = openReadOnly(dbFile);
    const nc = newCounts(ro);
    ro.close();

    expect(nc.projects).toBe(3);
    expect(nc.pages).toBe(4);
    expect(nc.takeoffs).toBe(2);
    expect(nc.files).toBe(2);
    // tables not created -> guarded to 0.
    expect(nc.invoices).toBe(0);
    expect(nc.measurements).toBe(0);
  });
});

describe('listFiles', () => {
  it('computes sharded disk paths and existence flags', () => {
    const dbFile = path.join(dataDir, 'app.db');
    makeMigratedDb(dbFile);
    // Place one of the two blobs on disk (sharded path: first 2 chars of id).
    fs.mkdirSync(path.join(dataDir, 'files', 'fi'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'files', 'fi', 'file-aaaa'), 'x');

    const ro = openReadOnly(dbFile);
    const files = listFiles(ro, dataDir).sort((a, b) => a.id.localeCompare(b.id));
    ro.close();

    expect(files).toHaveLength(2);
    expect(files[0].id).toBe('file-aaaa');
    expect(files[0].exists).toBe(true);
    expect(files[0].diskPath).toBe(path.join(dataDir, 'files', 'fi', 'file-aaaa'));
    expect(files[1].id).toBe('file-bbbb');
    expect(files[1].exists).toBe(false);
  });
});

describe('buildManifest', () => {
  it('writes a manifest json with capturedAt, schemaVersion and both count maps', () => {
    const dbFile = path.join(dataDir, 'app.db');
    makeMigratedDb(dbFile);

    const manifest = buildManifest(dataDir);
    expect(typeof manifest.capturedAt).toBe('string');
    expect(new Date(manifest.capturedAt).toString()).not.toBe('Invalid Date');
    expect(manifest.schemaVersion).toBe(11);
    expect(manifest.newCounts.projects).toBe(3);
    expect(manifest.legacyCounts).toBeTypeOf('object');
    expect(manifest.dataDir).toBe(path.resolve(dataDir));
  });

  it('handles a legacy db (schemaVersion null) and reports legacy counts', () => {
    const dbFile = path.join(dataDir, 'app.db');
    makeLegacyDb(dbFile);

    const manifest = buildManifest(dataDir);
    expect(manifest.schemaVersion).toBeNull();
    expect(manifest.legacyCounts.checklistItems).toBe(2);
    expect(manifest.legacyCounts.images).toBe(3);
  });

  it('handles a pure JSON-dir legacy with no app.db', () => {
    fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects', 'a.json'), '{"id":"a"}');

    const manifest = buildManifest(dataDir);
    expect(manifest.schemaVersion).toBeNull();
    expect(manifest.newCounts).toEqual({});
    expect(manifest.legacyCounts.jsonProjects).toBe(1);
  });
});
