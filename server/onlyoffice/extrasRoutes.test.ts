// Insert → Image → From storage, and File → Save Copy as (ONLYOFFICE Phase 3).
// A fake fetch plays the Document Server's file cache.
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
import { getMeta, putBuffer } from '../files';
import { readFileContent } from '../fileStore';
import { registerOnlyofficeRoutes } from './routes';
import { isOnlyofficeLink } from './extrasRoutes';

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
let fetched: string[];
let dsFiles: Map<string, Buffer>;

const fakeFetch = (async (input: any) => {
  const url = String(input);
  fetched.push(url);
  const file = dsFiles.get(url);
  return file ? new Response(file, { status: 200 }) : new Response('nf', { status: 404 });
}) as typeof fetch;

const users: Record<string, any> = {
  admin: { id: 'u-admin', username: 'noah', role: 'admin' },
  crew: { id: 'u-crew', username: 'crew', role: 'user' },
};
const mkApp = (as: keyof typeof users = 'crew', env: Record<string, string> = ENV) => {
  const a = express();
  a.use(express.json());
  registerOnlyofficeRoutes(a, {
    env, appJwtSecret: 'app-secret',
    authenticateToken: (req: any, _res: any, next: any) => { req.user = users[as]; next(); },
    requireAdmin: (_req: any, _res: any, next: any) => next(),
    db, dataDir, broadcastChange: () => {}, fetch: fakeFetch,
  });
  return a;
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-oo-extras-'));
  db = openDb(':memory:');
  runMigrations(db, dataDir, migrations);
  fetched = [];
  dsFiles = new Map();
  putBuffer(db, dataDir, 'doc1', Buffer.from('docx'), DOCX, { projectId: 'p1', customerId: 'c1', kind: 'document', name: 'Letter.docx' });
  putBuffer(db, dataDir, 'photo1', Buffer.from('jpg'), 'image/jpeg', { projectId: 'p1', kind: 'photo', name: 'wall.jpg' });
  putBuffer(db, dataDir, 'webp1', Buffer.from('webp'), 'image/webp', { projectId: 'p1', kind: 'photo', name: 'phone.webp' });
  putBuffer(db, dataDir, 'stamp1', Buffer.from('png'), 'image/png', { kind: 'company-stamp', name: 'APPROVED' });
  putBuffer(db, dataDir, 'sig-crew', Buffer.from('png'), 'image/png', { kind: 'signature', name: 'Full', createdBy: 'u-crew' });
  putBuffer(db, dataDir, 'sig-admin', Buffer.from('png'), 'image/png', { kind: 'signature', name: 'Full', createdBy: 'u-admin' });
});

describe('POST /api/onlyoffice/insert-image/:fileId', () => {
  const insert = (body: Record<string, unknown>, a = mkApp()) => request(a).post('/api/onlyoffice/insert-image/doc1').send(body);

  it('signs links ONLYOFFICE downloads the picked images through', async () => {
    const r = await insert({ c: 'add', fileIds: ['sig-crew', 'stamp1', 'photo1'] });
    expect(r.status).toBe(200);
    expect(r.body.c).toBe('add');
    expect(r.body.images.map((i: any) => i.fileType)).toEqual(['png', 'png', 'jpg']);
    expect(r.body.images[0].url).toMatch(/^http:\/\/app:3000\/api\/onlyoffice\/file\/sig-crew\?t=/);
    const signed = jwt.verify(r.body.token, SECRET) as any;
    expect(signed).toMatchObject({ c: 'add', images: r.body.images });

    // The link really serves the image.
    const u = new URL(r.body.images[2].url);
    const img = await request(mkApp()).get(u.pathname + u.search);
    expect(img.status).toBe(200);
  });

  it("never inserts someone else's signature", async () => {
    expect((await insert({ fileIds: ['sig-admin'] })).status).toBe(404);
    expect((await insert({ fileIds: ['sig-crew'] }, mkApp('admin'))).status).toBe(404);
  });

  it('skips images the editor cannot insert, and says so when none are left', async () => {
    const some = await insert({ fileIds: ['webp1', 'photo1'] });
    expect(some.body.images).toHaveLength(1);
    expect(some.body.skipped).toEqual(['phone.webp']);
    const none = await insert({ fileIds: ['webp1'] });
    expect(none.status).toBe(415);
    expect(none.body.skipped).toEqual(['phone.webp']);
  });

  it('keeps the command ONLYOFFICE asked for, defaulting to add', async () => {
    expect((await insert({ c: 'watermark', fileIds: ['stamp1'] })).body.c).toBe('watermark');
    expect((await insert({ c: 'nonsense', fileIds: ['stamp1'] })).body.c).toBe('add');
  });

  it('needs ONLYOFFICE set up, and a document the person can see', async () => {
    expect((await insert({ fileIds: ['stamp1'] }, mkApp('crew', {}))).status).toBe(503);
    putBuffer(db, dataDir, 'inv', Buffer.from('%PDF'), 'application/pdf', { kind: 'invoice', name: 'Invoice.pdf' });
    expect((await request(mkApp()).post('/api/onlyoffice/insert-image/inv').send({ fileIds: ['stamp1'] })).status).toBe(404);
  });
});

describe('POST /api/onlyoffice/save-copy/:fileId', () => {
  const copy = (body: Record<string, unknown>, fileId = 'doc1', a = mkApp()) => request(a).post(`/api/onlyoffice/save-copy/${fileId}`).send(body);
  const cached = (content: string, name = 'output.pdf') => {
    const url = `https://docs.example.com/cache/files/data/conv/${name}?md5=x&expires=1`;
    dsFiles.set(url.replace('https://docs.example.com', 'http://onlyoffice'), Buffer.from(content));
    return url;
  };

  it('files the copy next to the original: same project and customer, named with its new extension', async () => {
    const r = await copy({ url: cached('%PDF copy'), title: 'Letter.pdf', fileType: 'pdf' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Letter.pdf');
    expect(getMeta(db, r.body.fileId)).toMatchObject({ projectId: 'p1', customerId: 'c1', kind: 'document', mime: 'application/pdf', createdBy: 'u-crew' });
    expect(readFileContent(dataDir, r.body.fileId)!.toString()).toBe('%PDF copy');
    expect(fetched[0]).toMatch(/^http:\/\/onlyoffice\/cache\//); // over the internal address
  });

  it('a spreadsheet copy is a spreadsheet; a company document stays one', async () => {
    const sheet = await copy({ url: cached('csv', 'output.csv'), title: 'Letter', fileType: 'csv' });
    expect(getMeta(db, sheet.body.fileId)).toMatchObject({ kind: 'spreadsheet', name: 'Letter.csv', mime: 'text/csv' });
    putBuffer(db, dataDir, 'policy', Buffer.from('docx'), DOCX, { kind: 'company-document', name: 'Policy.docx' });
    const company = await copy({ url: cached('%PDF'), title: 'Policy.pdf', fileType: 'pdf' }, 'policy');
    expect(getMeta(db, company.body.fileId)).toMatchObject({ kind: 'company-document', projectId: null });
  });

  it('refuses links that are not ONLYOFFICE, without fetching them', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'https://evil.example.com/x.pdf', 'file:///etc/passwd', 'not a url']) {
      const r = await copy({ url, title: 'x.pdf', fileType: 'pdf' });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('bad-url');
    }
    expect(fetched).toEqual([]);
  });

  it('reports a failed download or an unknown format, saving nothing', async () => {
    const missing = await copy({ url: 'https://docs.example.com/cache/files/data/gone/output.pdf', title: 'x.pdf', fileType: 'pdf' });
    expect(missing.status).toBe(502);
    expect((await copy({ url: cached('x'), title: 'x', fileType: 'exe' })).status).toBe(415);
    expect(db.prepare("SELECT COUNT(*) c FROM files WHERE id NOT IN ('doc1','photo1','webp1','stamp1','sig-crew','sig-admin')").get()).toEqual({ c: 0 });
  });
});

describe('isOnlyofficeLink', () => {
  it('accepts only http(s) links on the public or internal ONLYOFFICE address', () => {
    const cfg = { publicUrl: 'https://docs.example.com', internalUrl: 'http://onlyoffice' } as any;
    expect(isOnlyofficeLink(cfg, 'https://docs.example.com/cache/a.pdf')).toBe(true);
    expect(isOnlyofficeLink(cfg, 'http://onlyoffice/cache/a.pdf')).toBe(true);
    expect(isOnlyofficeLink(cfg, 'https://docs.example.com.evil.com/a.pdf')).toBe(false);
    expect(isOnlyofficeLink(cfg, 'http://docs.example.com/a.pdf')).toBe(false); // other scheme, other origin
    expect(isOnlyofficeLink(cfg, 42)).toBe(false);
  });
});
