// What rings the bell (ONLYOFFICE Phase 5): a task or RFI assigned to someone
// (not yourself), an RFI's sender being recorded, and @mentions in document
// comments, whose link opens the document at the comment. The GC-answer
// trigger lives in server/mail/inboundHooks.test.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { registerDataRoutes } from './routes';
import { registerOnlyofficeRoutes } from './onlyoffice/routes';
import { mentionAddresses } from './onlyoffice/mentionRoutes';
import { Notifier, type Notification } from './notifications';
import { createProject } from './projectStore';
import { getRfi } from './rfiStore';
import { putBuffer } from './files';
import { applySendEffects } from './mail/itemSendEffects';
import { parseActionLinkParam } from '../src/utils/editorLinks';

const SECRET = 'oo-secret';
const ENV = {
  ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com',
  ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice',
  APP_INTERNAL_URL: 'http://app:3000',
  ONLYOFFICE_JWT_SECRET: SECRET,
};
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const USERS = {
  noah: { id: 'u1', username: 'noah', role: 'admin' },
  maria: { id: 'u2', username: 'maria', role: 'user' },
  joe: { id: 'u3', username: 'joe', role: 'user' },
};
type Who = keyof typeof USERS;

let db: Database.Database;
let app: express.Express;
let notifier: Notifier;
const bell = (userId: string): Notification[] => notifier.list(userId).items;

beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-notif-trig-'));
  db = openDb(':memory:');
  runMigrations(db, dataDir, migrations);
  for (const u of Object.values(USERS)) {
    db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(u.id, u.username, 'x', u.role);
  }
  createProject(db, { id: 'p1', name: 'Test Project', createdAt: 1, pages: [], takeoffs: [] });
  notifier = new Notifier(db);
  app = express();
  app.use(express.json());
  // Who's asking comes from a header, so one app serves every user.
  const authenticateToken = (req: any, _res: any, next: any) => { req.user = USERS[(req.get('x-as') as Who) || 'noah']; next(); };
  const requireAdmin = (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }));
  registerDataRoutes(app, {
    db, dataDir, dbFile: path.join(dataDir, 'app.db'), authenticateToken, requireAdmin,
    verifyToken: () => null, broadcastChange: () => {}, notifier,
  });
  registerOnlyofficeRoutes(app, {
    env: ENV, appJwtSecret: 'app-secret', authenticateToken, requireAdmin, db, dataDir,
    broadcastChange: () => {}, notifier,
    fetch: (async () => new Response('nf', { status: 404 })) as typeof fetch,
  });
});

const as = (who: Who) => ({
  get: (url: string) => request(app).get(url).set('x-as', who),
  post: (url: string, body?: object) => request(app).post(url).set('x-as', who).send(body ?? {}),
  put: (url: string, body: object) => request(app).put(url).set('x-as', who).send(body),
});

describe('tasks', () => {
  it('tell the assignee when a task is made for them or handed to them, never the one assigning themselves', async () => {
    const t = (await as('noah').post('/api/tasks', { title: 'Hang board in 204', assigneeUserId: 'u2' })).body;
    expect(bell('u2')).toEqual([expect.objectContaining({
      type: 'task-assigned', title: 'noah assigned you a task', body: 'Hang board in 204', link: `/tasks?open=${t.id}`, actorUserId: 'u1',
    })]);

    await as('joe').post('/api/tasks', { title: 'Mine', assigneeUserId: 'u3' });
    expect(bell('u3')).toEqual([]);

    // Saving without changing the assignee tells nobody; handing it on tells the new one.
    const put = (who: Who, assigneeUserId: string, version: number) =>
      as(who).put(`/api/tasks/${t.id}`, { title: 'Hang board in 204', assigneeUserId, version });
    expect((await put('maria', 'u2', 1)).status).toBe(200);
    expect(bell('u2')).toHaveLength(1);
    await put('maria', 'u3', 2);
    expect(bell('u3')).toEqual([expect.objectContaining({ title: 'maria assigned you a task', link: `/tasks?open=${t.id}` })]);
  });
});

describe('RFIs', () => {
  it('keep an internal assignee, told when assigned or reassigned', async () => {
    const r = (await as('noah').post('/api/projects/p1/rfis', { title: 'Corridor height?', assigneeUserId: 'u2' })).body;
    expect(getRfi(db, r.id).assigneeUserId).toBe('u2');
    expect(bell('u2')).toEqual([expect.objectContaining({
      type: 'rfi-assigned', title: 'noah assigned you RFI-001', body: 'Corridor height?', link: `/project/p1/rfis?open=${r.id}`,
    })]);

    // A save that doesn't mention the assignee (an older client) leaves it alone.
    await as('noah').put(`/api/rfis/${r.id}`, { title: 'Corridor height?', version: 1 });
    expect(getRfi(db, r.id).assigneeUserId).toBe('u2');
    expect(bell('u2')).toHaveLength(1);

    await as('maria').put(`/api/rfis/${r.id}`, { title: 'Corridor height?', assigneeUserId: 'u3', version: 2 });
    expect(bell('u3')).toEqual([expect.objectContaining({ title: 'maria assigned you RFI-001' })]);
    await as('joe').put(`/api/rfis/${r.id}`, { title: 'Corridor height?', assigneeUserId: null, version: 3 });
    expect(getRfi(db, r.id).assigneeUserId).toBeNull();

    expect((await as('noah').put(`/api/rfis/${r.id}`, { title: 'x', assigneeUserId: 'ghost', version: 4 })).status).toBe(400);
  });

  it('record who sent them', async () => {
    const r = (await as('noah').post('/api/projects/p1/rfis', { title: 'Corridor height?' })).body;
    applySendEffects(db, { itemType: 'rfi', itemId: r.id, userId: 'u3', role: 'user', to: 'gc@tidewater.example', threadKey: 't' });
    expect(getRfi(db, r.id)).toMatchObject({ status: 'sent', sentByUserId: 'u3' });
  });
});

describe('@mentions in document comments', () => {
  beforeEach(() => {
    putBuffer(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-notif-f-')), 'doc1', Buffer.from('docx'), DOCX, { projectId: 'p1', kind: 'document', name: 'Scope.docx' });
    putBuffer(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-notif-f-')), 'inv1', Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'invoice', name: 'Invoice 7.pdf' });
  });
  const ACTION = { action: { type: 'comment', data: 'c_42' } };
  const mentionAddress = (id: string) => ({ u1: 'noah@team.invalid', u2: 'maria@team.invalid', u3: 'joe@team.invalid' } as Record<string, string>)[id];

  it('give each user a readable address ONLYOFFICE recognises in a comment, never a real one', () => {
    const got = mentionAddresses([
      { id: 'b', username: 'Mary Jo' }, { id: 'a', username: 'mary.jo' }, { id: 'c', username: 'Zoëy!' }, { id: 'd', username: '***' },
    ]);
    expect(Object.fromEntries(got)).toEqual({
      a: 'mary.jo@team.invalid', b: 'mary.jo.2@team.invalid', c: 'zoey@team.invalid', d: 'user@team.invalid',
    });
    // The pattern ONLYOFFICE uses to find mentions in the comment text.
    const found = /\B[@+][A-Z0-9._%+-]+@[A-Z0-9._-]+\.[A-Z]+\b/i;
    for (const email of got.values()) expect(`hi +${email} there`.match(found)?.[0]).toBe(`+${email}`);
  });

  it('offer everyone else who can open the file, each under an address that stands for them', async () => {
    const users = (await as('maria').get('/api/onlyoffice/mention-users/doc1')).body.users;
    expect(users).toEqual([
      { id: 'u3', name: 'joe', email: mentionAddress('u3') },
      { id: 'u1', name: 'noah', email: mentionAddress('u1') },
    ]);
    // An admin-only document: only admins can be mentioned, and only admins can ask.
    expect((await as('noah').get('/api/onlyoffice/mention-users/inv1')).body.users).toEqual([]);
    expect((await as('maria').get('/api/onlyoffice/mention-users/inv1')).status).toBe(404);
  });

  it('notify the people mentioned, linking to the comment', async () => {
    const r = await as('maria').post('/api/onlyoffice/mention/doc1', {
      emails: [mentionAddress('u3'), mentionAddress('u1').toUpperCase(), 'someone@else.com', mentionAddress('u2')],
      message: '@joe can you check the soffit detail?',
      actionLink: ACTION,
    });
    expect(r.body).toEqual({ notified: 2 });
    const [n] = bell('u3');
    expect(n).toMatchObject({ type: 'mention', title: 'maria mentioned you in Scope.docx', body: '@joe can you check the soffit detail?', actorUserId: 'u2' });
    expect(bell('u1')).toHaveLength(1);
    expect(bell('u2')).toEqual([]); // not about yourself

    const url = new URL(n.link!, 'http://app');
    expect(url.pathname).toBe('/tools/edit');
    expect(url.searchParams.get('fileId')).toBe('doc1');
    expect(parseActionLinkParam(url.searchParams.get('comment'))).toEqual(ACTION);
  });

  it('never reach someone who cannot open the file', async () => {
    const r = await as('noah').post('/api/onlyoffice/mention/inv1', { emails: [mentionAddress('u2')], message: 'hi' });
    expect(r.body).toEqual({ notified: 0 });
    expect((await as('maria').post('/api/onlyoffice/mention/inv1', { emails: [mentionAddress('u1')] })).status).toBe(404);
  });

  it('open the editor at the comment the link points to', async () => {
    const r = await as('maria').post('/api/onlyoffice/config/doc1', { actionLink: ACTION });
    expect(r.body.config.editorConfig.actionLink).toEqual(ACTION);
    expect((jwt.verify(r.body.config.token, SECRET) as any).editorConfig.actionLink).toEqual(ACTION);
    // Anything but a small object is ignored.
    const junk = await as('maria').post('/api/onlyoffice/config/doc1', { actionLink: 'x'.repeat(10) });
    expect(junk.body.config.editorConfig.actionLink).toBeUndefined();
  });
});
