// server/taskStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import {
  listTasks, getTask, createTask, saveTask,
  setTaskStatus, deleteTask, addTaskPhoto, removeTaskPhoto,
  ValidationError, ConflictError, NotFoundError,
} from './taskStore';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-task-')), migrations);
  db.prepare("INSERT INTO users (id, username, password, role) VALUES ('u1','alice','x','user'),('u2','bob','x','admin')").run();
  db.prepare("INSERT INTO customers (id, name, createdAt) VALUES ('c1','Acme',0),('c2','Globex',0)").run();
  db.prepare("INSERT INTO projects (id, name, customerId, version, createdAt) VALUES ('p1','Plaza','c1',1,0),('p2','Tower',NULL,1,0)").run();
});

describe('tasks', () => {
  it('creates and reads a task with assignee + due date', () => {
    const { id } = createTask(db, { category: 'Shop', title: 'Fix door', assigneeUserId: 'u1', dueDate: '2026-07-01' });
    const task = getTask(db, id)!;
    expect(task.title).toBe('Fix door');
    expect(task.category).toBe('Shop');
    expect(task.status).toBe('todo');
    expect(task.assigneeUserId).toBe('u1');
    expect(task.assigneeUsername).toBe('alice');
    expect(task.dueDate).toBe('2026-07-01');
    expect(task.version).toBe(1);
    expect(task.photos).toEqual([]);
  });

  it('rejects empty/whitespace title (ValidationError)', () => {
    expect(() => createTask(db, { title: '' })).toThrow(ValidationError);
    expect(() => createTask(db, { title: '   ' })).toThrow(ValidationError);
    expect(() => createTask(db, {})).toThrow(ValidationError);
  });

  it('rejects unknown assignee (ValidationError)', () => {
    expect(() => createTask(db, { title: 'X', assigneeUserId: 'nope' })).toThrow(ValidationError);
  });

  it('rejects invalid dueDate format (ValidationError); accepts null/empty (stored null)', () => {
    expect(() => createTask(db, { title: 'X', dueDate: '07/01/2026' })).toThrow(ValidationError);
    const a = createTask(db, { title: 'A', dueDate: null });
    expect(getTask(db, a.id)!.dueDate).toBeNull();
    const b = createTask(db, { title: 'B', dueDate: '' });
    expect(getTask(db, b.id)!.dueDate).toBeNull();
  });

  it('lists tasks ordered by category ASC then sortOrder, with assigneeUsername + photoCount', () => {
    createTask(db, { category: 'B', title: 'b1' });
    createTask(db, { category: 'A', title: 'a1', assigneeUserId: 'u2' });
    const list = listTasks(db);
    expect(list.map(t => t.title)).toEqual(['a1', 'b1']);
    expect(list[0].assigneeUsername).toBe('bob');
    expect(list[0].photoCount).toBe(0);
  });

  it('saveTask with correct version bumps version to 2 and updates fields', () => {
    const { id } = createTask(db, { category: 'Shop', title: 'Fix door', assigneeUserId: 'u1', dueDate: '2026-07-01' });
    const task = getTask(db, id)!;
    const r = saveTask(db, id, { ...task, category: 'Yard', title: 'Fix gate', assigneeUserId: 'u2', dueDate: '2026-08-01' });
    expect(r.version).toBe(2);
    const reloaded = getTask(db, id)!;
    expect(reloaded.category).toBe('Yard');
    expect(reloaded.title).toBe('Fix gate');
    expect(reloaded.assigneeUserId).toBe('u2');
    expect(reloaded.assigneeUsername).toBe('bob');
    expect(reloaded.dueDate).toBe('2026-08-01');
  });

  it('saveTask with stale version throws ConflictError', () => {
    const { id } = createTask(db, { title: 'Original' });
    const task = getTask(db, id)!;
    saveTask(db, id, { ...task, title: 'Updated' }); // advances to v2
    expect(() => saveTask(db, id, { ...task, title: 'Stale' })).toThrow(ConflictError); // still at v1
  });

  it('saveTask with unknown id throws NotFoundError', () => {
    expect(() => saveTask(db, 'no-such-id', { title: 'X', version: 1 })).toThrow(NotFoundError);
  });
});

describe('setTaskStatus', () => {
  it('sets status and bumps version', () => {
    const { id } = createTask(db, { title: 'Work item' });
    const result = setTaskStatus(db, id, 'in_progress');
    expect(result).toEqual({ status: 'in_progress' });
    const task = getTask(db, id)!;
    expect(task.status).toBe('in_progress');
    expect(task.version).toBe(2);
  });

  it('throws ValidationError for invalid status', () => {
    const { id } = createTask(db, { title: 'Work item' });
    expect(() => setTaskStatus(db, id, 'nope')).toThrow(ValidationError);
  });

  it('throws NotFoundError for unknown id', () => {
    expect(() => setTaskStatus(db, 'no-such-id', 'in_progress')).toThrow(NotFoundError);
  });
});

describe('addTaskPhoto / removeTaskPhoto', () => {
  it('addTaskPhoto is idempotent (same fileId+stage twice → 1 photo)', () => {
    const { id } = createTask(db, { title: 'Photo task' });
    addTaskPhoto(db, id, 'f1', 'before');
    addTaskPhoto(db, id, 'f1', 'before');
    const task = getTask(db, id)!;
    expect(task.photos.length).toBe(1);
    expect(task.photos[0].stage).toBe('before');
  });

  it('throws ValidationError for invalid stage', () => {
    const { id } = createTask(db, { title: 'Photo task' });
    expect(() => addTaskPhoto(db, id, 'f1', 'sideways')).toThrow(ValidationError);
  });

  it('throws ValidationError for empty fileId', () => {
    const { id } = createTask(db, { title: 'Photo task' });
    expect(() => addTaskPhoto(db, id, '', 'before')).toThrow(ValidationError);
  });

  it('throws NotFoundError for unknown task', () => {
    expect(() => addTaskPhoto(db, 'no-such-id', 'f1', 'before')).toThrow(NotFoundError);
  });

  it('removeTaskPhoto removes the photo', () => {
    const { id } = createTask(db, { title: 'Photo task' });
    addTaskPhoto(db, id, 'f1', 'before');
    removeTaskPhoto(db, id, 'f1');
    const task = getTask(db, id)!;
    expect(task.photos.length).toBe(0);
  });
});

describe('deleteTask', () => {
  it('deletes task and cascades task_photos', () => {
    const { id } = createTask(db, { title: 'To delete' });
    addTaskPhoto(db, id, 'f1', 'before');
    deleteTask(db, id);
    expect(getTask(db, id)).toBeNull();
    const count = (db.prepare('SELECT COUNT(*) c FROM task_photos WHERE taskId = ?').get(id) as any).c;
    expect(count).toBe(0);
  });
});

describe('task relations', () => {
  it('derives customer from project on create (client customer ignored)', () => {
    const { id } = createTask(db, { title: 'T', projectId: 'p1', customerId: 'c2' });
    const t = getTask(db, id)!;
    expect(t.projectId).toBe('p1');
    expect(t.customerId).toBe('c1'); // derived from p1, not the passed c2
    expect(t.projectName).toBe('Plaza');
    expect(t.customerName).toBe('Acme');
  });

  it('allows a customer-only task (no project)', () => {
    const { id } = createTask(db, { title: 'T', customerId: 'c2' });
    const t = getTask(db, id)!;
    expect(t.projectId).toBeNull();
    expect(t.customerId).toBe('c2');
    expect(t.customerName).toBe('Globex');
  });

  it('project with null customer yields null customerId', () => {
    const { id } = createTask(db, { title: 'T', projectId: 'p2' });
    const t = getTask(db, id)!;
    expect(t.projectId).toBe('p2');
    expect(t.customerId).toBeNull();
  });

  it('rejects unknown project or customer', () => {
    expect(() => createTask(db, { title: 'T', projectId: 'nope' })).toThrow(ValidationError);
    expect(() => createTask(db, { title: 'T', customerId: 'nope' })).toThrow(ValidationError);
  });

  it('clearing the project on save clears the derived customer', () => {
    const { id } = createTask(db, { title: 'T', projectId: 'p1' });
    const v = getTask(db, id)!.version;
    saveTask(db, id, { title: 'T', projectId: null, customerId: null, version: v });
    const t = getTask(db, id)!;
    expect(t.projectId).toBeNull();
    expect(t.customerId).toBeNull();
  });

  it('save can set a customer-only relation', () => {
    const { id } = createTask(db, { title: 'T' });
    const v = getTask(db, id)!.version;
    saveTask(db, id, { title: 'T', customerId: 'c1', version: v });
    expect(getTask(db, id)!.customerId).toBe('c1');
  });

  it('setTaskStatus does not change project/customer relations', () => {
    const { id } = createTask(db, { title: 'T', projectId: 'p1' });
    setTaskStatus(db, id, 'in_progress');
    const t = getTask(db, id)!;
    expect(t.projectId).toBe('p1');
    expect(t.customerId).toBe('c1');
  });
});

describe('listTasks filters', () => {
  beforeEach(() => {
    createTask(db, { title: 'onP1', projectId: 'p1' });   // customer c1
    createTask(db, { title: 'onC2', customerId: 'c2' });
    createTask(db, { title: 'mineU2', assigneeUserId: 'u2' });
  });

  it('filters by projectId', () => {
    expect(listTasks(db, { projectId: 'p1' }).map(t => t.title)).toEqual(['onP1']);
  });
  it('filters by customerId (includes project-derived customers)', () => {
    expect(listTasks(db, { customerId: 'c1' }).map(t => t.title)).toEqual(['onP1']);
    expect(listTasks(db, { customerId: 'c2' }).map(t => t.title)).toEqual(['onC2']);
  });
  it('filters by assigneeUserId', () => {
    expect(listTasks(db, { assigneeUserId: 'u2' }).map(t => t.title)).toEqual(['mineU2']);
  });
  it('no filter returns all', () => {
    expect(listTasks(db).length).toBe(3);
  });
});
