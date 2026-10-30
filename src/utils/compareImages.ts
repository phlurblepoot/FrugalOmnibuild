// Images and image maths for the revision compare view (PlanSetCompare).
//
// Every page lives in "sheet units": the imageWidth × imageHeight space its
// measurements are stored in (a PDF page at 2× its point size, or a legacy
// raster's own pixels). Compare draws each revision in those units so both
// sheets share one physical scale, and lines the newer one up on the older one
// with an Alignment (shift + scale, in the older sheet's units).
//
// The pure functions (ink maps, alignment search, change map, takeoff check)
// work on plain arrays so they can be unit tested; the loaders need a DOM.
import { getCachedPdfDocument } from './pdfDocCache';
import { getImageUrl } from './store';
import type { Measurement, Point, ProjectPage } from '../types';

/** A revision drawn for compare. `scale` is canvas pixels per sheet unit. */
export interface SheetImage {
  canvas: HTMLCanvasElement;
  scale: number;
  /** 'full' = the stored PDF or full-size image; 'preview' = only the small
   *  upload preview was available. */
  quality: 'full' | 'preview';
}

/** Where the newer sheet sits on the older one: newer sheet point p lands on
 *  older sheet point (dx + p.x * scale, dy + p.y * scale). */
export interface Alignment { dx: number; dy: number; scale: number }

export const IDENTITY_ALIGNMENT: Alignment = { dx: 0, dy: 0, scale: 1 };

/** Longest edge, in canvas pixels, a full-size sheet is drawn at: about
 *  130 dpi on a 36" sheet, enough to read dimensions zoomed in. A 3:2 sheet
 *  at this size stays under iPad Safari's 16.7-million-pixel canvas limit. */
export const FULL_SHEET_LONG_EDGE = 4800;

const sheetSize = (page: ProjectPage) => ({
  w: page.imageWidth || 0,
  h: page.imageHeight || 0,
});

const whiteCanvas = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
};

const loadImageEl = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the page image'));
    img.src = src;
  });

/** Draws an image so it fills the page's sheet units (an image of a different
 *  pixel size, like the 400 px preview, is stretched to the sheet). */
async function sheetFromImage(page: ProjectPage, url: string, quality: SheetImage['quality']): Promise<SheetImage> {
  const img = await loadImageEl(url);
  const { w, h } = sheetSize(page);
  const sw = w || img.naturalWidth;
  const sh = h || img.naturalHeight;
  const scale = Math.min(img.naturalWidth / sw, FULL_SHEET_LONG_EDGE / Math.max(sw, sh));
  const canvas = whiteCanvas(sw * scale, sh * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, scale: canvas.width / sw, quality };
}

/** The small upload preview, drawn in sheet units. Fast; shown while the full
 *  sheet renders. */
export function loadPreviewSheet(page: ProjectPage): Promise<SheetImage> {
  const id = page.thumbnailId || page.imageId;
  return sheetFromImage(page, getImageUrl(id), page.thumbnailId ? 'preview' : 'full');
}

/** The page at full size: its stored PDF when it has one, otherwise its stored
 *  full-size image, otherwise (nothing better kept) the preview. */
export async function loadFullSheet(page: ProjectPage): Promise<SheetImage> {
  if (page.sourcePdfFileId && page.sourcePdfPageNum) {
    const doc = await getCachedPdfDocument(getImageUrl(page.sourcePdfFileId));
    const pdfPage = await doc.getPage(page.sourcePdfPageNum);
    try {
      const base = pdfPage.getViewport({ scale: 2 });
      const { w, h } = sheetSize(page);
      const sw = w || base.width;
      const sh = h || base.height;
      const pxPerUnit = Math.min(1.5, FULL_SHEET_LONG_EDGE / Math.max(sw, sh));
      const canvas = whiteCanvas(sw * pxPerUnit, sh * pxPerUnit);
      // Sheet units are the 2× viewport, so render at 2 × pxPerUnit; fit the
      // drawing to the stored sheet size in case the two ever disagree.
      const vp = pdfPage.getViewport({ scale: 2 * pxPerUnit * Math.min(sw / base.width, sh / base.height) });
      await pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, intent: 'print' } as any).promise;
      return { canvas, scale: canvas.width / sw, quality: 'full' };
    } finally {
      pdfPage.cleanup();
    }
  }
  if (page.imageId) return sheetFromImage(page, getImageUrl(page.imageId), 'full');
  return loadPreviewSheet(page);
}

// ── Ink maps ────────────────────────────────────────────────────────────────

/** A greyscale "ink" map: 0 = paper, 255 = solid linework. */
export interface InkMap { w: number; h: number; data: Uint8Array }

/** Ink map of RGBA pixels (darker and more coloured = more ink). */
export function inkFromRgba(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): InkMap {
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const lum = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    data[i] = 255 - lum;
  }
  return { w, h, data };
}

/** Ink map of a sheet image, drawn at `pxPerUnit` canvas pixels per sheet
 *  unit, with the sheet placed by `align` (the newer sheet onto the older's
 *  frame). `frameW`/`frameH` are the frame's size in sheet units. */
export function inkOf(img: SheetImage, frameW: number, frameH: number, pxPerUnit: number, align: Alignment = IDENTITY_ALIGNMENT): InkMap {
  const w = Math.max(1, Math.round(frameW * pxPerUnit));
  const h = Math.max(1, Math.round(frameH * pxPerUnit));
  const c = whiteCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D;
  const sheetW = img.canvas.width / img.scale;
  const sheetH = img.canvas.height / img.scale;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img.canvas,
    align.dx * pxPerUnit, align.dy * pxPerUnit,
    sheetW * align.scale * pxPerUnit, sheetH * align.scale * pxPerUnit);
  const map = inkFromRgba(ctx.getImageData(0, 0, w, h).data, w, h);
  c.width = 0; c.height = 0;
  return map;
}

/** Max filter of radius `r` (a square): thickens linework so a one-pixel
 *  wobble between two renderings still counts as "the same line". */
export function dilate(map: InkMap, r: number): InkMap {
  if (r <= 0) return map;
  const { w, h, data } = map;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) if (data[row + k] > m) m = data[row + k];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) if (tmp[k * w + x] > m) m = tmp[k * w + x];
      out[y * w + x] = m;
    }
  }
  return { w, h, data: out };
}

// ── Alignment search ────────────────────────────────────────────────────────

/** Ink at or above this counts as linework when lining sheets up. */
const ALIGN_INK = 96;

/** How well `b` shifted by (sx, sy) pixels covers `a`'s linework: each of a's
 *  ink pixels scores 1 when it lands on ink in b, ½ when it lands next to ink
 *  (`bNear`, b thickened), so the best score is the exact fit (0..1). */
export function overlapScore(aInk: number[], a: InkMap, b: InkMap, bNear: InkMap, sx: number, sy: number): number {
  if (!aInk.length) return 0;
  let hit = 0;
  for (const i of aInk) {
    const x = (i % a.w) - sx;
    const y = ((i / a.w) | 0) - sy;
    if (x < 0 || y < 0 || x >= b.w || y >= b.h) continue;
    const k = y * b.w + x;
    if (b.data[k] >= ALIGN_INK) hit += 1;
    else if (bNear.data[k] >= ALIGN_INK) hit += 0.5;
  }
  return hit / aInk.length;
}

const inkIndices = (m: InkMap, max = 40000): number[] => {
  const all: number[] = [];
  for (let i = 0; i < m.data.length; i++) if (m.data[i] >= ALIGN_INK) all.push(i);
  if (all.length <= max) return all;
  const step = all.length / max;
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(all[Math.floor(k * step)]);
  return out;
};

/** The shift (in pixels) of `b` that best lines its linework up with `a`,
 *  searching ±maxShift around (cx, cy). */
export function bestShift(a: InkMap, b: InkMap, maxShift: number, cx = 0, cy = 0): { sx: number; sy: number; score: number } {
  const aInk = inkIndices(a);
  const bD = dilate(b, 1);
  let best = { sx: cx, sy: cy, score: overlapScore(aInk, a, b, bD, cx, cy) };
  for (let sy = cy - maxShift; sy <= cy + maxShift; sy++) {
    for (let sx = cx - maxShift; sx <= cx + maxShift; sx++) {
      const s = overlapScore(aInk, a, b, bD, sx, sy);
      // Prefer the smaller move on a tie so identical sheets stay put.
      if (s > best.score + 1e-9 || (Math.abs(s - best.score) <= 1e-9 && Math.abs(sx) + Math.abs(sy) < Math.abs(best.sx) + Math.abs(best.sy))) {
        best = { sx, sy, score: s };
      }
    }
  }
  return best;
}

/**
 * Lines the newer sheet up on the older one by shifting it (scale stays as
 * given): a coarse search over up to an eighth of the sheet, then finer passes.
 * Returns the alignment and how well it fits (share of the older sheet's
 * linework the newer one covers, 0..1).
 */
export function autoAlign(older: SheetImage, newer: SheetImage, frameW: number, frameH: number, scale = 1): { align: Alignment; fit: number } {
  const levels = [160, 640, 1600].map(px => px / Math.max(frameW, frameH));
  let dx = 0, dy = 0, fit = 0;
  levels.forEach((ppu, li) => {
    const a = inkOf(older, frameW, frameH, ppu);
    const b = inkOf(newer, frameW, frameH, ppu, { dx: 0, dy: 0, scale });
    const reach = li === 0 ? Math.round(Math.max(a.w, a.h) / 8) : 4;
    const r = bestShift(a, b, reach, Math.round(dx * ppu), Math.round(dy * ppu));
    dx = r.sx / ppu;
    dy = r.sy / ppu;
    fit = r.score;
  });
  return { align: { dx, dy, scale }, fit };
}

// ── Change map ──────────────────────────────────────────────────────────────

/** Ink at or above this counts as a line when finding changes; lighter than
 *  this is paper, hatching tint or rendering haze. */
export const CHANGE_INK = 110;

export interface ChangeMap {
  w: number;
  h: number;
  /** 0 = no change, 1 = removed (only on the older), 2 = added (only on the newer). */
  kind: Uint8Array;
  removed: number;
  added: number;
}

/**
 * Where two aligned ink maps differ. A line counts as unchanged when the other
 * sheet has ink within `tolerance` pixels of it, so anti-aliasing, JPEG noise
 * and a small leftover misalignment don't light up as changes.
 */
export function changeMap(older: InkMap, newer: InkMap, tolerance = 2): ChangeMap {
  const { w, h } = older;
  const oD = dilate(older, tolerance);
  const nD = dilate(newer, tolerance);
  const kind = new Uint8Array(w * h);
  let removed = 0, added = 0;
  for (let i = 0; i < kind.length; i++) {
    const o = older.data[i] >= CHANGE_INK;
    const n = newer.data[i] >= CHANGE_INK;
    if (o && nD.data[i] < CHANGE_INK) { kind[i] = 1; removed++; }
    else if (n && oD.data[i] < CHANGE_INK) { kind[i] = 2; added++; }
  }
  return { w, h, kind, removed, added };
}

/** Colours for the difference view. */
export const DIFF_COLORS = {
  removed: [220, 38, 38] as const, // red
  added: [37, 99, 235] as const,   // blue
};

/** RGBA pixels for the difference view: unchanged linework as faint grey on
 *  white, removed in red, added in blue. */
export function diffPixels(older: InkMap, newer: InkMap, changes: ChangeMap): Uint8ClampedArray {
  const out = new Uint8ClampedArray(changes.w * changes.h * 4);
  for (let i = 0, j = 0; i < changes.kind.length; i++, j += 4) {
    const k = changes.kind[i];
    if (k === 1 || k === 2) {
      const [r, g, b] = k === 1 ? DIFF_COLORS.removed : DIFF_COLORS.added;
      out[j] = r; out[j + 1] = g; out[j + 2] = b;
    } else {
      // Unchanged: the darker of the two, faded to a light grey.
      const ink = Math.max(older.data[i], newer.data[i]);
      const v = 255 - Math.round(ink * 0.3);
      out[j] = v; out[j + 1] = v; out[j + 2] = v;
    }
    out[j + 3] = 255;
  }
  return out;
}

// ── Takeoffs on changed areas ───────────────────────────────────────────────

/** Points along a measurement's outline (all segments), every `step` units. */
export function measurementSamples(m: Measurement, step: number): Point[] {
  const out: Point[] = [];
  const paths: Point[][] = [m.points, ...(m.segments || []).map(s => s.points)];
  for (const pts of paths) {
    if (!pts?.length) continue;
    if (m.type === 'count') { out.push(...pts); continue; }
    const closed = m.type === 'area' && pts.length > 2;
    const n = closed ? pts.length : pts.length - 1;
    if (pts.length === 1) out.push(pts[0]);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      const k = Math.max(1, Math.ceil(len / step));
      for (let t = 0; t <= k; t++) out.push({ x: p.x + ((q.x - p.x) * t) / k, y: p.y + ((q.y - p.y) * t) / k });
    }
  }
  return out;
}

/**
 * Whether a measurement sits on changed linework: some point along it has a
 * change within `radius` sheet units. `toFrame` maps the measurement's own
 * sheet units into the change map's frame (sheet units); `pxPerUnit` is the
 * change map's resolution.
 */
export function touchesChange(m: Measurement, changes: ChangeMap, pxPerUnit: number, toFrame: (p: Point) => Point, radius: number): boolean {
  const r = Math.max(1, Math.round(radius * pxPerUnit));
  const samples = measurementSamples(m, Math.max(radius, 1));
  for (const s of samples) {
    const f = toFrame(s);
    const cx = Math.round(f.x * pxPerUnit), cy = Math.round(f.y * pxPerUnit);
    const x0 = Math.max(0, cx - r), x1 = Math.min(changes.w - 1, cx + r);
    const y0 = Math.max(0, cy - r), y1 = Math.min(changes.h - 1, cy + r);
    for (let y = y0; y <= y1; y++) {
      const row = y * changes.w;
      for (let x = x0; x <= x1; x++) if (changes.kind[row + x]) return true;
    }
  }
  return false;
}
