// Opening files in ONLYOFFICE and saving them back. The tests play the
// Document Server: they sign callbacks with the shared secret exactly as it
// does, and a fake fetch serves the "saved" files it links to and answers its
// command service. What they pin down is the saving contract (decision
// 2026-09-25): one version per editing session, never overwriting a change
// that came from anywhere else, and everyone who opens a file during a session
// landing in that same session.
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
let fetched: string[];
/** Files the fake Document Server serves, by full URL. */
let dsFiles: Map<string, Buffer | 'fail'>;
/** Document keys the fake Document Server says are open (command `info`). */
let openKeys: Set<string>;
let dsDown: boolean;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const fakeFetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  fetched.push(url);
  if (dsDown) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  if (url === 'http://onlyoffice/command') {
    const params = jwt.verify(JSON.parse(init.body).token, SECRET) as any;
    if (params.c === 'info') return json({ error: openKeys.has(params.key) ? 0 : 1 });
    return json({ error: 5 });
  }
  const file = dsFiles.get(url);
  if (!file) return new Response('not found', { status: 404 });
  if (file === 'fail') return new Response('boom', { status: 500 });
  return new Response(file, { status: 200 });
}) as typeof fetch;

const users: Record<string, any> = {
  admin: { id: 'u-admin', username: 'noah', role: 'admin' },
  user: { id: 'u-user', username: 'crew', role: 'user' },
};

const mkApp = (as: keyof typeof users | null = 'admin', env: Record<string, string> = ENV) => {
  const a = express();
  // The real server gives the callback its own parser and everything else this one.
  a.use((req, res, next) => (req.path.startsWith('/api/onlyoffice/callback/') ? next() : express.json()(req, res, next)));
  registerOnlyofficeRoutes(a, {
    env,
    appJwtSecret: 'app-secret',
    authenticateToken: (req: any, res: any, next: any) => {
      if (!as) return res.status(401).json({ error: 'Authentication required' });
      req.user = users[as];
      next();
    },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    db,
    dataDir,
    broadcastChange: e => events.push(e),
    fetch: fakeFetch,
  });
  return a;
};

let app: express.Express;

/** supertest leaves .docx bodies unread; collect them as bytes. */
const binary = (res: any, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-oo-ed-'));
  db = openDb(':memory:');
  runMigrations(db, dataDir, migrations);
  events = [];
  fetched = [];
  dsFiles = new Map();
  openKeys = new Set();
  dsDown = false;
  putBuffer(db, dataDir, 'doc1', Buffer.from('original'), DOCX, { projectId: 'p1', kind: 'document', name: 'Scope.docx', createdBy: 'u-admin' });
  app = mkApp();
});

const openConfig = async (fileId = 'doc1', body: Record<string, unknown> = {}, a = app) => {
  const r = await request(a).post(`/api/onlyoffice/config/${fileId}`).send(body);
  return r;
};

/** POST a callback the way the Document Server does by default: parameters in
 *  the body, and a Bearer header whose signed payload wraps them. */
const callback = (fileId: string, params: Record<string, unknown>, opts: { secret?: string; inBody?: boolean } = {}) => {
  const secret = opts.secret ?? SECRET;
  const req = request(app).post(`/api/onlyoffice/callback/${fileId}`);
  if (opts.inBody) return req.send({ token: jwt.sign(params, secret) });
  return req.set('Authorization', `Bearer ${jwt.sign({ payload: params }, secret)}`).send(params);
};

/** Have the fake Document Server hold a saved file and return its link. */
let saveCounter = 0;
const savedFile = (content: string, host = 'https://docs.example.com') => {
  const url = `${host}/cache/files/data/k${++saveCounter}/output.docx?md5=abc&expires=1`;
  dsFiles.set(url.replace('https://docs.example.com', 'http://onlyoffice'), Buffer.from(content));
  return url;
};

const live = () => getMeta(db, 'doc1')!;
const bytes = () => readFileContent(dataDir, 'doc1')!.toString();
const versionNumbers = () => listVersions(db, 'doc1').map(v => v.versionNumber);

describe('POST /api/onlyoffice/config/:fileId', () => {
  it('needs a signed-in user and a configured ONLYOFFICE', async () => {
    expect((await openConfig('doc1', {}, mkApp(null))).status).toBe(401);
    const r = await openConfig('doc1', {}, mkApp('admin', {}));
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('not-configured');
  });

  it('builds a signed config for editing: document type, key, title, user, internal links', async () => {
    const r = await openConfig('doc1', { theme: 'dark' });
    expect(r.status).toBe(200);
    expect(r.body.publicUrl).toBe('https://docs.example.com');
    expect(r.body.file).toMatchObject({ id: 'doc1', projectId: 'p1', ext: 'docx', mode: 'edit', editable: true });
    const c = r.body.config;
    expect(c).toMatchObject({
      type: 'desktop',
      documentType: 'word',
      document: { fileType: 'docx', title: 'Scope.docx', permissions: { edit: true, comment: true, review: true } },
      editorConfig: {
        mode: 'edit',
        callbackUrl: 'http://app:3000/api/onlyoffice/callback/doc1',
        user: { id: 'u-admin', name: 'noah' },
        customization: { forcesave: true, uiTheme: 'default-dark' },
      },
    });
    expect(c.document.key).toMatch(/^doc1-v1-[0-9a-f]{12}$/);
    expect(c.document.url).toMatch(/^http:\/\/app:3000\/api\/onlyoffice\/file\/doc1\?t=/);
    // ONLYOFFICE trusts the signed copy: it must carry exactly these settings.
    const { token, ...unsigned } = c;
    const { iat: _iat, ...signed } = jwt.verify(token, SECRET) as any;
    expect(signed).toEqual(unsigned);
  });

  it('the file link lets ONLYOFFICE download that one file, and nothing else', async () => {
    const { config } = (await openConfig()).body;
    const link = new URL(config.document.url);
    const got = await request(app).get(link.pathname + link.search).buffer(true).parse(binary);
    expect(got.status).toBe(200);
    expect((got.body as Buffer).toString()).toBe('original');
    putBuffer(db, dataDir, 'other', Buffer.from('secret'), DOCX, { name: 'Other.docx' });
    expect((await request(app).get(`/api/onlyoffice/file/other${link.search}`)).status).toBe(403);
    expect((await request(app).get('/api/onlyoffice/file/doc1')).status).toBe(403);
  });

  it('opens read-only on phones, for legacy formats and for old versions — with no save link', async () => {
    const phone = (await openConfig('doc1', { device: 'phone' })).body.config;
    expect(phone).toMatchObject({ type: 'mobile', editorConfig: { mode: 'view' }, document: { permissions: { edit: false } } });
    expect(phone.editorConfig.callbackUrl).toBeUndefined();

    putBuffer(db, dataDir, 'old', Buffer.from('x'), 'application/msword', { name: 'Letter.doc' });
    expect((await openConfig('old')).body.config.editorConfig.mode).toBe('view');

    const { archivedVersionId } = saveNewVersion(db, dataDir, 'doc1', Buffer.from('v2'), DOCX);
    expect((await openConfig(archivedVersionId)).body.config.editorConfig.mode).toBe('view');
    // None of these start an editing session.
    expect(db.prepare('SELECT COUNT(*) c FROM editor_sessions').get()).toEqual({ c: 0 });
  });

  it('titles generated documents with their extension', async () => {
    putBuffer(db, dataDir, 'inv', Buffer.from('%PDF'), 'application/pdf', { name: 'Invoice #12', kind: 'invoice' });
    const c = (await openConfig('inv')).body.config;
    expect(c).toMatchObject({ documentType: 'pdf', document: { fileType: 'pdf', title: 'Invoice #12.pdf' } });
  });

  it('hides admin-only documents from other users, and refuses files the editor cannot open', async () => {
    putBuffer(db, dataDir, 'inv', Buffer.from('%PDF'), 'application/pdf', { name: 'Invoice.pdf', kind: 'invoice' });
    expect((await openConfig('inv', {}, mkApp('user'))).status).toBe(404);
    expect((await openConfig('inv', {}, mkApp('admin'))).status).toBe(200);
    // Templates are admins' to change (Settings → Document Templates).
    putBuffer(db, dataDir, 'tpl', Buffer.from('docx'), DOCX, { name: 'Letterhead.docx', kind: 'document-template' });
    expect((await openConfig('tpl', {}, mkApp('user'))).status).toBe(404);
    expect((await openConfig('tpl', {}, mkApp('admin'))).status).toBe(200);
    expect((await openConfig('missing')).status).toBe(404);
    putBuffer(db, dataDir, 'pic', Buffer.from('png'), 'image/png', { name: 'site.png' });
    const r = await openConfig('pic');
    expect(r.status).toBe(415);
    expect(r.body.code).toBe('unsupported');
  });

  it('puts everyone who opens the file during a session into that same session', async () => {
    const first = (await openConfig()).body.config.document.key;
    // A save moves the file to a new version while people are still editing...
    const url = savedFile('edited once');
    expect((await callback('doc1', { key: first, status: 6, url, users: ['u-admin'], filetype: 'docx' })).body).toEqual({ error: 0 });
    expect(live().versionNumber).toBe(2);
    // ...yet someone opening it now still joins the open session.
    openKeys.add(first);
    const second = (await openConfig('doc1', {}, mkApp('user'))).body.config.document.key;
    expect(second).toBe(first);
    // A viewer joins it too, to see the edits live.
    expect((await openConfig('doc1', { device: 'phone' })).body.config.document.key).toBe(first);
  });

  it('drops a session ONLYOFFICE no longer has, and starts fresh on the current bytes', async () => {
    const first = (await openConfig()).body.config.document.key;
    await callback('doc1', { key: first, status: 6, url: savedFile('edited'), users: ['u-admin'] });
    // ONLYOFFICE restarted: the session vanished without a closing callback.
    const next = (await openConfig()).body.config.document.key;
    expect(next).not.toBe(first);
    expect(next).toMatch(/^doc1-v2-/);
    expect(fetched).toContain('http://onlyoffice/command');
  });

  it('says ONLYOFFICE is unreachable when a pinned session cannot be checked', async () => {
    const first = (await openConfig()).body.config.document.key;
    await callback('doc1', { key: first, status: 6, url: savedFile('edited'), users: ['u-admin'] });
    dsDown = true;
    const r = await openConfig();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('onlyoffice-unreachable');
  });
});

describe('POST /api/onlyoffice/callback/:fileId', () => {
  const start = async () => (await openConfig()).body.config.document.key as string;

  it('rejects callbacks that are unsigned, signed with another secret, or for another file', async () => {
    const key = await start();
    const unsigned = await request(app).post('/api/onlyoffice/callback/doc1').send({ key, status: 2, url: savedFile('x') });
    expect(unsigned.status).toBe(403);
    expect((await callback('doc1', { key, status: 2, url: savedFile('x') }, { secret: 'wrong' })).status).toBe(403);
    putBuffer(db, dataDir, 'doc2', Buffer.from('two'), DOCX, { name: 'Two.docx' });
    expect((await callback('doc2', { key, status: 2, url: savedFile('x') })).status).toBe(400);
    expect(bytes()).toBe('original');
    expect(versionNumbers()).toEqual([1]);
  });

  it('keeps one version per session: first save archives, later saves overwrite, the close ends it', async () => {
    const key = await start();
    expect((await callback('doc1', { key, status: 1, users: ['u-admin'] })).body).toEqual({ error: 0 });

    await callback('doc1', { key, status: 6, url: savedFile('first save'), users: ['u-user'], forcesavetype: 1 });
    expect(bytes()).toBe('first save');
    expect(versionNumbers()).toEqual([2, 1]);
    expect(live().createdBy).toBe('u-user');
    expect(listVersions(db, 'doc1')[1].createdBy).toBe('u-admin'); // the pre-session version keeps its author

    await callback('doc1', { key, status: 6, url: savedFile('second save'), users: ['u-admin'], forcesavetype: 1 });
    expect(bytes()).toBe('second save');
    expect(versionNumbers()).toEqual([2, 1]);
    expect(live().createdBy).toBe('u-admin');

    const r = await callback('doc1', { key, status: 2, url: savedFile('final'), users: ['u-admin'] });
    expect(r.body).toEqual({ error: 0 });
    expect(bytes()).toBe('final');
    expect(versionNumbers()).toEqual([2, 1]);
    expect(db.prepare('SELECT COUNT(*) c FROM editor_sessions').get()).toEqual({ c: 0 });
    expect(events.at(-1)).toMatchObject({ type: 'file', id: 'doc1', projectId: 'p1', action: 'updated', byUserId: 'u-admin' });

    // The next session starts from the saved bytes and gets its own version.
    const next = await start();
    expect(next).not.toBe(key);
    await callback('doc1', { key: next, status: 2, url: savedFile('next session'), users: ['u-user'] });
    expect(versionNumbers()).toEqual([3, 2, 1]);
  });

  it('never overwrites a change made outside the session: that save becomes a new version', async () => {
    const key = await start();
    await callback('doc1', { key, status: 6, url: savedFile('session edit'), users: ['u-admin'] });
    // Someone regenerates or uploads a new version meanwhile.
    saveNewVersion(db, dataDir, 'doc1', Buffer.from('regenerated'), DOCX, 'u-user');
    expect(versionNumbers()).toEqual([3, 2, 1]);

    await callback('doc1', { key, status: 2, url: savedFile('session edit 2'), users: ['u-admin'] });
    expect(bytes()).toBe('session edit 2');
    expect(versionNumbers()).toEqual([4, 3, 2, 1]);
    const history = listVersions(db, 'doc1');
    expect(readFileContent(dataDir, history[1].id)!.toString()).toBe('regenerated');
  });

  it('adds no version when the saved bytes are unchanged', async () => {
    const key = await start();
    await callback('doc1', { key, status: 6, url: savedFile('original'), users: ['u-admin'] });
    expect(versionNumbers()).toEqual([1]);
    expect(events).toHaveLength(0);
  });

  it('ends the session when everyone closes without changes', async () => {
    const key = await start();
    await callback('doc1', { key, status: 4 });
    expect(db.prepare('SELECT COUNT(*) c FROM editor_sessions').get()).toEqual({ c: 0 });
    expect(versionNumbers()).toEqual([1]);
  });

  it('accepts the token in the body when ONLYOFFICE is set up that way', async () => {
    const key = await start();
    await callback('doc1', { key, status: 2, url: savedFile('from body token'), users: ['u-admin'] }, { inBody: true });
    expect(bytes()).toBe('from body token');
  });

  it('downloads saves over the internal address, falling back to the link as given', async () => {
    const key = await start();
    await callback('doc1', { key, status: 6, url: savedFile('via internal'), users: ['u-admin'] });
    // (A save also queues a thumbnail, which calls the converter meanwhile.)
    expect(fetched.filter(u => !u.endsWith('/converter')).at(-1)).toMatch(/^http:\/\/onlyoffice\/cache\/files\//);

    // A link on another host (e.g. a proxy ONLYOFFICE reports) is used as-is.
    const elsewhere = 'https://cdn.example.net/cache/output.docx';
    dsFiles.set(elsewhere, Buffer.from('via given link'));
    await callback('doc1', { key, status: 6, url: elsewhere, users: ['u-admin'] });
    expect(bytes()).toBe('via given link');
  });

  it('reports a failed download so ONLYOFFICE keeps the edits, and changes nothing', async () => {
    const key = await start();
    const url = 'https://docs.example.com/cache/files/data/broken/output.docx';
    dsFiles.set('http://onlyoffice/cache/files/data/broken/output.docx', 'fail');
    const r = await callback('doc1', { key, status: 2, url, users: ['u-admin'] });
    expect(r.body).toEqual({ error: 1 });
    expect(bytes()).toBe('original');
    expect(versionNumbers()).toEqual([1]);
    // The session stays, so a retry still counts as this session's save.
    expect(db.prepare('SELECT COUNT(*) c FROM editor_sessions').get()).toEqual({ c: 1 });
  });

  it('saves what ONLYOFFICE could recover when assembling failed (status 3)', async () => {
    const key = await start();
    await callback('doc1', { key, status: 3, url: savedFile('recovered'), users: ['u-admin'] });
    expect(bytes()).toBe('recovered');
    expect(db.prepare('SELECT COUNT(*) c FROM editor_sessions').get()).toEqual({ c: 0 });
  });

  it('drops a save for a file that was deleted meanwhile', async () => {
    const key = await start();
    db.prepare('DELETE FROM files WHERE id = ?').run('doc1');
    expect((await callback('doc1', { key, status: 2, url: savedFile('too late'), users: ['u-admin'] })).body).toEqual({ error: 0 });
  });

  it('keeps the name honest when ONLYOFFICE hands back another format', async () => {
    const key = await start();
    await callback('doc1', { key, status: 2, url: savedFile('as pdf'), users: ['u-admin'], filetype: 'pdf' });
    expect(live()).toMatchObject({ name: 'Scope.pdf', mime: 'application/pdf' });
  });

  it('applies back-to-back saves in order', async () => {
    const key = await start();
    await Promise.all([
      callback('doc1', { key, status: 6, url: savedFile('forcesave'), users: ['u-admin'] }),
      callback('doc1', { key, status: 2, url: savedFile('close'), users: ['u-admin'] }),
    ]);
    expect(bytes()).toBe('close');
    expect(versionNumbers()).toEqual([2, 1]);
  });
});

describe('callback: what Version History needs', () => {
  const start = async () => (await openConfig()).body.config.document.key as string;
  const session = () => db.prepare('SELECT * FROM editor_sessions WHERE fileId = ?').get('doc1') as any;
  const changes = () => db.prepare('SELECT * FROM editor_changes WHERE fileId = ? ORDER BY versionNumber').all('doc1') as any[];
  const history = (created = '2026-09-26 10:00:00') => ({ changes: [{ created, user: { id: 'u-admin', name: 'noah' } }], serverVersion: '9.4.0' });
  const changesZip = (content = 'zip bytes') => {
    const url = `https://docs.example.com/cache/files/data/c${++saveCounter}/changes.zip`;
    dsFiles.set(url.replace('https://docs.example.com', 'http://onlyoffice'), Buffer.from(content));
    return url;
  };

  it('remembers who is in the session, and ignores reports for other sessions', async () => {
    const key = await start();
    await callback('doc1', { key, status: 1, users: ['u-admin', 'u-user'] });
    expect(JSON.parse(session().users)).toEqual(['u-admin', 'u-user']);
    await callback('doc1', { key: `${key}-old`, status: 1, users: [] });
    expect(JSON.parse(session().users)).toEqual(['u-admin', 'u-user']);
  });

  it('marks editor saves as edits; the version before keeps its own origin', async () => {
    const key = await start();
    await callback('doc1', { key, status: 6, url: savedFile('edited'), users: ['u-admin'] });
    const [now, before] = listVersions(db, 'doc1');
    expect(now.versionOrigin).toBe('editor');
    expect(before.versionOrigin).toBeNull();
  });

  it('keeps the change log a closing session sends, against the version it made', async () => {
    const key = await start();
    await callback('doc1', { key, status: 6, url: savedFile('forcesaved'), users: ['u-admin'] });
    await callback('doc1', { key, status: 2, url: savedFile('closed'), users: ['u-admin'], history: history(), changesurl: changesZip('the log') });
    const [row] = changes();
    expect(row).toMatchObject({ versionNumber: 2, serverVersion: '"9.4.0"' });
    expect(JSON.parse(row.changesJson)).toEqual(history().changes);
    expect(Buffer.from(row.zip).toString()).toBe('the log');
  });

  it('keeps the log even when the close brings no new bytes', async () => {
    const key = await start();
    await callback('doc1', { key, status: 6, url: savedFile('forcesaved'), users: ['u-admin'] });
    await callback('doc1', { key, status: 2, url: savedFile('forcesaved'), users: ['u-admin'], history: history(), changesurl: changesZip() });
    expect(changes().map(c => c.versionNumber)).toEqual([2]);
  });

  it('keeps no log when the session made more than one version (it would highlight the wrong changes)', async () => {
    const key = await start();
    await callback('doc1', { key, status: 6, url: savedFile('session edit'), users: ['u-admin'] });
    saveNewVersion(db, dataDir, 'doc1', Buffer.from('regenerated'), DOCX, 'u-user');
    await callback('doc1', { key, status: 2, url: savedFile('session edit 2'), users: ['u-admin'], history: history(), changesurl: changesZip() });
    expect(versionNumbers()).toEqual([4, 3, 2, 1]);
    expect(changes()).toEqual([]);
  });

  it('a change log that fails to download never fails the save', async () => {
    const key = await start();
    const url = 'https://docs.example.com/cache/files/data/nolog/changes.zip';
    dsFiles.set('http://onlyoffice/cache/files/data/nolog/changes.zip', 'fail');
    const r = await callback('doc1', { key, status: 2, url: savedFile('closed'), users: ['u-admin'], history: history(), changesurl: url });
    expect(r.body).toEqual({ error: 0 });
    expect(bytes()).toBe('closed');
    expect(changes()).toMatchObject([{ versionNumber: 2, zip: null }]);
  });
});
