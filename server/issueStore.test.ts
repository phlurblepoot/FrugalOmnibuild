// server/issueStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putBuffer } from './files';
import {
  listIssues, getIssue, createIssue, saveIssue, setIssueStatus, deleteIssue,
  addPhoto, removePhoto, addAttachment, updateAttachment, removeAttachment, markIssueSent, countOpenIssues,
  ValidationError, ConflictError, NotFoundError,
} from './issueStore';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = openDb(':memory:');
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-iss-'));
  runMigrations(db, dir, migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('issues', () => {
  it('numbers issues sequentially per project starting at 1', () => {
    const a = createIssue(db, 'p1', { title: 'A' });
    const b = createIssue(db, 'p1', { title: 'B' });
    const c = createIssue(db, 'p2', { title: 'C' }); // separate project sequence
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(c.number).toBe(1);
    expect(getIssue(db, a.id)!.status).toBe('open');
    expect(getIssue(db, a.id)!.version).toBe(1);
  });

  it('saveIssue is version-checked and updates the body', () => {
    const { id } = createIssue(db, 'p1', { title: 'A', description: 'first' });
    const iss = getIssue(db, id)!;
    const r = saveIssue(db, id, { ...iss, title: 'A2', description: 'second' });
    expect(r.version).toBe(2);
    const reloaded = getIssue(db, id)!;
    expect(reloaded.title).toBe('A2');
    expect(reloaded.description).toBe('second');
    expect(() => saveIssue(db, id, { ...iss })).toThrow(ConflictError); // stale
  });

  it('setIssueStatus validates and updates', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    setIssueStatus(db, id, 'resolved');
    expect(getIssue(db, id)!.status).toBe('resolved');
    expect(() => setIssueStatus(db, id, 'galactic')).toThrow(ValidationError);
  });

  it('validates create + unknown project + unknown issue', () => {
    expect(() => createIssue(db, 'nope', { title: 'X' })).toThrow(NotFoundError);
    expect(() => createIssue(db, 'p1', { title: '' })).toThrow(ValidationError);
    expect(() => saveIssue(db, 'nope', { version: 1, title: 'X' } as any)).toThrow(NotFoundError);
  });

  it('listIssues returns newest-first with photoCount', () => {
    createIssue(db, 'p1', { title: 'A' });
    createIssue(db, 'p1', { title: 'B' });
    const list = listIssues(db, 'p1');
    expect(list.map(i => i.title)).toEqual(['B', 'A']);
    expect(list[0].photoCount).toBe(0);
  });

  it('deleteIssue removes the issue and its photo links', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    db.prepare('INSERT INTO issue_photos (id, issueId, fileId, sortOrder, createdAt) VALUES (?, ?, ?, ?, ?)').run('ph', id, 'f1', 0, 1);
    deleteIssue(db, id);
    expect(getIssue(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM issue_photos').get() as any).c).toBe(0);
  });
});

describe('photos + sent', () => {
  it('adds and removes photo links (newest sortOrder appended)', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    addPhoto(db, id, 'f2');
    let iss = getIssue(db, id)!;
    expect(iss.photos.map((p: any) => p.fileId)).toEqual(['f1', 'f2']);
    removePhoto(db, id, 'f1');
    iss = getIssue(db, id)!;
    expect(iss.photos.map((p: any) => p.fileId)).toEqual(['f2']);
  });

  it('addPhoto throws for an unknown issue and is idempotent on duplicate fileId', () => {
    expect(() => addPhoto(db, 'nope', 'f1')).toThrow(NotFoundError);
    const { id } = createIssue(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    addPhoto(db, id, 'f1'); // duplicate ignored
    expect(getIssue(db, id)!.photos).toHaveLength(1);
  });

  it('markIssueSent sets sentAt + status sent', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    markIssueSent(db, id);
    const iss = getIssue(db, id)!;
    expect(iss.status).toBe('sent');
    expect(typeof iss.sentAt).toBe('number');
  });

  // updatedAt is the clock the generated-PDF "up to date" chip compares the
  // stored file against, so re-sending must not stamp it — the send would
  // otherwise stale the very PDF it just mailed, permanently.
  it('markIssueSent refreshes sentAt but leaves updatedAt/version alone on a re-send', async () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    const created = getIssue(db, id) as any;
    await new Promise(r => setTimeout(r, 2));

    markIssueSent(db, id);
    const firstSend = getIssue(db, id) as any;
    expect(firstSend.updatedAt).toBeGreaterThan(created.updatedAt); // first send is a real transition
    await new Promise(r => setTimeout(r, 2));

    markIssueSent(db, id);
    const resent = getIssue(db, id) as any;
    expect(resent.updatedAt).toBe(firstSend.updatedAt);
    expect(resent.version).toBe(firstSend.version);
    expect(resent.sentAt).toBeGreaterThan(firstSend.sentAt);
  });

  it('countOpenIssues counts only open issues for a project', () => {
    const a = createIssue(db, 'p1', { title: 'A' });
    createIssue(db, 'p1', { title: 'B' });
    setIssueStatus(db, a.id, 'resolved');
    expect(countOpenIssues(db, 'p1')).toBe(1);
    expect(countOpenIssues(db, 'p2')).toBe(0);
  });

  it('saveIssue and addPhoto bump updatedAt', async () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    const before = (getIssue(db, id) as any).updatedAt;
    expect(typeof before).toBe('number');
    await new Promise(r => setTimeout(r, 2));
    saveIssue(db, id, { title: 'A2', description: 'second', version: 1 });
    const afterSave = (getIssue(db, id) as any).updatedAt;
    expect(afterSave).toBeGreaterThan(before);
    await new Promise(r => setTimeout(r, 2));
    addPhoto(db, id, 'f1');
    expect((getIssue(db, id) as any).updatedAt).toBeGreaterThan(afterSave);
  });
});

// PDF attachments: same contract as the invoice's, but with this issue's photo
// freshness rule — updatedAt moves, version does not.
describe('attachments', () => {
  const pdfFile = (id: string) => putBuffer(db, dir, id, Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'document', name: `${id}.pdf` });
  const stale = (id: string) => db.prepare('UPDATE issues SET updatedAt = 1 WHERE id = ?').run(id);

  it('only an existing PDF can be attached, to an existing issue', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    putBuffer(db, dir, 'img', Buffer.from('x'), 'image/jpeg', { projectId: 'p1', kind: 'issue-photo', name: 'img.jpg' });
    expect(() => addAttachment(db, id, 'img')).toThrow(ValidationError);
    expect(() => addAttachment(db, id, 'missing')).toThrow(NotFoundError);
    expect(() => addAttachment(db, id, '')).toThrow(ValidationError);
    pdfFile('a1');
    expect(() => addAttachment(db, 'nope', 'a1')).toThrow(NotFoundError);
    expect(getIssue(db, id)!.attachments).toEqual([]);
  });

  it('adds idempotently in order, reorders, removes — stamping updatedAt but never version', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    pdfFile('a1'); pdfFile('a2');
    stale(id);
    addAttachment(db, id, 'a1');
    addAttachment(db, id, 'a1'); // idempotent
    addAttachment(db, id, 'a2');
    let iss = getIssue(db, id)!;
    expect(iss.attachments).toEqual([
      expect.objectContaining({ fileId: 'a1', sortOrder: 0, name: 'a1.pdf', mime: 'application/pdf' }),
      expect.objectContaining({ fileId: 'a2', sortOrder: 1, name: 'a2.pdf', mime: 'application/pdf' }),
    ]);
    expect(iss.updatedAt).toBeGreaterThan(1);
    expect(iss.version).toBe(1);

    stale(id);
    updateAttachment(db, id, 'a1', { sortOrder: 5 });
    iss = getIssue(db, id)!;
    expect(iss.attachments.map((a: any) => a.fileId)).toEqual(['a2', 'a1']);
    expect(iss.updatedAt).toBeGreaterThan(1);
    expect(iss.version).toBe(1);
    expect(() => updateAttachment(db, id, 'nope', { sortOrder: 0 })).toThrow(NotFoundError);

    stale(id);
    removeAttachment(db, id, 'a1');
    iss = getIssue(db, id)!;
    expect(iss.attachments.map((a: any) => a.fileId)).toEqual(['a2']);
    expect(iss.updatedAt).toBeGreaterThan(1);
    expect(iss.version).toBe(1);
  });

  it('deleteIssue removes its attachment links', () => {
    const { id } = createIssue(db, 'p1', { title: 'A' });
    pdfFile('a1');
    addAttachment(db, id, 'a1');
    deleteIssue(db, id);
    expect((db.prepare('SELECT COUNT(*) c FROM issue_attachments WHERE issueId = ?').get(id) as any).c).toBe(0);
  });
});
