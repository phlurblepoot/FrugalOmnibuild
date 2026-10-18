// server/mail/routes.test.ts  (spec §4.4)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { createProject } from '../projectStore';
import { saveCustomer } from '../customerStore';
import { MailCrypto } from './crypto';
import { createLink } from './links';
import * as accounts from './accountStore';
import { FakeMailProvider } from './providers/fake';
import { getFakeProvider, resetFakes } from './providers/fakeRegistry';
import { registerMailRoutes, createWebhookRateLimit, WEBHOOK_MAX_BODY_BYTES, WEBHOOK_RATE_LIMIT_PER_MIN, type MailRouteDeps } from './routes';
import { getWebhookSecret, getGooglePushSecret, ensureGmailWatch, GOOGLE_WEBHOOK_PATH, type GmailWatchApi } from './push';
import { signState, verifyState } from './oauth';
import { BodyCache } from './sync/bodyCache';
import { MailScheduler } from './sync/scheduler';
import { upsertFolders, upsertEnvelopes } from './sync/engine';
import type { MailContext } from './context';

let db: Database.Database;
let dir: string;
let app: express.Express;
let ctx: MailContext;
let acct: accounts.MailAccountRow;
let provider: FakeMailProvider;
let routeEnv: NodeJS.ProcessEnv;
const JWT_SECRET = 'test-jwt-secret';
// Swapped per test so a callback never touches a real provider.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let oauthStub: MailRouteDeps['oauthExchange'];
const crypto = new MailCrypto(Buffer.alloc(32, 6));
let currentUser = { id: 'u1', role: 'admin' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = (id: string, o: any = {}) => ({
  providerMessageId: id, references: [], from: { addr: 'gc@tidewater.example', name: 'Mike' }, to: [{ addr: 'me@birchwood.example' }], cc: [], bcc: [],
  subject: 'CO 4', snippet: 'hello', date: '2026-08-10T10:00:00.000Z',
  isRead: false, isStarred: false, isDraft: false,
  attachments: [{ attId: 'a1', name: 'cor.pdf', mime: 'application/pdf', size: 4 }],
  sizeBytes: 10, folderProviderIds: ['INBOX'], messageIdHeader: id + '@tidewater.example',
  html: '<p>Hi <img src="https://x/y.png"></p>', attachmentBytes: { a1: Buffer.from('%PDF') }, ...o,
});

const firstMessageId = () => (db.prepare('SELECT id FROM mail_messages').get() as { id: string }).id;

beforeEach(() => {
  resetFakes();
  currentUser = { id: 'u1', role: 'admin' };
  routeEnv = {};
  oauthStub = async () => ({ refreshToken: 'RT', accessToken: 'AT', email: 'oauth@birchwood.example', name: 'OAuth Nick' });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mr-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin'), ('u2','b','x','user')`).run();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createProject(db, { id: 'p1', name: 'P', createdAt: 1, pages: [], takeoffs: [] } as any);
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@birchwood.example', auth: { refreshToken: 'r' } });
  provider = getFakeProvider(acct.id);
  provider.seed([env('m1')]);
  ctx = { db, dataDir: dir, crypto, providerFactory: a => getFakeProvider(a.id), broadcastChange: () => {} };
  ctx.scheduler = new MailScheduler(ctx);
  upsertFolders(db, acct.id, provider.folders);
  upsertEnvelopes(ctx, acct, [env('m1')]);
  app = express();
  // Mirrors server.ts: the app-level parser steps aside for the two mail paths
  // that bring their own (the upload stream, and the webhook's 256 KB cap).
  const appJson = express.json({ limit: '50mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/mail/uploads') || req.path === '/api/mail/ms/webhook' || req.path === GOOGLE_WEBHOOK_PATH ? next() : appJson(req, res, next)));
  registerMailRoutes(app, {
    ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authenticateToken: (req: any, _r, next) => { req.user = currentUser; next(); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requireAdmin: (req: any, res, next) => (req.user.role === 'admin' ? next() : res.status(403).end()),
    verifyToken: t => (t === 'tok' ? currentUser : null),
    bodyCache: new BodyCache({ maxBytes: 1e6, ttlMs: 1e5 }),
    publicUrl: 'https://app.test',
    env: routeEnv,
    jwtSecret: JWT_SECRET,
    oauthExchange: (...args) => oauthStub!(...args),
  });
});

afterEach(async () => {
  // Routes can start sync workers (POST /accounts/:id/test) and fire background
  // backfills (load-older); drain them so no timer outlives the test.
  await ctx.scheduler!.stop();
});

// A second app with its own dep overrides — used by the OAuth flow tests and by
// the webhook tests that need an app WITHOUT an app-level JSON parser.
const altApp = (over: Partial<MailRouteDeps> = {}, opts: { json?: boolean } = {}) => {
  const a = express();
  if (opts.json !== false) a.use(express.json());
  registerMailRoutes(a, {
    ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authenticateToken: (req: any, _r, next) => { req.user = currentUser; next(); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requireAdmin: (req: any, res, next) => (req.user.role === 'admin' ? next() : res.status(403).end()),
    verifyToken: t => (t === 'tok' ? currentUser : null),
    bodyCache: new BodyCache({ maxBytes: 1e6, ttlMs: 1e5 }),
    publicUrl: 'https://app.test',
    env: routeEnv,
    jwtSecret: JWT_SECRET,
    oauthExchange: (...args) => oauthStub!(...args),
    ...over,
  });
  return a;
};

describe('mail routes', () => {
  it('GET /api/mail/accounts lists own accounts without secrets', async () => {
    const r = await request(app).get('/api/mail/accounts');
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ id: acct.id, emailAddress: 'me@birchwood.example', isDefault: 1, unreadCount: 1 });
    expect(r.body[0].authBlob).toBeUndefined();
    // acct is a 'fake' provider (see beforeEach), so it never gets imapAuth.
    expect(r.body[0].imapAuth).toBeUndefined();
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/accounts')).body).toEqual([]);
  });

  it('GET /api/mail/accounts gives imap rows their non-secret auth fields for edit prefill, never a password', async () => {
    const created = (await request(app).post('/api/mail/accounts/imap').send({
      emailAddress: 'imap@x.com', imapHost: 'imap.x.com', imapPort: 993, imapSecure: true,
      smtpHost: 'smtp.x.com', smtpPort: 587, smtpSecure: false, username: 'imapuser', password: 'sekrit',
    })).body;
    const r = await request(app).get('/api/mail/accounts');
    expect(r.status).toBe(200);
    const row = r.body.find((a: any) => a.id === created.id);
    expect(row.imapAuth).toEqual({
      imapHost: 'imap.x.com', imapPort: 993, imapSecure: true,
      smtpHost: 'smtp.x.com', smtpPort: 587, smtpSecure: false, username: 'imapuser',
    });
    // The password must never leave the server, in any shape, on this route.
    expect(JSON.stringify(r.body)).not.toContain('sekrit');
    expect(row.imapAuth.password).toBeUndefined();
    // Non-imap rows (the 'fake' account from beforeEach) carry no imapAuth at all.
    const fakeRow = r.body.find((a: any) => a.id === acct.id);
    expect(fakeRow.imapAuth).toBeUndefined();
  });

  it('POST /api/mail/accounts/imap creates a needs_review→ok account after test', async () => {
    const r = await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com', displayName: 'N', imapHost: 'imap.x', imapPort: 993, imapSecure: true, smtpHost: 'smtp.x', smtpPort: 587, smtpSecure: false, username: 'n', password: 'p' });
    expect(r.status).toBe(200);
    expect(r.body.provider).toBe('imap');
    expect(r.body.status).toBe('needs_review');
    const t = await request(app).post(`/api/mail/accounts/${r.body.id}/test`);
    expect(t.status).toBe(200);   // fake factory → always passes
    expect(accounts.getAccountAny(db, r.body.id)!.status).toBe('ok');
  });

  it('POST /api/mail/accounts/imap rejects a missing field and keeps the password on update', async () => {
    expect((await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com' })).status).toBe(400);
    const created = (await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com', imapHost: 'imap.x', smtpHost: 'smtp.x', username: 'n', password: 'secret' })).body;
    const upd = await request(app).post('/api/mail/accounts/imap').send({ id: created.id, emailAddress: 'n2@x.com', imapHost: 'imap.x', smtpHost: 'smtp.x', username: 'n' });
    expect(upd.status).toBe(200);
    expect(upd.body.emailAddress).toBe('n2@x.com');
    expect((accounts.readAuth(db, crypto, created.id) as accounts.ImapAuth).password).toBe('secret');
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).post('/api/mail/accounts/imap').send({ id: created.id, emailAddress: 'n3@x.com', imapHost: 'i', smtpHost: 's', username: 'n', password: 'p' })).status).toBe(404);
  });

  it('threads list + detail, scoped by owner', async () => {
    // Linking the thread to project 'p1' (named 'P' in beforeEach) exercises the
    // resolved `label` on both the threads-list chip payload and thread detail.
    await request(app).post('/api/mail/links').send({ threadKey: 'm1@tidewater.example', itemType: 'project', itemId: 'p1' });
    const folders = (await request(app).get('/api/mail/folders').query({ accountId: acct.id })).body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inbox = folders.find((f: any) => f.role === 'inbox');
    const list = await request(app).get('/api/mail/threads').query({ accountId: acct.id, folderId: inbox.id });
    expect(list.status).toBe(200);
    expect(list.body.threads.length).toBe(1);
    expect(list.body.threads[0]).toMatchObject({ threadKey: 'm1@tidewater.example', unreadCount: 1, hasAttachments: 1, snippet: 'hello' });
    expect(list.body.threads[0].links).toMatchObject([{ itemType: 'project', itemId: 'p1', label: 'P' }]);
    const detail = await request(app).get(`/api/mail/threads/${acct.id}/${encodeURIComponent('m1@tidewater.example')}`);
    expect(detail.body.messages[0]).toMatchObject({ subject: 'CO 4', from: { addr: 'gc@tidewater.example' } });
    expect(detail.body.messages[0].providerMessageId).toBeUndefined();
    expect(detail.body.thread.links).toMatchObject([{ itemType: 'project', itemId: 'p1', label: 'P' }]);
    expect(detail.body.links).toMatchObject([{ itemType: 'project', itemId: 'p1', label: 'P' }]);
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id })).status).toBe(404);
    expect((await request(app).get('/api/mail/folders').query({ accountId: acct.id })).status).toBe(404);
    expect((await request(app).get(`/api/mail/threads/${acct.id}/${encodeURIComponent('m1@tidewater.example')}`)).status).toBe(404);
  });

  it('the folderId filter matches whole ids, not id prefixes', async () => {
    const inbox = db.prepare(`SELECT id FROM mail_folders WHERE accountId = ? AND role = 'inbox'`).get(acct.id) as { id: string };
    const prefix = inbox.id.slice(0, 8);
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, folderId: prefix })).body.threads.length).toBe(0);
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, folderId: inbox.id })).body.threads.length).toBe(1);
  });

  it('search filters by subject/from/snippet', async () => {
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, q: 'mike' })).body.threads.length).toBe(1);
    expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, q: 'zzz' })).body.threads.length).toBe(0);
  });

  it('GET /api/mail/search indexes provider hits older than the local window and names the threads it filed', async () => {
    provider.injectInbound(env('old1', { subject: 'ancient CO', date: '2020-01-01T00:00:00.000Z', messageIdHeader: 'old1@tidewater.example' }));
    const r = await request(app).get('/api/mail/search').query({ accountId: acct.id, q: 'ancient' });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(1);
    // The keys, not just a count: the hit is archived and matched on body text,
    // so nothing but asking for it BY KEY will show it to the user.
    expect(r.body.threadKeys).toEqual(['old1@tidewater.example']);
    expect(db.prepare('SELECT 1 FROM mail_messages WHERE messageIdHeader = ?').get('old1@tidewater.example')).toBeTruthy();
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/search').query({ accountId: acct.id, q: 'x' })).status).toBe(404);
  });

  // Why the bypass exists: Gmail matches body text the local LIKE cannot see,
  // and the hit is usually archived, so the active Inbox filter would hide it.
  describe('GET /api/mail/threads?threadKeys=', () => {
    const fileArchived = () => {
      provider.injectInbound(env('old1', { subject: 'ancient CO', date: '2020-01-01T00:00:00.000Z', messageIdHeader: 'old1@tidewater.example', folderProviderIds: ['ARCHIVE'] }));
      upsertEnvelopes(ctx, acct, [env('old1', { subject: 'ancient CO', date: '2020-01-01T00:00:00.000Z', messageIdHeader: 'old1@tidewater.example', folderProviderIds: ['ARCHIVE'] })]);
    };
    const inboxId = () => (db.prepare(`SELECT id FROM mail_folders WHERE accountId = ? AND role = 'inbox'`).get(acct.id) as { id: string }).id;

    it('returns exactly those threads, past the folder filter and the q filter', async () => {
      fileArchived();
      // Both filters would hide it on their own.
      expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, folderId: inboxId() })).body.threads.map((t: { threadKey: string }) => t.threadKey)).toEqual(['m1@tidewater.example']);
      expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, q: 'nothing-matches-this' })).body.threads.length).toBe(0);

      const r = await request(app).get('/api/mail/threads').query({
        accountId: acct.id, folderId: inboxId(), q: 'nothing-matches-this', threadKeys: 'old1@tidewater.example',
      });
      expect(r.status).toBe(200);
      expect(r.body.threads.map((t: { threadKey: string }) => t.threadKey)).toEqual(['old1@tidewater.example']);
    });

    it('accepts a comma-separated list or a repeated param, newest first', async () => {
      fileArchived();
      const both = ['m1@tidewater.example', 'old1@tidewater.example'];
      const byComma = await request(app).get('/api/mail/threads').query({ accountId: acct.id, threadKeys: both.join(',') });
      expect(byComma.body.threads.map((t: { threadKey: string }) => t.threadKey)).toEqual(both);   // 2026 before 2020
      const byRepeat = await request(app).get(`/api/mail/threads?accountId=${acct.id}&threadKeys=${encodeURIComponent(both[0])}&threadKeys=${encodeURIComponent(both[1])}`);
      expect(byRepeat.body.threads.map((t: { threadKey: string }) => t.threadKey)).toEqual(both);
    });

    it('caps the key list at 50 rather than building an unbounded IN clause', async () => {
      const keys = Array.from({ length: 80 }, (_, i) => `k${i}`);
      // 'm1@tidewater.example' sits past the cap, so it must NOT come back.
      const r = await request(app).get('/api/mail/threads').query({ accountId: acct.id, threadKeys: [...keys, 'm1@tidewater.example'].join(',') });
      expect(r.status).toBe(200);
      expect(r.body.threads).toEqual([]);
      const under = await request(app).get('/api/mail/threads').query({ accountId: acct.id, threadKeys: [...keys.slice(0, 49), 'm1@tidewater.example'].join(',') });
      expect(under.body.threads.length).toBe(1);
    });

    it('is still owner-scoped', async () => {
      currentUser = { id: 'u2', role: 'user' };
      expect((await request(app).get('/api/mail/threads').query({ accountId: acct.id, threadKeys: 'm1@tidewater.example' })).status).toBe(404);
    });
  });

  it('body is sanitized with remote images blocked, cached, and images=1 allows them', async () => {
    const id = firstMessageId();
    const r = await request(app).get(`/api/mail/messages/${id}/body`);
    expect(r.status).toBe(200);
    expect(r.body.blockedRemoteImages).toBe(1);
    expect(r.body.html).toContain('data-blocked-src');
    provider.failNextWith(new Error('should not be called — cached'));
    expect((await request(app).get(`/api/mail/messages/${id}/body`)).status).toBe(200);
    provider.failNextWith(new Error('x'));
    await provider.listFolders().catch(() => {});   // clear the pending failure
    expect((await request(app).get(`/api/mail/messages/${id}/body`).query({ images: 1 })).body.blockedRemoteImages).toBe(0);
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get(`/api/mail/messages/${id}/body`)).status).toBe(404);
  });

  it('a message the provider has not filed yet is pending, not an error', async () => {
    // A send whose Sent Items read-back lost the race is indexed under a
    // "sent:" placeholder; asking the provider for it would 404 on the user's
    // own message.
    upsertEnvelopes(ctx, acct, [env('sent:out-9@birchwood.example', { messageIdHeader: 'out-9@birchwood.example', from: { addr: 'me@birchwood.example' }, subject: 'Pending one' })], { sentFromApp: true });
    const id = (db.prepare('SELECT id FROM mail_messages WHERE providerMessageId = ?').get('sent:out-9@birchwood.example') as { id: string }).id;

    const b = await request(app).get(`/api/mail/messages/${id}/body`);
    expect(b.status).toBe(202);
    expect(b.body).toEqual({ pending: true });

    const a = await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
    expect(a.status).toBe(404);
    expect(a.body.error).toMatch(/still being filed/);
  });

  it('attachment streams with token auth and content-disposition; save persists to Documents', async () => {
    const id = firstMessageId();
    const r = await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('cor.pdf');
    expect((await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'bad' })).status).toBe(401);
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1', name: 'COR-4 signed.pdf', kind: 'document', projectId: 'p1' }] });
    expect(s.status).toBe(200);
    expect(s.body.fileIds.length).toBe(1);
    const f = db.prepare('SELECT name, kind, projectId, sourceType, sourceId FROM files WHERE id = ?').get(s.body.fileIds[0]);
    expect(f).toMatchObject({ name: 'COR-4 signed.pdf', kind: 'document', projectId: 'p1', sourceType: 'mailMessage', sourceId: id });
  });

  it('saved attachments default to the multi-instance email-attachment kind so two do not version each other', async () => {
    provider.seed([env('m1', { attachments: [{ attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 }, { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 }], attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('%PDF') } })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: [{ attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 }, { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 }] })]);
    const id = firstMessageId();
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1' }, { attId: 'a2' }] });
    expect(s.status).toBe(200);
    expect(s.body.fileIds.length).toBe(2);
    expect(new Set(s.body.fileIds).size).toBe(2);
    const rows = db.prepare('SELECT name, kind FROM files WHERE parentFileId IS NULL ORDER BY name').all();
    expect(rows).toEqual([{ name: 'one.pdf', kind: 'email-attachment' }, { name: 'two.pdf', kind: 'email-attachment' }]);
  });

  // The owner's real Gmail flow: pick several attachments, choose a type for them
  // (the modal ALWAYS sends a kind), Save. Each attachment is its own document.
  it('saves several attachments under one picked kind as SEPARATE documents, not versions', async () => {
    const atts = [
      { attId: 'a1', name: 'plan.pdf', mime: 'application/pdf', size: 4 },
      { attId: 'a2', name: 'site-1.jpg', mime: 'image/jpeg', size: 3 },
      { attId: 'a3', name: 'site-2.png', mime: 'image/png', size: 3 },
    ];
    const bytes = { a1: Buffer.from('%PDF'), a2: Buffer.from('JPG'), a3: Buffer.from('PNG') };
    provider.seed([env('m1', { attachments: atts, attachmentBytes: bytes })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: atts })]);
    const id = firstMessageId();
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`)
      .send({ items: atts.map(a => ({ attId: a.attId, kind: 'document', projectId: 'p1' })) });
    expect(s.status).toBe(200);
    expect(s.body.failed).toEqual([]);
    expect(s.body.saved.length).toBe(3);
    expect(new Set(s.body.fileIds).size).toBe(3);
    // Three live rows, zero version history.
    const live = db.prepare('SELECT name, kind, mime, versionNumber FROM files WHERE parentFileId IS NULL ORDER BY name').all();
    expect(live).toEqual([
      { name: 'plan.pdf', kind: 'document', mime: 'application/pdf', versionNumber: 1 },
      { name: 'site-1.jpg', kind: 'document', mime: 'image/jpeg', versionNumber: 1 },
      { name: 'site-2.png', kind: 'document', mime: 'image/png', versionNumber: 1 },
    ]);
    expect(db.prepare('SELECT COUNT(*) c FROM files WHERE parentFileId IS NOT NULL').get()).toEqual({ c: 0 });
  });

  it('saves attachments picked one at a time in SEPARATE requests as separate documents', async () => {
    const atts = [
      { attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 },
      { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 },
    ];
    provider.seed([env('m1', { attachments: atts, attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('%PDF') } })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: atts })]);
    const id = firstMessageId();
    const one = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1', kind: 'document' }] });
    const two = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a2', kind: 'document' }] });
    expect(one.body.failed).toEqual([]);
    expect(two.body.failed).toEqual([]);
    expect(one.body.fileIds[0]).not.toBe(two.body.fileIds[0]);
    expect((db.prepare('SELECT name FROM files WHERE parentFileId IS NULL ORDER BY name').all() as { name: string }[]).map(r => r.name))
      .toEqual(['one.pdf', 'two.pdf']);
  });

  // BUG (real Gmail, reported 2026-09-02): saving attachments one at a time
  // failed on every one after the first. The first save's stale-id recovery
  // rewrites attachmentsJson with the provider's fresh ids, and the next
  // request still carries the id the client rendered before that — which the
  // rewritten list no longer holds.
  it('saves a second attachment whose id the FIRST save re-keyed out of the indexed list', async () => {
    const atts = [
      { attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 },
      { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 },
    ];
    provider.seed([env('m1', { attachments: atts, attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('%PDF') } })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: atts })]);
    const id = firstMessageId();
    provider.rotateAttachmentIds('m1', a => `${a}-rotated`);
    const one = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1', kind: 'document' }] });
    expect(one.body.failed).toEqual([]);
    // The client still holds the pre-rotation id for a2: it rendered its chips
    // before the save above re-indexed the row.
    const two = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a2', kind: 'document' }] });
    expect(two.body.failed).toEqual([]);
    // Resolved through priorIds, so saved[] names the id the provider knows now.
    expect(two.body.saved).toEqual([{ attId: 'a2-rotated', fileId: two.body.fileIds[0] }]);
    expect((db.prepare('SELECT name FROM files WHERE parentFileId IS NULL ORDER BY name').all() as { name: string }[]).map(r => r.name))
      .toEqual(['one.pdf', 'two.pdf']);
    // An id that was never on this message is still an honest miss.
    const bad = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'never' }] });
    expect(bad.body.failed).toEqual([{ attId: 'never', error: 'That attachment is not on this message' }]);
  });

  // The client narrows its retry list by matching failed[].attId against the
  // chips it is showing, so a failure has to come back under the id it SENT —
  // not the fresher one the priorIds lookup resolved it to.
  it('reports a failure under the id the client sent, even after a re-key', async () => {
    const atts = [
      { attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 },
      { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 },
    ];
    provider.seed([env('m1', { attachments: atts, attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('%PDF') } })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: atts })]);
    const id = firstMessageId();
    provider.rotateAttachmentIds('m1', a => `${a}-rotated`);
    await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1', kind: 'document' }] });
    provider.failNextWith(new Error('provider blew up'));
    const two = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a2', kind: 'document' }] });
    expect(two.body.failed).toEqual([{ attId: 'a2', error: 'Could not save this attachment' }]);
  });

  // BUG (real Gmail, production logs 2026-09-11): picking several attachments
  // and saving them in ONE request saved the first and failed every later one
  // with ProviderNotFoundError. Gmail mints new attachment ids on every message
  // read, and both the provider (looking an unknown id up) and the route
  // (recovering from the 404) re-read the body — each read invalidating the
  // ids the other side was holding. A batch must cost ONE body read, and the
  // provider must never read the body on its own during it.
  it('saves a whole batch of attachments whose ids Gmail has rotated, paying for ONE body read', async () => {
    const atts = [
      { attId: 'a1', name: 'plan.pdf', mime: 'application/pdf', size: 4 },
      { attId: 'a2', name: 'site-1.jpg', mime: 'image/jpeg', size: 3 },
      { attId: 'a3', name: 'site-2.png', mime: 'image/png', size: 3 },
    ];
    const bytes = { a1: Buffer.from('%PDF'), a2: Buffer.from('JPG'), a3: Buffer.from('PNG') };
    provider.seed([env('m1', { attachments: atts, attachmentBytes: bytes })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: atts })]);
    const id = firstMessageId();
    provider.gmailAttachmentIds = true;
    // The ids the row carries are the ones sync saw; the mailbox has moved on.
    provider.rotateAttachmentIds('m1', a => `${a}-stale`);
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`)
      .send({ items: atts.map(a => ({ attId: a.attId, kind: 'document', projectId: 'p1' })) });
    expect(s.status).toBe(200);
    expect(s.body.failed).toEqual([]);
    // Every item was served under the id the batch's ONE read minted.
    expect(s.body.saved.map((x: { attId: string }) => x.attId)).toEqual(['a1-stale-gen1', 'a2-stale-gen1', 'a3-stale-gen1']);
    expect(provider.bodyReads).toBe(1);
    const live = db.prepare('SELECT name, mime FROM files WHERE parentFileId IS NULL ORDER BY name').all();
    expect(live).toEqual([
      { name: 'plan.pdf', mime: 'application/pdf' },
      { name: 'site-1.jpg', mime: 'image/jpeg' },
      { name: 'site-2.png', mime: 'image/png' },
    ]);
    // The row now carries the live ids, each still answering to the id it replaced.
    const row = JSON.parse((db.prepare('SELECT attachmentsJson FROM mail_messages WHERE id = ?').get(id) as { attachmentsJson: string }).attachmentsJson);
    expect(row.map((a: { attId: string; priorIds?: string[] }) => [a.attId, a.priorIds])).toEqual([['a1-stale-gen1', ['a1']], ['a2-stale-gen1', ['a2']], ['a3-stale-gen1', ['a3']]]);
  });

  // The body route hands the client the ids of the read it just did (and
  // builds inline-image URLs from them), but never wrote them into the row —
  // so the download route, resolving against the row, 404'd on the very id
  // the body had just given out. Production: "Failed to load attachment …
  // ProviderNotFoundError" for every inline image.
  it('downloads an attachment under the id the body route returned, even when Gmail rotated it', async () => {
    const atts = [
      { attId: 'a1', name: 'cor.pdf', mime: 'application/pdf', size: 4 },
      { attId: 'a2', name: 'logo.png', mime: 'image/png', size: 3, contentId: 'logo@x' },
    ];
    provider.seed([env('m1', { attachments: atts, attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('PNG') }, html: '<p>Hi <img src="cid:logo@x"></p>' })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: atts })]);
    const id = firstMessageId();
    provider.gmailAttachmentIds = true;
    const b = await request(app).get(`/api/mail/messages/${id}/body`);
    expect(b.status).toBe(200);
    expect(b.body.attachments.map((a: { attId: string }) => a.attId)).toEqual(['a1-gen1', 'a2-gen1']);
    // The inline image's URL carries the fresh id …
    const src = b.body.html.match(/src="([^"]+)"/)![1];
    expect(src).toBe(`/api/mail/messages/${id}/attachments/a2-gen1?inline=1`);
    // … and both that URL and the fresh attachment id resolve.
    const img = await request(app).get(src).query({ token: 'tok' });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');
    const pdf = await request(app).get(`/api/mail/messages/${id}/attachments/a1-gen1`).query({ token: 'tok' });
    expect(pdf.status).toBe(200);
    // The id the row held before still works too, for a client that rendered
    // its chips from the thread list rather than the body.
    expect((await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' })).status).toBe(200);
    // All of that on the single read the body route did.
    expect(provider.bodyReads).toBe(1);
    const row = JSON.parse((db.prepare('SELECT attachmentsJson FROM mail_messages WHERE id = ?').get(id) as { attachmentsJson: string }).attachmentsJson);
    expect(row.map((a: { attId: string; priorIds?: string[] }) => [a.attId, a.priorIds])).toEqual([['a1-gen1', ['a1']], ['a2-gen1', ['a2']]]);
  });

  it('the body route leaves the row alone when the provider returned the ids it already holds', async () => {
    const id = firstMessageId();
    const before = (db.prepare('SELECT attachmentsJson FROM mail_messages WHERE id = ?').get(id) as { attachmentsJson: string }).attachmentsJson;
    expect((await request(app).get(`/api/mail/messages/${id}/body`)).status).toBe(200);
    expect((db.prepare('SELECT attachmentsJson FROM mail_messages WHERE id = ?').get(id) as { attachmentsJson: string }).attachmentsJson).toBe(before);
  });

  it('saving from a message the provider has not filed yet fails readably per item, without asking the provider', async () => {
    upsertEnvelopes(ctx, acct, [env('sent:out-9@birchwood.example', { messageIdHeader: 'out-9@birchwood.example', from: { addr: 'me@birchwood.example' }, subject: 'Pending one' })], { sentFromApp: true });
    const id = (db.prepare('SELECT id FROM mail_messages WHERE providerMessageId = ?').get('sent:out-9@birchwood.example') as { id: string }).id;
    const getAttachment = vi.spyOn(provider, 'getAttachment');
    const getBody = vi.spyOn(provider, 'getBody');
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1', kind: 'document' }, { attId: 'a2' }] });
    // 200 with every item failed, not a 4xx: the client's save modal only
    // understands the {saved, failed} shape — anything else throws past its toast.
    expect(s.status).toBe(200);
    expect(s.body.saved).toEqual([]);
    expect(s.body.fileIds).toEqual([]);
    expect(s.body.failed).toEqual([
      { attId: 'a1', error: 'This message is still being filed by the mail server — try again in a minute' },
      { attId: 'a2', error: 'This message is still being filed by the mail server — try again in a minute' },
    ]);
    expect(getAttachment).not.toHaveBeenCalled();
    expect(getBody).not.toHaveBeenCalled();
  });

  it('attachment save is per item: one failure does not discard the others', async () => {
    const twoAtts = [{ attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 }, { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 }];
    provider.seed([env('m1', { attachments: twoAtts, attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('%PDF') } })]);
    upsertEnvelopes(ctx, acct, [env('m1', { attachments: twoAtts })]);
    const id = firstMessageId();
    provider.failNextWith(new Error('provider blew up on the first fetch'));
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1' }, { attId: 'a2' }] });
    expect(s.status).toBe(200);
    expect(s.body.fileIds.length).toBe(1);
    expect(s.body.saved).toEqual([{ attId: 'a2', fileId: s.body.fileIds[0] }]);
    expect(s.body.failed).toEqual([{ attId: 'a1', error: 'Could not save this attachment' }]);
    // The one that worked really landed in Documents; the raw provider message never leaks.
    expect((db.prepare('SELECT name FROM files WHERE id = ?').get(s.body.fileIds[0]) as { name: string }).name).toBe('two.pdf');
    expect(JSON.stringify(s.body)).not.toContain('blew up');
  });

  it('attachment save reports an attId that is not on the message instead of skipping it', async () => {
    const id = firstMessageId();
    const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'nope' }, { attId: 'a1' }] });
    expect(s.status).toBe(200);
    expect(s.body.saved.length).toBe(1);
    expect(s.body.failed).toEqual([{ attId: 'nope', error: 'That attachment is not on this message' }]);
  });

  // Gmail mints attachment ids per message fetch, so the ids indexed at sync
  // time routinely 404 days later. Both attachment routes have to recover.
  describe('a stale provider attachment id', () => {
    const attsOf = (id: string) =>
      JSON.parse((db.prepare('SELECT attachmentsJson FROM mail_messages WHERE id = ?').get(id) as { attachmentsJson: string }).attachmentsJson);

    it('is re-resolved by the download route, which then re-indexes the fresh ids', async () => {
      const id = firstMessageId();
      provider.rotateAttachmentIds('m1', a => `${a}-rotated`);
      const r = await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
      expect(r.status).toBe(200);
      expect(r.headers['content-disposition']).toContain('cor.pdf');
      expect(r.body.toString()).toBe('%PDF');
      // Re-indexed, so the NEXT click resolves without the extra round trip.
      // priorIds keeps the id the client is still holding resolvable — see wantedAttachment.
      expect(attsOf(id)).toEqual([{ attId: 'a1-rotated', name: 'cor.pdf', mime: 'application/pdf', size: 4, priorIds: ['a1'] }]);
      const again = await request(app).get(`/api/mail/messages/${id}/attachments/a1-rotated`).query({ token: 'tok' });
      expect(again.status).toBe(200);
    });

    it('is re-resolved by the save route, so the file still lands in Documents', async () => {
      const id = firstMessageId();
      provider.rotateAttachmentIds('m1', a => `${a}-rotated`);
      const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1', name: 'COR-4.pdf', kind: 'document', projectId: 'p1' }] });
      expect(s.status).toBe(200);
      expect(s.body.failed).toEqual([]);
      // The FRESH id: the client sent 'a1', but that is not what served the bytes.
      expect(s.body.saved).toEqual([{ attId: 'a1-rotated', fileId: s.body.fileIds[0] }]);
      expect((db.prepare('SELECT name FROM files WHERE id = ?').get(s.body.fileIds[0]) as { name: string }).name).toBe('COR-4.pdf');
      expect(attsOf(id)).toEqual([{ attId: 'a1-rotated', name: 'cor.pdf', mime: 'application/pdf', size: 4, priorIds: ['a1'] }]);
    });

    // The bug this pins: the first recovery rewrites attachmentsJson, so a
    // helper that re-read the row per item could no longer find item 2's stale
    // id and rethrew its 404. Both items must land.
    it('recovers EVERY item of a multi-attachment save, not just the first', async () => {
      const atts = [
        { attId: 'a1', name: 'one.pdf', mime: 'application/pdf', size: 4 },
        { attId: 'a2', name: 'two.pdf', mime: 'application/pdf', size: 4 },
      ];
      provider.seed([env('m1', { attachments: atts, attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('%PDF') } })]);
      upsertEnvelopes(ctx, acct, [env('m1', { attachments: atts })]);
      const id = firstMessageId();
      provider.rotateAttachmentIds('m1', a => `${a}-rotated`);
      const body = vi.spyOn(provider, 'getBody');

      const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1' }, { attId: 'a2' }] });
      expect(s.status).toBe(200);
      expect(s.body.failed).toEqual([]);
      expect(s.body.fileIds.length).toBe(2);
      // saved[] names the id the provider actually served, not the dead one.
      expect(s.body.saved.map((x: { attId: string }) => x.attId)).toEqual(['a1-rotated', 'a2-rotated']);
      expect((db.prepare('SELECT name FROM files ORDER BY name').all() as { name: string }[]).map(r => r.name)).toEqual(['one.pdf', 'two.pdf']);
      // One re-read for the batch, not one per item.
      expect(body).toHaveBeenCalledTimes(1);
      body.mockRestore();
    });

    it('broadcasts the thread so open clients drop the dead ids they are showing', async () => {
      const seen: unknown[] = [];
      ctx.broadcastChange = ev => { seen.push(ev); };
      const id = firstMessageId();
      provider.rotateAttachmentIds('m1', a => `${a}-rotated`);
      await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
      expect(seen).toContainEqual({ type: 'mailThread', id: 'm1@tidewater.example', action: 'updated', byUserId: 'u1' });
    });

    it('matches by position + name when two attachments share a name but not a size', async () => {
      const atts = [
        { attId: 'a1', name: 'plan.pdf', mime: 'application/pdf', size: 4 },
        { attId: 'a2', name: 'plan.pdf', mime: 'application/pdf', size: 9 },
      ];
      provider.seed([env('m1', { attachments: atts, attachmentBytes: { a1: Buffer.from('%PDF'), a2: Buffer.from('%PDF12345') } })]);
      upsertEnvelopes(ctx, acct, [env('m1', { attachments: atts })]);
      const id = firstMessageId();
      provider.rotateAttachmentIds('m1', a => `${a}-x`);
      const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a2' }] });
      expect(s.body.failed).toEqual([]);
      // The 9-byte twin, not the 4-byte one.
      expect((db.prepare('SELECT size FROM files WHERE id = ?').get(s.body.fileIds[0]) as { size: number }).size).toBe(9);
    });

    it('still fails honestly when the attachment is genuinely gone', async () => {
      const id = firstMessageId();
      // The message now has no attachment answering to the indexed name.
      provider.seed([env('m1', { attachments: [], attachmentBytes: {} })]);
      const r = await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
      expect(r.status).toBe(502);
      const s = await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1' }] });
      expect(s.body.saved).toEqual([]);
      expect(s.body.failed).toEqual([{ attId: 'a1', error: 'Could not save this attachment' }]);
    });
  });

  it('the attachment stream is released when the client goes away mid-download', async () => {
    const id = firstMessageId();
    const endless = new Readable({ read() { this.push(Buffer.alloc(64 * 1024)); } });
    const destroyed = new Promise<void>(resolve => { endless.on('close', () => resolve()); });
    vi.spyOn(provider, 'getAttachment').mockResolvedValue({ stream: endless, mime: 'application/pdf', size: 0, name: 'endless.pdf' });
    const pending = request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' });
    pending.end(() => {});   // superagent is lazy — actually put the request on the wire
    // Let the response start flowing, then hang up the way a navigating browser does.
    await new Promise(r => setTimeout(r, 50));
    pending.abort();
    await expect(destroyed).resolves.toBeUndefined();
    expect(endless.destroyed).toBe(true);
  });

  it('another user cannot read or save a message they do not own', async () => {
    const id = firstMessageId();
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get(`/api/mail/messages/${id}/attachments/a1`).query({ token: 'tok' })).status).toBe(404);
    expect((await request(app).post(`/api/mail/messages/${id}/attachments/save`).send({ items: [{ attId: 'a1' }] })).status).toBe(404);
  });

  it('actions apply locally + to the provider and revert on provider failure', async () => {
    const id = firstMessageId();
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'read' })).status).toBe(200);
    expect((db.prepare('SELECT isRead FROM mail_messages').get() as { isRead: number }).isRead).toBe(1);
    provider.failNextWith(new Error('down'));
    const r = await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'star' });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('Mail provider request failed');   // §7: never echo the provider's raw message
    expect(JSON.stringify(r.body)).not.toContain('down');
    expect((db.prepare('SELECT isStarred FROM mail_messages').get() as { isStarred: number }).isStarred).toBe(0);
    expect((await request(app).post('/api/mail/threads/actions').send({ accountId: acct.id, threadKeys: ['m1@tidewater.example'], action: 'archive' })).status).toBe(200);
    expect(JSON.parse((db.prepare('SELECT folderIdsJson FROM mail_messages').get() as { folderIdsJson: string }).folderIdsJson))
      .toEqual([(db.prepare(`SELECT id FROM mail_folders WHERE role='archive'`).get() as { id: string }).id]);
  });

  // An IMAP MOVE re-numbers the message. If the row kept the old provider id it
  // would resolve to nothing and the next poll would index the moved copy again.
  it('archive re-keys the row to the provider id the message now has', async () => {
    const id = firstMessageId();
    provider.archive = async (ids: string[]) => ids.map(from => ({ from, to: 'Archive 9 77' }));
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'archive' })).status).toBe(200);
    const row = db.prepare('SELECT providerMessageId, folderIdsJson FROM mail_messages WHERE id = ?').get(id) as { providerMessageId: string; folderIdsJson: string };
    expect(row.providerMessageId).toBe('Archive 9 77');
    expect(JSON.parse(row.folderIdsJson)).toEqual([(db.prepare(`SELECT id FROM mail_folders WHERE role='archive'`).get() as { id: string }).id]);
  });

  it('trash drops the row when the provider cannot say where the message went', async () => {
    const id = firstMessageId();
    provider.trash = async (ids: string[]) => ids.map(from => ({ from, to: null }));
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'trash' })).status).toBe(200);
    expect(db.prepare('SELECT id FROM mail_messages WHERE id = ?').get(id)).toBeUndefined();
    // the thread rollup is rebuilt, not left pointing at a message that is gone
    expect(db.prepare('SELECT id FROM mail_threads').get()).toBeUndefined();
  });

  // Gmail has no Archive mailbox — archiving is "drop the Inbox label" — so a
  // 400 here would put Archive out of reach for every Gmail account.
  it('archives a mailbox that has no Archive folder by dropping the inbox', async () => {
    db.prepare(`DELETE FROM mail_folders WHERE accountId = ? AND role = 'archive'`).run(acct.id);
    const inboxId = (db.prepare(`SELECT id FROM mail_folders WHERE accountId = ? AND role = 'inbox'`).get(acct.id) as { id: string }).id;
    const id = firstMessageId();
    let archived: string[] = [];
    provider.archive = async (ids: string[]) => { archived = ids; return ids.map(from => ({ from, to: from })); };

    const r = await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'archive' });
    expect(r.status).toBe(200);
    expect(archived).toHaveLength(1);
    const row = db.prepare('SELECT folderIdsJson FROM mail_messages WHERE id = ?').get(id) as { folderIdsJson: string };
    expect(JSON.parse(row.folderIdsJson)).not.toContain(inboxId);
  });

  // Trash and move still need one: there is nowhere to put the message.
  it('still refuses trash and move when the destination folder is missing', async () => {
    db.prepare(`DELETE FROM mail_folders WHERE accountId = ? AND role = 'trash'`).run(acct.id);
    const id = firstMessageId();
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'trash' })).status).toBe(400);
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'move', folderId: 'nope' })).status).toBe(400);
  });

  // A refused IMAP MOVE leaves the message exactly where it was. Reading that
  // as "moved, id unknown" would delete a message the server never touched.
  it('puts the row back when the provider reports the move failed', async () => {
    const id = firstMessageId();
    const inboxId = (db.prepare(`SELECT id FROM mail_folders WHERE accountId = ? AND role = 'inbox'`).get(acct.id) as { id: string }).id;
    const before = db.prepare('SELECT providerMessageId, folderIdsJson FROM mail_messages WHERE id = ?').get(id) as { providerMessageId: string; folderIdsJson: string };
    provider.trash = async (ids: string[]) => ids.map(from => ({ from, to: null, failed: true as const }));

    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'trash' })).status).toBe(200);
    const after = db.prepare('SELECT providerMessageId, folderIdsJson FROM mail_messages WHERE id = ?').get(id) as { providerMessageId: string; folderIdsJson: string };
    expect(after).toBeTruthy();                                   // NOT deleted
    expect(after.providerMessageId).toBe(before.providerMessageId);
    expect(JSON.parse(after.folderIdsJson)).toEqual([inboxId]);    // and back in the inbox
  });

  it('an unchanged mapping leaves the row alone', async () => {
    const id = firstMessageId();
    const before = (db.prepare('SELECT providerMessageId FROM mail_messages WHERE id = ?').get(id) as { providerMessageId: string }).providerMessageId;
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'archive' })).status).toBe(200);
    expect((db.prepare('SELECT providerMessageId FROM mail_messages WHERE id = ?').get(id) as { providerMessageId: string }).providerMessageId).toBe(before);
  });

  it('actions reject an unknown action and a message the caller does not own', async () => {
    const id = firstMessageId();
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'bogus' })).status).toBe(400);
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'move' })).status).toBe(400);
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).post('/api/mail/messages/actions').send({ ids: [id], action: 'read' })).status).toBe(404);
    expect((await request(app).post('/api/mail/threads/actions').send({ accountId: acct.id, threadKeys: ['m1@tidewater.example'], action: 'read' })).status).toBe(404);
  });

  it('send + drafts + links + unread + recipients + heartbeat + setup-info', async () => {
    const s = await request(app).post('/api/mail/send').send({ to: [{ addr: 'gc@tidewater.example' }], subject: 'Hi', html: '<p>x</p>', attachments: [] });
    expect(s.status).toBe(200);
    expect(s.body.threadKey).toBeTruthy();
    expect(provider.sent.length).toBe(1);
    const d = await request(app).post('/api/mail/drafts').send({ accountId: acct.id, to: [], subject: 'draft', html: '' });
    expect(d.status).toBe(200);
    expect(d.body.draftId).toBeTruthy();
    expect((await request(app).put(`/api/mail/drafts/${d.body.draftId}`).send({ accountId: acct.id, to: [], subject: 'draft2', html: '' })).status).toBe(200);
    expect((await request(app).delete(`/api/mail/drafts/${d.body.draftId}`).query({ accountId: acct.id })).status).toBe(200);
    const l = await request(app).post('/api/mail/links').send({ threadKey: s.body.threadKey, itemType: 'project', itemId: 'p1' });
    expect(l.status).toBe(200);
    const gl = await request(app).get('/api/mail/links').query({ itemType: 'project', itemId: 'p1' });
    expect(gl.body.length).toBe(1);
    expect(gl.body[0].label).toBe('P');
    expect((await request(app).delete(`/api/mail/links/${l.body.id}`)).status).toBe(200);
    expect((await request(app).get('/api/mail/unread-count')).body).toEqual({ total: 1, byAccount: { [acct.id]: 1 } });
    const rc = await request(app).get('/api/mail/recipients').query({ q: 'tidewater' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(rc.body.some((x: any) => x.addr === 'gc@tidewater.example')).toBe(true);
    expect((await request(app).post('/api/mail/heartbeat').send({ accountIds: [acct.id] })).status).toBe(204);
    const si = await request(app).get('/api/mail/setup-info');
    // These are the URIs an admin pastes into the provider console, so they must
    // be exactly what the real redirect builds.
    expect(si.body).toMatchObject({
      google: { configured: false, redirectUri: 'https://app.test/api/mail/oauth/google/callback' },
      microsoft: { configured: false, redirectUri: 'https://app.test/api/mail/oauth/microsoft/callback' },
    });
    // Pub/Sub is optional: unconfigured, the URL is still shown (an admin needs
    // it to create the subscription) but the topic is null.
    expect(si.body.google.pubsub).toEqual({
      configured: false,
      topic: null,
      webhookUrl: `https://app.test${GOOGLE_WEBHOOK_PATH}?token=${getGooglePushSecret(db)}`,
    });
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/setup-info')).status).toBe(403);
  });

  it('draft saves carry staged uploads and keep them, and reject oversize totals', async () => {
    const up = await request(app).post('/api/mail/uploads').query({ name: 'a.txt' }).set('content-type', 'text/plain').send(Buffer.from('hello'));
    expect(up.status).toBe(200);
    const d = await request(app).post('/api/mail/drafts').send({ accountId: acct.id, to: [], subject: 's', html: '', attachments: [{ uploadId: up.body.uploadId }] });
    expect(d.status).toBe(200);
    const saved = provider.drafts.get(d.body.draftId);
    expect(saved?.attachments.map(x => x.name)).toEqual(['a.txt']);
    expect(saved?.attachments[0].content.toString()).toBe('hello');
    const again = await request(app).put(`/api/mail/drafts/${d.body.draftId}`).send({ accountId: acct.id, to: [], subject: 's', html: '', attachments: [{ uploadId: up.body.uploadId }] });
    expect(again.status).toBe(200);   // still staged after the first save
    const bad = await request(app).post('/api/mail/drafts').send({ accountId: acct.id, to: [], subject: 's', html: '', attachments: [{ uploadId: '00000000-0000-0000-0000-000000000000' }] });
    expect(bad.status).toBe(400);
    const big = await request(app).post('/api/mail/uploads').query({ name: 'big.bin' }).set('content-type', 'application/octet-stream').send(Buffer.alloc(14 * 1024 * 1024));
    const big2 = await request(app).post('/api/mail/uploads').query({ name: 'big2.bin' }).set('content-type', 'application/octet-stream').send(Buffer.alloc(14 * 1024 * 1024));
    const over = await request(app).post('/api/mail/drafts').send({ accountId: acct.id, to: [], subject: 's', html: '', attachments: [{ uploadId: big.body.uploadId }, { uploadId: big2.body.uploadId }] });
    expect(over.status).toBe(413);
  });

  it('reopens a reply draft with its content and attachments, keeps it threaded, and send removes it', async () => {
    const draftEnv = env('dr1', {
      messageIdHeader: 'dr1@birchwood.example', inReplyTo: 'm1@tidewater.example', references: ['m1@tidewater.example'],
      from: { addr: 'me@birchwood.example' }, to: [{ addr: 'gc@tidewater.example', name: 'Mike' }], cc: [{ addr: 'pm@tidewater.example' }],
      subject: 'Re: CO 4', date: '2026-08-11T10:00:00.000Z', isRead: true, isDraft: true, folderProviderIds: ['DRAFTS'],
      html: '<p style="color:red">Draft text <img src="https://x/logo.png"><script>alert(1)</script></p>',
      attachments: [{ attId: 'da1', name: 'takeoff.pdf', mime: 'application/pdf', size: 4 }],
      attachmentBytes: { da1: Buffer.from('%PDF') },
    });
    provider.seed([env('m1'), draftEnv]);
    upsertEnvelopes(ctx, acct, [draftEnv]);
    const row = db.prepare("SELECT id, threadKey FROM mail_messages WHERE providerMessageId = 'dr1'").get() as { id: string; threadKey: string };
    const parentThread = (db.prepare("SELECT threadKey FROM mail_messages WHERE providerMessageId = 'm1'").get() as { threadKey: string }).threadKey;

    const r = await request(app).get(`/api/mail/messages/${row.id}/draft`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      accountId: acct.id, draftId: 'dr1', subject: 'Re: CO 4',
      to: [{ addr: 'gc@tidewater.example', name: 'Mike' }], cc: [{ addr: 'pm@tidewater.example' }],
      replyTo: { accountId: acct.id, threadKey: parentThread },
    });
    // Lightly cleaned: styles and remote images stay, script goes.
    expect(r.body.html).toContain('style="color:red"');
    expect(r.body.html).toContain('src="https://x/logo.png"');
    expect(r.body.html).not.toContain('script');
    // The draft's attachment comes back as a staged upload the next save can carry.
    expect(r.body.attachments).toEqual([{ uploadId: expect.any(String), name: 'takeoff.pdf', size: 4 }]);
    const uploadId = r.body.attachments[0].uploadId;

    // Saving updates the SAME provider draft and answers the parent, never the draft itself.
    const put = await request(app).put('/api/mail/drafts/dr1').send({
      accountId: acct.id, to: [{ addr: 'gc@tidewater.example' }], subject: 'Re: CO 4', html: '<p>edited</p>',
      attachments: [{ uploadId }], replyTo: r.body.replyTo,
    });
    expect(put.status).toBe(200);
    expect(put.body.draftId).toBe('dr1');
    const saved = provider.drafts.get('dr1')!;
    expect(saved.inReplyTo).toBe('m1@tidewater.example');
    expect(saved.references).toEqual(['m1@tidewater.example']);
    expect(saved.attachments.map(a => [a.name, a.content.toString()])).toEqual([['takeoff.pdf', '%PDF']]);

    const seen: Array<{ type: string; id: string }> = [];
    ctx.broadcastChange = ev => { seen.push(ev); };
    const s = await request(app).post('/api/mail/send').send({
      accountId: acct.id, to: [{ addr: 'gc@tidewater.example' }], subject: 'Re: CO 4', html: '<p>edited</p>',
      attachments: [{ uploadId }], replyTo: r.body.replyTo, draftProviderId: 'dr1',
    });
    expect(s.status).toBe(200);
    // The draft's local row is gone at once (not at the next sync), and the change was broadcast.
    expect(db.prepare("SELECT 1 FROM mail_messages WHERE providerMessageId = 'dr1'").get()).toBeUndefined();
    expect(seen.some(e => e.type === 'mailThread')).toBe(true);
    expect(provider.sent.at(-1)!.inReplyTo).toBe('m1@tidewater.example');
    expect(s.body.threadKey).toBe(parentThread);
    expect(provider.drafts.has('dr1')).toBe(false);
  });

  it('opening a draft refuses a non-draft and another user\'s message', async () => {
    const id = firstMessageId();
    expect((await request(app).get(`/api/mail/messages/${id}/draft`)).status).toBe(400);
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get(`/api/mail/messages/${id}/draft`)).status).toBe(404);
  });

  it('drafts routes are scoped to the caller\'s own account', async () => {
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).post('/api/mail/drafts').send({ accountId: acct.id, to: [], subject: 'x', html: '' })).status).toBe(404);
    expect((await request(app).put('/api/mail/drafts/d1').send({ accountId: acct.id, to: [], subject: 'x', html: '' })).status).toBe(404);
    expect((await request(app).delete('/api/mail/drafts/d1').query({ accountId: acct.id })).status).toBe(404);
  });

  it('recipients include customer role addresses with the customer name and role', async () => {
    saveCustomer(db, { id: 'c1', name: 'Tidewater Builders', contactName: 'Mike', emails: { accounting: { to: 'ap@tidewaterbuilders.example, ap2@tidewaterbuilders.example' }, general: { to: 'info@other.com' } } });
    const r = await request(app).get('/api/mail/recipients').query({ q: 'tidewaterbuilders' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hit = r.body.find((x: any) => x.addr === 'ap@tidewaterbuilders.example');
    expect(hit).toMatchObject({ customerId: 'c1', role: 'accounting' });
    expect(hit.source).toContain('Tidewater Builders');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(r.body.some((x: any) => x.addr === 'ap2@tidewaterbuilders.example')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(r.body.some((x: any) => x.addr === 'info@other.com')).toBe(false);
  });

  it('POST /api/mail/links validates itemType and backfills reply state from existing messages', async () => {
    expect((await request(app).post('/api/mail/links').send({ threadKey: 'm1@tidewater.example', itemType: 'nope', itemId: 'p1' })).status).toBe(400);
    expect((await request(app).post('/api/mail/links').send({ threadKey: 'm1@tidewater.example', itemId: 'p1' })).status).toBe(400);
    // Thread has one inbound message (from gc@tidewater.example) and one outbound (from the app account).
    upsertEnvelopes(ctx, acct, [env('m2', { messageIdHeader: 'm2@birchwood.example', inReplyTo: 'm1@tidewater.example', from: { addr: 'ME@birchwood.example', name: 'Me' }, date: '2026-08-11T10:00:00.000Z', folderProviderIds: ['SENT'] })]);
    const l = await request(app).post('/api/mail/links').send({ threadKey: 'm1@tidewater.example', itemType: 'project', itemId: 'p1' });
    expect(l.status).toBe(200);
    expect(l.body).toMatchObject({ itemType: 'project', itemId: 'p1', projectId: 'p1' });
    expect(db.prepare('SELECT lastInboundDate, lastOutboundDate FROM mail_thread_reply_state WHERE threadKey = ?').get('m1@tidewater.example'))
      .toEqual({ lastInboundDate: '2026-08-10T10:00:00.000Z', lastOutboundDate: '2026-08-11T10:00:00.000Z' });
  });

  it('links and their subject/participant snapshots are visible app-wide; only the linker or an admin can unlink', async () => {
    const l = await request(app).post('/api/mail/links').send({ threadKey: 'm1@tidewater.example', itemType: 'project', itemId: 'p1' });
    expect(l.status).toBe(200);
    expect(l.body.subjectSnapshot).toBe('CO 4');

    // u1 owns the account the thread lives in, so u1 sees the snapshot fields
    const owner = await request(app).get('/api/mail/links').query({ itemType: 'project', itemId: 'p1' });
    expect(owner.body[0].subjectSnapshot).toBe('CO 4');
    expect(JSON.parse(owner.body[0].participantsJson)).toBeInstanceOf(Array);

    // u2 owns no mailbox holding this thread, but the link's snapshot is app data
    // taken at link time (not a live mailbox read), so it is visible cross-user too —
    // that's exactly what the #5 cross-user-open resolve/reference-card flow needs.
    currentUser = { id: 'u2', role: 'user' };
    const other = await request(app).get('/api/mail/links').query({ itemType: 'project', itemId: 'p1' });
    expect(other.body.length).toBe(1);                       // the link itself is item data: still visible
    expect(other.body[0].id).toBe(l.body.id);
    expect(other.body[0].subjectSnapshot).toBe('CO 4');       // snapshot: visible to any viewer
    expect(JSON.parse(other.body[0].participantsJson)).toBeInstanceOf(Array);
    // Nothing beyond the link row + label + snapshot columns leaks through.
    expect(Object.keys(other.body[0]).sort()).toEqual(Object.keys(owner.body[0]).sort());

    const denied = await request(app).delete(`/api/mail/links/${l.body.id}`);
    expect(denied.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_thread_links').get()).toEqual({ c: 1 });

    currentUser = { id: 'u2', role: 'admin' };               // an admin who did not create it still may
    expect((await request(app).delete(`/api/mail/links/${l.body.id}`)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM mail_thread_links').get()).toEqual({ c: 0 });
  });

  it('POST /api/mail/send rejects an unknown itemType and an empty recipient list before anything is sent', async () => {
    const base = { to: [{ addr: 'gc@tidewater.example' }], subject: 's', html: '<p>h</p>', attachments: [] };
    const badLink = await request(app).post('/api/mail/send').send({ ...base, links: [{ itemType: 'nope', itemId: 'p1' }] });
    expect(badLink.status).toBe(400);
    expect(badLink.body.error).toBe('Invalid itemType');

    const badAtt = await request(app).post('/api/mail/send')
      .send({ ...base, attachments: [{ fileId: 'f1', itemType: 'nope', itemId: 'p1' }] });
    expect(badAtt.status).toBe(400);
    expect(badAtt.body.error).toBe('Invalid itemType');

    const noTo = await request(app).post('/api/mail/send').send({ ...base, to: [] });
    expect(noTo.status).toBe(400);

    expect(provider.sent.length).toBe(0);
  });

  it('GET /api/mail/links validates itemType and requires itemId', async () => {
    expect((await request(app).get('/api/mail/links').query({ itemType: 'nope', itemId: 'p1' })).status).toBe(400);
    expect((await request(app).get('/api/mail/links').query({ itemType: 'project' })).status).toBe(400);
    expect((await request(app).get('/api/mail/links').query({ itemType: 'project', itemId: 'p1' })).status).toBe(200);
  });

  // ── project-threads / resolve-thread (spec Goals 3 + 5) ──

  /** A second mailbox owned by u2, so "the caller's accounts" can be tested for
   *  what it excludes as well as what it finds. */
  const seedOtherUsersMailbox = () => {
    const a2 = accounts.createAccount(db, crypto, { userId: 'u2', provider: 'fake', emailAddress: 'other@birchwood.example', auth: { refreshToken: 'r' } });
    const p2 = getFakeProvider(a2.id);
    upsertFolders(db, a2.id, p2.folders);
    upsertEnvelopes(ctx, a2, [env('z1', { messageIdHeader: 'z1@tidewater.example', subject: 'Secret job', date: '2026-08-10T10:00:00.000Z' })]);
    return a2;
  };

  it('GET /api/mail/project-threads gives one row per thread with every link labeled, newest activity first', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createProject(db, { id: 'p2', name: 'Q', createdAt: 1, pages: [], takeoffs: [] } as any);
    saveCustomer(db, { id: 'c1', name: 'Birchwood', emails: {} });
    upsertEnvelopes(ctx, acct, [
      env('m2', { messageIdHeader: 'm2@tidewater.example', subject: 'Invoice 12', date: '2026-08-12T10:00:00.000Z' }),
      env('m3', { messageIdHeader: 'm3@tidewater.example', subject: 'Other job', date: '2026-08-13T10:00:00.000Z' }),
    ]);
    await request(app).post('/api/mail/links').send({ threadKey: 'm1@tidewater.example', itemType: 'project', itemId: 'p1' });
    await request(app).post('/api/mail/links').send({ threadKey: 'm1@tidewater.example', itemType: 'customer', itemId: 'c1' });
    await request(app).post('/api/mail/links').send({ threadKey: 'm2@tidewater.example', itemType: 'project', itemId: 'p1' });
    await request(app).post('/api/mail/links').send({ threadKey: 'm3@tidewater.example', itemType: 'project', itemId: 'p2' });
    // Pin the clock-derived columns so ordering is a fact, not a race.
    db.prepare("UPDATE mail_thread_links SET createdAt = '2026-08-14T00:00:00.000Z' WHERE threadKey = 'm1@tidewater.example'").run();
    db.prepare("UPDATE mail_thread_links SET createdAt = '2026-08-15T00:00:00.000Z' WHERE threadKey = 'm2@tidewater.example'").run();
    db.prepare("UPDATE mail_thread_reply_state SET lastInboundDate = '2026-08-20T00:00:00.000Z', lastOutboundDate = '2026-08-19T00:00:00.000Z' WHERE threadKey = 'm1@tidewater.example'").run();

    const r = await request(app).get('/api/mail/project-threads').query({ projectId: 'p1' });
    expect(r.status).toBe(200);
    expect(r.body.map((t: any) => t.threadKey)).toEqual(['m1@tidewater.example', 'm2@tidewater.example']);  // m3 is p2's, not p1's
    expect(r.body[0]).toMatchObject({
      threadKey: 'm1@tidewater.example', subjectSnapshot: 'CO 4', firstDate: '2026-08-10T10:00:00.000Z',
      lastInboundDate: '2026-08-20T00:00:00.000Z', lastOutboundDate: '2026-08-19T00:00:00.000Z',
      lastActivity: '2026-08-20T00:00:00.000Z',
      // Both m1 links (project + customer) were pinned to the same createdAt above.
      earliestLinkCreatedAt: '2026-08-14T00:00:00.000Z',
    });
    expect(r.body[0].participants).toEqual(expect.arrayContaining([{ addr: 'gc@tidewater.example', name: 'Mike' }]));
    // Every link on the key — the customer link too, though it carries no projectId.
    expect(r.body[0].links).toEqual([
      { itemType: 'project', itemId: 'p1', label: 'P' },
      { itemType: 'customer', itemId: 'c1', label: 'Birchwood' },
    ]);
    // m2 never got a reply-state bump past its own message, so the link date is its activity.
    expect(r.body[1]).toMatchObject({
      subjectSnapshot: 'Invoice 12', lastActivity: '2026-08-15T00:00:00.000Z', earliestLinkCreatedAt: '2026-08-15T00:00:00.000Z',
    });

    const other = await request(app).get('/api/mail/project-threads').query({ projectId: 'p2' });
    expect(other.body.map((t: any) => t.threadKey)).toEqual(['m3@tidewater.example']);

    // Viewer-independent by design: links are app data, so a user with no mailbox
    // at all sees the same rows (same trust model as GET /api/mail/links).
    currentUser = { id: 'u2', role: 'user' };
    const asOther = await request(app).get('/api/mail/project-threads').query({ projectId: 'p1' });
    expect(asOther.body).toEqual(r.body);
  });

  // Review finding 3 (fix round 1): the client's reply indicator floors on
  // this field (max(lastOutboundDate, earliestLinkCreatedAt)) so an
  // already-old thread just linked to the project doesn't read as an
  // unanswered reply. Proven here as the server's MIN across every link on
  // the key, independent of link/query order.
  it('GET /api/mail/project-threads.earliestLinkCreatedAt is the MIN createdAt across every link on the thread', async () => {
    // Two links on the SAME thread, deliberately created out of chronological
    // order so a naive "first row" read (rather than an actual MIN) would fail.
    await request(app).post('/api/mail/links').send({ threadKey: 'm5@tidewater.example', itemType: 'project', itemId: 'p1' });
    await request(app).post('/api/mail/links').send({ threadKey: 'm5@tidewater.example', itemType: 'customer', itemId: 'c1' });
    db.prepare("UPDATE mail_thread_links SET createdAt = '2026-08-20T00:00:00.000Z' WHERE threadKey = 'm5@tidewater.example' AND itemType = 'project'").run();
    db.prepare("UPDATE mail_thread_links SET createdAt = '2026-08-05T00:00:00.000Z' WHERE threadKey = 'm5@tidewater.example' AND itemType = 'customer'").run();

    const r = await request(app).get('/api/mail/project-threads').query({ projectId: 'p1' });
    const m5 = r.body.find((t: any) => t.threadKey === 'm5@tidewater.example');
    expect(m5).toBeTruthy();
    expect(m5.earliestLinkCreatedAt).toBe('2026-08-05T00:00:00.000Z');
  });

  it('GET /api/mail/project-threads requires projectId and is empty for a project with no linked mail', async () => {
    expect((await request(app).get('/api/mail/project-threads')).status).toBe(400);
    expect((await request(app).get('/api/mail/project-threads').query({ projectId: '' })).status).toBe(400);
    const r = await request(app).get('/api/mail/project-threads').query({ projectId: 'p1' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it('GET /api/mail/project-threads accepts a customerId filter instead of projectId, and rejects both/neither', async () => {
    saveCustomer(db, { id: 'c1', name: 'Birchwood', emails: {} });
    await request(app).post('/api/mail/links').send({ threadKey: 'm1@tidewater.example', itemType: 'customer', itemId: 'c1' });

    const byCustomer = await request(app).get('/api/mail/project-threads').query({ customerId: 'c1' });
    expect(byCustomer.status).toBe(200);
    expect(byCustomer.body.map((t: any) => t.threadKey)).toEqual(['m1@tidewater.example']);
    expect(byCustomer.body[0].links).toEqual([{ itemType: 'customer', itemId: 'c1', label: 'Birchwood' }]);

    // A customer with no linked mail is an empty list, not an error.
    saveCustomer(db, { id: 'c2', name: 'Nobody', emails: {} });
    const empty = await request(app).get('/api/mail/project-threads').query({ customerId: 'c2' });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    // Neither param, or both at once, is a 400 — exactly one is required.
    expect((await request(app).get('/api/mail/project-threads')).status).toBe(400);
    expect((await request(app).get('/api/mail/project-threads').query({ customerId: '' })).status).toBe(400);
    expect((await request(app).get('/api/mail/project-threads').query({ projectId: 'p1', customerId: 'c1' })).status).toBe(400);
  });

  it('GET /api/mail/resolve-thread matches an exact threadKey in the caller\'s own mailbox', async () => {
    const r = await request(app).get('/api/mail/resolve-thread').query({ threadKey: 'm1@tidewater.example' });
    expect(r.status).toBe(200);
    expect(r.body.match).toEqual({ accountId: acct.id, threadKey: 'm1@tidewater.example' });
  });

  it('GET /api/mail/resolve-thread falls back to normalized subject + a 3-day window + a shared participant', async () => {
    const q = { threadKey: 'not-mine@elsewhere', subject: 'Re: Re: CO 4', firstDate: '2026-08-11T00:00:00.000Z', participants: 'GC@tidewater.example, someone@else.com' };
    const hit = await request(app).get('/api/mail/resolve-thread').query(q);
    expect(hit.body.match).toEqual({ accountId: acct.id, threadKey: 'm1@tidewater.example' });

    const wrongSubject = await request(app).get('/api/mail/resolve-thread').query({ ...q, subject: 'CO 5' });
    expect(wrongSubject.body.match).toBeNull();

    const outOfWindow = await request(app).get('/api/mail/resolve-thread').query({ ...q, firstDate: '2026-08-14T11:00:00.000Z' });
    expect(outOfWindow.body.match).toBeNull();

    const noShared = await request(app).get('/api/mail/resolve-thread').query({ ...q, participants: 'nobody@else.com' });
    expect(noShared.body.match).toBeNull();

    const noParticipants = await request(app).get('/api/mail/resolve-thread').query({ ...q, participants: '' });
    expect(noParticipants.body.match).toBeNull();
  });

  it('GET /api/mail/resolve-thread never reaches into another user\'s mailbox', async () => {
    seedOtherUsersMailbox();
    const exact = await request(app).get('/api/mail/resolve-thread').query({ threadKey: 'z1@tidewater.example' });
    expect(exact.body.match).toBeNull();
    const fallback = await request(app).get('/api/mail/resolve-thread')
      .query({ threadKey: 'z1@tidewater.example', subject: 'Secret job', firstDate: '2026-08-10T10:00:00.000Z', participants: 'gc@tidewater.example' });
    expect(fallback.body.match).toBeNull();
    // ...and the owner of that mailbox does find it.
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/resolve-thread').query({ threadKey: 'z1@tidewater.example' })).body.match)
      .toMatchObject({ threadKey: 'z1@tidewater.example' });
  });

  it('GET /api/mail/resolve-thread caps subject length and participant count', async () => {
    const base = { subject: 'CO 4', firstDate: '2026-08-11T00:00:00.000Z', participants: 'gc@tidewater.example' };
    const longSubject = await request(app).get('/api/mail/resolve-thread').query({ ...base, subject: 'x'.repeat(501) });
    expect(longSubject.status).toBe(400);
    const manyParticipants = await request(app).get('/api/mail/resolve-thread')
      .query({ ...base, participants: Array.from({ length: 21 }, (_, i) => `a${i}@x.com`).join(',') });
    expect(manyParticipants.status).toBe(400);
    expect((await request(app).get('/api/mail/resolve-thread').query({ ...base, subject: 'x'.repeat(500) })).status).toBe(200);
  });

  // ── reply-flags (spec Goal 4) ──

  /** Links an item to a thread (no real mail_threads row required — same as an
   *  ITEM-view link in the project-threads tests) and pins createdAt so ordering
   *  is a fact, not a race. */
  const link = (threadKey: string, itemType: string, itemId: string, createdAt: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createLink(db, { threadKey, itemType: itemType as any, itemId, linkedByUserId: 'u1' });
    db.prepare('UPDATE mail_thread_links SET createdAt = ? WHERE threadKey = ? AND itemType = ? AND itemId = ?').run(createdAt, threadKey, itemType, itemId);
  };
  const replyState = (threadKey: string, inbound: string | null, outbound: string | null) => {
    db.prepare('INSERT INTO mail_thread_reply_state (threadKey, lastInboundDate, lastOutboundDate, updatedAt) VALUES (?,?,?,?)').run(threadKey, inbound, outbound, new Date().toISOString());
  };

  it('GET /api/mail/reply-flags flags an item whose last inbound reply is newer than the last outbound and the link itself', async () => {
    link('t-true@x', 'invoice', 'i-true', '2026-08-01T00:00:00.000Z');
    replyState('t-true@x', '2026-08-10T00:00:00.000Z', '2026-08-05T00:00:00.000Z');
    const r = await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice', itemIds: 'i-true' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ flagged: ['i-true'] });
  });

  it('GET /api/mail/reply-flags does not flag when the last outbound is newer than the last inbound', async () => {
    link('t-outbound@x', 'invoice', 'i-outbound', '2026-08-01T00:00:00.000Z');
    replyState('t-outbound@x', '2026-08-05T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
    const r = await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice', itemIds: 'i-outbound' });
    expect(r.body).toEqual({ flagged: [] });
  });

  it('GET /api/mail/reply-flags does not flag when the item was linked to the thread after the last inbound reply', async () => {
    // No outbound at all — but the link itself postdates the inbound message, i.e.
    // someone linked this thread to the item only after the customer's reply.
    link('t-linkedlate@x', 'invoice', 'i-linkedlate', '2026-08-10T00:00:00.000Z');
    replyState('t-linkedlate@x', '2026-08-05T00:00:00.000Z', null);
    const r = await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice', itemIds: 'i-linkedlate' });
    expect(r.body).toEqual({ flagged: [] });
  });

  it('GET /api/mail/reply-flags does not flag an item whose thread has no reply-state row', async () => {
    link('t-nostate@x', 'invoice', 'i-nostate', '2026-08-01T00:00:00.000Z');
    const r = await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice', itemIds: 'i-nostate' });
    expect(r.body).toEqual({ flagged: [] });
  });

  it('GET /api/mail/reply-flags does not flag an item with no link at all', async () => {
    const r = await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice', itemIds: 'i-nolink' });
    expect(r.body).toEqual({ flagged: [] });
  });

  it('GET /api/mail/reply-flags evaluates the rule against the NEWEST link, not any link', async () => {
    // The older link's thread would flag on its own (inbound after that link's
    // createdAt, no outbound) — but a newer link on a different thread exists for
    // the same item, and that thread's reply state does not satisfy the rule.
    link('t-old@x', 'invoice', 'i-newest', '2026-08-01T00:00:00.000Z');
    replyState('t-old@x', '2026-08-10T00:00:00.000Z', null);
    link('t-new@x', 'invoice', 'i-newest', '2026-08-15T00:00:00.000Z');
    replyState('t-new@x', '2026-08-16T00:00:00.000Z', '2026-08-20T00:00:00.000Z');
    const r = await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice', itemIds: 'i-newest' });
    expect(r.body).toEqual({ flagged: [] });
  });

  it('GET /api/mail/reply-flags validates itemType and rejects more than 100 itemIds', async () => {
    expect((await request(app).get('/api/mail/reply-flags').query({ itemType: 'nope', itemIds: 'a' })).status).toBe(400);
    expect((await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice' })).status).toBe(400);
    const manyIds = Array.from({ length: 101 }, (_, i) => `i${i}`).join(',');
    expect((await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice', itemIds: manyIds })).status).toBe(400);
    const cappedIds = Array.from({ length: 100 }, (_, i) => `i${i}`).join(',');
    expect((await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice', itemIds: cappedIds })).status).toBe(200);
  });

  it('GET /api/mail/reply-flags evaluates multiple ids in one call, mixing flagged and unflagged', async () => {
    link('t-mix-a@x', 'invoice', 'i-mix-a', '2026-08-01T00:00:00.000Z');
    replyState('t-mix-a@x', '2026-08-10T00:00:00.000Z', null);   // flagged
    link('t-mix-b@x', 'invoice', 'i-mix-b', '2026-08-01T00:00:00.000Z');
    replyState('t-mix-b@x', '2026-08-05T00:00:00.000Z', '2026-08-10T00:00:00.000Z');  // not flagged
    const r = await request(app).get('/api/mail/reply-flags').query({ itemType: 'invoice', itemIds: 'i-mix-a,i-mix-b,i-mix-none' });
    expect(r.status).toBe(200);
    expect(r.body.flagged.sort()).toEqual(['i-mix-a']);
  });

  it('GET /api/mail/providers reports which OAuth providers the env configures', async () => {
    expect((await request(app).get('/api/mail/providers')).body).toEqual({ google: false, microsoft: false });
    routeEnv.GOOGLE_OAUTH_CLIENT_ID = 'gid';
    routeEnv.GOOGLE_OAUTH_CLIENT_SECRET = 'gsec';
    routeEnv.MS_OAUTH_CLIENT_ID = 'mid';
    currentUser = { id: 'u2', role: 'user' };   // any authenticated user, not just admins
    expect((await request(app).get('/api/mail/providers')).body).toEqual({ google: true, microsoft: false });
  });

  it('POST /api/mail/uploads rejects an empty body, and takes a JSON one as bytes', async () => {
    // The app-level parser steps aside for this path (server.ts), so the raw
    // parser sees every content type — an application/json attachment is stored
    // as the bytes it is, not parsed into an object.
    expect((await request(app).post('/api/mail/uploads').query({ name: 'a.jpg' }).set('Content-Type', 'image/jpeg').send(Buffer.alloc(0))).status).toBe(400);
    expect((await request(app).post('/api/mail/uploads').query({ name: 'a.json' }).send({ its: 'a file' })).body.uploadId).toBeTruthy();
  });

  it('staged uploads: POST /api/mail/uploads returns uploadId usable by send', async () => {
    const u = await request(app).post('/api/mail/uploads').query({ name: 'a.jpg' }).set('Content-Type', 'image/jpeg').send(Buffer.from('jpg'));
    expect(u.status).toBe(200);
    const s = await request(app).post('/api/mail/send').send({ to: [{ addr: 'a@b' }], subject: 's', html: 'h', attachments: [{ uploadId: u.body.uploadId }] });
    expect(s.status).toBe(200);
    expect(provider.sent[0].attachments[0].name).toBe('a.jpg');
  });

  it('send surfaces MailSendError status codes', async () => {
    const r = await request(app).post('/api/mail/send').send({ to: [], subject: 's', html: 'h', attachments: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('recipient');
  });

  it('load-older moves indexedSince back and PATCH/DELETE account work', async () => {
    const before = acct.indexedSince;
    expect((await request(app).post(`/api/mail/accounts/${acct.id}/load-older`).send({ months: 6 })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.indexedSince < before).toBe(true);
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ signatureHtml: '<p>sig</p>', displayName: 'Nick' })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.signatureHtml).toBe('<p>sig</p>');
    expect((await request(app).delete(`/api/mail/accounts/${acct.id}`)).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)).toBeNull();
  });

  it('POST /api/mail/accounts/:id/refresh pokes the scheduler and answers 202', async () => {
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount');
    const r = await request(app).post(`/api/mail/accounts/${acct.id}/refresh`);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true });
    expect(poke).toHaveBeenCalledWith(acct.id);
    poke.mockRestore();
  });

  it('POST /api/mail/accounts/:id/refresh answers 503 when there is no scheduler to poke', async () => {
    const noSync = { ...ctx, scheduler: undefined };
    const r = await request(altApp({ ctx: noSync })).post(`/api/mail/accounts/${acct.id}/refresh`);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'Sync unavailable' });
  });

  it('POST /api/mail/accounts/:id/refresh rejects another user\'s account without poking', async () => {
    currentUser = { id: 'u2', role: 'user' };
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount');
    expect((await request(app).post(`/api/mail/accounts/${acct.id}/refresh`)).status).toBe(404);
    expect(poke).not.toHaveBeenCalled();
    poke.mockRestore();
  });

  it('DELETE /api/mail/accounts/:id stops the worker and drops the cached provider first', async () => {
    const created = (await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com', imapHost: 'imap.x', smtpHost: 'smtp.x', username: 'n', password: 'p' })).body;
    await request(app).post(`/api/mail/accounts/${created.id}/test`);
    expect(ctx.scheduler!.isRunning(created.id)).toBe(true);
    const dropSpy = vi.spyOn(ctx.scheduler!, 'dropProvider');
    expect((await request(app).delete(`/api/mail/accounts/${created.id}`)).status).toBe(200);
    expect(ctx.scheduler!.isRunning(created.id)).toBe(false);
    expect(dropSpy).toHaveBeenCalledWith(created.id);
    dropSpy.mockRestore();
  });

  it('account mutation routes reject another user\'s account', async () => {
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ displayName: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/mail/accounts/${acct.id}`)).status).toBe(404);
    expect((await request(app).post(`/api/mail/accounts/${acct.id}/test`)).status).toBe(404);
    expect((await request(app).post(`/api/mail/accounts/${acct.id}/load-older`).send({ months: 6 })).status).toBe(404);
    expect(accounts.getAccountAny(db, acct.id)).not.toBeNull();
  });

  it('PATCH isDefault + disable/enable drive the scheduler', async () => {
    const second = (await request(app).post('/api/mail/accounts/imap').send({ emailAddress: 'n@x.com', imapHost: 'imap.x', smtpHost: 'smtp.x', username: 'n', password: 'p' })).body;
    expect((await request(app).patch(`/api/mail/accounts/${second.id}`).send({ isDefault: true })).status).toBe(200);
    expect(accounts.getAccountAny(db, second.id)!.isDefault).toBe(1);
    expect(accounts.getAccountAny(db, acct.id)!.isDefault).toBe(0);
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ status: 'disabled' })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.status).toBe('disabled');
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ status: 'ok' })).status).toBe(200);
    expect(accounts.getAccountAny(db, acct.id)!.status).toBe('ok');
    expect(ctx.scheduler!.isRunning(acct.id)).toBe(true);
  });

  it('heartbeat ignores account ids the caller does not own', async () => {
    const spy = vi.spyOn(ctx.scheduler!, 'markViewed');
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).post('/api/mail/heartbeat').send({ accountIds: [acct.id] })).status).toBe(204);
    expect(spy).toHaveBeenCalledWith([]);
    spy.mockRestore();
  });
  // ── OAuth connect flow ──
  it('GET /api/mail/oauth/:provider/start redirects to consent with PKCE state', async () => {
    routeEnv.GOOGLE_OAUTH_CLIENT_ID = 'gid';
    routeEnv.GOOGLE_OAUTH_CLIENT_SECRET = 'g-client-secret-value';
    const r = await request(app).get('/api/mail/oauth/google/start').query({ token: 'tok' });
    expect(r.status).toBe(302);
    const url = new URL(r.headers.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(r.headers.location).toContain('state=');
    // The state is a signed envelope carrying the caller and the PKCE verifier.
    expect(verifyState(JWT_SECRET, url.searchParams.get('state')!)).toMatchObject({ userId: 'u1', provider: 'google' });
    // The verifier itself never leaves in the clear alongside its challenge.
    expect(url.searchParams.get('code_challenge')).not.toBe(verifyState(JWT_SECRET, url.searchParams.get('state')!).verifier);
    // Nothing here may carry the client secret. (It has to be long: the URL is
    // mostly random base64url, so a two-character secret matches it by chance.)
    expect(r.headers.location).not.toContain('g-client-secret-value');
    // ?token= is in this request's own url; the browser must not pass it along
    // as the Referer when it follows the hop to the provider.
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('start rejects an unknown provider, a bad token, a missing publicUrl and missing env', async () => {
    expect((await request(app).get('/api/mail/oauth/aol/start').query({ token: 'tok' })).status).toBe(400);
    expect((await request(app).get('/api/mail/oauth/google/start').query({ token: 'nope' })).status).toBe(401);
    // env not configured for microsoft
    const noEnv = await request(app).get('/api/mail/oauth/microsoft/start').query({ token: 'tok' });
    expect(noEnv.status).toBe(503);
    expect(noEnv.body.error).toContain('MS_OAUTH_CLIENT_ID');
    routeEnv.GOOGLE_OAUTH_CLIENT_ID = 'gid';
    routeEnv.GOOGLE_OAUTH_CLIENT_SECRET = 'g-client-secret-value';
    const noUrl = await request(altApp({ publicUrl: null })).get('/api/mail/oauth/google/start').query({ token: 'tok' });
    expect(noUrl.status).toBe(503);
    expect(noUrl.body.error).toContain('APP_PUBLIC_URL');
  });

  it('callback exchanges the code, creates the account and starts the worker', async () => {
    const state = signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v1' });
    const seen: Array<{ provider: string; code: string; verifier: string }> = [];
    oauthStub = async (provider, _env, _url, code, verifier) => { seen.push({ provider, code, verifier }); return { refreshToken: 'RT', accessToken: 'AT', email: 'New@Birchwood.example', name: 'Nick' }; };
    const startSpy = vi.spyOn(ctx.scheduler!, 'startAccount');
    const r = await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c1', state });
    expect(r.status).toBe(302);
    const created = accounts.listAccounts(db, 'u1').find(a => a.emailAddress === 'new@birchwood.example')!;
    expect(created).toBeTruthy();
    expect(created.provider).toBe('google');
    expect(created.status).toBe('ok');
    expect(created.displayName).toBe('Nick');
    expect(accounts.readAuth(db, crypto, created.id)).toEqual({ refreshToken: 'RT' });
    expect(r.headers.location).toBe(`/settings?tab=mail&connected=${created.id}`);
    // code + verifier reached the exchange; the refresh token never reaches the browser.
    expect(seen[0]).toEqual({ provider: 'google', code: 'c1', verifier: 'v1' });
    expect(r.headers.location).not.toContain('RT');
    expect(startSpy).toHaveBeenCalledWith(created.id);
    startSpy.mockRestore();
  });

  it('a second callback for the same address reconnects instead of duplicating', async () => {
    const state = () => signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' });
    await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c1', state: state() });
    const first = accounts.listAccounts(db, 'u1').find(a => a.emailAddress === 'oauth@birchwood.example')!;
    accounts.updateAccount(db, first.id, { status: 'auth_error', lastError: 'expired' });
    const dropSpy = vi.spyOn(ctx.scheduler!, 'dropProvider');
    // Same mailbox, different casing from the provider — still one account.
    oauthStub = async () => ({ refreshToken: 'RT2', accessToken: 'AT', email: 'OAuth@Birchwood.example', name: 'OAuth Nick' });
    const r = await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c2', state: state() });
    expect(r.headers.location).toBe(`/settings?tab=mail&connected=${first.id}`);
    expect(accounts.listAccounts(db, 'u1').filter(a => a.emailAddress === 'oauth@birchwood.example')).toHaveLength(1);
    const after = accounts.getAccountAny(db, first.id)!;
    expect(after.status).toBe('ok');
    expect(after.lastError).toBeNull();
    expect(accounts.readAuth(db, crypto, first.id)).toEqual({ refreshToken: 'RT2' });
    expect(dropSpy).toHaveBeenCalledWith(first.id);
    dropSpy.mockRestore();
  });

  it('reconnecting a running account rebuilds its provider on the NEW refresh token', async () => {
    const state = () => signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' });
    await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c1', state: state() });
    const a = accounts.listAccounts(db, 'u1').find(x => x.emailAddress === 'oauth@birchwood.example')!;
    // The worker is live, and it captured its provider (holding RT) when it started.
    expect(ctx.scheduler!.isRunning(a.id)).toBe(true);
    const stopSpy = vi.spyOn(ctx.scheduler!, 'stopAccount');
    const factorySpy = vi.spyOn(ctx, 'providerFactory');

    oauthStub = async () => ({ refreshToken: 'RT2', accessToken: 'AT', email: 'oauth@birchwood.example', name: 'OAuth Nick' });
    await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c2', state: state() });

    expect(accounts.readAuth(db, crypto, a.id)).toEqual({ refreshToken: 'RT2' });
    // Without stopAccount() first, startAccount() no-ops and the old provider —
    // still holding RT — keeps ticking until it dies on an auth error. This is
    // the assertion that catches that: the provider must be REBUILT on RT2.
    expect(factorySpy).toHaveBeenCalled();
    expect(factorySpy.mock.calls.at(-1)![1]).toEqual({ refreshToken: 'RT2' });
    expect(stopSpy).toHaveBeenCalledWith(a.id);
    expect(ctx.scheduler!.isRunning(a.id)).toBe(true);
    stopSpy.mockRestore();
    factorySpy.mockRestore();
  });

  it('another user connecting the same address gets their own account', async () => {
    await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c', state: signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' }) });
    await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c', state: signState(JWT_SECRET, { userId: 'u2', provider: 'google', verifier: 'v' }) });
    expect(accounts.listAccounts(db, 'u1').filter(a => a.emailAddress === 'oauth@birchwood.example')).toHaveLength(1);
    expect(accounts.listAccounts(db, 'u2').filter(a => a.emailAddress === 'oauth@birchwood.example')).toHaveLength(1);
  });

  it('callback redirects with a safe error and creates nothing when anything is wrong', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM mail_accounts').get() as { n: number };
    const bad = await request(app).get('/api/mail/oauth/google/callback').query({ code: 'c', state: 'garbage' });
    expect(bad.status).toBe(302);
    expect(bad.headers.location).toMatch(/^\/settings\?tab=mail&error=/);

    // A state signed with another secret is rejected the same way.
    expect((await request(app).get('/api/mail/oauth/google/callback')
      .query({ code: 'c', state: signState('other-secret', { userId: 'u1', provider: 'google', verifier: 'v' }) }))
      .headers.location).toMatch(/error=/);

    // The state's provider must match the URL's, or a Google grant could be filed as Microsoft.
    expect((await request(app).get('/api/mail/oauth/microsoft/callback')
      .query({ code: 'c', state: signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' }) }))
      .headers.location).toMatch(/error=/);

    // A denied consent comes back with no code at all.
    expect((await request(app).get('/api/mail/oauth/google/callback')
      .query({ error: 'access_denied', state: signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' }) }))
      .headers.location).toMatch(/error=/);

    // A failed exchange must not leak the code, and must not leave a half-made account.
    oauthStub = async () => { throw new Error('invalid_grant for code c-secret'); };
    const failed = await request(app).get('/api/mail/oauth/google/callback')
      .query({ code: 'c-secret', state: signState(JWT_SECRET, { userId: 'u1', provider: 'google', verifier: 'v' }) });
    expect(failed.headers.location).toMatch(/error=/);
    expect(failed.headers.location).not.toContain('c-secret');
    expect((db.prepare('SELECT COUNT(*) n FROM mail_accounts').get() as { n: number }).n).toBe(before.n);
  });
});

describe('POST /api/mail/ms/webhook', () => {
  const subscribe = (id: string) => accounts.updateAccount(db, acct.id, { syncState: JSON.stringify({ deltaLinks: {}, subscriptionId: id }) });

  it('echoes the validation token back as plain text for the Graph handshake', async () => {
    const r = await request(app).post('/api/mail/ms/webhook').query({ validationToken: 'tok-abc 123' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.text).toBe('tok-abc 123');
  });

  it('pokes the account that owns the subscription named in a notification', async () => {
    subscribe('sub-9');
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(app).post('/api/mail/ms/webhook').send({
      value: [{ subscriptionId: 'sub-9', clientState: getWebhookSecret(db), resource: 'me/messages', changeType: 'created' }],
    });
    expect(r.status).toBe(202);
    expect(poke).toHaveBeenCalledWith(acct.id);
    poke.mockRestore();
  });

  it('accepts but ignores a notification carrying the wrong clientState', async () => {
    subscribe('sub-9');
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(app).post('/api/mail/ms/webhook').send({ value: [{ subscriptionId: 'sub-9', clientState: 'forged' }] });
    expect(r.status).toBe(202);
    expect(poke).not.toHaveBeenCalled();
    poke.mockRestore();
  });

  it('acks a junk body instead of failing, so Graph does not retry it forever', async () => {
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    expect((await request(app).post('/api/mail/ms/webhook').send({ nope: true })).status).toBe(202);
    expect((await request(app).post('/api/mail/ms/webhook').send([1, 2, 3])).status).toBe(202);
    expect(poke).not.toHaveBeenCalled();
    poke.mockRestore();
  });

  it('needs no authentication — Microsoft has no token to send', async () => {
    subscribe('sub-9');
    currentUser = { id: 'nobody', role: 'none' };
    expect((await request(app).post('/api/mail/ms/webhook').query({ validationToken: 't' })).status).toBe(200);
  });

  // ── the route is open to the internet: body cap + rate limit ──

  it('rejects an oversized body with 413 without reading or acting on it', async () => {
    subscribe('sub-9');
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(app).post('/api/mail/ms/webhook').send({
      value: [{ subscriptionId: 'sub-9', clientState: getWebhookSecret(db), pad: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES) }],
    });
    expect(r.status).toBe(413);
    expect(poke).not.toHaveBeenCalled();
    poke.mockRestore();
  });

  it('parses its own body, so the cap does not depend on the app-level parser', async () => {
    subscribe('sub-9');
    // No express.json() at all on this app — exactly what server.ts arranges for
    // this path. The notification must still be understood.
    const bare = altApp({}, { json: false });
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(bare).post('/api/mail/ms/webhook').send({
      value: [{ subscriptionId: 'sub-9', clientState: getWebhookSecret(db) }],
    });
    expect(r.status).toBe(202);
    expect(poke).toHaveBeenCalledWith(acct.id);
    poke.mockRestore();
  });

  // 600, not the old 120: Graph batches several accounts' notifications through
  // one IP, and a burst that trips the limiter costs real mail its latency.
  it('throttles at the documented ceiling and warns at most once a minute', async () => {
    expect(WEBHOOK_RATE_LIMIT_PER_MIN).toBe(600);
    subscribe('sub-9');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const limited = altApp({ webhookRateLimit: createWebhookRateLimit(2) });
    const post = () => request(limited).post('/api/mail/ms/webhook').send({
      value: [{ subscriptionId: 'sub-9', clientState: getWebhookSecret(db) }],
    });
    expect((await post()).status).toBe(202);
    expect((await post()).status).toBe(202);
    const third = await post();
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: 'Too many notifications' });
    expect((await post()).status).toBe(429);
    // Two rejections, one log line — the burst that tripped it must not flood.
    expect(warn.mock.calls.filter(c => String(c[0]).includes('rate limit'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('runs the injected rate limiter before the handler', async () => {
    subscribe('sub-9');
    let calls = 0;
    const limited = altApp({ webhookRateLimit: (_req, res) => { calls++; res.status(429).end(); } });
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(limited).post('/api/mail/ms/webhook').send({
      value: [{ subscriptionId: 'sub-9', clientState: getWebhookSecret(db) }],
    });
    expect(r.status).toBe(429);
    expect(calls).toBe(1);
    expect(poke).not.toHaveBeenCalled();
    poke.mockRestore();
  });
});

describe('POST /api/mail/google/webhook', () => {
  // Pub/Sub sends only the topic's payload — there is no field of ours in the
  // body to echo a secret back in, the way Graph echoes clientState — so the
  // shared secret rides in the query string of the URL the admin registers.
  const token = () => getGooglePushSecret(db);
  const push = (payload: unknown) => ({
    message: { data: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8').toString('base64'), messageId: '1' },
    subscription: 'projects/ft/subscriptions/mail-push',
  });
  const gmailAccount = (email: string, userId = 'u1') =>
    accounts.createAccount(db, crypto, { userId, provider: 'google', emailAddress: email, auth: { refreshToken: 'r' } });

  it('pokes every google account holding the pushed address, whatever its case', async () => {
    const a = gmailAccount('Nick@Birchwood.example');
    const b = gmailAccount('nick@birchwood.example', 'u2');
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(app).post(GOOGLE_WEBHOOK_PATH).query({ token: token() }).send(push({ emailAddress: 'NICK@birchwood.example', historyId: 42 }));
    expect(r.status).toBe(204);
    expect(new Set(poke.mock.calls.map(c => c[0]))).toEqual(new Set([a.id, b.id]));
    poke.mockRestore();
  });

  it('refuses a missing or wrong token with 403 and does not act on the body', async () => {
    gmailAccount('nick@birchwood.example');
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const body = push({ emailAddress: 'nick@birchwood.example' });
    expect((await request(app).post(GOOGLE_WEBHOOK_PATH).send(body)).status).toBe(403);
    expect((await request(app).post(GOOGLE_WEBHOOK_PATH).query({ token: 'forged' }).send(body)).status).toBe(403);
    // A token of the right length must fail too — the compare is on content.
    expect((await request(app).post(GOOGLE_WEBHOOK_PATH).query({ token: 'f'.repeat(token().length) }).send(body)).status).toBe(403);
    expect(poke).not.toHaveBeenCalled();
    poke.mockRestore();
  });

  it('checks the token before parsing the body, so a stranger gets no free parse', async () => {
    // Malformed JSON: if the parser ran first this would be a 400, and an
    // unauthenticated caller would have had 256 KB of parsing done for them.
    const r = await request(app).post(GOOGLE_WEBHOOK_PATH).query({ token: 'forged' })
      .set('Content-Type', 'application/json').send('{ not json');
    expect(r.status).toBe(403);
  });

  it('never echoes the secret back to a caller that guessed wrong', async () => {
    const r = await request(app).post(GOOGLE_WEBHOOK_PATH).query({ token: 'forged' }).send(push({ emailAddress: 'x@y.com' }));
    expect(r.text).not.toContain(token());
    expect(r.body).toEqual({});
  });

  it('acks an undecodable push instead of making Pub/Sub redeliver it', async () => {
    gmailAccount('nick@birchwood.example');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const post = (body: unknown) => request(app).post(GOOGLE_WEBHOOK_PATH).query({ token: token() }).send(body as object);
    expect((await post({ message: { data: '!!!not base64!!!' } })).status).toBe(204);
    expect((await post(push('{ not json'))).status).toBe(204);
    expect((await post({ nope: true })).status).toBe(204);
    expect(poke).not.toHaveBeenCalled();
    warn.mockRestore();
    poke.mockRestore();
  });

  it('acks an address no account holds', async () => {
    gmailAccount('nick@birchwood.example');
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(app).post(GOOGLE_WEBHOOK_PATH).query({ token: token() }).send(push({ emailAddress: 'stranger@elsewhere.com' }));
    expect(r.status).toBe(204);
    expect(poke).not.toHaveBeenCalled();
    poke.mockRestore();
  });

  // ── open to the internet, same hardening as the Graph webhook ──

  it('rejects an oversized body with 413 before the token is even consulted', async () => {
    gmailAccount('nick@birchwood.example');
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(app).post(GOOGLE_WEBHOOK_PATH).query({ token: token() })
      .send(push({ emailAddress: 'nick@birchwood.example', pad: 'x'.repeat(WEBHOOK_MAX_BODY_BYTES) }));
    expect(r.status).toBe(413);
    expect(poke).not.toHaveBeenCalled();
    poke.mockRestore();
  });

  it('parses its own body, so the cap does not depend on the app-level parser', async () => {
    const a = gmailAccount('nick@birchwood.example');
    const bare = altApp({}, { json: false });
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(bare).post(GOOGLE_WEBHOOK_PATH).query({ token: token() }).send(push({ emailAddress: 'nick@birchwood.example' }));
    expect(r.status).toBe(204);
    expect(poke).toHaveBeenCalledWith(a.id);
    poke.mockRestore();
  });

  it('runs its own rate limiter before the handler', async () => {
    gmailAccount('nick@birchwood.example');
    let calls = 0;
    const limited = altApp({ googleWebhookRateLimit: (_req, res) => { calls++; res.status(429).end(); } });
    const poke = vi.spyOn(ctx.scheduler!, 'pokeAccount').mockImplementation(() => {});
    const r = await request(limited).post(GOOGLE_WEBHOOK_PATH).query({ token: token() }).send(push({ emailAddress: 'nick@birchwood.example' }));
    expect(r.status).toBe(429);
    expect(calls).toBe(1);
    expect(poke).not.toHaveBeenCalled();
    poke.mockRestore();
  });

  it('throttles at the same documented ceiling as the Graph webhook', async () => {
    gmailAccount('nick@birchwood.example');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const limited = altApp({ googleWebhookRateLimit: createWebhookRateLimit(2, 'Pub/Sub') });
    const post = () => request(limited).post(GOOGLE_WEBHOOK_PATH).query({ token: token() }).send(push({ emailAddress: 'nick@birchwood.example' }));
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(204);
    expect((await post()).status).toBe(429);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('Pub/Sub webhook rate limit'))).toHaveLength(1);
    warn.mockRestore();
  });

  it('reports the topic when GOOGLE_PUBSUB_TOPIC is set, and only to an admin', async () => {
    routeEnv.GOOGLE_PUBSUB_TOPIC = 'projects/ft/topics/mail';
    const si = await request(app).get('/api/mail/setup-info');
    expect(si.body.google.pubsub).toEqual({
      configured: true,
      topic: 'projects/ft/topics/mail',
      webhookUrl: `https://app.test${GOOGLE_WEBHOOK_PATH}?token=${token()}`,
    });
    // The URL carries the secret, so it must never leave the admin-only route.
    currentUser = { id: 'u2', role: 'user' };
    const denied = await request(app).get('/api/mail/setup-info');
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain(token());
  });
});

describe('Gmail watch teardown on delete / disable', () => {
  // A watch nobody hands back keeps publishing for up to a week into a mailbox
  // the app has stopped syncing. Best effort throughout: the account operation
  // must succeed whatever Gmail says.
  const flush = () => new Promise(r => setTimeout(r, 0));
  const watched = (email = 'nick@birchwood.example', userId = 'u1') => {
    const g = accounts.createAccount(db, crypto, { userId, provider: 'google', emailAddress: email, auth: { refreshToken: 'r' } });
    accounts.updateAccount(db, g.id, { syncState: JSON.stringify({ historyId: '100', watchExpiration: Date.now() + 3 * 86400_000 }) });
    const p = getFakeProvider(g.id) as FakeMailProvider & GmailWatchApi;
    p.watch = vi.fn(async (_topic: string) => ({ historyId: '7', expiration: String(Date.now() + 7 * 86400_000) }));
    p.stopWatch = vi.fn(async () => {});
    return { g, p };
  };

  it('DELETE hands the watch back before the account disappears', async () => {
    const { g, p } = watched();
    expect((await request(app).delete(`/api/mail/accounts/${g.id}`)).status).toBe(200);
    await flush();
    expect(p.stopWatch).toHaveBeenCalledTimes(1);
    expect(accounts.getAccountAny(db, g.id)).toBeNull();
  });

  it('disabling stops the watch and clears the expiry, keeping the poll watermark', async () => {
    const { g, p } = watched();
    expect((await request(app).patch(`/api/mail/accounts/${g.id}`).send({ status: 'disabled' })).status).toBe(200);
    await flush();
    expect(p.stopWatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(accounts.getAccountAny(db, g.id)!.syncState!)).toEqual({ historyId: '100' });
    expect(accounts.getAccountAny(db, g.id)!.status).toBe('disabled');
  });

  it('re-enabling registers a fresh watch on the next tick', async () => {
    const { g, p } = watched();
    await request(app).patch(`/api/mail/accounts/${g.id}`).send({ status: 'disabled' });
    await flush();
    expect((await request(app).patch(`/api/mail/accounts/${g.id}`).send({ status: 'ok' })).status).toBe(200);
    // What the scheduler does on that account's next tick, with a topic set.
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, p, 'projects/ft/topics/mail');
    expect(p.watch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(accounts.getAccountAny(db, g.id)!.syncState!).watchExpiration).toBeGreaterThan(Date.now());
  });

  it('does not cancel a shared mailbox\'s watch when a sibling account remains', async () => {
    // users/me/stop is mailbox-scoped, and the webhook pokes every account on
    // an address on purpose. Deleting one must not take the other's push down.
    const { g: a, p } = watched('shared@birchwood.example');
    const { g: b } = watched('Shared@birchwood.example');
    expect((await request(app).delete(`/api/mail/accounts/${a.id}`)).status).toBe(200);
    await flush();
    expect(p.stopWatch).not.toHaveBeenCalled();
    expect(JSON.parse(accounts.getAccountAny(db, b.id)!.syncState!)).toEqual({ historyId: '100' });
  });

  it('a delete still succeeds when Gmail refuses the stop', async () => {
    const { g, p } = watched();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    p.stopWatch = vi.fn(async () => { throw new Error('Gmail 500'); });
    expect((await request(app).delete(`/api/mail/accounts/${g.id}`)).status).toBe(200);
    await flush();
    expect(accounts.getAccountAny(db, g.id)).toBeNull();
    warn.mockRestore();
  });

  it('touches nothing for an account that has no watch to hand back', async () => {
    // acct is the fake/IMAP-shaped one — no watch, no Gmail call, and the
    // provider is not even resolved.
    expect((await request(app).patch(`/api/mail/accounts/${acct.id}`).send({ status: 'disabled' })).status).toBe(200);
    expect((await request(app).delete(`/api/mail/accounts/${acct.id}`)).status).toBe(200);
  });
});

// Task 4: fake-provider test-injection routes. Gated at registration time on
// MAIL_FAKE_PROVIDER=1 — the same switch providers/index.ts already uses to
// route every account through the fake — so they only ever exist in a
// dev/e2e process and never a real deployment.
describe('mail _test fixture routes', () => {
  const settle = () => new Promise(r => setTimeout(r, 50));

  it('404s on both routes when MAIL_FAKE_PROVIDER is unset', async () => {
    expect((await request(app).post('/api/mail/_test/seed').send({})).status).toBe(404);
    expect((await request(app).post('/api/mail/_test/inject').send({})).status).toBe(404);
  });

  it('POST /_test/seed creates a fake account and its threads show up in GET /api/mail/threads', async () => {
    routeEnv.MAIL_FAKE_PROVIDER = '1';
    const fakeApp = altApp();
    const seedRes = await request(fakeApp).post('/api/mail/_test/seed').send({
      emailAddress: 'inbox@e2e.test',
      threads: [
        { subject: 'RFI 12', from: { addr: 'gc@tidewater.example', name: 'GC' }, messages: [{ text: 'first message' }] },
        { subject: 'Change order', from: { addr: 'gc@tidewater.example', name: 'GC' }, messages: [{ text: 'co message' }] },
      ],
    });
    expect(seedRes.status).toBe(200);
    expect(seedRes.body.accountId).toBeTruthy();
    expect(seedRes.body.threadKeys).toHaveLength(2);

    const threadsRes = await request(fakeApp).get(`/api/mail/threads?accountId=${seedRes.body.accountId}`);
    expect(threadsRes.status).toBe(200);
    const keys = threadsRes.body.threads.map((t: any) => t.threadKey).sort();
    expect(keys).toEqual([...seedRes.body.threadKeys].sort());
  });

  it('reuses an existing fake account for the same caller + email on a second seed call', async () => {
    routeEnv.MAIL_FAKE_PROVIDER = '1';
    const fakeApp = altApp();
    const first = await request(fakeApp).post('/api/mail/_test/seed').send({
      emailAddress: 'reuse@e2e.test',
      threads: [{ subject: 'A', from: { addr: 'gc@tidewater.example' }, messages: [{ text: 'hi' }] }],
    });
    const second = await request(fakeApp).post('/api/mail/_test/seed').send({
      emailAddress: 'reuse@e2e.test',
      threads: [{ subject: 'B', from: { addr: 'gc@tidewater.example' }, messages: [{ text: 'hi again' }] }],
    });
    expect(second.body.accountId).toBe(first.body.accountId);
  });

  it('POST /_test/inject lands a message on the given thread', async () => {
    routeEnv.MAIL_FAKE_PROVIDER = '1';
    const fakeApp = altApp();
    const seedRes = await request(fakeApp).post('/api/mail/_test/seed').send({
      emailAddress: 'inject@e2e.test',
      threads: [{ subject: 'RFI 1', from: { addr: 'gc@tidewater.example', name: 'GC' }, messages: [{ text: 'root message' }] }],
    });
    const { accountId, threadKeys } = seedRes.body;
    const injectRes = await request(fakeApp).post('/api/mail/_test/inject').send({
      accountId, threadKey: threadKeys[0], from: { addr: 'gc@tidewater.example', name: 'GC' }, text: 'here is my reply',
    });
    expect(injectRes.status).toBe(200);
    expect(injectRes.body).toEqual({ ok: true });
    await settle();

    const threadRes = await request(fakeApp).get(`/api/mail/threads/${accountId}/${threadKeys[0]}`);
    expect(threadRes.status).toBe(200);
    expect(threadRes.body.messages).toHaveLength(2);
  });

  it('seeds 2 threads, injects a reply onto one, and the reply lands inbound on that thread only', async () => {
    routeEnv.MAIL_FAKE_PROVIDER = '1';
    const fakeApp = altApp();
    const seedRes = await request(fakeApp).post('/api/mail/_test/seed').send({
      emailAddress: 'sanity@e2e.test',
      threads: [
        { subject: 'Thread one', from: { addr: 'gc@tidewater.example', name: 'GC' }, messages: [{ text: 'thread one root' }] },
        { subject: 'Thread two', from: { addr: 'owner@tidewater.example', name: 'Owner' }, messages: [{ text: 'thread two root' }] },
      ],
    });
    expect(seedRes.status).toBe(200);
    const { accountId, threadKeys } = seedRes.body;
    expect(threadKeys).toHaveLength(2);

    const injectRes = await request(fakeApp).post('/api/mail/_test/inject').send({
      accountId, threadKey: threadKeys[0], from: { addr: 'gc@tidewater.example', name: 'GC' }, subject: 'Re: Thread one', text: 'a reply on thread one',
    });
    expect(injectRes.status).toBe(200);
    await settle();

    const touched = await request(fakeApp).get(`/api/mail/threads/${accountId}/${threadKeys[0]}`);
    expect(touched.status).toBe(200);
    expect(touched.body.thread.messageCount).toBe(2);
    const last = touched.body.messages[touched.body.messages.length - 1];
    expect(last.from.addr).toBe('gc@tidewater.example');
    expect(last.from.addr).not.toBe('sanity@e2e.test');   // inbound: not from the account's own address

    // The other thread is untouched.
    const other = await request(fakeApp).get(`/api/mail/threads/${accountId}/${threadKeys[1]}`);
    expect(other.body.thread.messageCount).toBe(1);
  });
});

describe('trusted image senders (per user)', () => {
  it('stores, lists and removes a sender for the signed-in user only', async () => {
    expect((await request(app).put('/api/mail/image-senders').send({ addr: 'Bob@Example.com ' })).status).toBe(204);
    expect((await request(app).get('/api/mail/image-senders')).body.senders).toEqual(['bob@example.com']);
    currentUser = { id: 'u2', role: 'user' };
    expect((await request(app).get('/api/mail/image-senders')).body.senders).toEqual([]);
    currentUser = { id: 'u1', role: 'user' };
    expect((await request(app).delete('/api/mail/image-senders').query({ addr: 'bob@example.com' })).status).toBe(204);
    expect((await request(app).get('/api/mail/image-senders')).body.senders).toEqual([]);
    expect((await request(app).put('/api/mail/image-senders').send({ addr: 'nope' })).status).toBe(400);
  });
});
