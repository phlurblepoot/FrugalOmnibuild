// server/activity.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { logActivity, listActivity } from './activity';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-act-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Maple', 1);
  db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run('u1', 'noah', 'x', 'admin');
});

describe('activity log', () => {
  it('logs and lists newest-first with project and user names joined', () => {
    logActivity(db, { projectId: 'p1', userId: 'u1', type: 'status_changed', message: 'Stage changed to awarded' });
    logActivity(db, { type: 'project_created', message: 'Project "Other" created' });
    const items = listActivity(db, 10);
    expect(items).toHaveLength(2);
    expect(items[0].message).toBe('Project "Other" created');
    expect(items[0].projectName).toBeNull();
    expect(items[1]).toMatchObject({
      type: 'status_changed', projectId: 'p1', projectName: 'Maple', username: 'noah',
    });
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) logActivity(db, { type: 't', message: `m${i}` });
    expect(listActivity(db, 3)).toHaveLength(3);
  });

  it('never throws on logging failure', () => {
    db.exec('DROP TABLE activity');
    expect(() => logActivity(db, { type: 't', message: 'm' })).not.toThrow();
  });

  it('filters by projectId when given', () => {
    logActivity(db, { projectId: 'p1', type: 'a', message: 'one' });
    logActivity(db, { projectId: 'p9', type: 'a', message: 'two' });
    logActivity(db, { type: 'a', message: 'three' });
    const items = listActivity(db, 10, 'p1');
    expect(items).toHaveLength(1);
    expect(items[0].message).toBe('one');
  });
});
