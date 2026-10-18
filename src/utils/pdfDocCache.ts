// In-memory caches so flipping between vector (PDF-backed) canvas pages
// doesn't re-parse or re-render work it already did this session.
//
// PdfCanvas is remounted by CanvasView on every page flip (`key={page.id}`),
// so without a cache each visit re-fetches + re-parses the source PDF via
// pdf.js and re-rasterizes the page into an offscreen canvas — even when
// flipping back to a page seen moments ago. Two independent caches live
// here, both pure (no React):
//
//  1. Document cache — `getCachedPdfDocument`: keeps up to
//     PDF_DOC_CACHE_MAX parsed PDFDocumentProxy objects alive per source
//     URL, shared across concurrent callers via one in-flight promise.
//  2. Bitmap cache — `getCachedPageBitmap` / `putCachedPageBitmap`: keeps
//     rendered page canvases keyed by a caller-chosen identity (PdfCanvas
//     uses `${sourcePdfUrl}#${sourcePdfPageNum}`), bounded by a memory
//     budget (bytes), not an entry count, since canvases vary hugely in
//     size with zoom/DPI.
//
// pdfjsLib is typed `any` throughout (the app's convention for pdf.js)
// to keep this file free of pdfjs type imports.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

export const PDF_DOC_CACHE_MAX = 2;
export const PAGE_BITMAP_BUDGET_BYTES = 200 * 1024 * 1024; // 200MB

// ── Document cache ──────────────────────────────────────────────────────────

interface DocCacheEntry {
  promise: Promise<any>;
  lastUsed: number;
}

const docCache = new Map<string, DocCacheEntry>();
let docClock = 0;

function destroyDocEntry(entry: DocCacheEntry): void {
  // Only reachable via a settled (or eventually-settling) promise — never
  // call .destroy() on a proxy we don't have yet.
  entry.promise.then(proxy => {
    try { proxy.destroy(); } catch { /* noop */ }
  }).catch(() => { /* load never succeeded — nothing to destroy */ });
}

/**
 * Returns a shared, cached PDFDocumentProxy promise for `url`. Concurrent
 * callers for the same url before it resolves share the same in-flight
 * promise (only the first caller's `onProgress` is wired up — later callers
 * get no progress ticks, since for them the load is already underway or
 * instantaneous from cache).
 *
 * At most PDF_DOC_CACHE_MAX documents are kept; adding a new one past the cap
 * evicts the least-recently-used entry and destroys its proxy once settled.
 * A failed load is evicted immediately (on rejection) so a transient error
 * isn't cached forever — the next call for the same url starts a fresh load.
 */
export function getCachedPdfDocument(
  url: string,
  onProgress?: (progress: { loaded: number; total: number }) => void,
): Promise<any> {
  const existing = docCache.get(url);
  if (existing) {
    existing.lastUsed = ++docClock;
    // Bump to most-recently-used position (Map iteration order = insertion
    // order, so delete+re-set moves this key to the end).
    docCache.delete(url);
    docCache.set(url, existing);
    return existing.promise;
  }

  const loadingTask = pdfjsLib.getDocument({ url });
  if (onProgress) {
    loadingTask.onProgress = (p: { loaded: number; total: number }) => onProgress(p);
  }
  const promise = loadingTask.promise;

  const entry: DocCacheEntry = { promise, lastUsed: ++docClock };
  docCache.set(url, entry);

  promise.catch(() => {
    // Don't poison the cache with a failed load — only remove if this is
    // still the entry we inserted (a later successful call may have already
    // replaced it, though the url-keyed cache makes that unlikely in
    // practice).
    if (docCache.get(url) === entry) docCache.delete(url);
  });

  while (docCache.size > PDF_DOC_CACHE_MAX) {
    const oldestKey = docCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestEntry = docCache.get(oldestKey)!;
    docCache.delete(oldestKey);
    destroyDocEntry(oldestEntry);
  }

  return promise;
}

// ── Rendered-bitmap cache ───────────────────────────────────────────────────

interface BitmapCacheEntry {
  canvas: HTMLCanvasElement;
  bytes: number;
  lastUsed: number;
}

const bitmapCache = new Map<string, BitmapCacheEntry>();
let bitmapClock = 0;
let bitmapBudgetBytes: number = PAGE_BITMAP_BUDGET_BYTES;

function bitmapBytesFor(canvas: HTMLCanvasElement): number {
  return canvas.width * canvas.height * 4; // RGBA
}

export function getCachedPageBitmap(pageId: string): HTMLCanvasElement | null {
  const entry = bitmapCache.get(pageId);
  if (!entry) return null;
  entry.lastUsed = ++bitmapClock;
  bitmapCache.delete(pageId);
  bitmapCache.set(pageId, entry);
  return entry.canvas;
}

/**
 * Caches `canvas` under `pageId`, then evicts least-recently-used entries
 * (oldest first) until the total is back under the memory budget. A single
 * entry larger than the budget is still cached — it just becomes the sole
 * survivor of the eviction pass, since the last entry is never evicted.
 */
export function putCachedPageBitmap(pageId: string, canvas: HTMLCanvasElement): void {
  const bytes = bitmapBytesFor(canvas);
  bitmapCache.delete(pageId);
  bitmapCache.set(pageId, { canvas, bytes, lastUsed: ++bitmapClock });
  evictBitmapsOverBudget();
}

function totalBitmapBytes(): number {
  let total = 0;
  for (const entry of bitmapCache.values()) total += entry.bytes;
  return total;
}

function evictBitmapsOverBudget(): void {
  for (const key of [...bitmapCache.keys()]) {
    if (totalBitmapBytes() <= bitmapBudgetBytes) return;
    if (bitmapCache.size <= 1) return; // never evict the last remaining entry
    bitmapCache.delete(key);
  }
}

// ── Test helpers ─────────────────────────────────────────────────────────

/** Override the bitmap budget (bytes). Pass null to restore the default. */
export function _setBudgetForTests(bytes: number | null): void {
  bitmapBudgetBytes = bytes ?? PAGE_BITMAP_BUDGET_BYTES;
  evictBitmapsOverBudget();
}

/** Inspect current cache occupancy without mutating it. */
export function _inspectPdfCachesForTests(): { docCount: number; bitmapCount: number; bitmapBytes: number } {
  return { docCount: docCache.size, bitmapCount: bitmapCache.size, bitmapBytes: totalBitmapBytes() };
}

/** Clears both caches and restores the default bitmap budget. Test-only. */
export function _resetPdfCachesForTests(): void {
  for (const entry of docCache.values()) destroyDocEntry(entry);
  docCache.clear();
  bitmapCache.clear();
  bitmapBudgetBytes = PAGE_BITMAP_BUDGET_BYTES;
  docClock = 0;
  bitmapClock = 0;
}
