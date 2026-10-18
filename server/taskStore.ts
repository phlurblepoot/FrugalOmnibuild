// server/taskStore.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;
export const TASK_PHOTO_STAGES = ['before', 'in_progress', 'after'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function photoCount(db: Database.Database, taskId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM task_photos WHERE taskId = ?').get(taskId) as any).c;
}

function validateAssignee(db: Database.Database, assigneeUserId: unknown): string | null {
  if (assigneeUserId === undefined || assigneeUserId === null || assigneeUserId === '') return null;
  if (typeof assigneeUserId !== 'string') throw new ValidationError('Invalid assignee');
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(assigneeUserId)) throw new ValidationError('Assignee is not a known user');
  return assigneeUserId;
}

function validateDue(dueDate: unknown): string | null {
  if (dueDate === undefined || dueDate === null || dueDate === '') return null;
  if (typeof dueDate !== 'string' || !DATE_RE.test(dueDate)) throw new ValidationError('Due date must be YYYY-MM-DD');
  return dueDate;
}

function validateCustomerId(db: Database.Database, customerId: unknown): string | null {
  if (customerId === undefined || customerId === null || customerId === '') return null;
  if (typeof customerId !== 'string') throw new ValidationError('Invalid customer');
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw new ValidationError('Customer is not a known customer');
  return customerId;
}

// Resolve the (projectId, customerId) pair, enforcing the invariant that a
// project always dictates its own customer. Client-supplied customerId is only
// honored when no project is set.
function resolveRelations(db: Database.Database, projectId: unknown, customerId: unknown): { projectId: string | null; customerId: string | null } {
  if (projectId !== undefined && projectId !== null && projectId !== '') {
    if (typeof projectId !== 'string') throw new ValidationError('Invalid project');
    const row = db.prepare('SELECT customerId FROM projects WHERE id = ?').get(projectId) as { customerId: string | null } | undefined;
    if (!row) throw new ValidationError('Project is not a known project');
    return { projectId, customerId: row.customerId ?? null };
  }
  return { projectId: null, customerId: validateCustomerId(db, customerId) };
}

interface TaskInput {
  category?: string; title?: string; notes?: string;
  assigneeUserId?: string | null; dueDate?: string | null;
  projectId?: string | null; customerId?: string | null;
}

export function getTask(db: Database.Database, id: string): any | null {
  const row = db.prepare(`
    SELECT t.*, u.username AS assigneeUsername, p.name AS projectName, c.name AS customerName
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigneeUserId
    LEFT JOIN projects p ON p.id = t.projectId
    LEFT JOIN customers c ON c.id = t.customerId
    WHERE t.id = ?`).get(id) as any;
  if (!row) return null;
  const photos = db.prepare('SELECT id, fileId, stage, sortOrder FROM task_photos WHERE taskId = ? ORDER BY stage, sortOrder, createdAt').all(id);
  return { ...row, photos };
}

export function listTasks(db: Database.Database, filter: { projectId?: string; customerId?: string; assigneeUserId?: string } = {}): any[] {
  const where: string[] = [];
  const params: any[] = [];
  if (filter.projectId) { where.push('t.projectId = ?'); params.push(filter.projectId); }
  if (filter.customerId) { where.push('t.customerId = ?'); params.push(filter.customerId); }
  if (filter.assigneeUserId) { where.push('t.assigneeUserId = ?'); params.push(filter.assigneeUserId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT t.*, u.username AS assigneeUsername, p.name AS projectName, c.name AS customerName
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigneeUserId
    LEFT JOIN projects p ON p.id = t.projectId
    LEFT JOIN customers c ON c.id = t.customerId
    ${whereSql}
    ORDER BY t.category ASC, t.sortOrder ASC, t.createdAt ASC, t.rowid ASC`).all(...params) as any[];
  return rows.map(r => ({ ...r, photoCount: photoCount(db, r.id) }));
}

export function createTask(db: Database.Database, input: TaskInput & { createdBy?: string | null }): { id: string } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Task title is required');
  const assignee = validateAssignee(db, input.assigneeUserId);
  const due = validateDue(input.dueDate);
  const rel = resolveRelations(db, input.projectId, input.customerId);
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM tasks').get() as any).m;
    db.prepare(`INSERT INTO tasks (id, category, title, notes, assigneeUserId, status, dueDate, projectId, customerId, sortOrder, version, createdAt, createdBy)
      VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, (input.category ?? '').trim(), input.title!.trim(), (input.notes ?? '').trim(), assignee, due, rel.projectId, rel.customerId, max + 1, Date.now(), input.createdBy ?? null);
  });
  tx();
  return { id };
}

export function saveTask(db: Database.Database, id: string, input: TaskInput & { version?: number }): { version: number } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ValidationError('Task title is required');
  if (!Number.isInteger(input.version) || (input.version as number) < 1) throw new ValidationError('Missing or invalid version — reload the task');
  const assignee = validateAssignee(db, input.assigneeUserId);
  const due = validateDue(input.dueDate);
  const rel = resolveRelations(db, input.projectId, input.customerId);
  let newVersion = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT version FROM tasks WHERE id = ?').get(id) as { version: number } | undefined;
    if (!row) throw new NotFoundError('Task not found');
    if (row.version !== input.version) throw new ConflictError(`Task changed since it was loaded (server v${row.version}, payload v${input.version})`);
    newVersion = row.version + 1;
    db.prepare('UPDATE tasks SET category = ?, title = ?, notes = ?, assigneeUserId = ?, dueDate = ?, projectId = ?, customerId = ?, version = ? WHERE id = ?')
      .run((input.category ?? '').trim(), input.title!.trim(), (input.notes ?? '').trim(), assignee, due, rel.projectId, rel.customerId, newVersion, id);
  });
  tx();
  return { version: newVersion };
}

export function setTaskStatus(db: Database.Database, id: string, status: string): { status: string } {
  if (!(TASK_STATUSES as readonly string[]).includes(status)) throw new ValidationError(`Invalid task status: ${status}`);
  const row = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('Task not found');
  db.prepare('UPDATE tasks SET status = ?, version = version + 1 WHERE id = ?').run(status, id);
  return { status };
}

export function deleteTask(db: Database.Database, id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM task_photos WHERE taskId = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  });
  tx();
}

export function addTaskPhoto(db: Database.Database, taskId: string, fileId: string, stage: string): void {
  if (!db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)) throw new NotFoundError('Task not found');
  if (typeof fileId !== 'string' || !fileId) throw new ValidationError('fileId is required');
  if (!(TASK_PHOTO_STAGES as readonly string[]).includes(stage)) throw new ValidationError(`Invalid photo stage: ${stage}`);
  if (db.prepare('SELECT id FROM task_photos WHERE taskId = ? AND fileId = ? AND stage = ?').get(taskId, fileId, stage)) return;
  const max = (db.prepare('SELECT COALESCE(MAX(sortOrder), -1) m FROM task_photos WHERE taskId = ?').get(taskId) as any).m;
  db.prepare('INSERT INTO task_photos (id, taskId, fileId, stage, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), taskId, fileId, stage, max + 1, Date.now());
}

export function removeTaskPhoto(db: Database.Database, taskId: string, fileId: string): void {
  db.prepare('DELETE FROM task_photos WHERE taskId = ? AND fileId = ?').run(taskId, fileId);
}
