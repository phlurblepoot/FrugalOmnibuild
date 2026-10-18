// ONLYOFFICE as a viewer (Phase 6): share links open the embedded viewer,
// anonymous and never able to edit; mail attachments open for their owner
// only, and the Document Server's download link opens that one attachment,
// for an hour, and nothing else.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { putBuffer } from '../files';
import { registerOnlyofficeRoutes } from './routes';
import { registerShareRoutes } from '../shareRoutes';
import { revokeShare } from '../shares';
import { createOnlyofficeServices } from './services';
import { createAttachmentViewer } from './viewers';
import { mailAttachmentSubject } from './links';
import { documentKeyFor } from './editorConfig';
import { getMeta } from '../files';
import { MailCrypto } from '../mail/crypto';
import * as accounts from '../mail/accountStore';
import { getFakeProvider, resetFakes } from '../mail/providers/fakeRegistry';
import { registerMailRoutes } from '../mail/routes';
import { BodyCache } from '../mail/sync/bodyCache';
import { MailScheduler } from '../mail/sync/scheduler';
import { upsertFolders, upsertEnvelopes } from '../mail/sync/engine';
import type { MailContext } from '../mail/context';

const SECRET = 'oo-secret';
const ENV = {
  ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com',
  ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice',
  APP_INTERNAL_URL: 'http://app:3000',
  ONLYOFFICE_JWT_SECRET: SECRET,
};
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLS = 'application/vnd.ms-excel';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-oo-view-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations, { mailCrypto: new MailCrypto(Buffer.alloc(32, 3)) });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','noah','x','admin'), ('u2','maria','x','user')`).run();
});

/** The path and query of a URL ONLYOFFICE would fetch from the app. */
const appPath = (url: string) => url.replace(ENV.APP_INTERNAL_URL, '');
const assertViewOnly = (config: any) => {
  expect(config.editorConfig.mode).toBe('view');
  expect(config.editorConfig.callbackUrl).toBeUndefined();
  const p = config.document.permissions;
  expect([p.edit, p.comment, p.review, p.fillForms]).toEqual([false, false, false, false]);
  // The signed copy is what ONLYOFFICE trusts.
  const signed = jwt.verify(config.token, SECRET) as any;
  expect(signed.editorConfig.mode).toBe('view');
  expect(signed.document.permissions.edit).toBe(false);
  expect(signed.editorConfig.callbackUrl).toBeUndefined();
};

describe('share links: the embedded viewer', () => {
  const share = (id: string, type: string, resourceId: string, name = 'Shared') =>
    db.prepare('INSERT INTO shares (id, type, resourceId, name, createdAt) VALUES (?, ?, ?, ?, 1)').run(id, type, resourceId, name);
  const mkApp = (env: Record<string, string> = ENV) => {
    const a = express();
    a.use(express.json());
    registerOnlyofficeRoutes(a, {
      env, appJwtSecret: 'app-secret', db, dataDir: dir, broadcastChange: () => {},
      authenticateToken: (_req, res) => { res.status(401).end(); }, // nobody is signed in
      requireAdmin: (_req, res) => { res.status(403).end(); },
      fetch: (async () => new Response('nf', { status: 404 })) as typeof fetch,
    });
    registerShareRoutes(a, { db, dataDir: dir, env, authenticateToken: (_req, res) => { res.status(401).end(); } });
    return a;
  };

  beforeEach(() => {
    putBuffer(db, dir, 'pdf1', Buffer.from('%PDF-1.7 bid set'), 'application/pdf', { projectId: 'p1', kind: 'takeoff-print', name: 'Bid set.pdf' });
    putBuffer(db, dir, 'img1', Buffer.from('png'), 'image/png', { name: 'photo.png' });
    share('s-pdf', 'printout', 'pdf1', 'Bid set');
    share('s-img', 'image', 'img1');
    share('s-pages', 'pages', JSON.stringify([{ imageId: 'img1', name: 'A1' }]));
  });

  it('opens a shared file anonymously, view only, embedded, on phones too', async () => {
    const a = mkApp();
    for (const device of ['desktop', 'phone']) {
      const r = await request(a).get(`/api/share/s-pdf/viewer?device=${device}`);
      expect(r.status).toBe(200);
      expect(r.body.publicUrl).toBe('https://docs.example.com');
      expect(r.body.config.type).toBe('embedded');
      expect(r.body.config.document).toMatchObject({ fileType: 'pdf', title: 'Bid set.pdf' });
      expect(r.body.config.editorConfig.user.name).toBe('Guest');
      expect(r.body.config.editorConfig.customization.close).toBeUndefined();
      assertViewOnly(r.body.config);
    }
  });

  it('never joins an editing session: its own document key', async () => {
    const r = await request(mkApp()).get('/api/share/s-pdf/viewer');
    expect(r.body.config.document.key).toMatch(/^share-[0-9a-f]{40}$/);
    expect(r.body.config.document.key).not.toBe(documentKeyFor(getMeta(db, 'pdf1')!));
  });

  it("lets ONLYOFFICE download exactly the shared file, through the share link itself", async () => {
    const a = mkApp();
    const r = await request(a).get('/api/share/s-pdf/viewer');
    expect(r.body.config.document.url).toBe('http://app:3000/api/share/s-pdf');
    const file = await request(a).get(appPath(r.body.config.document.url));
    expect(file.status).toBe(200);
    expect(file.body.toString()).toBe('%PDF-1.7 bid set');
  });

  it('a viewer already opened loses the file once sharing stops (Phase 7)', async () => {
    const a = mkApp();
    const r = await request(a).get('/api/share/s-pdf/viewer');
    revokeShare(db, 's-pdf');
    expect((await request(a).get(appPath(r.body.config.document.url))).status).toBe(410);
  });

  it('leaves images, page sets and unknown shares to the page, and says when ONLYOFFICE is not set up', async () => {
    const a = mkApp();
    expect((await request(a).get('/api/share/s-img/viewer')).body.code).toBe('unsupported');
    expect((await request(a).get('/api/share/s-pages/viewer')).status).toBe(404);
    expect((await request(a).get('/api/share/nope/viewer')).status).toBe(404);
    const off = await request(mkApp({})).get('/api/share/s-pdf/viewer');
    expect([off.status, off.body.code]).toEqual([503, 'not-configured']);
  });
});

describe('mail attachments in the viewer', () => {
  let app: express.Express;
  let ctx: MailContext;
  let currentUser: { id: string; username: string; role: string };
  const services = () => createOnlyofficeServices({ env: ENV, appJwtSecret: 'app-secret', db, dataDir: dir });
  let tokens: ReturnType<typeof services>['tokens'];

  const envelope = (id: string) => ({
    providerMessageId: id, references: [], from: { addr: 'gc@tidewater.example', name: 'Mike' }, to: [{ addr: 'me@birchwood.example' }], cc: [], bcc: [],
    subject: 'Revised scope', snippet: 'see attached', date: '2026-09-20T10:00:00.000Z',
    isRead: false, isStarred: false, isDraft: false,
    attachments: [
      { attId: 'a1', name: 'Scope.docx', mime: DOCX, size: 9 },
      { attId: 'a2', name: 'Budget.xls', mime: 'application/octet-stream', size: 7 },
      { attId: 'a3', name: 'Plan.pdf', mime: 'application/pdf', size: 4 },
    ],
    sizeBytes: 10, folderProviderIds: ['INBOX'], messageIdHeader: `${id}@tidewater.example`, html: '<p>Hi</p>',
    attachmentBytes: { a1: Buffer.from('DOCX BODY'), a2: Buffer.from('XLS OLD'), a3: Buffer.from('%PDF') },
  });

  const mkApp = (env: Record<string, string> = ENV) => {
    const a = express();
    a.use(express.json());
    registerMailRoutes(a, {
      ctx,
      authenticateToken: (req: any, _r, next) => { req.user = currentUser; next(); },
      requireAdmin: (_req, _res, next) => next(),
      verifyToken: () => null,
      bodyCache: new BodyCache({ maxBytes: 1e6, ttlMs: 1e5 }),
      publicUrl: null, env: {}, jwtSecret: 'x',
      attachmentViewer: createAttachmentViewer(env, tokens),
    });
    return a;
  };

  beforeEach(() => {
    resetFakes();
    currentUser = { id: 'u1', username: 'noah', role: 'admin' };
    tokens = services().tokens;
    const acct = accounts.createAccount(db, new MailCrypto(Buffer.alloc(32, 3)), { userId: 'u1', provider: 'fake', emailAddress: 'me@birchwood.example', auth: { refreshToken: 'r' } });
    const provider = getFakeProvider(acct.id);
    provider.seed([envelope('m1')]);
    ctx = { db, dataDir: dir, crypto: new MailCrypto(Buffer.alloc(32, 3)), providerFactory: x => getFakeProvider(x.id), broadcastChange: () => {} };
    ctx.scheduler = new MailScheduler(ctx);
    upsertFolders(db, acct.id, provider.folders);
    upsertEnvelopes(ctx, acct, [envelope('m1')]);
    app = mkApp();
  });
  afterEach(async () => { await ctx.scheduler!.stop(); });

  const messageId = () => (db.prepare('SELECT id FROM mail_messages').get() as { id: string }).id;
  const open = (attId: string, body: object = {}) => request(app).post(`/api/mail/messages/${messageId()}/attachments/${attId}/viewer`).send(body);

  it('opens a Word attachment view only, as its owner, and ONLYOFFICE can fetch it', async () => {
    const r = await open('a1');
    expect(r.status).toBe(200);
    expect(r.body.file).toEqual({ name: 'Scope.docx', ext: 'docx' });
    expect(r.body.config.type).toBe('desktop');
    expect(r.body.config.document).toMatchObject({ fileType: 'docx', title: 'Scope.docx' });
    expect(r.body.config.document.key).toMatch(/^mail-[0-9a-f]{40}$/);
    expect(r.body.config.editorConfig.user).toEqual({ id: 'u1', name: 'noah' });
    assertViewOnly(r.body.config);
    const file = await request(app).get(appPath(r.body.config.document.url)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect((file.body as Buffer).toString()).toBe('DOCX BODY');
  });

  it('knows an old format by its name, and gives phones the phone viewer', async () => {
    const r = await open('a2', { device: 'phone' });
    expect(r.body.config).toMatchObject({ type: 'mobile', document: { fileType: 'xls' } });
  });

  it('leaves PDFs to the browser, other people out, and says when ONLYOFFICE is not set up', async () => {
    expect((await open('a3')).status).toBe(415);
    expect((await open('nope')).status).toBe(404);
    currentUser = { id: 'u2', username: 'maria', role: 'user' };
    expect((await open('a1')).status).toBe(404);
    currentUser = { id: 'u1', username: 'noah', role: 'admin' };
    app = mkApp({});
    const off = await open('a1');
    expect([off.status, off.body.code]).toEqual([503, 'not-configured']);
  });

  it("the download link opens that one attachment, for an hour, and nothing else", async () => {
    const r = await open('a1');
    const url = new URL(r.body.config.document.url);
    const t = url.searchParams.get('t')!;
    const id = messageId();
    const get = (m: string, a: string, token: string) => request(app).get(`/api/mail/viewer-file/${m}/${a}`).query({ t: token });
    expect((await get(id, 'a1', t)).status).toBe(200);
    // Another attachment, another message, no token, a login-style token, or an expired one: refused.
    expect((await get(id, 'a2', t)).status).toBe(403);
    expect((await get('other-message', 'a1', t)).status).toBe(403);
    expect((await get(id, 'a1', '')).status).toBe(403);
    expect((await get(id, 'a1', jwt.sign({ id: 'u1' }, 'app-secret'))).status).toBe(403);
    expect((await get(id, 'a1', tokens.sign(mailAttachmentSubject(id, 'a1'), -10))).status).toBe(403);
    const exp = (jwt.decode(t) as { exp: number; iat: number });
    expect(exp.exp - exp.iat).toBe(3600);
  });
});
