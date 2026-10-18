// The connection check is what an admin reads when the editor won't open, so
// these tests pin each way it can break to the message that says how to fix
// it. A fake Document Server stands in for ONLYOFFICE: it checks both
// signatures the way the real one does and, for a conversion, really downloads
// the test file from the app under test.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { registerOnlyofficeRoutes, type OnlyofficeRouteDeps } from './routes';
import { LinkTokens } from './tokens';

const SECRET = 'shared-oo-secret';
const ENV = {
  ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com',
  ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice',
  APP_INTERNAL_URL: 'http://app:3000',
  ONLYOFFICE_JWT_SECRET: SECRET,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface FakeOptions {
  /** The Document Server's own JWT_SECRET. */
  secret?: string;
  /** What /converter does once the signature checks out. */
  convert?: 'download' | 'refuse-private-ip' | 'download-then-fail';
}

let app: express.Express;
let calls: { path: string; bodyParams: any; headerPayload: any }[];

/** A stand-in Document Server reachable only through the injected fetch. */
const fakeDocumentServer = (opts: FakeOptions = {}): typeof fetch => (async (input: any, init: any) => {
  const url = new URL(String(input));
  expect(url.origin).toBe('http://onlyoffice');
  const body = JSON.parse(init.body);
  const secret = opts.secret ?? SECRET;
  let bodyParams: any = null;
  let headerPayload: any = null;
  try { bodyParams = jwt.verify(body.token, secret); } catch { /* bad signature */ }
  try { headerPayload = (jwt.verify(String(init.headers.Authorization).replace('Bearer ', ''), secret) as any).payload; } catch { /* bad signature */ }
  calls.push({ path: url.pathname, bodyParams, headerPayload });

  if (url.pathname === '/command') {
    if (!bodyParams) return json({ error: 6 });
    return json({ error: 0, version: '9.4.0.1' });
  }
  if (url.pathname === '/converter') {
    if (!bodyParams) return json({ error: -8 });
    if (opts.convert === 'refuse-private-ip') return json({ error: -4 });
    const src = new URL(bodyParams.url);
    expect(src.origin).toBe('http://app:3000');
    const got = await request(app).get(src.pathname + src.search);
    if (got.status !== 200) return json({ error: -4 });
    if (opts.convert === 'download-then-fail') return json({ error: -3 });
    return json({ endConvert: true, fileType: 'docx', fileUrl: 'http://onlyoffice/cache/files/data/x/output.docx', percent: 100 });
  }
  return new Response('<html>Not Found</html>', { status: 404 });
}) as typeof fetch;

const testDb = () => {
  const db = openDb(':memory:');
  runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-oo-')), migrations);
  return db;
};

const mkApp = (over: Partial<OnlyofficeRouteDeps> = {}, user: any = { id: 'u1', role: 'admin' }) => {
  const a = express();
  a.use(express.json());
  registerOnlyofficeRoutes(a, {
    env: ENV,
    appJwtSecret: 'app-secret',
    authenticateToken: (req: any, res: any, next: any) => {
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      req.user = user;
      next();
    },
    requireAdmin: (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
    fetch: fakeDocumentServer(),
    db: testDb(),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ft-oo-')),
    broadcastChange: () => {},
    ...over,
  });
  return a;
};

beforeEach(() => { calls = []; });

describe('GET /api/onlyoffice/status', () => {
  it('is admin-only', async () => {
    app = mkApp({}, { id: 'u2', role: 'user' });
    expect((await request(app).get('/api/onlyoffice/status')).status).toBe(403);
    app = mkApp({}, null);
    expect((await request(app).get('/api/onlyoffice/status')).status).toBe(401);
  });

  it('reports what is missing, and calls nothing, when not configured', async () => {
    let fetched = false;
    app = mkApp({ env: {}, fetch: (async () => { fetched = true; return json({}); }) as typeof fetch });
    const r = await request(app).get('/api/onlyoffice/status');
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(false);
    expect(r.body.problems.map((p: any) => p.variable)).toEqual(['ONLYOFFICE_PUBLIC_URL', 'APP_INTERNAL_URL', 'ONLYOFFICE_JWT_SECRET']);
    expect(r.body.checks.appToOnlyoffice.status).toBe('skipped');
    expect(r.body.checks.onlyofficeToApp.status).toBe('skipped');
    expect(fetched).toBe(false);
  });

  it('passes both checks when the two servers reach each other with the same secret', async () => {
    app = mkApp();
    const r = await request(app).get('/api/onlyoffice/status');
    expect(r.body).toMatchObject({
      configured: true,
      publicUrl: 'https://docs.example.com',
      internalUrl: 'http://onlyoffice',
      appInternalUrl: 'http://app:3000',
      version: '9.4.0.1',
      checks: { appToOnlyoffice: { status: 'ok' }, onlyofficeToApp: { status: 'ok' } },
    });
    expect(r.body.checks.appToOnlyoffice.message).toContain('ONLYOFFICE 9.4.0.1');
    expect(r.body.checks.onlyofficeToApp.message).toContain('http://app:3000');
    // Both signatures carry the same parameters, in the body and the header.
    expect(calls.map(c => c.path)).toEqual(['/command', '/converter']);
    for (const c of calls) {
      const { iat: _b, ...fromBody } = c.bodyParams;
      expect(c.headerPayload).toEqual(fromBody);
    }
    expect(calls[1].bodyParams).toMatchObject({ async: true, filetype: 'txt', outputtype: 'docx' });
  });

  it('says the secrets differ when ONLYOFFICE rejects the signature, and skips the second check', async () => {
    app = mkApp({ fetch: fakeDocumentServer({ secret: 'something-else' }) });
    const r = await request(app).get('/api/onlyoffice/status');
    expect(r.body.checks.appToOnlyoffice.status).toBe('failed');
    expect(r.body.checks.appToOnlyoffice.message).toMatch(/ONLYOFFICE_JWT_SECRET here must equal JWT_SECRET/);
    expect(r.body.checks.onlyofficeToApp.status).toBe('skipped');
  });

  it('names the network error and the setting to check when ONLYOFFICE cannot be reached', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND onlyoffice'), { code: 'ENOTFOUND' }) });
    }) as typeof fetch;
    app = mkApp({ fetch: down });
    const r = await request(app).get('/api/onlyoffice/status');
    expect(r.body.checks.appToOnlyoffice.status).toBe('failed');
    expect(r.body.checks.appToOnlyoffice.message).toContain('ENOTFOUND');
    expect(r.body.checks.appToOnlyoffice.message).toContain('ONLYOFFICE_INTERNAL_URL');
  });

  it('says when the address answers but is not a Document Server', async () => {
    app = mkApp({ fetch: (async () => new Response('<html>Welcome to nginx</html>', { status: 404 })) as typeof fetch });
    const r = await request(app).get('/api/onlyoffice/status');
    expect(r.body.checks.appToOnlyoffice.message).toMatch(/HTTP 404/);
  });

  it('points at APP_INTERNAL_URL and ALLOW_PRIVATE_IP_ADDRESS when ONLYOFFICE cannot download from the app', async () => {
    app = mkApp({ fetch: fakeDocumentServer({ convert: 'refuse-private-ip' }) });
    const r = await request(app).get('/api/onlyoffice/status');
    expect(r.body.checks.appToOnlyoffice.status).toBe('ok');
    expect(r.body.checks.onlyofficeToApp.status).toBe('failed');
    expect(r.body.checks.onlyofficeToApp.message).toContain('APP_INTERNAL_URL');
    expect(r.body.checks.onlyofficeToApp.message).toContain('ALLOW_PRIVATE_IP_ADDRESS=true');
  });

  it('says ONLYOFFICE did reach the app when the download worked but the conversion failed', async () => {
    app = mkApp({ fetch: fakeDocumentServer({ convert: 'download-then-fail' }) });
    const r = await request(app).get('/api/onlyoffice/status');
    expect(r.body.checks.onlyofficeToApp.status).toBe('failed');
    expect(r.body.checks.onlyofficeToApp.message).toMatch(/reached this app at http:\/\/app:3000, but/);
  });
});

describe('GET /api/onlyoffice/selftest/:id', () => {
  it('serves the test text without a login, only for a valid token for that id', async () => {
    app = mkApp({}, null);
    const tokens = new LinkTokens('app-secret');
    const good = tokens.sign('selftest:abc', 60);
    const ok = await request(app).get(`/api/onlyoffice/selftest/abc?t=${good}`);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('connection test');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((await request(app).get(`/api/onlyoffice/selftest/other?t=${good}`)).status).toBe(403);
    expect((await request(app).get('/api/onlyoffice/selftest/abc')).status).toBe(403);
    const expired = tokens.sign('selftest:abc', -5);
    expect((await request(app).get(`/api/onlyoffice/selftest/abc?t=${expired}`)).status).toBe(403);
  });
});
