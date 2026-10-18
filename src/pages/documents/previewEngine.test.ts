// src/pages/documents/previewEngine.test.ts
// Pure/logic coverage for the hover-card + viewer-modal preview engine
// (docs/superpowers/specs/2026-08-17-document-previews-design.md). pdfjs and
// canvas are mocked — vitest's jsdom has no real canvas, and we don't want a
// real PDF parse in unit tests. fetchFileBlob (the authenticated byte fetch
// used across the app) is mocked so tests can assert whether a
// network call happened without hitting the server.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDocument = vi.fn();

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: (...args: unknown[]) => getDocument(...args),
}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.mjs?url', () => ({ default: 'worker-url' }));

const fetchFileBlob = vi.fn();
vi.mock('../../utils/store', async (orig) => ({
  getImageThumbUrl: (await orig<typeof import('../../utils/store')>()).getImageThumbUrl,
  fetchFileBlob: (...args: unknown[]) => fetchFileBlob(...args),
}));

import {
  previewKindFor, getPreviewThumb, makeGenerationGuard, loadPdfDoc, renderPdfPage,
  MODAL_PDF_SCALE, MODAL_MAX_LONG_SIDE, HOVER_PDF_SIZE_CAP, _cache,
} from './previewEngine';

const realCreateElement = document.createElement.bind(document);

// Fake page: a fixed viewport and a no-op render, matching the brief's
// guidance (getViewport -> {width:100,height:50}; render fills nothing).
// `cancel` mirrors pdf.js's RenderTask so the modal's page-flip cancellation
// path can be exercised.
const renderCancel = vi.fn();
function makeFakePdf(numPages = 3, pageWidthPt = 100, pageHeightPt = 50) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: pageWidthPt * scale, height: pageHeightPt * scale }),
    render: () => ({ promise: Promise.resolve(), cancel: renderCancel }),
  };
  return {
    numPages,
    getPage: vi.fn(async () => page),
    destroy: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  _cache.clear();

  getDocument.mockImplementation(() => ({ promise: Promise.resolve(makeFakePdf()) }));
  fetchFileBlob.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(8) });

  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }),
        toDataURL: () => 'data:image/jpeg;base64,ZmFrZQ==',
      } as unknown as HTMLCanvasElement;
    }
    return realCreateElement(tag);
  }) as typeof document.createElement);
});

describe('previewKindFor', () => {
  it('image/* -> image', () => {
    expect(previewKindFor('image/png')).toBe('image');
    expect(previewKindFor('image/jpeg')).toBe('image');
  });
  it('application/pdf -> pdf', () => {
    expect(previewKindFor('application/pdf')).toBe('pdf');
  });
  it('xlsx/xls mimes -> sheet', () => {
    expect(previewKindFor('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('sheet');
    expect(previewKindFor('application/vnd.ms-excel')).toBe('sheet');
  });
  it('anything else -> other', () => {
    expect(previewKindFor('text/plain')).toBe('other');
  });
});

describe('getPreviewThumb', () => {
  it('images resolve to the shrunk photo url without any fetch', async () => {
    const thumb = await getPreviewThumb({ id: 'f1', versionNumber: 1, mime: 'image/png', size: 1000 });
    expect(thumb).toEqual({ kind: 'image', url: '/api/images/f1/thumb?v=1' });
    expect(fetchFileBlob).not.toHaveBeenCalled();
    expect(getDocument).not.toHaveBeenCalled();
  });

  it('hover-capped pdf resolves to icon and does not fetch', async () => {
    const row = { id: 'f2', versionNumber: 1, mime: 'application/pdf', size: 16 * 1024 * 1024 };
    const thumb = await getPreviewThumb(row, { forHover: true });
    expect(thumb).toEqual({ kind: 'icon' });
    expect(fetchFileBlob).not.toHaveBeenCalled();
  });

  it('modal path renders the same big pdf (fetch called)', async () => {
    const row = { id: 'f2', versionNumber: 1, mime: 'application/pdf', size: 16 * 1024 * 1024 };
    const thumb = await getPreviewThumb(row);
    expect(thumb.kind).toBe('canvas');
    expect(fetchFileBlob).toHaveBeenCalledWith('f2');
  });

  it('sheet/other mimes resolve to icon without fetching', async () => {
    const sheet = await getPreviewThumb({ id: 'f3', versionNumber: 1, mime: 'application/vnd.ms-excel', size: 10 });
    const other = await getPreviewThumb({ id: 'f4', versionNumber: 1, mime: 'text/plain', size: 10 });
    expect(sheet).toEqual({ kind: 'icon' });
    expect(other).toEqual({ kind: 'icon' });
    expect(fetchFileBlob).not.toHaveBeenCalled();
  });

  it('cache: second call same id+version returns without re-fetch; icon results not cached', async () => {
    const row = { id: 'f5', versionNumber: 1, mime: 'application/pdf', size: 16 * 1024 * 1024 };

    // Hover on a size-capped pdf -> icon, must not be cached as the thumb.
    const hoverThumb = await getPreviewThumb(row, { forHover: true });
    expect(hoverThumb).toEqual({ kind: 'icon' });
    expect(_cache.has('f5:1')).toBe(false);

    // Modal path renders for real and caches it.
    const modalThumb = await getPreviewThumb(row);
    expect(modalThumb.kind).toBe('canvas');
    expect(fetchFileBlob).toHaveBeenCalledTimes(1);

    // A second modal call hits the cache — no second fetch.
    const again = await getPreviewThumb(row);
    expect(again).toEqual(modalThumb);
    expect(fetchFileBlob).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls for the same id:version share one fetch+render', async () => {
    const row = { id: 'f6', versionNumber: 1, mime: 'application/pdf', size: 16 * 1024 * 1024 };
    const [a, b] = await Promise.all([getPreviewThumb(row), getPreviewThumb(row)]);
    expect(a).toBe(b);
    expect(fetchFileBlob).toHaveBeenCalledTimes(1);
    expect(getDocument).toHaveBeenCalledTimes(1);
  });

  it('a rejected in-flight render clears the memo so a later call retries', async () => {
    const row = { id: 'f7', versionNumber: 1, mime: 'application/pdf', size: 16 * 1024 * 1024 };
    fetchFileBlob.mockRejectedValueOnce(new Error('network'));
    await expect(getPreviewThumb(row)).rejects.toThrow('network');
    expect(fetchFileBlob).toHaveBeenCalledTimes(1);

    const thumb = await getPreviewThumb(row);
    expect(thumb.kind).toBe('canvas');
    expect(fetchFileBlob).toHaveBeenCalledTimes(2);
  });

  it('eviction keeps the map at <=100', async () => {
    for (let i = 0; i < 101; i++) {
      await getPreviewThumb({ id: `img${i}`, versionNumber: 1, mime: 'image/png', size: 10 });
    }
    expect(_cache.size).toBeLessThanOrEqual(100);
  });
});

describe('loadPdfDoc / renderPdfPage (viewer modal path)', () => {
  it('loadPdfDoc fetches once and exposes the page count', async () => {
    const doc = await loadPdfDoc('f8');
    expect(fetchFileBlob).toHaveBeenCalledWith('f8');
    expect(doc.numPages).toBe(3);
  });

  it('renderPdfPage sizes the canvas to the scaled viewport and renders the asked-for page', async () => {
    const doc = await loadPdfDoc('f9');
    const canvas = { width: 0, height: 0, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    await renderPdfPage(doc, 2, canvas).promise;
    expect(doc.getPage).toHaveBeenCalledWith(2);
    expect(canvas.width).toBe(Math.round(100 * MODAL_PDF_SCALE));
    expect(canvas.height).toBe(Math.round(50 * MODAL_PDF_SCALE));
  });

  it('cancel() before the page resolves skips the render entirely', async () => {
    const doc = await loadPdfDoc('f10');
    const canvas = { width: 0, height: 0, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    const task = renderPdfPage(doc, 1, canvas);
    task.cancel();
    await task.promise;
    // getPage() was already in flight; the canvas must be left untouched.
    expect(canvas.width).toBe(0);
  });

  it('page flips reuse the same doc handle — no extra fetch', async () => {
    const doc = await loadPdfDoc('f11');
    const canvas = { width: 0, height: 0, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    await renderPdfPage(doc, 1, canvas).promise;
    await renderPdfPage(doc, 2, canvas).promise;
    expect(fetchFileBlob).toHaveBeenCalledTimes(1);
  });

  it('a letter-size page (612x792pt) renders unclamped at MODAL_PDF_SCALE', async () => {
    getDocument.mockImplementation(() => ({ promise: Promise.resolve(makeFakePdf(1, 612, 792)) }));
    const doc = await loadPdfDoc('f12');
    const canvas = { width: 0, height: 0, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    await renderPdfPage(doc, 1, canvas).promise;
    expect(canvas.width).toBe(918);
    expect(canvas.height).toBe(1188);
  });

  it('a large-format page (2592x1728pt) is clamped so its long side is exactly MODAL_MAX_LONG_SIDE', async () => {
    getDocument.mockImplementation(() => ({ promise: Promise.resolve(makeFakePdf(1, 2592, 1728)) }));
    const doc = await loadPdfDoc('f13');
    const canvas = { width: 0, height: 0, getContext: () => ({}) } as unknown as HTMLCanvasElement;
    await renderPdfPage(doc, 1, canvas).promise;
    expect(Math.max(canvas.width, canvas.height)).toBe(MODAL_MAX_LONG_SIDE);
    expect(canvas.width).toBe(2400);
    expect(canvas.height).toBe(1600);
  });
});

describe('makeGenerationGuard', () => {
  it('next() invalidates prior ids', () => {
    const guard = makeGenerationGuard();
    const id1 = guard.next();
    expect(guard.isCurrent(id1)).toBe(true);

    const id2 = guard.next();
    expect(guard.isCurrent(id1)).toBe(false);
    expect(guard.isCurrent(id2)).toBe(true);
  });

  it('a fresh guard has no current id until next() is called', () => {
    const guard = makeGenerationGuard();
    expect(guard.isCurrent(0)).toBe(false);
    expect(guard.isCurrent(1)).toBe(false);
  });
});
