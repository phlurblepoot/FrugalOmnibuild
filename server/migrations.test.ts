import { describe, it, expect } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from './db';
import { runMigrations, currentVersion, type Migration } from './migrations';

const tmpDir = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-mig-'));

const m = (version: number, sql: string): Migration => ({
  version,
  name: `m${version}`,
  up: ({ db }) => { db.exec(sql); },
});

describe('runMigrations', () => {
  it('applies pending migrations in order and records them', () => {
    const db = openDb(':memory:');
    const result = runMigrations(db, tmpDir(), [
      m(1, 'CREATE TABLE a (id INTEGER)'),
      m(2, 'CREATE TABLE b (id INTEGER)'),
    ]);
    expect(result.from).toBe(0);
    expect(result.to).toBe(2);
    expect(result.applied).toEqual(['m1', 'm2']);
    expect(currentVersion(db)).toBe(2);
    // both tables exist
    db.prepare('SELECT * FROM a').all();
    db.prepare('SELECT * FROM b').all();
    db.close();
  });

  it('is idempotent — second run applies nothing', () => {
    const db = openDb(':memory:');
    const migs = [m(1, 'CREATE TABLE a (id INTEGER)')];
    runMigrations(db, tmpDir(), migs);
    const second = runMigrations(db, tmpDir(), migs);
    expect(second.applied).toEqual([]);
    db.close();
  });

  it('rolls back a failing migration and stops', () => {
    const db = openDb(':memory:');
    const bad: Migration = {
      version: 2,
      name: 'bad',
      up: ({ db }) => {
        db.exec('CREATE TABLE partial (id INTEGER)');
        throw new Error('boom');
      },
    };
    expect(() =>
      runMigrations(db, tmpDir(), [m(1, 'CREATE TABLE a (id INTEGER)'), bad])
    ).toThrow('boom');
    expect(currentVersion(db)).toBe(1); // m1 applied, bad rolled back
    expect(() => db.prepare('SELECT * FROM partial').all()).toThrow(); // rolled back
    db.close();
  });

  it('backs up the db file before applying when dbFile is given', () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'app.db');
    let db = openDb(dbFile);
    runMigrations(db, dir, [m(1, 'CREATE TABLE a (id INTEGER)')], { dbFile });
    db.prepare('INSERT INTO a (id) VALUES (1)').run();
    db.close();

    db = openDb(dbFile);
    runMigrations(db, dir, [
      m(1, 'CREATE TABLE a (id INTEGER)'),
      m(2, 'CREATE TABLE b (id INTEGER)'),
    ], { dbFile });
    db.close();

    const backups = fsSync.readdirSync(path.join(dir, 'backups'));
    // one backup per run that had pending migrations (run 1 had no file yet to back up
    // before schema_version existed is fine either way; assert at least the v1 backup)
    expect(backups.some(f => f.startsWith('app-v1-'))).toBe(true);
  });

  it('vacuums the database after applying when the vacuum option is set', () => {
    const dir = tmpDir();
    const dbFile = path.join(dir, 'app.db');
    let db = openDb(dbFile);
    // create bloat then delete it so the file is mostly free pages
    db.exec('CREATE TABLE bloat (data TEXT)');
    const big = 'x'.repeat(1024 * 1024);
    const ins = db.prepare('INSERT INTO bloat (data) VALUES (?)');
    for (let i = 0; i < 10; i++) ins.run(big);
    db.prepare('DELETE FROM bloat').run();
    db.close();
    const sizeBefore = fsSync.statSync(dbFile).size;

    db = openDb(dbFile);
    runMigrations(db, dir, [m(1, 'CREATE TABLE a (id INTEGER)')], { dbFile, vacuum: true });
    db.close();
    const sizeAfter = fsSync.statSync(dbFile).size;
    expect(sizeBefore).toBeGreaterThan(10 * 1024 * 1024);
    expect(sizeAfter).toBeLessThan(sizeBefore / 2); // free pages reclaimed

    // and a no-op run must not vacuum (nothing pending → no pause at boot)
    db = openDb(dbFile);
    const second = runMigrations(db, dir, [m(1, 'CREATE TABLE a (id INTEGER)')], { dbFile, vacuum: true });
    expect(second.applied).toEqual([]);
    db.close();
  });
});
