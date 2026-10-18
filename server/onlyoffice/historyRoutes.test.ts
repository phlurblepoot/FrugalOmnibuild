// Version history inside the editor, and restoring a version. As in
// editorRoutes.test.ts the tests play the Document Server: they sign callbacks
// with the shared secret, and a fake fetch answers its command service. Here
// that includes `forcesave`, which the fake answers the way ONLYOFFICE does: it
// says a save is coming, then posts that save to the callback.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { getMeta, listVersions, putBuffer, saveNewVersion } from '../files';
import { readFileContent } from '../fileStore';
import type { EntityChangedEvent } from '../realtime/changeFeed';
import { registerOnlyofficeRoutes } from './routes';
import { changeTimes } from './editorRoutes';

const SECRET = 'shared-oo-secret';
const ENV = {
  ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com',
  ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice',
  APP_INTERNAL_URL: 'http://app:3000',
  ONLYOFFICE_JWT_SECRET: SECRET,
};
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let db: Database.Database;
let dataDir: string;
let events: EntityChangedEvent[];
let dsFiles: Map<string, Buffer>;
let openKeys: Set<string>;
/** What the fake Document Server holds unsaved, by key; `forcesave` posts it. */
let unsaved: Map<string, string>;
/** When set, `forcesave` says a save is coming but never sends it. */
let forcesaveHangs: boolean;
let commands: any[];
let app: express.Express;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let saveCounter = 0;
const savedFile = (content: string) => {
  const url = `https://docs.example.com/cache/files/data/k${++saveCounter}/output.docx`;
  dsFiles.set(url.replace('https://docs.example.com', 'http://onlyoffice'), Buffer.from(content));
  return url;
};

const fakeFetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  if (url === 'http://onlyoffice/command') {
    const params = jwt.verify(JSON.parse(init.body).token, SECRET) as any;
    commands.push(params);
    if (params.c === 'info') return json({ error: openKeys.has(params.key) ? 0 : 1 });
    if (params.c === 'forcesave') {
      if (!openKeys.has(params.key)) return json({ error: 1 });
      const content = unsaved.get(params.key);
      if (content === undefined) return json({ error: 4 });
      unsaved.delete(params.key);
      if (!forcesaveHangs) {
        setTimeout(() => {
          // supertest only sends once something awaits the request.
          void callback('doc1', { key: params.key, status: 6, url: savedFile(content), users: ['u-admin'], forcesavetype: 0, userdata: params.userdata }).then(() => undefined);
        }, 5);
      }
      return json({ error: 0 });
    }
    return json({ error: 5 });
  }
  const file = dsFiles.get(url);
  return file ? new Response(file, { status: 200 }) : new Response('not found', { status: 404 });
}) as typeof fetch;

const users: Record<string, any> = {
  admin: { id: 'u-admin', username: 'noah', role: 'admin' },
  user: { id: 'u-user', username: 'crew', role: 'user' },
};

const mkApp = (as: keyof typeof users = 'admin', env: Record<string, string> = ENV) => {
  const a = express();
  a.use((req, res, next) => (req.path.startsWith('/api/onlyoffice/callback/') ? next() : express.json()(req, res, next)));
  registerOnlyofficeRoutes(a, {
    env,
    appJwtSecret: 'app-secret',
    authenticateToken: (req: any, _res: any, next: any) => { req.user = users[as]; next(); },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    db,
    dataDir,
    broadcastChange: e => events.push(e),
    fetch: fakeFetch,
    forcesaveTimeoutMs: 300,
  });
  return a;
};

const callback = (fileId: string, params: Record<string, unknown>, a = app) =>
  request(a).post(`/api/onlyoffice/callback/${fileId}`).set('Authorization', `Bearer ${jwt.sign({ payload: params }, SECRET)}`).send(params);

const openEditor = async (a = app) => {
  const key = (await request(a).post('/api/onlyoffice/config/doc1').send({})).body.config.document.key as string;
  openKeys.add(key);
  return key;
};

const bytes = () => readFileContent(dataDir, 'doc1')!.toString();
const versionNumbers = () => listVersions(db, 'doc1').map(v => v.versionNumber);
const session = () => db.prepare('SELECT * FROM editor_sessions WHERE fileId = ?').get('doc1') as any;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-oo-hist-'));
  db = openDb(':memory:');
  runMigrations(db, dataDir, migrations);
  db.prepare(`INSERT INTO users (id, username, role) VALUES ('u-admin', 'noah', 'admin'), ('u-user', 'crew', 'user')`).run();
  events = [];
  dsFiles = new Map();
  openKeys = new Set();
  unsaved = new Map();
  forcesaveHangs = false;
  commands = [];
  putBuffer(db, dataDir, 'doc1', Buffer.from('v1 bytes'), DOCX, { projectId: 'p1', kind: 'document', name: 'Scope.docx', createdBy: 'u-admin' });
  app = mkApp();
});

/** Three versions: v1 by noah, v2 by crew in the editor (with its change
 *  log), v3 an upload by crew. */
const threeVersions = () => {
  saveNewVersion(db, dataDir, 'doc1', Buffer.from('v2 bytes'), DOCX, 'u-user', 'editor');
  db.prepare(`INSERT INTO editor_changes (fileId, versionNumber, changesJson, serverVersion, zip, createdAt) VALUES ('doc1', 2, ?, '"9.4.0"', ?, 1)`)
    .run(JSON.stringify([{ created: '2026-09-26 10:00:00', user: { id: 'u-user', name: 'crew' } }]), Buffer.from('zip'));
  saveNewVersion(db, dataDir, 'doc1', Buffer.from('v3 bytes'), DOCX, 'u-user');
};

describe('GET /api/onlyoffice/history/:fileId', () => {
  it('lists every version oldest first, with who made it and the change log where one was kept', async () => {
    threeVersions();
    const r = await request(app).get('/api/onlyoffice/history/doc1');
    expect(r.status).toBe(200);
    expect(r.body.currentVersion).toBe(3);
    expect(r.body.versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
    expect(r.body.versions.map((v: any) => v.user?.name)).toEqual(['noah', 'crew', 'crew']);
    expect(r.body.versions[1]).toMatchObject({ origin: 'editor', serverVersion: '9.4.0', changes: [{ created: '2026-09-26 10:00:00' }] });
    expect(r.body.versions[0].changes).toBeUndefined();
    // Keys are distinct, and the current one is the key the editor opens with.
    const keys = r.body.versions.map((v: any) => v.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).toBe(await openEditor());
  });

  it('shows the open session\'s key for the current version', async () => {
    const key = await openEditor();
    await callback('doc1', { key, status: 6, url: savedFile('saved in session'), users: ['u-admin'] });
    const r = await request(app).get('/api/onlyoffice/history/doc1');
    expect(r.body.versions.at(-1)).toMatchObject({ version: 2, key });
  });

  it('drops the change log when the version before it was deleted', async () => {
    threeVersions();
    const v1 = listVersions(db, 'doc1').find(v => v.versionNumber === 1)!;
    db.prepare('DELETE FROM files WHERE id = ?').run(v1.id);
    const r = await request(app).get('/api/onlyoffice/history/doc1');
    expect(r.body.versions.map((v: any) => v.version)).toEqual([2, 3]);
    expect(r.body.versions[0].changes).toBeUndefined();
  });

  it('hides admin-only documents from everyone else', async () => {
    putBuffer(db, dataDir, 'inv1', Buffer.from('x'), DOCX, { kind: 'invoice', name: 'Invoice.docx' });
    expect((await request(mkApp('user')).get('/api/onlyoffice/history/inv1')).status).toBe(404);
    expect((await request(mkApp('admin')).get('/api/onlyoffice/history/inv1')).status).toBe(200);
  });
});

describe('GET /api/onlyoffice/history/:fileId/:version', () => {
  it('signs a link ONLYOFFICE can open the version with', async () => {
    threeVersions();
    const r = await request(app).get('/api/onlyoffice/history/doc1/1');
    expect(r.status).toBe(200);
    const v1 = listVersions(db, 'doc1').find(v => v.versionNumber === 1)!;
    expect(r.body).toMatchObject({ version: 1, fileType: 'docx' });
    expect(r.body.url).toMatch(new RegExp(`^http://app:3000/api/onlyoffice/file/${v1.id}\\?t=`));
    expect(r.body.changesUrl).toBeUndefined();
    const signed = jwt.verify(r.body.token, SECRET) as any;
    expect(signed).toMatchObject({ version: 1, key: r.body.key, url: r.body.url, fileType: 'docx' });

    // The link opens those bytes, and only that version.
    const file = await request(app).get(new URL(r.body.url).pathname + new URL(r.body.url).search)
      .buffer(true).parse((res, done) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => done(null, Buffer.concat(c))); });
    expect(file.body.toString()).toBe('v1 bytes');
  });

  it('adds the change log and the version before, on the address the browser uses', async () => {
    threeVersions();
    const r = await request(app).get('/api/onlyoffice/history/doc1/2').query({ origin: 'https://takeoff.example.com' });
    expect(r.body.changesUrl).toMatch(/^https:\/\/takeoff\.example\.com\/api\/onlyoffice\/changes\/doc1\/2\?t=/);
    expect(r.body.previous).toMatchObject({ fileType: 'docx' });
    expect(r.body.previous.url).toMatch(/^http:\/\/app:3000\/api\/onlyoffice\/file\//);
    const signed = jwt.verify(r.body.token, SECRET) as any;
    expect(signed.changesUrl).toBe(r.body.changesUrl);
    expect(signed.previous).toEqual(r.body.previous);

    // The editor frame downloads the log cross-origin.
    const log = await request(app).get(new URL(r.body.changesUrl).pathname + new URL(r.body.changesUrl).search);
    expect(log.status).toBe(200);
    expect(log.headers['access-control-allow-origin']).toBe('https://docs.example.com');
    expect(log.headers['content-type']).toMatch(/application\/zip/);
    // A link for one version's log opens no other.
    const other = await request(app).get(`/api/onlyoffice/changes/doc1/3${new URL(r.body.changesUrl).search}`);
    expect(other.status).toBe(403);
  });

  it('answers 404 for a version that no longer exists', async () => {
    expect((await request(app).get('/api/onlyoffice/history/doc1/7')).status).toBe(404);
  });
});

describe('POST /api/files/:id/restore', () => {
  const restore = (body: Record<string, unknown>, a = app) => request(a).post('/api/files/doc1/restore').send(body);

  it('restores as a new version on top, so the version it replaces stays in the history', async () => {
    threeVersions();
    const r = await restore({ version: 1 }, mkApp('user'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ versionNumber: 4, restoredFrom: 1 });
    expect(bytes()).toBe('v1 bytes');
    expect(versionNumbers()).toEqual([4, 3, 2, 1]);
    expect(getMeta(db, 'doc1')).toMatchObject({ versionOrigin: 'restore', createdBy: 'u-user' });
    expect(readFileContent(dataDir, listVersions(db, 'doc1')[1].id)!.toString()).toBe('v3 bytes');
    expect(events.at(-1)).toMatchObject({ type: 'file', id: 'doc1', action: 'updated' });
  });

  it('accepts a version\'s row id too (the Documents page has those)', async () => {
    threeVersions();
    const v2 = listVersions(db, 'doc1').find(v => v.versionNumber === 2)!;
    expect((await restore({ versionId: v2.id })).status).toBe(200);
    expect(bytes()).toBe('v2 bytes');
  });

  it('refuses the current version, and versions of other files', async () => {
    threeVersions();
    expect((await restore({ version: 3 })).body.code).toBe('current');
    putBuffer(db, dataDir, 'doc2', Buffer.from('a'), DOCX, { name: 'Two.docx' });
    saveNewVersion(db, dataDir, 'doc2', Buffer.from('b'), DOCX);
    const otherVersion = listVersions(db, 'doc2')[1];
    expect((await restore({ versionId: otherVersion.id })).status).toBe(404);
    expect(versionNumbers()).toEqual([3, 2, 1]);
  });

  it('puts the name\'s extension back with the bytes', async () => {
    db.prepare(`UPDATE files SET name = 'Scope.doc', mime = 'application/msword' WHERE id = 'doc1'`).run();
    saveNewVersion(db, dataDir, 'doc1', Buffer.from('converted'), DOCX);
    db.prepare(`UPDATE files SET name = 'Scope.docx' WHERE id = 'doc1'`).run();
    await restore({ version: 1 });
    expect(getMeta(db, 'doc1')).toMatchObject({ name: 'Scope.doc', mime: 'application/msword' });
  });

  it('waits while someone else has the file open in the editor', async () => {
    threeVersions();
    const key = await openEditor();
    await callback('doc1', { key, status: 1, users: ['u-admin', 'u-user'] });
    const r = await restore({ version: 1, from: 'editor' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'open-in-editor', users: ['crew'] });
    expect(r.body.error).toContain('crew is editing this file');
    expect(versionNumbers()).toEqual([3, 2, 1]);
  });

  it('from the Documents page, waits even when the only editor is you', async () => {
    threeVersions();
    const key = await openEditor();
    await callback('doc1', { key, status: 1, users: ['u-admin'] });
    const r = await restore({ version: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('You have this file open in the Document Editor');
  });

  it('ignores a session ONLYOFFICE no longer has', async () => {
    threeVersions();
    const key = await openEditor();
    await callback('doc1', { key, status: 1, users: ['u-user'] });
    openKeys.delete(key); // ONLYOFFICE restarted
    expect((await restore({ version: 1 })).status).toBe(200);
    expect(session()).toBeUndefined();
  });

  describe('from inside the editor, alone in it', () => {
    /** v1, then v2 by crew; noah opens v2 and is alone in the editor. */
    const openAlone = async () => {
      saveNewVersion(db, dataDir, 'doc1', Buffer.from('v2 bytes'), DOCX, 'u-user');
      const key = await openEditor();
      await callback('doc1', { key, status: 1, users: ['u-admin'] });
      return key;
    };

    it('saves what is open first, then restores on top, and the next open is a fresh session', async () => {
      const key = await openAlone();
      unsaved.set(key, 'unsaved edits');
      const r = await restore({ version: 1, from: 'editor' });
      expect(r.status).toBe(200);
      expect(commands.find(c => c.c === 'forcesave')).toMatchObject({ key, userdata: 'restore' });
      expect(versionNumbers()).toEqual([4, 3, 2, 1]);
      const [now, edits] = listVersions(db, 'doc1');
      expect(readFileContent(dataDir, edits.id)!.toString()).toBe('unsaved edits');
      expect(now.versionOrigin).toBe('restore');
      expect(bytes()).toBe('v1 bytes');
      expect(session()).toBeUndefined();
      expect(await openEditor()).not.toBe(key);
    });

    it('with nothing unsaved, restores straight away', async () => {
      await openAlone();
      expect((await restore({ version: 1, from: 'editor' })).status).toBe(200);
      expect(versionNumbers()).toEqual([3, 2, 1]);
      expect(commands.filter(c => c.c === 'forcesave')).toHaveLength(1);
    });

    it('gives up, changing nothing, when the open file never arrives', async () => {
      const key = await openAlone();
      unsaved.set(key, 'unsaved edits');
      forcesaveHangs = true;
      const r = await restore({ version: 1, from: 'editor' });
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('save-timeout');
      expect(bytes()).toBe('v2 bytes');
      expect(versionNumbers()).toEqual([2, 1]);
      expect(session().docKey).toBe(key);
    });

    it('drops the old session\'s closing save when it holds nothing new since the restore', async () => {
      const key = await openAlone();
      await restore({ version: 1, from: 'editor' });
      expect(versionNumbers()).toEqual([3, 2, 1]);
      const before = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19);
      const r = await callback('doc1', { key, status: 2, url: savedFile('re-assembled old state'), users: ['u-admin'],
        history: { changes: [{ created: before, user: { id: 'u-admin' } }] } });
      expect(r.body).toEqual({ error: 0 });
      expect(bytes()).toBe('v1 bytes');
      expect(versionNumbers()).toEqual([3, 2, 1]);
      expect(db.prepare('SELECT COUNT(*) c FROM editor_superseded_sessions').get()).toEqual({ c: 0 });
    });

    it('keeps edits made in the old session after the restore, as a new version', async () => {
      const key = await openAlone();
      await restore({ version: 1, from: 'editor' });
      const after = new Date(Date.now() + 60_000).toISOString().replace('T', ' ').slice(0, 19);
      await callback('doc1', { key, status: 2, url: savedFile('typed in a second tab'), users: ['u-admin'],
        history: { changes: [{ created: after, user: { id: 'u-admin' } }] } });
      expect(bytes()).toBe('typed in a second tab');
      expect(versionNumbers()).toEqual([4, 3, 2, 1]);
      expect(getMeta(db, 'doc1')!.versionOrigin).toBe('editor');
    });

    it('judges an old-session save without a history by its bytes', async () => {
      const key = await openAlone();
      await callback('doc1', { key, status: 6, url: savedFile('saved before'), users: ['u-admin'] });
      await restore({ version: 1, from: 'editor' });
      expect(versionNumbers()).toEqual([4, 3, 2, 1]);
      await callback('doc1', { key, status: 6, url: savedFile('saved before'), users: ['u-admin'] });
      expect(versionNumbers()).toEqual([4, 3, 2, 1]);
      await callback('doc1', { key, status: 6, url: savedFile('pressed save in a second tab'), users: ['u-admin'] });
      expect(versionNumbers()).toEqual([5, 4, 3, 2, 1]);
      expect(bytes()).toBe('pressed save in a second tab');
    });
  });
});

describe('changeTimes', () => {
  it('reads ONLYOFFICE\'s UTC timestamps, and gives up on anything else', () => {
    expect(changeTimes({ changes: [{ created: '2026-09-26 10:00:05' }] })).toEqual([Date.UTC(2026, 8, 26, 10, 0, 5)]);
    expect(changeTimes({ changes: [{ created: '2026-09-26 10:00' }] })).toEqual([Date.UTC(2026, 8, 26, 10, 0, 0)]);
    expect(changeTimes({ changes: [{ created: 'yesterday' }] })).toBeNull();
    expect(changeTimes({ changes: [] })).toBeNull();
    expect(changeTimes(undefined)).toBeNull();
  });
});
