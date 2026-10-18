// src/pages/documents/previewEngine.ts
// Shared engine behind the Documents hover-card preview and viewer modal
// (docs/superpowers/specs/2026-08-17-document-previews-design.md). Type
// detection is pure; thumbnail generation is lazy (nothing is fetched until
// a caller actually asks for a thumb) and cached in-memory for the session.
//
// pdfjs config mirrors src/pages/project/proposal/shrinkPdf.ts exactly (same
// legacy build + worker import) so the two code paths share one pdf.js
// setup. Byte fetching reuses fetchFileBlob (src/utils/store.ts) — the same
// authenticated fetch the rest of the app uses — rather than a raw fetch call.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { fetchFileBlob, getImageThumbUrl } from '../../utils/store';
import { SHEET_MIMES } from './openTarget';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export type PreviewKind = 'image' | 'pdf' | 'sheet' | 'other';

export function previewKindFor(mime: string): PreviewKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (SHEET_MIMES.includes(mime)) return 'sheet';
  return 'other';
}

export type Thumb =
  | { kind: 'image'; url: string }
  | { kind: 'canvas'; dataUrl: string }
  | { kind: 'icon' };

// PDFs over this size skip the hover-preview render entirely (icon +
// "Open to preview" instead) — the viewer modal has no such cap.
export const HOVER_PDF_SIZE_CAP = 15 * 1024 * 1024;

const THUMB_LONG_SIDE = 360;
const CACHE_MAX_ENTRIES = 100;

// Keyed `${id}:${versionNumber}` so an older version's thumb never masks a
// newer upload sharing the same file id. Exported for tests only.
export const _cache: Map<string, Thumb> = new Map();

// In-flight render memo, same key shape as _cache. Covers rapid re-hover of
// the same row while its render is still in flight — without this, each
// concurrent caller would kick off its own fetchFileBlob + pdfjs render for
// the identical bytes. Entries are removed on settle (success OR failure) so
// a failed render doesn't wedge — the next call retries.
const _pending: Map<string, Promise<Thumb>> = new Map();

const cacheKey = (id: string, versionNumber: number): string => `${id}:${versionNumber}`;

function cacheSet(key: string, thumb: Thumb): void {
  // Map preserves insertion order, so the first key is the oldest — good
  // enough eviction without tracking access times separately.
  if (!_cache.has(key) && _cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = _cache.keys().next().value;
    if (oldestKey !== undefined) _cache.delete(oldestKey);
  }
  _cache.set(key, thumb);
}

// Scale the viewer modal renders a page at — readable on screen without
// producing a canvas so large that flipping pages feels sluggish.
export const MODAL_PDF_SCALE = 1.5;

// Hard cap on the rendered canvas's long side, in device pixels. Large-format
// plan sheets (e.g. 36"x24"+) at MODAL_PDF_SCALE can exceed iOS Safari's
// ~16.7M-px canvas limit (blank render or throw); this keeps every page under
// that regardless of its physical size. Letter-size pages are far below this
// bound, so MODAL_PDF_SCALE remains their effective scale.
export const MODAL_MAX_LONG_SIDE = 2400;

// A loaded pdf.js document. The viewer modal holds one of these for as long as
// it's open so page flips don't refetch or re-parse the bytes; it MUST call
// destroy() when it closes (pdf.js keeps a worker-side document alive
// otherwise). The hover/thumb path below loads and destroys its own within a
// single call.
export interface PdfDocHandle {
  numPages: number;
  getPage(pageNumber: number): Promise<any>;
  destroy(): Promise<void>;
}

export async function loadPdfDoc(id: string): Promise<PdfDocHandle> {
  const blob = await fetchFileBlob(id);
  const bytes = await blob.arrayBuffer();
  return await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
}

// Renders one page into a caller-owned canvas. Returns a cancel handle because
// pdf.js refuses two concurrent render() calls on the same canvas — flipping
// pages faster than a render completes must cancel the outgoing one first. A
// cancelled render rejects (RenderingCancelledException); callers that
// cancelled are expected to swallow it.
export function renderPdfPage(
  doc: PdfDocHandle,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale: number = MODAL_PDF_SCALE,
): { promise: Promise<void>; cancel: () => void } {
  let cancelled = false;
  let task: { cancel?: () => void } | null = null;
  const promise = (async () => {
    const page = await doc.getPage(pageNumber);
    if (cancelled) return;
    const vp1 = page.getViewport({ scale: 1 });
    const longSidePt = Math.max(vp1.width, vp1.height);
    const effectiveScale = Math.min(scale, MODAL_MAX_LONG_SIDE / longSidePt);
    const vp = page.getViewport({ scale: effectiveScale });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    task = page.render({ canvasContext: ctx, viewport: vp } as any);
    await (task as any).promise;
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      task?.cancel?.();
    },
  };
}

async function renderPdfThumb(id: string): Promise<Thumb> {
  const pdf = await loadPdfDoc(id);
  try {
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = THUMB_LONG_SIDE / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { kind: 'icon' };
    await page.render({ canvasContext: ctx, viewport: vp } as any).promise;
    return { kind: 'canvas', dataUrl: canvas.toDataURL('image/jpeg', 0.8) };
  } finally {
    try { await pdf.destroy(); } catch { /* ignore */ }
  }
}

export async function getPreviewThumb(
  row: { id: string; versionNumber: number; mime: string; size: number },
  opts?: { forHover?: boolean },
): Promise<Thumb> {
  const kind = previewKindFor(row.mime);
  const key = cacheKey(row.id, row.versionNumber);

  if (kind === 'image') {
    // No fetch: the <img> element loads it itself — the photo shrunk, which
    // the server swaps for the original when it can't shrink one. Trivial to
    // recompute (it's just a URL string), so not worth spending eviction
    // budget on.
    return { kind: 'image', url: getImageThumbUrl(row.id, row.versionNumber) };
  }

  if (kind !== 'pdf') return { kind: 'icon' };

  const cached = _cache.get(key);
  if (cached) return cached;

  if (opts?.forHover && row.size > HOVER_PDF_SIZE_CAP) {
    // Deliberately not cached (nor memoized) under the file's key: caching
    // this icon would poison the modal path, which must still render the
    // real thumb for the same file/version once opened. Hover-capped
    // requests never reach the fetch below, so there's nothing to dedup.
    return { kind: 'icon' };
  }

  const pending = _pending.get(key);
  if (pending) return pending;

  const promise = renderPdfThumb(row.id)
    .then(thumb => { cacheSet(key, thumb); return thumb; })
    .finally(() => { _pending.delete(key); });
  _pending.set(key, promise);
  return promise;
}

// Pure generation-counter guard: a hover session (or any in-flight async
// render) calls next() when it starts and checks isCurrent(id) before acting
// on its result, so a stale render that resolves after mouse-leave/re-hover
// is silently dropped instead of flashing the wrong thumb.
export function makeGenerationGuard(): { next(): number; isCurrent(id: number): boolean } {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(id: number): boolean {
      return id === current && id !== 0;
    },
  };
}
