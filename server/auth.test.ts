// Signing in and out, and the media cookie (spec
// docs/superpowers/specs/2026-10-07-file-link-security-design.md). Driven
// through the real routes with real tokens: server/auth.ts's own token checks
// in front of the data routes, as server.ts wires them.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { registerDataRoutes } from './routes';
import { putBuffer } from './files';
import { MEDIA_COOKIE, registerAuthRoutes, tokenAuth } from './auth';

const SECRET = 'test-jwt-secret';
const PASSWORD = 'right-password';

let db: Database.Database;
let dir: string;

const mkApp = (opts: { behindProxy?: boolean } = {}) => {
  const a = express();
  // server.ts trusts Cloudflare's hop the same way.
  if (opts.behindProxy) a.set('trust proxy', 1);
  a.use(express.json());
  const { verifyToken, authenticateToken } = tokenAuth(SECRET);
  registerAuthRoutes(a, { db, jwtSecret: SECRET, verifyToken, loginLimiter: (_req, _res, next) => next() });
  registerDataRoutes(a, {
    db,
    dataDir: dir,
    dbFile: path.join(dir, 'app.db'),
    authenticateToken,
    requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
    verifyToken,
    broadcastChange: () => {},
  });
  return a;
};

const tokenFor = (role: 'admin' | 'user', opts: jwt.SignOptions = { expiresIn: '1h' }, secret = SECRET) =>
  jwt.sign({ id: role === 'admin' ? 'u-admin' : 'u-crew', username: role === 'admin' ? 'boss' : 'crew', role }, secret, opts);

/** The Set-Cookie line for the media cookie, if the response has one. */
const mediaCookieOf = (res: request.Response): string | undefined =>
  ([] as string[]).concat(res.headers['set-cookie'] ?? []).find(c => c.startsWith(`${MEDIA_COOKIE}=`));

const login = (a: express.Express, username: string, password = PASSWORD) =>
  request(a).post('/api/auth/login').send({ username, password });

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-auth-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations);
  const hash = bcrypt.hashSync(PASSWORD, 4);
  db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run('u-admin', 'boss', hash, 'admin');
  db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run('u-crew', 'crew', hash, 'user');
  putBuffer(db, dir, 'photo', Buffer.from('photo bytes'), 'image/jpeg', { kind: 'issue-photo', name: 'site.jpg' });
});

describe('signing in', () => {
  it('gives the browser the media cookie: HttpOnly, SameSite=Lax, Path=/api, expiring with the token', async () => {
    const res = await login(mkApp(), 'crew');
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: 'u-crew', username: 'crew', role: 'user' });
    const cookie = mediaCookieOf(res)!;
    expect(cookie.startsWith(`${MEDIA_COOKIE}=${res.body.token};`)).toBe(true);
    expect(cookie).toContain('; HttpOnly');
    expect(cookie).toContain('; SameSite=Lax');
    expect(cookie).toContain('; Path=/api');
    const { exp } = jwt.decode(res.body.token) as { exp: number };
    expect(cookie).toContain(`; Expires=${new Date(exp * 1000).toUTCString()}`);
    // Plain http (a LAN install): a Secure cookie would never come back.
    expect(cookie).not.toContain('Secure');
  });

  it('marks it Secure when the visitor came over HTTPS through the proxy', async () => {
    const res = await login(mkApp({ behindProxy: true }), 'crew').set('X-Forwarded-Proto', 'https');
    expect(mediaCookieOf(res)).toContain('; Secure');
  });

  it('sets no cookie for a wrong password or an unknown user', async () => {
    const wrong = await login(mkApp(), 'crew', 'wrong-password');
    expect(wrong.status).toBe(401);
    expect(mediaCookieOf(wrong)).toBeUndefined();
    const unknown = await login(mkApp(), 'nobody');
    expect(unknown.status).toBe(401);
    expect(mediaCookieOf(unknown)).toBeUndefined();
  });

  it('lets that browser load photos with no header, until it signs out', async () => {
    const browser = request.agent(mkApp());
    await browser.post('/api/auth/login').send({ username: 'crew', password: PASSWORD }).expect(200);
    const photo = await browser.get('/api/images/photo/raw');
    expect([photo.status, photo.body.toString()]).toEqual([200, 'photo bytes']);

    const out = await browser.post('/api/auth/logout');
    expect(out.status).toBe(200);
    const cleared = mediaCookieOf(out)!;
    expect(cleared.startsWith(`${MEDIA_COOKIE}=;`)).toBe(true);
    expect(cleared).toContain('; Path=/api');
    expect(cleared).toContain('; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect((await browser.get('/api/images/photo/raw')).status).toBe(401);
  });
});

describe('POST /api/auth/media-session', () => {
  it('trades a valid Authorization token for the cookie (a session from before it existed)', async () => {
    const token = tokenFor('user');
    const res = await request(mkApp()).post('/api/auth/media-session').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const cookie = mediaCookieOf(res)!;
    expect(cookie.startsWith(`${MEDIA_COOKIE}=${token};`)).toBe(true);
    expect(cookie).toContain('; HttpOnly');
    const { exp } = jwt.decode(token) as { exp: number };
    expect(cookie).toContain(`; Expires=${new Date(exp * 1000).toUTCString()}`);
  });

  it('refuses a missing, forged or expired token, and clears any old cookie', async () => {
    const a = mkApp();
    const expired = tokenFor('user', { expiresIn: -10 });
    for (const header of [null, 'Bearer nope', `Bearer ${tokenFor('user', { expiresIn: '1h' }, 'some-other-secret')}`, `Bearer ${expired}`]) {
      const req = request(a).post('/api/auth/media-session');
      const res = await (header ? req.set('Authorization', header) : req);
      expect(res.status).toBe(401);
      expect(mediaCookieOf(res)).toMatch(new RegExp(`^${MEDIA_COOKIE}=;`));
    }
  });

  it('never takes the cookie itself as the sign-in', async () => {
    const res = await request(mkApp()).post('/api/auth/media-session').set('Cookie', `${MEDIA_COOKIE}=${tokenFor('user')}`);
    expect(res.status).toBe(401);
  });
});

describe('the media cookie', () => {
  it('signs in nothing but the photo and file reads: every other route wants the Authorization header', async () => {
    const a = mkApp();
    const token = tokenFor('admin');
    const cookie = `${MEDIA_COOKIE}=${token}`;
    const PROJECT = { id: 'p1', name: 'Job', createdAt: 1, pages: [], takeoffs: [] };

    expect((await request(a).post('/api/projects').set('Cookie', cookie).send(PROJECT)).status).toBe(401);
    expect((await request(a).post('/api/files/up1?kind=document&name=a.pdf').set('Cookie', cookie)
      .set('Content-Type', 'application/pdf').send(Buffer.from('pdf'))).status).toBe(401);
    expect((await request(a).delete('/api/files/photo').set('Cookie', cookie)).status).toBe(401);
    expect((await request(a).get('/api/projects').set('Cookie', cookie)).status).toBe(401);

    expect((await request(a).post('/api/projects').set('Authorization', `Bearer ${token}`).send(PROJECT)).status).toBe(200);
    expect((await request(a).get('/api/images/photo/raw').set('Cookie', cookie)).status).toBe(200);
  });

  it('is checked like any token on every request: expired, forged or malformed ones are refused', async () => {
    const a = mkApp();
    const raw = (token: string) => request(a).get('/api/images/photo/raw').set('Cookie', `${MEDIA_COOKIE}=${token}`);
    expect((await raw(tokenFor('user'))).status).toBe(200);
    expect((await raw(tokenFor('user', { expiresIn: -10 }))).status).toBe(401);
    expect((await raw(tokenFor('user', { expiresIn: '1h' }, 'some-other-secret'))).status).toBe(401);
    // Signed, but not a session: no id, name and role.
    expect((await raw(jwt.sign({ id: 'u-crew' }, SECRET, { expiresIn: '1h' }))).status).toBe(401);
  });

  it('takes a role from its token: a non-admin cookie gets no billing documents', async () => {
    putBuffer(db, dir, 'inv', Buffer.from('%PDF invoice'), 'application/pdf', { kind: 'invoice', name: 'Invoice 1001.pdf' });
    const a = mkApp();
    const content = (role: 'admin' | 'user') => request(a).get('/api/files/inv/content').set('Cookie', `${MEDIA_COOKIE}=${tokenFor(role)}`);
    expect((await content('user')).status).toBe(404);
    expect((await content('admin')).status).toBe(200);
  });
});
