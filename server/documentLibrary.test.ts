// The document library (ONLYOFFICE Phase 3): new documents from the bundled
// blanks or a template, templates and company stamps (admins manage, everyone
// uses), and signatures (each person's own). Driven through the real routes.
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
import { getMeta, listVersions, putBuffer, saveNewVersion } from './files';
import { readFileContent } from './fileStore';
import { removeUserSignatures } from './documentLibrary';
import { MEDIA_COOKIE } from './auth';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let db: Database.Database;
let dir: string;

const users = {
  admin: { id: 'u-admin', role: 'admin' },
  crew: { id: 'u-crew', role: 'user' },
  other: { id: 'u-other', role: 'user' },
} as const;

const as = (who: keyof typeof users, tokenUser: { id: string } | null = users[who]) => {
  const a = express();
  a.use(express.json({ limit: '50mb' }));
  registerDataRoutes(a, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    authenticateToken: (req: any, _res: any, next: any) => { req.user = users[who]; next(); },
    requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
    verifyToken: () => tokenUser,
    broadcastChange: () => {},
  });
  return a;
};

const bytesOf = (id: string) => readFileContent(dir, id)!;
const blank = (ext: string) => fsSync.readFileSync(path.join(__dirname, 'documentLibrary', 'blank', `new.${ext}`));

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-library-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Maple', 1);
  db.prepare('UPDATE projects SET customerId = ? WHERE id = ?').run('c1', 'p1');
});

describe('POST /api/documents/new', () => {
  const create = (body: Record<string, unknown>, who: keyof typeof users = 'crew') =>
    request(as(who)).post('/api/documents/new').send(body);

  it('makes a blank Word, Excel or PDF form in the project, named with its extension', async () => {
    for (const [type, mime] of [['docx', DOCX], ['xlsx', XLSX], ['pdf', 'application/pdf']] as const) {
      const r = await create({ type, name: 'Site letter', projectId: 'p1', kind: 'document' });
      expect(r.status).toBe(200);
      const meta = getMeta(db, r.body.fileId)!;
      expect(meta).toMatchObject({ name: `Site letter.${type}`, mime, projectId: 'p1', customerId: 'c1', kind: 'document', createdBy: 'u-crew', versionNumber: 1 });
      expect(bytesOf(meta.id).equals(blank(type))).toBe(true);
    }
  });

  it('starts from a template of the same type', async () => {
    putBuffer(db, dir, 'tpl', Buffer.from('letterhead bytes'), DOCX, { kind: 'document-template', name: 'Letterhead.docx' });
    saveNewVersion(db, dir, 'tpl', Buffer.from('letterhead v2'), DOCX);
    const r = await create({ type: 'docx', templateId: 'tpl', name: 'Proposal', projectId: 'p1' });
    expect(r.status).toBe(200);
    expect(bytesOf(r.body.fileId).toString()).toBe('letterhead v2');
    expect(r.body.name).toBe('Proposal.docx');
    expect((await create({ type: 'xlsx', templateId: 'tpl', projectId: 'p1' })).body.code).toBe('template-type');
    expect((await create({ type: 'docx', templateId: 'gone', projectId: 'p1' })).status).toBe(404);
  });

  it('needs a real project, except for company documents', async () => {
    expect((await create({ type: 'docx', name: 'x' })).body.code).toBe('no-project');
    expect((await create({ type: 'docx', name: 'x', projectId: 'nope' })).body.code).toBe('no-project');
    const company = await create({ type: 'docx', name: 'Safety policy', kind: 'company-document', projectId: 'p1' });
    expect(company.status).toBe(200);
    expect(getMeta(db, company.body.fileId)).toMatchObject({ kind: 'company-document', projectId: null });
  });

  it('refuses other types and kinds', async () => {
    expect((await create({ type: 'pptx', projectId: 'p1' })).body.code).toBe('bad-type');
    expect((await create({ type: 'docx', projectId: 'p1', kind: 'photo' })).body.code).toBe('bad-kind');
    expect((await create({ type: 'docx', projectId: 'p1', kind: 'invoice' })).body.code).toBe('bad-kind');
    expect((await create({ type: 'docx', projectId: 'p1', kind: 'custom:abc' })).status).toBe(200);
  });

  it('defaults the kind by type and the name to Untitled', async () => {
    const r = await create({ type: 'xlsx', projectId: 'p1' });
    expect(getMeta(db, r.body.fileId)).toMatchObject({ kind: 'spreadsheet', name: 'Untitled.xlsx' });
  });
});

describe('document templates', () => {
  const uploadTemplate = (who: keyof typeof users, name: string, mime = DOCX, body = 'tpl bytes') =>
    request(as(who)).post(`/api/document-templates?name=${encodeURIComponent(name)}`).set('Content-Type', mime).send(Buffer.from(body));

  it('admins add, rename and delete; everyone lists', async () => {
    const added = await uploadTemplate('admin', 'Letter');
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ name: 'Letter.docx', ext: 'docx', createdBy: 'u-admin' });
    expect((await request(as('crew')).get('/api/document-templates')).body.map((t: any) => t.name)).toEqual(['Letter.docx']);

    const renamed = await request(as('admin')).patch(`/api/document-templates/${added.body.id}`).send({ name: 'Cover letter' });
    expect(renamed.body.name).toBe('Cover letter.docx'); // the extension stays

    saveNewVersion(db, dir, added.body.id, Buffer.from('edited'), DOCX);
    const archived = listVersions(db, added.body.id)[1].id;
    expect((await request(as('admin')).delete(`/api/document-templates/${added.body.id}`)).status).toBe(200);
    expect(getMeta(db, added.body.id)).toBeNull();
    expect(getMeta(db, archived)).toBeNull(); // versions go too
  });

  it('refuses non-admins, and files that are not Word, Excel or PDF', async () => {
    expect((await uploadTemplate('crew', 'Letter')).status).toBe(403);
    expect((await uploadTemplate('admin', 'Slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).body.code).toBe('unsupported');
    const t = (await uploadTemplate('admin', 'Letter')).body;
    expect((await request(as('crew')).patch(`/api/document-templates/${t.id}`).send({ name: 'x' })).status).toBe(403);
    expect((await request(as('crew')).delete(`/api/document-templates/${t.id}`)).status).toBe(403);
  });

  it('adds the company letterhead once', async () => {
    const r = await request(as('admin')).post('/api/document-templates/letterhead');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Letterhead.docx', ext: 'docx' });
    expect(bytesOf(r.body.id).equals(fsSync.readFileSync(path.join(__dirname, '..', 'docs', 'Template.docx')))).toBe(true);
    expect((await request(as('admin')).post('/api/document-templates/letterhead')).status).toBe(409);
  });

  it('stays out of Documents and out of a non-admin editor, but survives orphan cleanup', async () => {
    const t = (await uploadTemplate('admin', 'Letter')).body;
    const docs = await request(as('admin')).get('/api/documents');
    expect(docs.body.rows.map((r: any) => r.id)).not.toContain(t.id);
    await request(as('admin')).post('/api/storage/orphans/cleanup');
    expect(getMeta(db, t.id)).not.toBeNull();
  });
});

describe('company stamps', () => {
  const uploadStamp = (who: keyof typeof users, name = 'APPROVED', mime = 'image/png') =>
    request(as(who)).post(`/api/company-stamps?name=${encodeURIComponent(name)}`).set('Content-Type', mime).send(Buffer.from('png'));

  it('admins add, rename and delete; everyone lists', async () => {
    const s = (await uploadStamp('admin')).body;
    expect(s).toMatchObject({ name: 'APPROVED', mime: 'image/png' });
    expect((await request(as('crew')).get('/api/company-stamps')).body.map((x: any) => x.name)).toEqual(['APPROVED']);
    expect((await request(as('admin')).patch(`/api/company-stamps/${s.id}`).send({ name: 'Reviewed' })).body.name).toBe('Reviewed');
    expect((await request(as('admin')).delete(`/api/company-stamps/${s.id}`)).status).toBe(200);
    expect((await request(as('crew')).get('/api/company-stamps')).body).toEqual([]);
  });

  it('refuses non-admins and non-images', async () => {
    expect((await uploadStamp('crew')).status).toBe(403);
    expect((await uploadStamp('admin', 'x', 'application/pdf')).body.code).toBe('unsupported');
  });
});

describe('signatures', () => {
  const add = (who: keyof typeof users, name?: string) =>
    request(as(who)).post(`/api/signatures${name ? `?name=${encodeURIComponent(name)}` : ''}`).set('Content-Type', 'image/png').send(Buffer.from(`sig of ${who}`));
  const mine = async (who: keyof typeof users) => (await request(as(who)).get('/api/signatures')).body as any[];

  it('each person keeps several, named, with the first as default until they pick another', async () => {
    const full = (await add('crew', 'Full')).body;
    const initials = (await add('crew', 'Initials')).body;
    const unnamed = (await add('crew')).body;
    expect(unnamed.name).toBe('Signature 3');
    expect((await mine('crew')).map(s => [s.name, s.isDefault])).toEqual([['Full', true], ['Initials', false], ['Signature 3', false]]);

    await request(as('crew')).patch(`/api/signatures/${initials.id}`).send({ isDefault: true });
    expect((await mine('crew')).find(s => s.isDefault).id).toBe(initials.id);

    await request(as('crew')).delete(`/api/signatures/${initials.id}`);
    expect((await mine('crew')).find(s => s.isDefault).id).toBe(full.id); // falls back to the oldest
  });

  it('are private: nobody else lists, changes or reads them', async () => {
    const sig = (await add('crew', 'Full')).body;
    expect(await mine('other')).toEqual([]);
    expect((await request(as('other')).patch(`/api/signatures/${sig.id}`).send({ name: 'mine now' })).status).toBe(404);
    expect((await request(as('other')).delete(`/api/signatures/${sig.id}`)).status).toBe(404);
    expect((await request(as('admin')).delete(`/api/signatures/${sig.id}`)).status).toBe(404);

    const read = (who: keyof typeof users) => request(as(who)).get(`/api/files/${sig.id}/content`).set('Authorization', 'Bearer t');
    expect((await read('crew')).status).toBe(200);
    expect((await read('other')).status).toBe(404);
    expect((await read('admin')).status).toBe(404);
    // The same through the image URL an <img> loads, signed in by the media cookie.
    const raw = (who: keyof typeof users) => request(as(who)).get(`/api/images/${sig.id}/raw`).set('Cookie', `${MEDIA_COOKIE}=t`);
    expect((await raw('crew')).status).toBe(200);
    expect((await raw('other')).status).toBe(404);
    expect((await raw('admin')).status).toBe(404);
  });

  it('stay out of Documents, survive orphan cleanup, and go when their owner is removed', async () => {
    const sig = (await add('crew', 'Full')).body;
    expect((await request(as('admin')).get('/api/documents')).body.rows).toEqual([]);
    await request(as('admin')).post('/api/storage/orphans/cleanup');
    expect(getMeta(db, sig.id)).not.toBeNull();
    removeUserSignatures(db, dir, 'u-crew');
    expect(getMeta(db, sig.id)).toBeNull();
  });

  it('must be images', async () => {
    const r = await request(as('crew')).post('/api/signatures').set('Content-Type', 'text/plain').send(Buffer.from('x'));
    expect(r.body.code).toBe('unsupported');
  });
});
