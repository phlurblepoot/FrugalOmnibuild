// server/punchStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listPunchItems, getPunchItem, createPunchItem, savePunchItem,
  setPunchDone, deletePunchItem, addPunchPhoto, removePunchPhoto, punchProgress,
  ValidationError, ConflictError, NotFoundError,
} from './punchStore';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-punch-')), migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('punchItems', () => {
  it('creates and reads a punch item (area, description set; done===0; version===1; photos===[])', () => {
    const { id } = createPunchItem(db, 'p1', { area: 'Kitchen', description: 'Fix cabinet' });
    const item = getPunchItem(db, id)!;
    expect(item.area).toBe('Kitchen');
    expect(item.description).toBe('Fix cabinet');
    expect(item.done).toBe(0);
    expect(item.version).toBe(1);
    expect(item.photos).toEqual([]);
  });

  it('rejects empty/whitespace description (ValidationError)', () => {
    expect(() => createPunchItem(db, 'p1', { description: '' })).toThrow(ValidationError);
    expect(() => createPunchItem(db, 'p1', { description: '   ' })).toThrow(ValidationError);
    expect(() => createPunchItem(db, 'p1', {})).toThrow(ValidationError);
  });

  it('rejects unknown project (NotFoundError)', () => {
    expect(() => createPunchItem(db, 'nope', { description: 'X' })).toThrow(NotFoundError);
  });

  it('lists items ordered by area ASC then sortOrder', () => {
    createPunchItem(db, 'p1', { area: 'Bath', description: 'b1' });
    createPunchItem(db, 'p1', { area: 'Attic', description: 'a1' });
    createPunchItem(db, 'p1', { area: 'Attic', description: 'a2' });
    const list = listPunchItems(db, 'p1');
    expect(list.map(i => i.description)).toEqual(['a1', 'a2', 'b1']);
    expect(list[0].photoCount).toBe(0);
  });

  it('savePunchItem with correct version bumps version to 2 and updates fields', () => {
    const { id } = createPunchItem(db, 'p1', { area: 'Kitchen', description: 'Fix cabinet' });
    const item = getPunchItem(db, id)!;
    const r = savePunchItem(db, id, { ...item, area: 'Bath', description: 'Fix tub' });
    expect(r.version).toBe(2);
    const reloaded = getPunchItem(db, id)!;
    expect(reloaded.area).toBe('Bath');
    expect(reloaded.description).toBe('Fix tub');
  });

  it('savePunchItem with stale version throws ConflictError', () => {
    const { id } = createPunchItem(db, 'p1', { description: 'Original' });
    const item = getPunchItem(db, id)!;
    savePunchItem(db, id, { ...item, description: 'Updated' }); // advances to v2
    expect(() => savePunchItem(db, id, { ...item, description: 'Stale' })).toThrow(ConflictError); // still at v1
  });
});

describe('setPunchDone', () => {
  it('marks item done=true and bumps version to 2', () => {
    const { id } = createPunchItem(db, 'p1', { description: 'Fix something' });
    const result = setPunchDone(db, id, true);
    expect(result.done).toBe(true);
    const item = getPunchItem(db, id)!;
    expect(item.done).toBe(1);
    expect(item.version).toBe(2);
  });

  it('throws NotFoundError for unknown id', () => {
    expect(() => setPunchDone(db, 'no-such-id', true)).toThrow(NotFoundError);
  });
});

describe('addPunchPhoto / removePunchPhoto', () => {
  it('addPunchPhoto is idempotent — same fileId+stage only stored once', () => {
    const { id } = createPunchItem(db, 'p1', { description: 'Fix something' });
    addPunchPhoto(db, id, 'f1', 'before');
    addPunchPhoto(db, id, 'f1', 'before'); // duplicate
    const item = getPunchItem(db, id)!;
    expect(item.photos.length).toBe(1);
    expect(item.photos[0].stage).toBe('before');
  });

  it('addPunchPhoto with invalid stage throws ValidationError', () => {
    const { id } = createPunchItem(db, 'p1', { description: 'Fix something' });
    expect(() => addPunchPhoto(db, id, 'f1', 'sideways')).toThrow(ValidationError);
  });

  it('removePunchPhoto removes the photo', () => {
    const { id } = createPunchItem(db, 'p1', { description: 'Fix something' });
    addPunchPhoto(db, id, 'f1', 'before');
    removePunchPhoto(db, id, 'f1');
    const item = getPunchItem(db, id)!;
    expect(item.photos.length).toBe(0);
  });
});

describe('deletePunchItem', () => {
  it('deletes item and its photos; getPunchItem returns null and punch_photos are cleaned up', () => {
    const { id } = createPunchItem(db, 'p1', { description: 'Fix something' });
    addPunchPhoto(db, id, 'f1', 'before');
    deletePunchItem(db, id);
    expect(getPunchItem(db, id)).toBeNull();
    const photoCount = (db.prepare('SELECT COUNT(*) c FROM punch_photos WHERE punchItemId = ?').get(id) as any).c;
    expect(photoCount).toBe(0);
  });
});

describe('punchProgress', () => {
  it('returns done and total counts for a project', () => {
    createPunchItem(db, 'p1', { area: 'Kitchen', description: 'Fix cabinet' });
    const { id: id2 } = createPunchItem(db, 'p1', { area: 'Bath', description: 'Fix tub' });
    setPunchDone(db, id2, true);
    const progress = punchProgress(db, 'p1');
    expect(progress.done).toBe(1);
    expect(progress.total).toBe(2);
  });
});
