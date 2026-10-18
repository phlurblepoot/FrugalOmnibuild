import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { mergePdfs, insertPages, appendPages, parsePageRanges, PdfMergeError } from './pdfMerge';

const makePdf = async (sizes: [number, number][]) => {
  const d = await PDFDocument.create();
  for (const [w, h] of sizes) d.addPage([w, h]);
  return Buffer.from(await d.save());
};

describe('mergePdfs', () => {
  it('joins pages in the order given', async () => {
    const a = await makePdf([[100, 100], [110, 110]]);
    const b = await makePdf([[200, 200]]);
    const merged = await PDFDocument.load(await mergePdfs([a, b]));
    expect(merged.getPageCount()).toBe(3);
    expect(merged.getPages().map(p => p.getWidth())).toEqual([100, 110, 200]);
  });

  it('keeps the order when reversed', async () => {
    const a = await makePdf([[100, 100]]);
    const b = await makePdf([[200, 200]]);
    const merged = await PDFDocument.load(await mergePdfs([b, a]));
    expect(merged.getPages().map(p => p.getWidth())).toEqual([200, 100]);
  });

  it('refuses fewer than two PDFs', async () => {
    await expect(mergePdfs([await makePdf([[10, 10]])])).rejects.toBeInstanceOf(PdfMergeError);
  });

  it('names which PDF could not be read', async () => {
    const a = await makePdf([[10, 10]]);
    await expect(mergePdfs([a, Buffer.from('not a pdf')])).rejects.toMatchObject({ index: 1 });
  });
});

describe('insertPages', () => {
  const widths = async (b: Uint8Array) => (await PDFDocument.load(b)).getPages().map(p => p.getWidth());
  const target = () => makePdf([[1, 10], [2, 10], [3, 10]]);
  const source = () => makePdf([[10, 10], [20, 10], [30, 10]]);

  it('appends all pages at the end by default', async () => {
    expect(await widths(await insertPages(await target(), await source()))).toEqual([1, 2, 3, 10, 20, 30]);
  });

  it('inserts at the start', async () => {
    expect(await widths(await insertPages(await target(), await source(), { position: 'start' }))).toEqual([10, 20, 30, 1, 2, 3]);
  });

  it('inserts after page N', async () => {
    expect(await widths(await insertPages(await target(), await source(), { position: { afterPage: 2 } }))).toEqual([1, 2, 10, 20, 30, 3]);
    expect(await widths(await insertPages(await target(), await source(), { position: { afterPage: 0 } }))).toEqual([10, 20, 30, 1, 2, 3]);
    expect(await widths(await insertPages(await target(), await source(), { position: { afterPage: 3 } }))).toEqual([1, 2, 3, 10, 20, 30]);
  });

  it('takes chosen pages in the order given', async () => {
    expect(await widths(await insertPages(await target(), await source(), { pages: [3, 1], position: { afterPage: 1 } }))).toEqual([1, 30, 10, 2, 3]);
  });

  it('rejects pages and positions that do not exist', async () => {
    await expect(insertPages(await target(), await source(), { pages: [4] })).rejects.toBeInstanceOf(PdfMergeError);
    await expect(insertPages(await target(), await source(), { pages: [0] })).rejects.toBeInstanceOf(PdfMergeError);
    await expect(insertPages(await target(), await source(), { pages: [] })).rejects.toBeInstanceOf(PdfMergeError);
    await expect(insertPages(await target(), await source(), { position: { afterPage: 4 } })).rejects.toBeInstanceOf(PdfMergeError);
  });
});

describe('POST /api/files/merge-pdf', () => {
  it('saves the merged PDF as a new document', { timeout: 30000 }, async () => {
    const os = await import('os'); const fs = await import('fs'); const path = await import('path');
    const express = (await import('express')).default; const request = (await import('supertest')).default;
    const { openDb } = await import('./db'); const { runMigrations } = await import('./migrations');
    const { migrations } = await import('./migrationList'); const { registerDataRoutes } = await import('./routes');
    const { putBuffer, getMeta } = await import('./files');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-merge-'));
    const db = openDb(':memory:'); runMigrations(db, dir, migrations);
    const app = express(); app.use(express.json());
    registerDataRoutes(app, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _r: any, n: any) => { req.user = { id: 'u1', role: 'admin' }; n(); },
      requireAdmin: (_q: any, _r: any, n: any) => n(), verifyToken: () => null, broadcastChange: () => {},
    } as any);
    putBuffer(db, dir, 'a', await makePdf([[10, 10]]), 'application/pdf', { name: 'a.pdf', projectId: 'p1' });
    putBuffer(db, dir, 'b', await makePdf([[20, 10], [30, 10]]), 'application/pdf', { name: 'b.pdf', projectId: 'p1' });
    putBuffer(db, dir, 'c', Buffer.from('x'), 'image/png', { name: 'c.png' });
    const ok = await request(app).post('/api/files/merge-pdf').send({ ids: ['b', 'a'] });
    expect(ok.status).toBe(200);
    const meta = getMeta(db, ok.body.fileId)!;
    expect(meta.projectId).toBe('p1');
    expect(meta.name).toBe('b (merged).pdf');
    const { readFileContent } = await import('./fileStore');
    const doc = await PDFDocument.load(readFileContent(dir, meta.id)!);
    expect(doc.getPages().map(p => p.getWidth())).toEqual([20, 30, 10]);
    expect((await request(app).post('/api/files/merge-pdf').send({ ids: ['a', 'c'] })).status).toBe(400);
    expect((await request(app).post('/api/files/merge-pdf').send({ ids: ['a'] })).status).toBe(400);
  });
});

describe('parsePageRanges', () => {
  it('reads pages and ranges, blank is all', () => {
    expect(parsePageRanges('', 3)).toEqual([1, 2, 3]);
    expect(parsePageRanges('1-2, 3', 3)).toEqual([1, 2, 3]);
    expect(parsePageRanges('3-1', 3)).toEqual([3, 2, 1]);
    expect(parsePageRanges('2 2', 3)).toEqual([2, 2]);
  });
  it('rejects junk and pages out of range', () => {
    expect(() => parsePageRanges('x', 3)).toThrow(PdfMergeError);
    expect(() => parsePageRanges('0', 3)).toThrow(PdfMergeError);
    expect(() => parsePageRanges('2-9', 3)).toThrow(PdfMergeError);
  });
});

describe('appendPages', () => {
  const widths = async (b: Uint8Array) => (await PDFDocument.load(b)).getPages().map(p => p.getWidth());
  it('puts several sources at one spot, in order', async () => {
    const t = await makePdf([[1, 10], [2, 10]]);
    const a = await makePdf([[10, 10], [20, 10]]);
    const b = await makePdf([[30, 10], [40, 10]]);
    const out = await appendPages(t, [{ bytes: a, pages: '2' }, { bytes: b }], { afterPage: 1 });
    expect(await widths(out)).toEqual([1, 20, 30, 40, 2]);
    expect(await widths(await appendPages(t, [{ bytes: a }, { bytes: b, pages: '1' }], 'start'))).toEqual([10, 20, 30, 1, 2]);
    expect(await widths(await appendPages(t, [{ bytes: a, pages: '1' }]))).toEqual([1, 2, 10]);
  });
  it('names the source with a bad page list', async () => {
    const t = await makePdf([[1, 10]]);
    const a = await makePdf([[10, 10]]);
    await expect(appendPages(t, [{ bytes: a }, { bytes: a, pages: '5' }])).rejects.toMatchObject({ index: 1 });
    await expect(appendPages(t, [])).rejects.toBeInstanceOf(PdfMergeError);
  });
});

describe('POST /api/files/:id/append-pdf', () => {
  it('saves the result as a new version of the PDF', { timeout: 30000 }, async () => {
    const os = await import('os'); const fs = await import('fs'); const path = await import('path');
    const express = (await import('express')).default; const request = (await import('supertest')).default;
    const { openDb } = await import('./db'); const { runMigrations } = await import('./migrations');
    const { migrations } = await import('./migrationList'); const { registerDataRoutes } = await import('./routes');
    const { putBuffer, getMeta, listVersions } = await import('./files');
    const { readFileContent } = await import('./fileStore');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-append-'));
    const db = openDb(':memory:'); runMigrations(db, dir, migrations);
    const app = express(); app.use(express.json());
    registerDataRoutes(app, {
      db, dataDir: dir, dbFile: path.join(dir, 'app.db'),
      authenticateToken: (req: any, _r: any, n: any) => { req.user = { id: 'u1', role: 'admin' }; n(); },
      requireAdmin: (_q: any, _r: any, n: any) => n(), verifyToken: () => null, broadcastChange: () => {},
    } as any);
    putBuffer(db, dir, 'a', await makePdf([[1, 10], [2, 10]]), 'application/pdf', { name: 'a.pdf' });
    putBuffer(db, dir, 'b', await makePdf([[20, 10], [30, 10]]), 'application/pdf', { name: 'b.pdf' });
    putBuffer(db, dir, 'c', Buffer.from('x'), 'image/png', { name: 'c.png' });
    const ok = await request(app).post('/api/files/a/append-pdf').send({ sources: [{ id: 'b', pages: '2' }], position: { afterPage: 1 } });
    expect(ok.status).toBe(200);
    expect(getMeta(db, 'a')!.versionNumber).toBe(2);
    expect(listVersions(db, 'a').length).toBeGreaterThan(1);
    const doc = await PDFDocument.load(readFileContent(dir, 'a')!);
    expect(doc.getPages().map(p => p.getWidth())).toEqual([1, 30, 2]);
    expect((await request(app).post('/api/files/a/append-pdf').send({ sources: [{ id: 'c' }] })).status).toBe(400);
    expect((await request(app).post('/api/files/a/append-pdf').send({ sources: [{ id: 'b', pages: '9' }] })).status).toBe(400);
    expect((await request(app).post('/api/files/a/append-pdf').send({ sources: [] })).status).toBe(400);
    expect((await request(app).post('/api/files/nope/append-pdf').send({ sources: [{ id: 'b' }] })).status).toBe(404);
  });
});
