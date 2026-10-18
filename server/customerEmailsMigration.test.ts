import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrations } from './migrationList';

/** Find and return migration 17. */
function getMig17() {
  const m = migrations.find(m => m.version === 17);
  if (!m) throw new Error('Migration 17 not found');
  return m;
}

/** Minimal DB that has a customers table with the legacy flat email columns. */
function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  // Simulate the shape created by migration 16 (no emails column yet).
  db.exec(`
    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      generalEmail TEXT,
      accountingEmail TEXT,
      estimatingEmail TEXT,
      pmEmail TEXT,
      createdAt INTEGER,
      updatedAt INTEGER,
      attrs TEXT
    );
  `);
  return db;
}

describe('migration 17: customer-emails-json', () => {
  it('backfills emails JSON from flat columns for rows that have some', () => {
    const db = legacyDb();
    db.prepare(`INSERT INTO customers (id, name, generalEmail, accountingEmail) VALUES (?, ?, ?, ?)`)
      .run('c1', 'Acme', 'a@x.com', 'b@x.com');

    getMig17().up({ db, dataDir: '' });

    const row = db.prepare(`SELECT emails FROM customers WHERE id = ?`).get('c1') as any;
    expect(row.emails).not.toBeNull();
    const parsed = JSON.parse(row.emails);
    expect(parsed.general).toEqual({ to: 'a@x.com' });
    expect(parsed.accounting).toEqual({ to: 'b@x.com' });
    // Roles with null columns should be absent.
    expect(parsed.estimating).toBeUndefined();
    expect(parsed.pm).toBeUndefined();
  });

  it('leaves emails NULL for a row with all-null email columns', () => {
    const db = legacyDb();
    db.prepare(`INSERT INTO customers (id, name) VALUES (?, ?)`).run('c2', 'No Emails');

    getMig17().up({ db, dataDir: '' });

    const row = db.prepare(`SELECT emails FROM customers WHERE id = ?`).get('c2') as any;
    // Row had no emails → emails column stays NULL (we don't write an empty object).
    expect(row.emails).toBeNull();
  });

  it('is idempotent: re-running up() does not overwrite an already-written emails column', () => {
    const db = legacyDb();
    db.prepare(`INSERT INTO customers (id, name, generalEmail) VALUES (?, ?, ?)`)
      .run('c3', 'Idempotent', 'first@x.com');

    // First run sets emails JSON.
    getMig17().up({ db, dataDir: '' });

    // Manually overwrite emails with a custom value to detect if a second run clobbers it.
    const custom = JSON.stringify({ general: { to: 'custom@x.com' } });
    db.prepare(`UPDATE customers SET emails = ? WHERE id = ?`).run(custom, 'c3');

    // Second run: emails IS NOT NULL so the WHERE emails IS NULL predicate skips it.
    getMig17().up({ db, dataDir: '' });

    const row = db.prepare(`SELECT emails FROM customers WHERE id = ?`).get('c3') as any;
    expect(JSON.parse(row.emails).general.to).toBe('custom@x.com');
  });
});
