import { describe, it, expect, beforeEach } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { registerDataRoutes } from './routes';
import {
  putDataUrl, putBuffer, getMeta, getDataUrlString, removeFile, saveNewVersion, listVersions,
  setFileFlags, isDirectUploadKind, DIRECT_UPLOAD_KINDS, SYSTEM_KINDS, MULTI_INSTANCE_KINDS,
  replaceLiveContent,
} from './files';
import { readFileContent } from './fileStore';

let db: Database.Database;
let dir: string;
let app: express.Express;

const buildApp = (role: 'admin' | 'user' = 'admin', userId = 'u1') => {
  const a = express();
  a.use(express.json({ limit: '50mb' }));
  registerDataRoutes(a, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    authenticateToken: (req: any, _res: any, next: any) => { req.user = { id: userId, role }; next(); },
    requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
    verifyToken: () => null,
    broadcastChange: () => {},
  });
  return a;
};

// Uploads through the real POST /api/files/:id path so tests exercise the
// same code that production upload/generate call sites use.
const upload = async (
  id: string,
  opts: { projectId?: string; kind?: string; name?: string; customerId?: string; sourceType?: string; sourceId?: string; mode?: string } = {},
  body = 'x'
) => {
  const qs = Object.entries(opts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  const res = await request(app).post(`/api/files/${id}${qs ? `?${qs}` : ''}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from(body));
  expect(res.status).toBe(200);
  return res.body.fileId as string;
};

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-files-'));
  db = openDb(':memory:');
  // Full schema: the files layer reads the source-attribution columns added in
  // migration 23, which the app always has by the time it serves a request.
  runMigrations(db, dir, migrations);
  app = buildApp('admin');
});

const PNG_DATAURL = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');

describe('files layer', () => {
  it('putDataUrl stores content on disk and metadata in db', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    const meta = getMeta(db, 'img1')!;
    expect(meta.mime).toBe('image/png');
    expect(meta.size).toBe(7);
    expect(meta.kind).toBe('other');
    expect(readFileContent(dir, 'img1')!.toString()).toBe('fakepng');
  });

  it('getDataUrlString round-trips byte-identically', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    expect(getDataUrlString(db, dir, 'img1')).toBe(PNG_DATAURL);
  });

  it('putBuffer reproduces the dataURL the old raw-upload path built', () => {
    putBuffer(db, dir, 'pdf1', Buffer.from('fakepdf'), 'application/pdf');
    // legacy POST /api/files/:id built: data:<mime>;base64,<b64> (server.ts:653)
    expect(getDataUrlString(db, dir, 'pdf1'))
      .toBe('data:application/pdf;base64,' + Buffer.from('fakepdf').toString('base64'));
  });

  it('overwriting an id replaces content and mime', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    putBuffer(db, dir, 'img1', Buffer.from('newcontent'), 'image/jpeg');
    expect(getMeta(db, 'img1')!.mime).toBe('image/jpeg');
    expect(readFileContent(dir, 'img1')!.toString()).toBe('newcontent');
  });

  it('preserves projectId/kind/name labels across overwrite', () => {
    putBuffer(db, dir, 'img1', Buffer.from('a'), 'image/png', { projectId: 'p1', kind: 'plan', name: 'Sheet A1' });
    putBuffer(db, dir, 'img1', Buffer.from('b'), 'image/png');
    const meta = getMeta(db, 'img1')!;
    expect(meta.projectId).toBe('p1');
    expect(meta.kind).toBe('plan');
    expect(meta.name).toBe('Sheet A1');
  });

  it('removeFile deletes row and disk content', () => {
    putDataUrl(db, dir, 'img1', PNG_DATAURL);
    removeFile(db, dir, 'img1');
    expect(getMeta(db, 'img1')).toBeNull();
    expect(readFileContent(dir, 'img1')).toBeNull();
  });

  it('returns null for unknown ids', () => {
    expect(getMeta(db, 'nope')).toBeNull();
    expect(getDataUrlString(db, dir, 'nope')).toBeNull();
  });

  it('round-trips dataURLs with extra parameters byte-identically', () => {
    const url = 'data:text/plain;charset=utf-8;base64,' + Buffer.from('hello').toString('base64');
    putDataUrl(db, dir, 'txt1', url);
    expect(getDataUrlString(db, dir, 'txt1')).toBe(url);
    expect(getMeta(db, 'txt1')!.mime).toBe('text/plain');
  });

  it('preserves parentFileId/versionNumber/createdAt across overwrite', () => {
    putBuffer(db, dir, 'img1', Buffer.from('a'), 'image/png');
    db.prepare('UPDATE files SET parentFileId = ?, versionNumber = ?, createdAt = ? WHERE id = ?')
      .run('parent1', 3, 12345, 'img1');
    putBuffer(db, dir, 'img1', Buffer.from('b'), 'image/png');
    const meta = getMeta(db, 'img1')!;
    expect(meta.parentFileId).toBe('parent1');
    expect(meta.versionNumber).toBe(3);
    expect(meta.createdAt).toBe(12345);
  });
});

describe('file versioning', () => {
  it('archives old content to a version row and overwrites in place', () => {
    putBuffer(db, dir, 'f1', Buffer.from('v1-bytes'), 'application/pdf', { projectId: 'p1', kind: 'printout', name: 'Bid.pdf' });
    const r1 = saveNewVersion(db, dir, 'f1', Buffer.from('v2-bytes'), 'application/pdf');
    expect(r1.versionNumber).toBe(2);

    // live row: same id, new content, bumped version, labels intact
    const live = getMeta(db, 'f1')!;
    expect(live.versionNumber).toBe(2);
    expect(live.projectId).toBe('p1');
    expect(live.name).toBe('Bid.pdf');
    expect(readFileContent(dir, 'f1')!.toString()).toBe('v2-bytes');

    // archived row: old content, parent points at the original
    const archived = getMeta(db, r1.archivedVersionId)!;
    expect(archived.parentFileId).toBe('f1');
    expect(archived.versionNumber).toBe(1);
    expect(readFileContent(dir, r1.archivedVersionId)!.toString()).toBe('v1-bytes');
  });

  it('listVersions returns live row first then history newest-first', () => {
    putBuffer(db, dir, 'f1', Buffer.from('v1'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v2'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v3'), 'application/pdf');
    const versions = listVersions(db, 'f1');
    expect(versions[0].id).toBe('f1');
    expect(versions[0].versionNumber).toBe(3);
    expect(versions.slice(1).map(v => v.versionNumber)).toEqual([2, 1]);
  });

  it('throws for unknown files', () => {
    expect(() => saveNewVersion(db, dir, 'nope', Buffer.from('x'), 'text/plain')).toThrow();
  });

  it('keeps versionNumbers unique across live and history after several saves', () => {
    putBuffer(db, dir, 'f1', Buffer.from('v1'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v2'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v3'), 'application/pdf');
    const nums = listVersions(db, 'f1').map(v => v.versionNumber).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3]);
    expect(new Set(nums).size).toBe(nums.length);
  });
});

describe('version authors (createdBy)', () => {
  it('records the uploader, and each version keeps its own author', async () => {
    app = buildApp('admin', 'alice');
    const id = await upload('doc-a', { projectId: 'p1', kind: 'document', name: 'Scope.docx' }, 'v1');
    expect(getMeta(db, id)!.createdBy).toBe('alice');

    app = buildApp('user', 'bob');
    const r = await request(app).post(`/api/files/${id}/versions`).set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    expect(r.status).toBe(200);
    const [live, v1] = listVersions(db, id);
    expect(live.createdBy).toBe('bob');
    expect(v1.createdBy).toBe('alice');
  });

  it('a regenerate (upsert-by-source) stamps the regenerating user on the new version', async () => {
    app = buildApp('admin', 'alice');
    const id = await upload('inv-1', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'i1' }, 'first');
    app = buildApp('admin', 'carol');
    expect(await upload('inv-2', { projectId: 'p1', kind: 'invoice', sourceType: 'invoice', sourceId: 'i1' }, 'second')).toBe(id);
    const [live, v1] = listVersions(db, id);
    expect(live.createdBy).toBe('carol');
    expect(v1.createdBy).toBe('alice');
  });

  it('a version saved with no known author is not credited to the previous one', () => {
    putBuffer(db, dir, 'f1', Buffer.from('v1'), 'application/pdf', { createdBy: 'alice' });
    saveNewVersion(db, dir, 'f1', Buffer.from('v2'), 'application/pdf');
    expect(getMeta(db, 'f1')!.createdBy).toBeNull();
  });
});

describe('version origin', () => {
  it('stamps editor saves and restores, resets on a plain upload, and archived versions keep theirs', async () => {
    putBuffer(db, dir, 'f1', Buffer.from('generated'), 'application/pdf', { createdBy: 'alice' });
    expect(getMeta(db, 'f1')!.versionOrigin).toBeNull();
    saveNewVersion(db, dir, 'f1', Buffer.from('edited'), 'application/pdf', 'bob', 'editor');
    expect(getMeta(db, 'f1')!.versionOrigin).toBe('editor');
    replaceLiveContent(db, dir, 'f1', Buffer.from('edited more'), 'application/pdf', 'bob', 'editor');
    saveNewVersion(db, dir, 'f1', Buffer.from('regenerated'), 'application/pdf', 'alice');
    const [live, v2, v1] = listVersions(db, 'f1');
    expect(live.versionOrigin).toBeNull();
    expect(v2).toMatchObject({ versionNumber: 2, versionOrigin: 'editor', createdBy: 'bob' });
    expect(v1).toMatchObject({ versionNumber: 1, versionOrigin: null, createdBy: 'alice' });
  });
});

describe('removeFile and the editor change log', () => {
  const addChanges = (fileId: string, versionNumber: number) =>
    db.prepare(`INSERT INTO editor_changes (fileId, versionNumber, changesJson, createdAt) VALUES (?, ?, '[]', 1)`).run(fileId, versionNumber);
  const changeVersions = (fileId: string) =>
    (db.prepare('SELECT versionNumber FROM editor_changes WHERE fileId = ? ORDER BY versionNumber').all(fileId) as { versionNumber: number }[]).map(r => r.versionNumber);

  it('deleting an archived version drops only its log; deleting the live row drops them all', () => {
    putBuffer(db, dir, 'f1', Buffer.from('v1'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v2'), 'application/pdf');
    saveNewVersion(db, dir, 'f1', Buffer.from('v3'), 'application/pdf');
    addChanges('f1', 2); addChanges('f1', 3);
    const v2 = listVersions(db, 'f1').find(v => v.versionNumber === 2)!;
    removeFile(db, dir, v2.id);
    expect(changeVersions('f1')).toEqual([3]);
    removeFile(db, dir, 'f1');
    expect(changeVersions('f1')).toEqual([]);
  });
});

describe('DELETE /api/files/:id/versions/:versionId', () => {
  const setup = async () => {
    app = buildApp('admin', 'alice');
    const id = await upload('doc-a', { projectId: 'p1', kind: 'document', name: 'Scope.docx' }, 'v1'); // by alice
    app = buildApp('user', 'bob');
    await request(app).post(`/api/files/${id}/versions`).set('Content-Type', 'application/pdf').send(Buffer.from('v2')); // by bob
    await request(app).post(`/api/files/${id}/versions`).set('Content-Type', 'application/pdf').send(Buffer.from('v3')); // by bob
    const [, v2, v1] = listVersions(db, id);
    return { id, v1, v2 };
  };
  const del = (id: string, versionId: string) => request(app).delete(`/api/files/${id}/versions/${versionId}`);

  it('lets the version\'s author delete it, bytes and all', async () => {
    const { id, v2 } = await setup();
    app = buildApp('user', 'bob');
    expect((await del(id, v2.id)).status).toBe(200);
    expect(listVersions(db, id).map(v => v.versionNumber)).toEqual([3, 1]);
    expect(readFileContent(dir, v2.id)).toBeNull();
  });

  it('refuses anyone else who is not an admin', async () => {
    const { id, v1 } = await setup();
    app = buildApp('user', 'bob');
    expect((await del(id, v1.id)).status).toBe(403);
    expect(listVersions(db, id)).toHaveLength(3);
  });

  it('lets an admin delete any version, including ones with no recorded author', async () => {
    const { id, v1, v2 } = await setup();
    db.prepare('UPDATE files SET createdBy = NULL WHERE id = ?').run(v1.id);
    app = buildApp('user', 'bob');
    expect((await del(id, v1.id)).status).toBe(403);
    app = buildApp('admin', 'carol');
    expect((await del(id, v1.id)).status).toBe(200);
    expect((await del(id, v2.id)).status).toBe(200);
    expect(listVersions(db, id).map(v => v.versionNumber)).toEqual([3]);
  });

  it('never deletes the live version, or a version of another file', async () => {
    const { id, v1 } = await setup();
    const other = await upload('doc-b', { projectId: 'p1', kind: 'document', name: 'Other.docx' }, 'b');
    app = buildApp('admin', 'carol');
    expect((await del(id, id)).status).toBe(404);
    expect((await del(other, v1.id)).status).toBe(404);
    expect(getMeta(db, id)).not.toBeNull();
    expect(getMeta(db, v1.id)).not.toBeNull();
  });
});

describe('replaceLiveContent', () => {
  it('swaps the live bytes in place: same version number, history kept, size and hash updated', () => {
    putBuffer(db, dir, 'f1', Buffer.from('v1'), 'application/pdf', { name: 'Bid.pdf', createdBy: 'alice' });
    saveNewVersion(db, dir, 'f1', Buffer.from('v2'), 'application/pdf', 'bob');
    const before = getMeta(db, 'f1')!;
    const after = replaceLiveContent(db, dir, 'f1', Buffer.from('v2 with more edits'), 'application/pdf', 'carol');
    expect(after.versionNumber).toBe(before.versionNumber);
    expect(after.size).toBe('v2 with more edits'.length);
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.createdBy).toBe('carol');
    expect(after.name).toBe('Bid.pdf');
    expect(readFileContent(dir, 'f1')!.toString()).toBe('v2 with more edits');
    expect(listVersions(db, 'f1').map(v => v.versionNumber)).toEqual([2, 1]);
  });

  it('throws for unknown files', () => {
    expect(() => replaceLiveContent(db, dir, 'nope', Buffer.from('x'), 'text/plain')).toThrow();
  });
});

describe('upload metadata', () => {
  it('persists customerId/sourceType/sourceId and defaults archived to 0', () => {
    putBuffer(db, dir, 'f1', Buffer.from('a'), 'application/pdf', {
      projectId: 'p1', customerId: 'c1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-1', name: 'Invoice 12.pdf',
    });
    const meta = getMeta(db, 'f1')!;
    expect(meta).toMatchObject({
      projectId: 'p1', customerId: 'c1', kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-1', archived: 0,
    });
  });

  it('carries the new columns across a plain overwrite', () => {
    putBuffer(db, dir, 'f1', Buffer.from('a'), 'application/pdf', { customerId: 'c1', sourceType: 'issue', sourceId: 'i1', kind: 'issue-report' });
    db.prepare('UPDATE files SET archived = 1 WHERE id = ?').run('f1');
    putBuffer(db, dir, 'f1', Buffer.from('b'), 'application/pdf');
    expect(getMeta(db, 'f1')).toMatchObject({ customerId: 'c1', sourceType: 'issue', sourceId: 'i1', archived: 1 });
  });

  it('setFileFlags archives and re-types a file, and ignores unknown ids', () => {
    putBuffer(db, dir, 'f1', Buffer.from('a'), 'application/pdf', { kind: 'document' });
    expect(setFileFlags(db, 'f1', { archived: true })!.archived).toBe(1);
    expect(setFileFlags(db, 'f1', { kind: 'custom:permits' })!.kind).toBe('custom:permits');
    expect(setFileFlags(db, 'f1', { archived: false })!.archived).toBe(0);
    expect(setFileFlags(db, 'nope', { archived: true })).toBeNull();
  });

  it('classifies direct-upload kinds (custom types included) apart from system kinds', () => {
    for (const k of DIRECT_UPLOAD_KINDS) expect(isDirectUploadKind(k)).toBe(true);
    expect(isDirectUploadKind('custom:permits')).toBe(true);
    for (const k of SYSTEM_KINDS) expect(isDirectUploadKind(k)).toBe(false);
  });
});

describe('upsert-by-source uploads', () => {
  const SOURCE = { kind: 'invoice', sourceType: 'invoice', sourceId: 'inv-1', projectId: 'p1' };

  it('versions the existing live row instead of creating a second document', () => {
    const first = putBuffer(db, dir, 'gen1', Buffer.from('v1-bytes'), 'application/pdf', { ...SOURCE, name: 'Invoice 12.pdf' });
    expect(first).toMatchObject({ id: 'gen1', versioned: false, versionNumber: 1 });

    // a regenerate mints a fresh id client-side — it must land on the same document
    const second = putBuffer(db, dir, 'gen2', Buffer.from('v2-bytes'), 'application/pdf', { ...SOURCE, name: 'Invoice 12.pdf' });
    expect(second.id).toBe('gen1');
    expect(second.versioned).toBe(true);
    expect(second.versionNumber).toBe(2);

    expect(getMeta(db, 'gen2')).toBeNull(); // no stray row for the requested id
    expect(readFileContent(dir, 'gen1')!.toString()).toBe('v2-bytes');

    const versions = listVersions(db, 'gen1');
    expect(versions.map(v => v.versionNumber)).toEqual([2, 1]);
    expect(readFileContent(dir, versions[1].id)!.toString()).toBe('v1-bytes');
  });

  it('keeps versioning the live row, never an archived version row', () => {
    putBuffer(db, dir, 'gen1', Buffer.from('v1'), 'application/pdf', SOURCE);
    putBuffer(db, dir, 'gen2', Buffer.from('v2'), 'application/pdf', SOURCE);
    const third = putBuffer(db, dir, 'gen3', Buffer.from('v3'), 'application/pdf', SOURCE);
    expect(third.id).toBe('gen1');
    expect(third.versionNumber).toBe(3);
    // one live row for the source, the rest are history hanging off it
    const live = db.prepare(
      'SELECT id FROM files WHERE parentFileId IS NULL AND sourceType = ? AND sourceId = ?'
    ).all('invoice', 'inv-1') as { id: string }[];
    expect(live.map(r => r.id)).toEqual(['gen1']);
    expect(listVersions(db, 'gen1').map(v => v.versionNumber)).toEqual([3, 2, 1]);
  });

  it('refreshes the live row labels a regenerate carries', () => {
    putBuffer(db, dir, 'gen1', Buffer.from('v1'), 'application/pdf', { ...SOURCE, name: 'Invoice 12.pdf' });
    putBuffer(db, dir, 'gen2', Buffer.from('v2'), 'application/pdf', { ...SOURCE, name: 'Invoice 12 (revised).pdf', customerId: 'c1' });
    expect(getMeta(db, 'gen1')).toMatchObject({ name: 'Invoice 12 (revised).pdf', customerId: 'c1', projectId: 'p1' });
  });

  it('does not collide across kinds on the same entity', () => {
    // two single-instance documents hanging off one RFI
    putBuffer(db, dir, 'rfi-pdf', Buffer.from('pdf'), 'application/pdf', { kind: 'rfi', sourceType: 'rfi', sourceId: 'rfi-1' });
    const response = putBuffer(db, dir, 'rfi-resp', Buffer.from('resp'), 'application/pdf', { kind: 'rfi-response', sourceType: 'rfi', sourceId: 'rfi-1' });
    expect(response).toMatchObject({ id: 'rfi-resp', versioned: false });
    expect(getMeta(db, 'rfi-pdf')!.versionNumber).toBe(1);
  });

  it('never versions daily-report photos onto each other — a 5-photo upload yields 5 distinct rows, not 1', () => {
    const SOURCE_DR = { kind: 'daily-report-photo', sourceType: 'dailyReport', sourceId: 'dr-1' };
    const first = putBuffer(db, dir, 'drp1', Buffer.from('photo-1'), 'image/jpeg', SOURCE_DR);
    const second = putBuffer(db, dir, 'drp2', Buffer.from('photo-2'), 'image/jpeg', SOURCE_DR);
    expect(first).toMatchObject({ id: 'drp1', versioned: false });
    expect(second).toMatchObject({ id: 'drp2', versioned: false }); // not versioned onto drp1

    const live = db.prepare(
      'SELECT id FROM files WHERE parentFileId IS NULL AND sourceType = ? AND sourceId = ? ORDER BY id'
    ).all('dailyReport', 'dr-1') as { id: string }[];
    expect(live.map(r => r.id)).toEqual(['drp1', 'drp2']);
    expect(readFileContent(dir, 'drp1')!.toString()).toBe('photo-1');
    expect(readFileContent(dir, 'drp2')!.toString()).toBe('photo-2');
  });

  it('never versions payment attachments onto each other — a check photo then a remittance PDF are two documents', () => {
    const SOURCE_PAY = { kind: 'payment-attachment', sourceType: 'payment', sourceId: 'pay-1', projectId: 'p1' };
    const photo = putBuffer(db, dir, 'chk', Buffer.from('check'), 'image/jpeg', { ...SOURCE_PAY, name: 'Check.jpg' });
    const pdf = putBuffer(db, dir, 'remit', Buffer.from('%PDF'), 'application/pdf', { ...SOURCE_PAY, name: 'Remittance.pdf' });
    expect(photo).toMatchObject({ id: 'chk', versioned: false });
    expect(pdf).toMatchObject({ id: 'remit', versioned: false });
    expect(getMeta(db, 'chk')).toMatchObject({ mime: 'image/jpeg', name: 'Check.jpg', versionNumber: 1 });
  });

  it('never versions a multi-instance kind — an entity has many photos', () => {
    const first = putBuffer(db, dir, 'ph1', Buffer.from('photo-a'), 'image/jpeg', { kind: 'issue-photo', sourceType: 'issue', sourceId: 'issue-1' });
    const second = putBuffer(db, dir, 'ph2', Buffer.from('photo-b'), 'image/jpeg', { kind: 'issue-photo', sourceType: 'issue', sourceId: 'issue-1' });
    expect(first).toMatchObject({ id: 'ph1', versioned: false, versionNumber: 1 });
    expect(second).toMatchObject({ id: 'ph2', versioned: false, versionNumber: 1 });

    // both survive as live rows with their own bytes — neither became history
    const live = db.prepare(
      'SELECT id FROM files WHERE parentFileId IS NULL AND sourceType = ? AND sourceId = ? ORDER BY id'
    ).all('issue', 'issue-1') as { id: string }[];
    expect(live.map(r => r.id)).toEqual(['ph1', 'ph2']);
    expect(readFileContent(dir, 'ph1')!.toString()).toBe('photo-a');
    expect(readFileContent(dir, 'ph2')!.toString()).toBe('photo-b');
  });

  it('never versions one plan-set PDF onto another', () => {
    const SET = { kind: 'plan-source', sourceType: 'plan-set', sourceId: 'ps1', projectId: 'p1' };
    const first = putBuffer(db, dir, 'pdf-a', Buffer.from('arch-set'), 'application/pdf', { ...SET, name: 'Architectural.pdf' });
    const second = putBuffer(db, dir, 'pdf-b', Buffer.from('struct-set'), 'application/pdf', { ...SET, name: 'Structural.pdf' });
    expect(first).toMatchObject({ id: 'pdf-a', versioned: false });
    expect(second).toMatchObject({ id: 'pdf-b', versioned: false });

    // both keep their own id and bytes — the pages split out of each PDF go on
    // rendering the PDF they came from
    expect(readFileContent(dir, 'pdf-a')!.toString()).toBe('arch-set');
    expect(readFileContent(dir, 'pdf-b')!.toString()).toBe('struct-set');
    const live = db.prepare(
      'SELECT id FROM files WHERE parentFileId IS NULL AND sourceType = ? AND sourceId = ? ORDER BY id'
    ).all('plan-set', 'ps1') as { id: string }[];
    expect(live.map(r => r.id)).toEqual(['pdf-a', 'pdf-b']);
  });

  it('excludes every multi-instance kind, on any entity', () => {
    for (const kind of MULTI_INSTANCE_KINDS) {
      putBuffer(db, dir, `${kind}-1`, Buffer.from('a'), 'image/jpeg', { kind, sourceType: 'e', sourceId: 'e-1' });
      const second = putBuffer(db, dir, `${kind}-2`, Buffer.from('b'), 'image/jpeg', { kind, sourceType: 'e', sourceId: 'e-1' });
      expect(second, `${kind} must not upsert`).toMatchObject({ id: `${kind}-2`, versioned: false });
    }
  });

  // One email holds many peer attachments and the save modal ALWAYS sends a
  // user-picked kind ('document', 'photo', custom:*) — none of which are
  // multi-instance — so the second attachment used to land as a VERSION of the
  // first. The mailMessage source link is provenance, not identity.
  it('never upserts a mailMessage source, whatever kind was picked', () => {
    for (const kind of ['document', 'photo', 'spreadsheet', 'other', 'custom:abc', 'email-attachment']) {
      const src = { kind, sourceType: 'mailMessage', sourceId: 'msg-1' };
      putBuffer(db, dir, `${kind}-1`, Buffer.from('a'), 'application/pdf', src);
      const second = putBuffer(db, dir, `${kind}-2`, Buffer.from('b'), 'image/jpeg', src);
      expect(second, `${kind} must not upsert`).toMatchObject({ id: `${kind}-2`, versioned: false, versionNumber: 1 });
    }
    // Every one is its own live document; nothing was archived as history.
    expect(db.prepare('SELECT COUNT(*) c FROM files WHERE parentFileId IS NOT NULL').get()).toEqual({ c: 0 });
    expect((db.prepare(
      "SELECT COUNT(*) c FROM files WHERE sourceType = 'mailMessage' AND sourceId = 'msg-1' AND parentFileId IS NULL"
    ).get() as { c: number }).c).toBe(12);
  });

  it('un-archives the document it versions', () => {
    putBuffer(db, dir, 'gen1', Buffer.from('v1'), 'application/pdf', SOURCE);
    setFileFlags(db, 'gen1', { archived: true });
    const regenerated = putBuffer(db, dir, 'gen2', Buffer.from('v2'), 'application/pdf', SOURCE);
    expect(regenerated).toMatchObject({ id: 'gen1', versioned: true, archived: 0 });
  });

  it('does not collide across entities of the same kind', () => {
    putBuffer(db, dir, 'p-a', Buffer.from('a'), 'application/pdf', { kind: 'printout', sourceType: 'printout', sourceId: 'po1' });
    const b = putBuffer(db, dir, 'p-b', Buffer.from('b'), 'application/pdf', { kind: 'printout', sourceType: 'printout', sourceId: 'po2' });
    expect(b).toMatchObject({ id: 'p-b', versioned: false });
  });

  it('creates normally when the source triple is incomplete', () => {
    putBuffer(db, dir, 'u1', Buffer.from('a'), 'application/pdf', { kind: 'document', sourceType: 'invoice' });
    const second = putBuffer(db, dir, 'u2', Buffer.from('b'), 'application/pdf', { kind: 'document', sourceType: 'invoice' });
    expect(second).toMatchObject({ id: 'u2', versioned: false });
    expect(getMeta(db, 'u1')!.versionNumber).toBe(1);
  });

  it('applies to putDataUrl too, preserving the stored string format', () => {
    const RESPONSE = { kind: 'rfi-response', sourceType: 'rfi', sourceId: 'rfi-1' };
    const first = putDataUrl(db, dir, 'doc1', PNG_DATAURL, RESPONSE);
    expect(first.versioned).toBe(false);
    const next = 'data:image/png;base64,' + Buffer.from('secondpng').toString('base64');
    const second = putDataUrl(db, dir, 'doc2', next, RESPONSE);
    expect(second).toMatchObject({ id: 'doc1', versioned: true, versionNumber: 2 });
    expect(getDataUrlString(db, dir, 'doc1')).toBe(next);
  });

  it('replays a non-canonical stored format through a version', () => {
    // saveNewVersion stamps 'dataurl' on the way through, so the formats that
    // are NOT a canonical dataURL are the ones the replay exists to protect.
    const RESPONSE = { kind: 'rfi-response', sourceType: 'rfi', sourceId: 'rfi-1' };
    const bare = Buffer.from('bare-base64-payload').toString('base64');
    putDataUrl(db, dir, 'doc1', bare, RESPONSE);
    expect(getMeta(db, 'doc1')!.legacyFormat).toBe('base64');

    const nextBare = Buffer.from('second-bare-payload').toString('base64');
    expect(putDataUrl(db, dir, 'doc2', nextBare, RESPONSE)).toMatchObject({ id: 'doc1', versioned: true });
    expect(getDataUrlString(db, dir, 'doc1')).toBe(nextBare); // no data: prefix bolted on

    // and a dataURL carrying extra parameters replays verbatim too
    const verbatim = 'data:text/plain;charset=utf-8;base64,' + Buffer.from('hello').toString('base64');
    expect(putDataUrl(db, dir, 'doc3', verbatim, RESPONSE)).toMatchObject({ id: 'doc1', versioned: true });
    expect(getDataUrlString(db, dir, 'doc1')).toBe(verbatim);
  });
});

describe('regenerating', () => {
  it('always makes a new version, even when an old client still asks to overwrite', async () => {
    const id = await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v1');
    const res = await request(app).post(`/api/files/zzz?projectId=p1&kind=invoice&name=a&sourceType=invoice&sourceId=inv-1&mode=overwrite`)
      .set('Content-Type', 'application/pdf').send(Buffer.from('v2'));
    expect(res.body).toMatchObject({ fileId: id, versioned: true });
    expect(getMeta(db, id)!.versionNumber).toBe(2);
    expect(readFileContent(dir, id)!.toString()).toBe('v2');
    const archived = db.prepare('SELECT id FROM files WHERE parentFileId = ?').all(id) as { id: string }[];
    expect(archived).toHaveLength(1);
    expect(readFileContent(dir, archived[0].id)!.toString()).toBe('v1');
  });

  it('an archived version keeps the date its bytes were made, not the date it was archived', async () => {
    const id = await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v1');
    db.prepare('UPDATE files SET createdAt = 1000 WHERE id = ?').run(id);
    await upload('f2', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v2');
    const archived = db.prepare('SELECT createdAt FROM files WHERE parentFileId = ?').get(id) as { createdAt: number };
    expect(archived.createdAt).toBe(1000);
    expect(getMeta(db, id)!.createdAt).toBeGreaterThan(1000);
  });

  it('clears a leftover old-editor draft for the file', async () => {
    const id = await upload('f1', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v1');
    db.prepare(`INSERT INTO drafts (userId, fileId, kind, data, updatedAt) VALUES ('u1', ?, 'pdf', '{}', 1)`).run(id);
    await upload('f2', { projectId: 'p1', kind: 'invoice', name: 'a', sourceType: 'invoice', sourceId: 'inv-1' }, 'v2');
    expect(db.prepare('SELECT COUNT(*) c FROM drafts WHERE fileId = ?').get(id)).toEqual({ c: 0 });
  });
});
