// Unit coverage for the in-memory PDF document + rendered-bitmap caches that
// back instant page flips in PdfCanvas (src/components/PdfCanvas.tsx).
// pdfjs-dist is mocked exactly like previewEngine.test.ts does — no real PDF
// parse, and it gives us a `getDocument` spy to assert call counts / inspect
// in-flight sharing against.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDocument = vi.fn();

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: (...args: unknown[]) => getDocument(...args),
}));

import {
  getCachedPdfDocument,
  getCachedPageBitmap,
  putCachedPageBitmap,
  _setBudgetForTests,
  _inspectPdfCachesForTests,
  _resetPdfCachesForTests,
  PDF_DOC_CACHE_MAX,
} from './pdfDocCache';

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** A loading-task-shaped object: { onProgress, promise }. */
function makeLoadingTask(resolveWith: any, opts: { rejectWith?: any } = {}) {
  const task: any = { onProgress: undefined };
  task.promise = opts.rejectWith
    ? Promise.reject(opts.rejectWith)
    : Promise.resolve(resolveWith);
  return task;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetPdfCachesForTests();
});

describe('getCachedPdfDocument', () => {
  it('loads once and returns a promise resolving to the proxy', async () => {
    const proxy = { destroy: vi.fn(async () => {}) };
    getDocument.mockReturnValue(makeLoadingTask(proxy));

    const result = await getCachedPdfDocument('https://example.test/a.pdf');
    expect(result).toBe(proxy);
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledWith({ url: 'https://example.test/a.pdf' });
  });

  it('shares one in-flight promise across concurrent callers for the same url', async () => {
    const proxy = { destroy: vi.fn(async () => {}) };
    getDocument.mockReturnValue(makeLoadingTask(proxy));

    const p1 = getCachedPdfDocument('https://example.test/a.pdf');
    const p2 = getCachedPdfDocument('https://example.test/a.pdf');
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(p1).toBe(p2);
    await expect(p1).resolves.toBe(proxy);
  });

  it('only wires onProgress for the caller that triggered the load', async () => {
    const proxy = { destroy: vi.fn(async () => {}) };
    const task = makeLoadingTask(proxy);
    getDocument.mockReturnValue(task);

    const progress1 = vi.fn();
    const progress2 = vi.fn();
    const p1 = getCachedPdfDocument('https://example.test/a.pdf', progress1);
    const p2 = getCachedPdfDocument('https://example.test/a.pdf', progress2);
    await Promise.all([p1, p2]);

    // The task's onProgress hook was wired to the FIRST caller only.
    expect(task.onProgress).toBeDefined();
    task.onProgress({ loaded: 10, total: 100 });
    expect(progress1).toHaveBeenCalledWith({ loaded: 10, total: 100 });
    expect(progress2).not.toHaveBeenCalled();
  });

  it('a later cache hit (already resolved) fires no progress at all', async () => {
    const proxy = { destroy: vi.fn(async () => {}) };
    getDocument.mockReturnValue(makeLoadingTask(proxy));

    await getCachedPdfDocument('https://example.test/a.pdf');
    expect(getDocument).toHaveBeenCalledTimes(1);

    const progress = vi.fn();
    const cached = await getCachedPdfDocument('https://example.test/a.pdf', progress);
    expect(cached).toBe(proxy);
    // No second load was even started, so there is nothing to report progress on.
    expect(getDocument).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
  });

  it('evicts the least-recently-used document once more than PDF_DOC_CACHE_MAX are loaded, destroying its proxy', async () => {
    expect(PDF_DOC_CACHE_MAX).toBe(2);
    const proxyA = { destroy: vi.fn(async () => {}) };
    const proxyB = { destroy: vi.fn(async () => {}) };
    const proxyC = { destroy: vi.fn(async () => {}) };

    getDocument.mockReturnValueOnce(makeLoadingTask(proxyA));
    await getCachedPdfDocument('a.pdf');
    getDocument.mockReturnValueOnce(makeLoadingTask(proxyB));
    await getCachedPdfDocument('b.pdf');
    expect(_inspectPdfCachesForTests().docCount).toBe(2);

    // Touch 'a' so 'b' becomes the LRU victim.
    await getCachedPdfDocument('a.pdf');

    getDocument.mockReturnValueOnce(makeLoadingTask(proxyC));
    await getCachedPdfDocument('c.pdf');

    expect(_inspectPdfCachesForTests().docCount).toBe(2);
    // 'b' was evicted and destroyed; 'a' and 'c' survive.
    await vi.waitFor(() => expect(proxyB.destroy).toHaveBeenCalledTimes(1));
    expect(proxyA.destroy).not.toHaveBeenCalled();
    expect(proxyC.destroy).not.toHaveBeenCalled();
  });

  it('does not cache a failed load — the next call retries', async () => {
    getDocument.mockReturnValueOnce(makeLoadingTask(null, { rejectWith: new Error('network down') }));
    await expect(getCachedPdfDocument('flaky.pdf')).rejects.toThrow('network down');
    expect(_inspectPdfCachesForTests().docCount).toBe(0);

    const proxy = { destroy: vi.fn(async () => {}) };
    getDocument.mockReturnValueOnce(makeLoadingTask(proxy));
    const result = await getCachedPdfDocument('flaky.pdf');
    expect(result).toBe(proxy);
    expect(getDocument).toHaveBeenCalledTimes(2);
  });
});

describe('bitmap cache', () => {
  it('returns null on a miss and the cached canvas on a hit', () => {
    expect(getCachedPageBitmap('page-1')).toBeNull();
    const canvas = makeCanvas(10, 10);
    putCachedPageBitmap('page-1', canvas);
    expect(getCachedPageBitmap('page-1')).toBe(canvas);
  });

  it('evicts least-recently-used entries once the budget is exceeded', () => {
    // Each canvas is 10x10x4 bytes = 400 bytes. Budget for 2.5 entries.
    _setBudgetForTests(1000);
    putCachedPageBitmap('p1', makeCanvas(10, 10));
    putCachedPageBitmap('p2', makeCanvas(10, 10));
    putCachedPageBitmap('p3', makeCanvas(10, 10));
    // 3 * 400 = 1200 > 1000 budget -> oldest (p1) evicted, leaving 800.
    expect(getCachedPageBitmap('p1')).toBeNull();
    expect(getCachedPageBitmap('p2')).not.toBeNull();
    expect(getCachedPageBitmap('p3')).not.toBeNull();
  });

  it('touching an entry (a get) protects it from the next eviction', () => {
    _setBudgetForTests(1000);
    putCachedPageBitmap('p1', makeCanvas(10, 10));
    putCachedPageBitmap('p2', makeCanvas(10, 10));
    // Touch p1 so it becomes more-recently-used than p2.
    expect(getCachedPageBitmap('p1')).not.toBeNull();
    putCachedPageBitmap('p3', makeCanvas(10, 10));
    // p2 is now the LRU victim, not p1.
    expect(getCachedPageBitmap('p2')).toBeNull();
    expect(getCachedPageBitmap('p1')).not.toBeNull();
    expect(getCachedPageBitmap('p3')).not.toBeNull();
  });

  it('keeps a single oversized entry alone rather than rejecting it', () => {
    _setBudgetForTests(100); // smaller than a single 10x10 canvas (400 bytes)
    const big = makeCanvas(10, 10);
    putCachedPageBitmap('huge', big);
    expect(getCachedPageBitmap('huge')).toBe(big);
    expect(_inspectPdfCachesForTests().bitmapCount).toBe(1);
  });

  it('putting a bitmap that alone exceeds the budget evicts everything else', () => {
    _setBudgetForTests(1000);
    putCachedPageBitmap('small1', makeCanvas(10, 10)); // 400 bytes
    putCachedPageBitmap('small2', makeCanvas(10, 10)); // 400 bytes
    // A canvas whose bytes alone (40x40x4 = 6400) blow the 1000 budget.
    putCachedPageBitmap('big', makeCanvas(40, 40));
    expect(getCachedPageBitmap('small1')).toBeNull();
    expect(getCachedPageBitmap('small2')).toBeNull();
    expect(getCachedPageBitmap('big')).not.toBeNull();
    expect(_inspectPdfCachesForTests().bitmapCount).toBe(1);
  });

  it('re-putting the same pageId replaces rather than double-counts its bytes', () => {
    _setBudgetForTests(1000);
    putCachedPageBitmap('p1', makeCanvas(10, 10));
    putCachedPageBitmap('p1', makeCanvas(10, 10));
    expect(_inspectPdfCachesForTests().bitmapCount).toBe(1);
    expect(_inspectPdfCachesForTests().bitmapBytes).toBe(400);
  });
});

describe('_resetPdfCachesForTests', () => {
  it('clears both caches and restores the default budget', async () => {
    const proxy = { destroy: vi.fn(async () => {}) };
    getDocument.mockReturnValueOnce(makeLoadingTask(proxy));
    await getCachedPdfDocument('a.pdf');
    putCachedPageBitmap('p1', makeCanvas(10, 10));
    expect(_inspectPdfCachesForTests()).toEqual({ docCount: 1, bitmapCount: 1, bitmapBytes: 400 });

    _resetPdfCachesForTests();
    expect(_inspectPdfCachesForTests()).toEqual({ docCount: 0, bitmapCount: 0, bitmapBytes: 0 });

    // Budget restored to default: a single small canvas shouldn't need to
    // evict anything under it, and a fresh load fetches again (nothing carried over).
    putCachedPageBitmap('p2', makeCanvas(10, 10));
    expect(getCachedPageBitmap('p2')).not.toBeNull();
    getDocument.mockReturnValueOnce(makeLoadingTask(proxy));
    await getCachedPdfDocument('a.pdf');
    expect(getDocument).toHaveBeenCalledTimes(2);
  });
});
