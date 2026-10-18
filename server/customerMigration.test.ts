import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrations } from './migrationList';

const m16 = migrations.find(m => m.version === 16)!;

function seed() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, contractor TEXT, meta TEXT);`);
  const ins = db.prepare('INSERT INTO projects (id, contractor) VALUES (?, ?)');
  ins.run('p1', 'Acme');
  ins.run('p2', ' acme ');
  ins.run('p3', 'Beta Co');
  ins.run('p4', '');
  ins.run('p5', null);
  return db;
}

describe('migration 16 customers-from-contractor', () => {
  it('creates a customer per distinct contractor, links projects, routes blanks to Unassigned, keeps contractor', () => {
    const db = seed();
    m16.up({ db } as any);
    const cust = db.prepare('SELECT id, name FROM customers ORDER BY name').all() as any[];
    expect(cust.map(c => c.name).sort()).toEqual(['Acme', 'Beta Co', 'Unassigned']);
    const cid = (pid: string) => (db.prepare('SELECT customerId FROM projects WHERE id = ?').get(pid) as any).customerId;
    expect(cid('p1')).toBe(cid('p2'));
    expect(cid('p1')).not.toBe(cid('p3'));
    expect(cid('p4')).toBe('customer-unassigned');
    expect(cid('p5')).toBe('customer-unassigned');
    expect((db.prepare('SELECT contractor FROM projects WHERE id = ?').get('p1') as any).contractor).toBe('Acme');
  });

  it('is safe to run when a projects.customerId already exists (idempotent columns)', () => {
    const db = seed();
    m16.up({ db } as any);
    expect(() => m16.up({ db } as any)).not.toThrow();
  });
});
