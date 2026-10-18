import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../server/migrations';
import { migrations } from '../server/migrationList';
import { writeFileContent, pathFor } from '../server/fileStore';
import { verifyMigration, LATEST_SCHEMA_VERSION } from './verify-migration';

let tmpRoot: string;
let dataDir: string;
let dbFile: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-verify-'));
  dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  dbFile = path.join(dataDir, 'app.db');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Build a fully-migrated db by running the REAL migration runner on a fresh
 * (empty) data dir, then seeding a minimal-but-valid normalized graph plus a
 * couple of on-disk files. Returns the open writable handle so callers can
 * mutate it to construct broken cases before re-opening read-only in verify.
 */
function buildMigratedDb(): Database.Database {
  const db = new Database(dbFile);
  runMigrations(db, dataDir, migrations);
  return db;
}

/** Insert a valid project + page + measurement chain. */
function seedGraph(db: Database.Database): void {
  db.prepare(
    "INSERT INTO projects (id, data, createdAt, name, status, version) VALUES ('p1', NULL, 1, 'Alpha', 'estimating', 1)"
  ).run();
  db.prepare(
    "INSERT INTO pages (id, projectId, name, pageNumber, sortOrder) VALUES ('pg1', 'p1', 'Sheet 1', '1', 0)"
  ).run();
  db.prepare(
    "INSERT INTO measurements (id, pageId, projectId, type, points, sortOrder) VALUES ('m1', 'pg1', 'p1', 'line', '[]', 0)"
  ).run();
}

/** Write a real blob to disk and insert a matching files row with its true sha256. */
function seedFile(db: Database.Database, id: string, content: string, projectId: string | null): void {
  const { size, sha256 } = writeFileContent(dataDir, id, Buffer.from(content));
  db.prepare(
    `INSERT INTO files (id, projectId, name, mime, size, sha256, kind, versionNumber, createdAt)
     VALUES (?, ?, ?, 'application/octet-stream', ?, ?, 'other', 1, 1)`
  ).run(id, projectId, `${id}.bin`, size, sha256);
}

describe('verifyMigration — CLEAN migrated dir', () => {
  it('passes every hard check on a freshly-migrated, well-formed data dir', () => {
    const db = buildMigratedDb();
    seedGraph(db);
    seedFile(db, 'file-aaaa', 'hello world', 'p1');
    seedFile(db, 'file-bbbb', 'second blob', 'p1');
    db.close();

    const { checks, passed } = verifyMigration(dataDir);
    expect(passed).toBe(true);

    const byName = Object.fromEntries(checks.map((c) => [c.name, c]));
    expect(byName.schemaVersion.status).toBe('pass');
    expect(byName.normalizationComplete.status).toBe('pass');
    expect(byName.fileIntegrity.status).toBe('pass');
    expect(byName.fkIntegrity.status).toBe('pass');
    expect(byName.orphanFiles.status).toBe('pass');
    expect(byName.counts.status).toBe('pass');
    // No FAIL anywhere.
    expect(checks.some((c) => c.status === 'fail')).toBe(false);
  });

  it('honors --sample without failing (size+existence still checked for all)', () => {
    const db = buildMigratedDb();
    seedGraph(db);
    seedFile(db, 'file-aaaa', 'a', 'p1');
    seedFile(db, 'file-bbbb', 'bb', 'p1');
    seedFile(db, 'file-cccc', 'ccc', 'p1');
    db.close();

    const { checks, passed } = verifyMigration(dataDir, { sample: 1 });
    expect(passed).toBe(true);
    const fi = checks.find((c) => c.name === 'fileIntegrity')!;
    expect(fi.status).toBe('pass');
    expect(fi.detail).toContain('1/3');
  });
});

describe('verifyMigration — BROKEN cases', () => {
  it('(a) fileIntegrity FAILS when a files row blob is missing on disk', () => {
    const db = buildMigratedDb();
    seedGraph(db);
    seedFile(db, 'file-aaaa', 'hello', 'p1');
    db.close();
    // Delete the blob off disk, leaving the files row dangling.
    fs.rmSync(pathFor(dataDir, 'file-aaaa'));

    const { checks, passed } = verifyMigration(dataDir);
    expect(passed).toBe(false);
    const fi = checks.find((c) => c.name === 'fileIntegrity')!;
    expect(fi.status).toBe('fail');
    expect(fi.detail).toContain('MISSING');
  });

  it('(b) fileIntegrity FAILS when disk bytes do not match stored sha256', () => {
    const db = buildMigratedDb();
    seedGraph(db);
    seedFile(db, 'file-aaaa', 'original content', 'p1');
    db.close();
    // Corrupt the blob in place but keep the SAME byte length so size matches
    // and only the hash check trips.
    const p = pathFor(dataDir, 'file-aaaa');
    const corrupt = Buffer.from('CORRUPTED____xyz'); // same length as 'original content'
    expect(corrupt.length).toBe(Buffer.from('original content').length);
    fs.writeFileSync(p, corrupt);

    const { checks, passed } = verifyMigration(dataDir);
    expect(passed).toBe(false);
    const fi = checks.find((c) => c.name === 'fileIntegrity')!;
    expect(fi.status).toBe('fail');
    expect(fi.detail).toContain('HASH-MISMATCH');
  });

  it('(c) fkIntegrity FAILS on a measurement with a dangling pageId', () => {
    const db = buildMigratedDb();
    seedGraph(db);
    db.prepare(
      "INSERT INTO measurements (id, pageId, projectId, type, points, sortOrder) VALUES ('m-bad', 'ghost-page', 'p1', 'line', '[]', 1)"
    ).run();
    db.close();

    const { checks, passed } = verifyMigration(dataDir);
    expect(passed).toBe(false);
    const fk = checks.find((c) => c.name === 'fkIntegrity')!;
    expect(fk.status).toBe('fail');
    expect(fk.detail).toContain('measurements.pageId');
  });

  it('(c2) fkIntegrity FAILS on a payment with a dangling polymorphic target', () => {
    const db = buildMigratedDb();
    seedGraph(db);
    db.prepare(
      "INSERT INTO payments (id, targetType, targetId, date, amount, method, note, createdAt) VALUES ('pay-bad', 'invoice', 'ghost-invoice', 1, 100, 'check', null, 1)"
    ).run();
    db.close();

    const { checks, passed } = verifyMigration(dataDir);
    expect(passed).toBe(false);
    const fk = checks.find((c) => c.name === 'fkIntegrity')!;
    expect(fk.status).toBe('fail');
    expect(fk.detail).toContain('payments.targetId');
  });

  it('(d) normalizationComplete FAILS on a project with non-null data', () => {
    const db = buildMigratedDb();
    seedGraph(db);
    db.prepare(
      "INSERT INTO projects (id, data, createdAt, name, status, version) VALUES ('p-blob', '{\"id\":\"p-blob\"}', 1, 'Undecomposed', 'estimating', 1)"
    ).run();
    db.close();

    const { checks, passed } = verifyMigration(dataDir);
    expect(passed).toBe(false);
    const nc = checks.find((c) => c.name === 'normalizationComplete')!;
    expect(nc.status).toBe('fail');
    expect(nc.detail).toContain('non-null data');
  });

  it('(e) schemaVersion FAILS when schema_version is below latest', () => {
    const db = buildMigratedDb();
    seedGraph(db);
    // Roll the recorded version back below the latest.
    db.prepare('DELETE FROM schema_version WHERE version = ?').run(LATEST_SCHEMA_VERSION);
    db.close();

    const { checks, passed } = verifyMigration(dataDir);
    expect(passed).toBe(false);
    const sv = checks.find((c) => c.name === 'schemaVersion')!;
    expect(sv.status).toBe('fail');
  });
});

describe('verifyMigration — WARN-only findings (do not fail the run)', () => {
  it('orphanFiles WARNs (not fails) for a file pointing at a missing project', () => {
    const db = buildMigratedDb();
    seedGraph(db);
    seedFile(db, 'file-orphan', 'x', 'no-such-project');
    db.close();

    const { checks, passed } = verifyMigration(dataDir);
    expect(passed).toBe(true); // WARN must not fail
    const of = checks.find((c) => c.name === 'orphanFiles')!;
    expect(of.status).toBe('warn');
  });
});
