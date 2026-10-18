// Conversions (ONLYOFFICE Phase 4): the polling conversion client, old
// formats converted on upload (the original kept as version 1), the pay app
// PDF, first-page thumbnails, and photos shrunk with sharp. A fake fetch plays
// the Document Server's conversion service and file cache.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { registerDataRoutes } from '../routes';
import { getMeta, listVersions, putBuffer, saveNewVersion } from '../files';
import { readFileContent } from '../fileStore';
import { registerOnlyofficeRoutes } from './routes';
import { createOnlyofficeServices, type OnlyofficeServices } from './services';
import { convert } from './client';
import { uploadConversionTarget } from './conversions';
import { PHOTO_THUMBNAIL_SIZE } from './thumbnails';
import { SIGNATURE_KIND } from '../documentLibrary';

const SECRET = 'shared-oo-secret';
const ENV = {
  ONLYOFFICE_PUBLIC_URL: 'https://docs.example.com',
  ONLYOFFICE_INTERNAL_URL: 'http://onlyoffice',
  APP_INTERNAL_URL: 'http://app:3000',
  ONLYOFFICE_JWT_SECRET: SECRET,
};
const CFG = { publicUrl: ENV.ONLYOFFICE_PUBLIC_URL, internalUrl: ENV.ONLYOFFICE_INTERNAL_URL, appInternalUrl: ENV.APP_INTERNAL_URL, jwtSecret: SECRET };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let db: Database.Database;
let dataDir: string;
let requests: any[];
/** How the fake converter answers: a conversion error code, or how many
 *  "still working" answers come before the result. */
let converterError: number;
let pendingPolls: number;
/** What the fake converter returns; by default "<from>-><to>". */
let converted: string | null;
let dsFiles: Map<string, Buffer>;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fakeFetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  if (url === 'http://onlyoffice/converter') {
    const params = jwt.verify(JSON.parse(init.body).token, SECRET) as any;
    requests.push(params);
    if (converterError) return json({ error: converterError });
    if (pendingPolls > 0) { pendingPolls--; return json({ endConvert: false, percent: 50 }); }
    const fileUrl = `https://docs.example.com/cache/files/conv/${params.key}/output.${params.outputtype}`;
    dsFiles.set(fileUrl.replace('https://docs.example.com', 'http://onlyoffice'), Buffer.from(converted ?? `${params.filetype}->${params.outputtype}`));
    return json({ endConvert: true, percent: 100, fileUrl, fileType: params.outputtype });
  }
  const file = dsFiles.get(url);
  return file ? new Response(file, { status: 200 }) : new Response('nf', { status: 404 });
}) as typeof fetch;

let services: OnlyofficeServices;
const users: Record<string, any> = { admin: { id: 'u-admin', role: 'admin' }, crew: { id: 'u-crew', role: 'user' } };
const mkApp = (as: 'admin' | 'crew' = 'admin', env: Record<string, string> = ENV) => {
  services = createOnlyofficeServices({ env, appJwtSecret: 'app-secret', db, dataDir, fetch: fakeFetch });
  const a = express();
  a.use(express.json());
  const authenticateToken = (req: any, _res: any, next: any) => { req.user = users[as]; next(); };
  const requireAdmin = (req: any, res: any, next: any) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }));
  registerDataRoutes(a, {
    db, dataDir, dbFile: path.join(dataDir, 'app.db'), authenticateToken, requireAdmin,
    verifyToken: () => users[as], broadcastChange: () => {}, onlyoffice: services,
  });
  registerOnlyofficeRoutes(a, {
    env, appJwtSecret: 'app-secret', authenticateToken, requireAdmin, db, dataDir, broadcastChange: () => {}, fetch: fakeFetch, services,
  });
  return a;
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-oo-conv-'));
  db = openDb(':memory:');
  runMigrations(db, dataDir, migrations);
  requests = [];
  converterError = 0;
  pendingPolls = 0;
  converted = null;
  dsFiles = new Map();
});

describe('convert (conversion client)', () => {
  const req = { filetype: 'docx', outputtype: 'pdf', key: 'k1', title: 'a.docx', url: 'http://app:3000/f' };

  it('asks asynchronously and polls with the same request until ONLYOFFICE is done', async () => {
    pendingPolls = 2;
    const r = await convert(CFG as any, fakeFetch, req, 5000, 1);
    expect(r.fileType).toBe('pdf');
    expect(requests).toHaveLength(3);
    expect(requests.every(p => p.async === true && p.key === 'k1')).toBe(true);
  });

  it('turns error codes into reasons, and gives up after the time allowed', async () => {
    converterError = -5;
    await expect(convert(CFG as any, fakeFetch, req, 5000, 1)).rejects.toThrow('password-protected');
    converterError = -4;
    await expect(convert(CFG as any, fakeFetch, req, 5000, 1)).rejects.toMatchObject({ code: 'download-failed' });
    converterError = 0;
    pendingPolls = 1000;
    await expect(convert(CFG as any, fakeFetch, req, 30, 10)).rejects.toThrow('ran out of time');
  });
});

describe('uploadConversionTarget', () => {
  it('converts old and unusual formats by extension, and leaves the rest alone', () => {
    expect(uploadConversionTarget('Budget.XLS')).toEqual({ from: 'xls', to: 'xlsx' });
    expect(uploadConversionTarget('Spec.pages')).toEqual({ from: 'pages', to: 'docx' });
    expect(uploadConversionTarget('Deck.key')).toEqual({ from: 'key', to: 'pptx' });
    for (const n of ['a.docx', 'a.xlsx', 'a.pdf', 'a.csv', 'a.txt', 'a.png', 'noext', null]) expect(uploadConversionTarget(n)).toBeNull();
  });
});

describe('conversion on upload', () => {
  const upload = (a: express.Express, name: string, qs = 'kind=spreadsheet&projectId=p1', body = 'old xls bytes') =>
    request(a).post(`/api/files/up1?${qs}&name=${encodeURIComponent(name)}`).set('Content-Type', 'application/vnd.ms-excel').send(Buffer.from(body));

  it('keeps the upload as version 1 and makes the converted file version 2, renamed', async () => {
    const r = await upload(mkApp(), 'Budget.xls');
    expect(r.body.conversion).toEqual({ status: 'converted', from: 'xls', to: 'xlsx', name: 'Budget.xlsx' });
    const [now, original] = listVersions(db, 'up1');
    expect(now).toMatchObject({ versionNumber: 2, name: 'Budget.xlsx', mime: XLSX, versionOrigin: 'convert', createdBy: 'u-admin' });
    expect(readFileContent(dataDir, now.id)!.toString()).toBe('xls->xlsx');
    expect(original).toMatchObject({ versionNumber: 1, mime: 'application/vnd.ms-excel' });
    expect(readFileContent(dataDir, original.id)!.toString()).toBe('old xls bytes');
    expect(requests[0]).toMatchObject({ filetype: 'xls', outputtype: 'xlsx', title: 'Budget.xls' });
    expect(requests[0].url).toMatch(/^http:\/\/app:3000\/api\/onlyoffice\/file\/up1\?t=/);
  });

  it('keeps the original, and says why, when conversion fails', async () => {
    converterError = -3;
    const r = await upload(mkApp(), 'Budget.xls');
    expect(r.status).toBe(200);
    expect(r.body.conversion).toMatchObject({ status: 'failed', from: 'xls', to: 'xlsx' });
    expect(r.body.conversion.message).toMatch(/^Kept as \.xls: ONLYOFFICE couldn't convert/);
    expect(listVersions(db, 'up1').map(v => v.versionNumber)).toEqual([1]);
    expect(getMeta(db, 'up1')!.name).toBe('Budget.xls');
  });

  it('says so when the editor is not set up', async () => {
    const r = await upload(mkApp('admin', {}), 'Notes.odt', 'kind=document&projectId=p1');
    expect(r.body.conversion).toMatchObject({ status: 'failed', message: expect.stringContaining("isn't set up") });
    expect(requests).toEqual([]);
  });

  it('leaves modern formats and generated documents alone', async () => {
    const a = mkApp();
    expect((await upload(a, 'Budget.xlsx')).body.conversion).toBeUndefined();
    const generated = await upload(a, 'Old.xls', 'kind=payapp-export&sourceType=payapp&sourceId=pa1&projectId=p1');
    expect(generated.body.conversion).toBeUndefined();
    await services.thumbnails.idle();
    expect(requests.filter(r => r.outputtype !== 'png')).toEqual([]); // thumbnails aside
  });
});

describe('POST /api/onlyoffice/pay-app-pdf/:payAppId', () => {
  const workbook = (body = 'workbook v1') =>
    putBuffer(db, dataDir, `wb-${Math.random()}`, Buffer.from(body), XLSX, {
      kind: 'payapp-export', sourceType: 'payapp', sourceId: 'pa1', projectId: 'p1', customerId: 'c1', name: 'Pay App #3 — G702.xlsx',
    });

  it('makes the workbook into a PDF of the pay app, en-US, as a new version each time', async () => {
    workbook();
    const a = mkApp();
    const r = await request(a).post('/api/onlyoffice/pay-app-pdf/pa1');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Pay App #3 — G702.pdf', versionNumber: 1 });
    expect(getMeta(db, r.body.fileId)).toMatchObject({
      kind: 'payapp-pdf', sourceType: 'payapp', sourceId: 'pa1', projectId: 'p1', customerId: 'c1', mime: 'application/pdf',
    });
    expect(readFileContent(dataDir, r.body.fileId)!.toString()).toBe('xlsx->pdf');
    expect(requests[0]).toMatchObject({ filetype: 'xlsx', outputtype: 'pdf', region: 'en-US' });
    // Every sheet (G702 and G703), landscape, each sheet's own fit and breaks.
    expect(requests[0].spreadsheetLayout).toEqual({ orientation: 'landscape', ignorePrintArea: false });

    // Nothing changed: the same PDF back, no duplicate version.
    const same = await request(a).post('/api/onlyoffice/pay-app-pdf/pa1');
    expect(same.body).toMatchObject({ fileId: r.body.fileId, versionNumber: 1, changed: false });

    workbook('workbook v2');
    converted = 'xlsx->pdf (v2)';
    const again = await request(a).post('/api/onlyoffice/pay-app-pdf/pa1');
    expect(again.body).toMatchObject({ fileId: r.body.fileId, versionNumber: 2, changed: true });
  });

  it('is for admins, needs the workbook, and reports a failed conversion', async () => {
    workbook();
    expect((await request(mkApp('crew')).post('/api/onlyoffice/pay-app-pdf/pa1')).status).toBe(403);
    expect((await request(mkApp()).post('/api/onlyoffice/pay-app-pdf/nope')).body.code).toBe('no-workbook');
    converterError = -3;
    const failed = await request(mkApp()).post('/api/onlyoffice/pay-app-pdf/pa1');
    expect(failed.status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) c FROM files WHERE kind = 'payapp-pdf'").get()).toEqual({ c: 0 });
  });
});

describe('thumbnails', () => {
  const thumb = (a: express.Express, id = 'doc1') => request(a).get(`/api/onlyoffice/thumbnail/${id}`);

  beforeEach(() => {
    putBuffer(db, dataDir, 'doc1', Buffer.from('docx bytes'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', { projectId: 'p1', kind: 'document', name: 'Letter.docx' });
  });

  it('queues a missing one, then serves the PNG of page one, cached by content', async () => {
    const a = mkApp();
    expect((await thumb(a)).status).toBe(202);
    await services.thumbnails.idle();
    const r = await thumb(a);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(requests[0]).toMatchObject({ filetype: 'docx', outputtype: 'png', thumbnail: { first: true, aspect: 1, width: 320, height: 320 } });

    // A new version has new bytes, so a new thumbnail; the same bytes elsewhere share one.
    saveNewVersion(db, dataDir, 'doc1', Buffer.from('edited'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect((await thumb(a)).status).toBe(202);
    await services.thumbnails.idle();
    expect(requests).toHaveLength(2);
  });

  it('has none for images, admin-only files for others, or while ONLYOFFICE is not set up', async () => {
    putBuffer(db, dataDir, 'pic', Buffer.from('png'), 'image/png', { name: 'site.png' });
    putBuffer(db, dataDir, 'inv', Buffer.from('%PDF'), 'application/pdf', { kind: 'invoice', name: 'Invoice.pdf' });
    expect((await thumb(mkApp(), 'pic')).status).toBe(404);
    expect((await thumb(mkApp('crew'), 'inv')).status).toBe(404);
    expect((await thumb(mkApp('admin', {}))).status).toBe(404);
  });

  it('does not keep retrying a file ONLYOFFICE could not render', async () => {
    converterError = -3;
    const a = mkApp();
    expect((await thumb(a)).status).toBe(202);
    await services.thumbnails.idle();
    expect((await thumb(a)).status).toBe(404);
    expect(requests).toHaveLength(1);
  });

  it('are made after an upload, and swept once their file is gone', async () => {
    const a = mkApp();
    await request(a).post('/api/files/up2?kind=document&projectId=p1&name=Memo.docx').set('Content-Type', 'application/octet-stream').send(Buffer.from('memo'));
    await services.thumbnails.idle();
    const sha = getMeta(db, 'up2')!.sha256;
    expect(fs.existsSync(services.thumbnails.pathFor(sha))).toBe(true);
    db.prepare("DELETE FROM files WHERE id = 'up2'").run();
    expect(services.thumbnails.sweep()).toBe(1);
    expect(fs.existsSync(services.thumbnails.pathFor(sha))).toBe(false);
  });
});

describe('photo thumbnails', () => {
  const thumb = (a: express.Express, id = 'pic') => request(a).get(`/api/images/${id}/thumb`).set('Authorization', 'Bearer t').buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  const photo = (width: number, height: number, opts: { orientation?: number } = {}) =>
    sharp({ create: { width, height, channels: 3, background: '#3a7' } }).jpeg().withMetadata(opts).toBuffer();

  it('shrinks a photo to a WebP, with no Document Server needed', async () => {
    putBuffer(db, dataDir, 'pic', await photo(2000, 1500), 'image/jpeg', { projectId: 'p1', kind: 'photo', name: 'site.jpg' });
    const r = await thumb(mkApp('admin', {}));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/webp');
    expect(r.headers['cache-control']).toBe('private, max-age=31536000');
    const m = await sharp(r.body).metadata();
    expect([m.format, m.width, m.height]).toEqual(['webp', PHOTO_THUMBNAIL_SIZE, 360]);
    expect(r.body.length).toBeLessThan(20_000);
    expect(requests).toHaveLength(0);
  });

  it('turns a photo upright by its EXIF orientation, and never enlarges a small one', async () => {
    // Taken sideways: stored 400×200, meant to be seen 200×400.
    putBuffer(db, dataDir, 'pic', await photo(400, 200, { orientation: 6 }), 'image/jpeg', { name: 'sideways.jpg' });
    const r = await thumb(mkApp());
    const m = await sharp(r.body).metadata();
    expect([m.width, m.height, m.orientation ?? 1]).toEqual([200, 400, 1]);
  });

  it('keeps a transparent PNG transparent', async () => {
    const png = await sharp({ create: { width: 600, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    putBuffer(db, dataDir, 'pic', png, 'image/png', { name: 'logo.png' });
    const m = await sharp((await thumb(mkApp())).body).metadata();
    expect(m.hasAlpha).toBe(true);
  });

  it('sends the original for anything it cannot shrink, and nothing for a signature or a missing file', async () => {
    const a = mkApp();
    putBuffer(db, dataDir, 'svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', { name: 'logo.svg' });
    putBuffer(db, dataDir, 'bad', Buffer.from('not a jpeg'), 'image/jpeg', { name: 'broken.jpg' });
    putBuffer(db, dataDir, 'doc', Buffer.from('docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', { name: 'a.docx' });
    for (const id of ['svg', 'bad', 'bad', 'doc']) {
      const r = await request(a).get(`/api/images/${id}/thumb`).set('Authorization', 'Bearer t');
      expect([r.status, r.headers.location]).toEqual([302, `/api/images/${id}/raw`]);
    }
    putBuffer(db, dataDir, 'sig', await photo(300, 100), 'image/png', { kind: SIGNATURE_KIND, name: 'Signature.png' });
    expect((await request(a).get('/api/images/sig/thumb').set('Authorization', 'Bearer t')).status).toBe(404);
    expect((await request(a).get('/api/images/nope/thumb').set('Authorization', 'Bearer t')).status).toBe(404);
    expect(fs.existsSync(path.join(dataDir, 'thumbnails'))).toBe(false);
  });

  it('makes one thumbnail however many ask at once', async () => {
    putBuffer(db, dataDir, 'pic', await photo(1200, 900), 'image/jpeg', { name: 'site.jpg' });
    for (let i = 0; i < 4; i++) putBuffer(db, dataDir, `pic${i}`, await photo(800 + i, 600), 'image/jpeg', { name: `p${i}.jpg` });
    const a = mkApp();
    const all = await Promise.all(['pic', 'pic', 'pic', 'pic0', 'pic1', 'pic2', 'pic3'].map(id => thumb(a, id)));
    expect(all.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200, 200]);
    expect(fs.readdirSync(path.join(dataDir, 'thumbnails')).filter(n => n.endsWith('.webp'))).toHaveLength(5);
  });

  it('are made after an upload, and swept once their file is gone', async () => {
    const a = mkApp('admin', {});
    await request(a).post('/api/files/up3?kind=photo&projectId=p1&name=site.jpg').set('Content-Type', 'image/jpeg').send(await photo(900, 600));
    await services.thumbnails.idle();
    const sha = getMeta(db, 'up3')!.sha256;
    expect(fs.existsSync(services.thumbnails.photoPathFor(sha))).toBe(true);
    db.prepare("DELETE FROM files WHERE id = 'up3'").run();
    expect(services.thumbnails.sweep()).toBe(1);
    expect(fs.existsSync(services.thumbnails.photoPathFor(sha))).toBe(false);
  });
});
