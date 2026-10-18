// server/punchStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const PUNCH_STAGES = ['before', 'during', 'after'] as const;

function requireProject(db: Database.Database, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) throw new NotFoundError('Project not found');
}

function photoCount(db: Database.Database, itemId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM punch_photos WHERE punchItemId = ?').get(itemId) as any).c;
}

interface PunchInput { area?: string; description?: string; }

export function getPunchItem(db: Database.Database, id: string): any | null {
  const row = db.prepare('SELECT * FROM punch_items WHERE id = ?').get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, stage, sortOrder FROM punch_photos WHERE punchItemId = ? ORDER BY stage, sortOrder, createdAt').all(id);
  return { ...row, photos };
}

export function listPunchItems(db: Database.Database, projectId: string): any[] {
  const rows = db.prepare('SELECT * FROM punch_items WHERE projectId = ? ORDER BY area ASC, sortOrder ASC, createdAt ASC, rowid ASC').all(projectId) as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}

export function createPunchItem(db: Database.Database, projectId: string, input: PunchInput): { id: string } {
  requireProject(db, projectId);
  if (typeof input.description !== 'string' || !input.description.trim()) throw new ValidationError('Punch item description is required');
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM punch_items WHERE projectId = ?').get(projectId) as any).m;
    db.prepare('INSERT INTO punch_items (id, projectId, area, description, done, sortOrder, version, createdAt) VALUES (?, ?, ?, ?, 0, ?, 1, ?)')
      .run(id, projectId, (input.area ?? '').trim(), input.description!.trim(), max + 1, Date.now());
  });
  tx();
  return { id };
}

export function savePunchItem(db: Database.Database, id: string, input: PunchInput & { version?: number }): { version: number } {
  if (typeof input.description !== 'string' || !input.description.trim()) throw new ValidationError('Punch item description is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the item');
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM punch_items WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Punch item not found');
    if (row.version !== input.version) throw new ConflictError(`Punch item changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE punch_items SET area = ?, description = ?, version = ? WHERE id = ?')
      .run((input.area ?? '').trim(), input.description!.trim(), newVersion, id);
  });
  tx();
  return { version: newVersion };
}

export function setPunchDone(db: Database.Database, id: string, done: boolean): { done: boolean } {
  const row = db.prepare('SELECT id FROM punch_items WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Punch item not found');
  db.prepare('UPDATE punch_items SET done = ?, version = version + 1 WHERE id = ?').run(done ? 1 : 0, id);
  return { done };
}

export function deletePunchItem(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM punch_photos WHERE punchItemId = ?').run(id);
    db.prepare('DELETE FROM punch_items WHERE id = ?').run(id);
  });
  tx();
}

export function addPunchPhoto(db: Database.Database, itemId: string, fileId: string, stage: string): void {
  if (!db.prepare('SELECT id FROM punch_items WHERE id = ?').get(itemId)) throw new NotFoundError('Punch item not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  if (!(PUNCH_STAGES as readonly string[]).includes(stage)) throw new ValidationError(`Invalid photo stage: ${stage}`);
  const exists = db.prepare('SELECT id FROM punch_photos WHERE punchItemId = ? AND fileId = ? AND stage = ?').get(itemId, fileId, stage);
  if (exists) return; // idempotent
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM punch_photos WHERE punchItemId = ?').get(itemId) as any).m;
  db.prepare('INSERT INTO punch_photos (id, punchItemId, fileId, stage, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), itemId, fileId, stage, max + 1, Date.now());
}

export function removePunchPhoto(db: Database.Database, itemId: string, fileId: string): void {
  db.prepare('DELETE FROM punch_photos WHERE punchItemId = ? AND fileId = ?').run(itemId, fileId);
}

export function punchProgress(db: Database.Database, projectId: string): { done: number; total: number } {
  const total = (db.prepare('SELECT COUNT(*) c FROM punch_items WHERE projectId = ?').get(projectId) as any).c;
  const done = (db.prepare('SELECT COUNT(*) c FROM punch_items WHERE projectId = ? AND done = 1').get(projectId) as any).c;
  return { done, total };
}
