import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('test infrastructure', () => {
  it('runs better-sqlite3 in-memory', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER)');
    db.prepare('INSERT INTO t (id) VALUES (?)').run(42);
    const row = db.prepare('SELECT id FROM t').get() as { id: number };
    expect(row.id).toBe(42);
    db.close();
  });
});
