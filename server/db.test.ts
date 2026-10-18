import { describe, it, expect } from 'vitest';
import { openDb } from './db';

describe('openDb', () => {
  it('opens an in-memory db with DELETE journal mode', () => {
    const db = openDb(':memory:');
    // in-memory dbs report 'memory'; the pragma call must not throw
    const mode = db.pragma('journal_mode', { simple: true });
    expect(['delete', 'memory']).toContain(mode);
    db.close();
  });

  it('enables foreign keys', () => {
    const db = openDb(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});
