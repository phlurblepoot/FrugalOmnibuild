import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import Tesseract, { PSM } from 'tesseract.js';

// Background timer worker to prevent throttling in background tabs
let pulseWorker: Worker | null = null;
let pulseId = 0;
const pulseCallbacks = new Map<number, () => void>();

const initPulseWorker = () => {
  if (typeof window === 'undefined' || pulseWorker) return;
  const code = `
    self.onmessage = function(e) {
      setTimeout(() => {
        postMessage(e.data.id);
      }, e.data.delay);
    };
  `;
  const blob = new Blob([code], { type: 'application/javascript' });
  pulseWorker = new Worker(URL.createObjectURL(blob));
  pulseWorker.onmessage = (e) => {
    const id = e.data;
    const callback = pulseCallbacks.get(id);
    if (callback) {
      pulseCallbacks.delete(id);
      callback();
    }
  };
};

const getPulse = (delay = 100) => {
  initPulseWorker();
  return new Promise(resolve => {
    const id = ++pulseId;
    pulseCallbacks.set(id, () => resolve(null));
    pulseWorker!.postMessage({ id, delay });
  });
};

// Polyfill requestAnimationFrame to use our worker when the tab is hidden
// This prevents pdf.js from pausing when the user switches tabs
if (typeof window !== 'undefined') {
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = function(callback: FrameRequestCallback): number {
    if (document.hidden) {
      initPulseWorker();
      const id = ++pulseId;
      pulseCallbacks.set(id, () => callback(performance.now()));
      pulseWorker!.postMessage({ id, delay: 16 });
      return id;
    }
    return originalRequestAnimationFrame(callback);
  };
  
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  window.cancelAnimationFrame = function(handle: number): void {
    if (document.hidden && pulseCallbacks.has(handle)) {
      pulseCallbacks.delete(handle);
      return;
    }
    originalCancelAnimationFrame(handle);
  };
}

// Configure the worker to use the local version matching the installed pdfjs-dist version
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface PdfPageImage {
  // Legacy field — only populated when callers explicitly opt in via includeFullPageRaster.
  // The vector pipeline leaves this empty; pages are rendered on demand from the source PDF.
  dataUrl: string;
  thumbnailDataUrl: string;
  width: number;
  height: number;
  pageNum: number;
  extractedText?: string;
  /** Medium-resolution JPEG (1568px long side, the most Claude looks at) for
   *  AI sheet reading. Only produced when the caller opts in via
   *  includeAiImage; transient (not stored) — the 400px thumbnail is too
   *  low-res to read a title block, so this is sent to /api/ai/read-sheet. */
  aiImageDataUrl?: string;
  /** The sheet in quarters at twice the detail (see AiSheetImages). */
  aiDetailDataUrls?: string[];
  /** Populated when this page could not be rendered. dataUrl will be empty. */
  error?: string;
}

// ── OCR region extraction helpers ─────────────────────────────────────────────

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for OCR'));
    img.src = src;
  });

/**
 * Crop a rectangular region (given as percentages 0–100 of the source image)
 * and return a PNG data URL that has been upscaled and contrast-enhanced so
 * Tesseract can read small sheet numbers reliably.
 */
export async function buildOcrCrop(
  imageUrl: string,
  region: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const img = await loadImage(imageUrl);
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;

  const sx = Math.max(0, (region.x / 100) * naturalW);
  const sy = Math.max(0, (region.y / 100) * naturalH);
  const sw = Math.max(1, Math.min(naturalW - sx, (region.width / 100) * naturalW));
  const sh = Math.max(1, Math.min(naturalH - sy, (region.height / 100) * naturalH));

  // Upscale so the shortest side of the crop is at least ~160px — Tesseract is
  // far more accurate when glyphs are large. Cap the multiplier to keep memory sane.
  const upscale = Math.min(6, Math.max(1, 160 / Math.min(sw, sh)));
  const dw = Math.max(1, Math.round(sw * upscale));
  const dh = Math.max(1, Math.round(sh * upscale));

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create canvas context for OCR');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);

  // Grayscale first; track the brightness range so we can stretch contrast.
  const imageData = ctx.getImageData(0, 0, dw, dh);
  const d = imageData.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    d[i] = d[i + 1] = d[i + 2] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  // Only stretch when there is real contrast — otherwise a near-blank crop would
  // be pushed to solid black, which is worse for OCR than leaving it alone.
  const span = max - min;
  if (span >= 16) {
    for (let i = 0; i < d.length; i += 4) {
      let v = ((d[i] - min) / span) * 255;
      v = 255 * Math.pow(Math.max(0, Math.min(1, v / 255)), 1.25);
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Crop a region (0–100 percentages) as a plain COLOR JPEG for the vision
 *  model — same geometry as buildOcrCrop but without the Tesseract-oriented
 *  grayscale/contrast preprocessing. Upscaled so the short side is ≥200px. */
export async function buildRegionCrop(
  imageUrl: string,
  region: { x: number; y: number; width: number; height: number }
): Promise<string> {
  const img = await loadImage(imageUrl);
  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  const sx = Math.max(0, (region.x / 100) * naturalW);
  const sy = Math.max(0, (region.y / 100) * naturalH);
  const sw = Math.max(1, Math.min(naturalW - sx, (region.width / 100) * naturalW));
  const sh = Math.max(1, Math.min(naturalH - sy, (region.height / 100) * naturalH));
  const upscale = Math.min(6, Math.max(1, 200 / Math.min(sw, sh)));
  let dw = Math.max(1, Math.round(sw * upscale));
  let dh = Math.max(1, Math.round(sh * upscale));
  // Cap the long side so a huge selected region can't produce a multi-megapixel
  // crop that blows the model's request timeout — scale both dimensions down
  // proportionally so the crop's aspect ratio (and the earlier short-side
  // upscale) is preserved.
  const MAX_LONG_SIDE = 1536;
  const longSide = Math.max(dw, dh);
  if (longSide > MAX_LONG_SIDE) {
    const downscale = MAX_LONG_SIDE / longSide;
    dw = Math.max(1, Math.round(dw * downscale));
    dh = Math.max(1, Math.round(dh * downscale));
  }
  const canvas = document.createElement('canvas');
  canvas.width = dw; canvas.height = dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create canvas context for region crop');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, dw, dh);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Tesseract parameters tuned for the kind of text being extracted. */
export function ocrParamsFor(mode: 'pageNumber' | 'description'): { tessedit_char_whitelist: string; tessedit_pageseg_mode: PSM } {
  return mode === 'pageNumber'
    ? {
        // Sheet numbers are short uppercase codes (e.g. A1.1, S-201, M2.3).
        tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.-/ ',
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
      }
    : {
        tessedit_char_whitelist: '',
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      };
}

/** Clean up Tesseract output for a sheet number: uppercase, drop spaces, trim stray punctuation.
 *  In the numeric body (after the 1-3 letter prefix), common letter/digit OCR confusions are
 *  corrected: S→5, G→6, O→0, I→1, B→8, Z→2. */
export function cleanSheetNumber(raw: string): string {
  const upper = (raw || '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9.\-/]/g, '')
    .replace(/^[.\-/]+|[.\-/]+$/g, '')
    .trim();

  if (!upper) return '';

  // Sheet numbers follow <letters><sep><digits>. In the digit body, apply position-aware
  // substitutions: letters that look like digits are almost certainly digit misreads there.
  const DIGIT_SUBS: Record<string, string> = { S: '5', G: '6', O: '0', I: '1', B: '8', Z: '2' };
  return upper.replace(/^([A-Z]{1,3})([-./]?)(.*)$/, (_, prefix, sep, body) =>
    prefix + sep + body.replace(/[SGOIBZ]/g, (c: string) => DIGIT_SUBS[c] ?? c)
  );
}

/** Clean up Tesseract output for a free-text description. */
export function cleanDescriptionText(raw: string): string {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

export interface LoadPdfPagesOptions {
  /** When true, also rasterize each page to a JPEG dataUrl (legacy path). Defaults to false. */
  includeFullPageRaster?: boolean;
  /** When true, also produce `aiImageDataUrl` + `aiDetailDataUrls` per page
   *  for AI sheet reading. Defaults to false (skips the extra renders when AI is off). */
  includeAiImage?: boolean;
}

/** Claude scales images down to about this long edge, so larger is wasted. */
const AI_IMAGE_LONG_EDGE = 1568;

/** The images Claude reads one sheet from. */
export interface AiSheetImages {
  /** The whole sheet, 1568 px on the long edge. */
  page: string;
  /** The sheet in quarters (top-left, top-right, bottom-left, bottom-right),
   *  each 1568 px on its long edge: twice the detail of `page`, so small print
   *  reads wherever it is on the sheet and whichever way it is turned. */
  details: string[];
}

/** Draws the region (x, y, w, h) of a sheet, in sheet pixels, onto `ctx` at scale `s`. */
type DrawRegion = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number) => Promise<void> | void;

/** Claude's images for a sheet of `width` × `height`. Always full size, never
 *  a preview thumbnail. */
async function aiImagesFrom(width: number, height: number, draw: DrawRegion): Promise<AiSheetImages> {
  const render = async (x: number, y: number, w: number, h: number): Promise<string> => {
    const s = Math.min(1, AI_IMAGE_LONG_EDGE / Math.max(w, h));
    const aiCanvas = document.createElement('canvas');
    aiCanvas.width = Math.round(w * s);
    aiCanvas.height = Math.round(h * s);
    const aiCtx = aiCanvas.getContext('2d');
    if (!aiCtx) return '';
    aiCtx.fillStyle = 'white';
    aiCtx.fillRect(0, 0, aiCanvas.width, aiCanvas.height);
    await draw(aiCtx, x, y, w, h, s);
    const url = aiCanvas.toDataURL('image/jpeg', 0.72);
    // Free the backing store now: a scan renders many pages in a row.
    aiCanvas.width = 0;
    aiCanvas.height = 0;
    return url;
  };
  const page = await render(0, 0, width, height);
  const hw = width / 2, hh = height / 2;
  const details: string[] = [];
  for (const [x, y] of [[0, 0], [hw, 0], [0, hh], [hw, hh]]) {
    const d = await render(x, y, hw, hh);
    if (d) details.push(d);
  }
  return { page, details };
}

/** Claude's images for a PDF page: drawn from `raster` when the page is
 *  already rendered at `scale`, otherwise rendered straight from the PDF. */
export function renderAiImages(page: any, scale = 2.0, raster?: HTMLCanvasElement): Promise<AiSheetImages> {
  const viewport = page.getViewport({ scale });
  return aiImagesFrom(viewport.width, viewport.height, async (ctx, x, y, w, h, s) => {
    if (raster) {
      ctx.drawImage(raster, x, y, w, h, 0, 0, ctx.canvas.width, ctx.canvas.height);
    } else {
      const vp = page.getViewport({ scale: scale * s });
      await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x * s, -y * s], intent: 'print' } as any).promise;
    }
  });
}

/** How many of a page's text runs `layoutTextOf` lists, largest first. */
const LAYOUT_TEXT_RUNS = 80;

/**
 * The page's largest text, with where it sits and which way it is turned, one
 * run per line, e.g. `[x 91%, y 96%, turned 90°, size 24] A-201`. Sheet
 * numbers, sheet titles and drawing labels ("FRONT ELEVATION") are printed
 * big, so this lists them wherever the title block is and however the text is
 * turned, while leaving out the small print of general notes. Empty for a
 * scanned page with no text layer.
 */
export async function layoutTextOf(page: any): Promise<string> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  // A run is a line of text; `endX`/`endY` is where its last piece ends.
  type Run = { x: number; y: number; angle: number; size: number; str: string; endX: number; endY: number; closed: boolean };
  const runs: Run[] = [];
  for (const item of content.items as any[]) {
    const str = (item.str ?? '').trim();
    if (!str || !item.transform) continue;
    // Item → viewport space (top-left origin, page rotation applied).
    const [a, b, , , e, f] = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(a, b);
    if (!size) continue;
    // Screen angle the text runs at: 0 = left to right, 90 = bottom to top.
    const angle = Math.round(((-Math.atan2(b, a) * 180) / Math.PI + 360) % 360);
    const endX = e + (a / size) * (item.width ?? 0);
    const endY = f + (b / size) * (item.width ?? 0);
    const prev = runs[runs.length - 1];
    // pdf.js splits a line into several pieces: join a piece to the run before
    // it when it has the same size and direction and starts where that ended.
    if (prev && !prev.closed && prev.angle === angle && Math.abs(prev.size - size) < 0.5
        && Math.hypot(e - prev.endX, f - prev.endY) < size * 1.5) {
      prev.str += ' ' + str;
      prev.endX = endX;
      prev.endY = endY;
      prev.closed = !!item.hasEOL;
      continue;
    }
    runs.push({ x: e, y: f, angle, size, str, endX, endY, closed: !!item.hasEOL });
  }
  const pct = (v: number, of: number) => Math.max(0, Math.min(100, Math.round((v / of) * 100)));
  return runs
    .filter(r => r.str.replace(/\s/g, '').length > 0)
    .sort((r1, r2) => r2.size - r1.size)
    .slice(0, LAYOUT_TEXT_RUNS)
    .sort((r1, r2) => r1.y - r2.y || r1.x - r2.x)
    .map(r => `[x ${pct(r.x, viewport.width)}%, y ${pct(r.y, viewport.height)}%${r.angle ? `, turned ${r.angle}°` : ''}, size ${Math.round(r.size)}] ${r.str.replace(/\s+/g, ' ').slice(0, 120)}`)
    .join('\n');
}

/** Claude's images and the page's large text, for a page stored as a source
 *  PDF. `cache` keeps each PDF open across the pages of one scan. */
export async function renderAiImagesFromSourcePdf(
  fileUrl: string, pageNum: number, cache: Map<string, Promise<any>>,
): Promise<AiSheetImages & { layoutText: string }> {
  let doc = cache.get(fileUrl);
  if (!doc) {
    doc = pdfjsLib.getDocument({ url: fileUrl }).promise;
    cache.set(fileUrl, doc);
  }
  const page = await (await doc).getPage(pageNum);
  try {
    const images = await renderAiImages(page);
    const layoutText = await layoutTextOf(page).catch(() => '');
    return { ...images, layoutText };
  } finally {
    page.cleanup();
  }
}

/** Claude's images for an older page stored as a full-size image (not its preview). */
export async function renderAiImagesFromImage(url: string): Promise<AiSheetImages> {
  const img = await loadImage(url);
  return aiImagesFrom(img.naturalWidth, img.naturalHeight, (ctx, x, y, w, h) => {
    ctx.drawImage(img, x, y, w, h, 0, 0, ctx.canvas.width, ctx.canvas.height);
  });
}

export const loadPdfPagesGenerator = async function*(
  file: File,
  onProgress?: (status: string, pageNum: number, totalPages: number) => void,
  pageNums?: number[],
  options: LoadPdfPagesOptions = {}
): AsyncGenerator<PdfPageImage, void, unknown> {
  const includeFullPageRaster = options.includeFullPageRaster ?? false;
  const includeAiImage = options.includeAiImage ?? false;
  const fileUrl = URL.createObjectURL(file);
  const getPdfDoc = () => pdfjsLib.getDocument({
    url: fileUrl,
    cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.5.207/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@5.5.207/standard_fonts/',
    disableFontFace: true,
  }).promise;

  let pdf = await getPdfDoc();
  const totalPages = pdf.numPages;

  // When `pageNums` is supplied (retry path), iterate only those pages —
  // deduped, in-range, in sorted order. Otherwise process every page.
  const indices: number[] = pageNums
    ? [...new Set(pageNums)].filter(n => Number.isInteger(n) && n >= 1 && n <= totalPages).sort((a, b) => a - b)
    : Array.from({ length: totalPages }, (_, i) => i + 1);

  let tesseractWorker: Tesseract.Worker | null = null;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const thumbCanvas = document.createElement('canvas');
  const thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });

  if (!context || !thumbCtx) {
    throw new Error('Could not create canvas context');
  }

  const renderOnePage = async (i: number): Promise<PdfPageImage> => {
    const page = await pdf.getPage(i);

    // Base viewport at 2.0× — this is the coordinate space measurements are stored
    // in (matches the legacy raster dimensions exactly), so a page's width / height
    // stay stable whether the consumer asks for the raster or not.
    const scale = 2.0;
    const viewport = page.getViewport({ scale });

    // Text extraction runs without rasterizing. For text-based PDFs this is the
    // accurate path; for image-based PDFs we still need OCR, which requires a
    // canvas — so render at thumbnail resolution in that case (the OCR canvas is
    // discarded after recognition).
    if (onProgress) onProgress('reading the text', i, totalPages);
    let extractedText = '';
    try {
      const textContent = await page.getTextContent();
      extractedText = textContent.items.map((item: any) => item.str).join(' ');
    } catch (e) {
      console.warn('Could not extract text from page', e);
    }

    const needsOcr = !extractedText || extractedText.trim().length < 5;
    const needsFullRender = includeFullPageRaster || needsOcr;

    if (needsFullRender) {
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, intent: 'print' } as any).promise;
    }

    if (needsOcr) {
      if (onProgress) onProgress('reading the text', i, totalPages);
      try {
        if (!tesseractWorker) {
          tesseractWorker = await Tesseract.createWorker('eng', 1, {
            langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
          });
        }
        const { data: { text } } = await tesseractWorker.recognize(canvas);
        extractedText = text;

        if (i % 10 === 0) {
          await tesseractWorker.terminate();
          tesseractWorker = null;
        }
      } catch (ocrError) {
        console.warn('OCR failed', ocrError);
      }
    }

    // Thumbnail is always produced — needed for the page list UI.
    const thumbScale = 400 / Math.max(viewport.width, viewport.height);
    thumbCanvas.width = viewport.width * thumbScale;
    thumbCanvas.height = viewport.height * thumbScale;
    if (needsFullRender) {
      thumbCtx.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    } else {
      // Render the page once directly at thumbnail resolution.
      const thumbVp = page.getViewport({ scale: scale * thumbScale });
      thumbCtx.fillStyle = 'white';
      thumbCtx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
      await page.render({ canvasContext: thumbCtx, viewport: thumbVp, intent: 'print' } as any).promise;
    }

    const dataUrl = includeFullPageRaster ? canvas.toDataURL('image/jpeg', 0.6) : '';
    const thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.5);

    // Full-size images for AI reading (the 400px thumbnail can't resolve a
    // title block): the whole sheet and its quarters (see AiSheetImages).
    // Only asked for when the source PDF could not be stored; otherwise AI Scan
    // renders them from the stored PDF. Cut from the full canvas when we have one.
    let aiImageDataUrl = '';
    let aiDetailDataUrls: string[] = [];
    if (includeAiImage) {
      const ai = await renderAiImages(page, scale, needsFullRender ? canvas : undefined);
      aiImageDataUrl = ai.page;
      aiDetailDataUrls = ai.details;
    }

    page.cleanup();

    return {
      dataUrl,
      thumbnailDataUrl,
      aiImageDataUrl,
      aiDetailDataUrls,
      width: viewport.width,
      height: viewport.height,
      pageNum: i,
      extractedText,
    };
  };

  // Re-open the underlying pdf document — used both for periodic memory recycling
  // and to recover the worker after a failed page render.
  const reopenPdf = async () => {
    try { await pdf.destroy(); } catch { /* ignore */ }
    pdf = await getPdfDoc();
  };

  try {
    let processed = 0;
    for (const i of indices) {
      processed++;
      if (onProgress) onProgress('processing the image', i, totalPages);

      let result: PdfPageImage | null = null;
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try {
          result = await renderOnePage(i);
          lastError = null;
        } catch (err) {
          lastError = err;
          console.warn(`Page ${i} render failed (attempt ${attempt + 1})`, err);
          if (attempt === 0) {
            // The pdf.js worker may have been torn down. Rebuild the document
            // and pause briefly before retrying.
            try { await reopenPdf(); } catch (reopenErr) {
              console.warn('PDF reopen failed during retry', reopenErr);
            }
            await getPulse(250);
          }
        }
      }

      if (!result) {
        // Yield a placeholder so the consumer can verify totals and report failures.
        result = {
          dataUrl: '',
          thumbnailDataUrl: '',
          width: 0,
          height: 0,
          pageNum: i,
          error: String((lastError as any)?.message || lastError || 'Unknown render error'),
        };
      }

      if (processed % 10 === 0 && typeof pdf.cleanup === 'function') {
        try { await pdf.cleanup(); } catch (e) { console.warn('pdf.cleanup failed', e); }
      }

      if (processed % 50 === 0 && processed < indices.length) {
        try { await reopenPdf(); } catch (e) { console.warn('pdf reload failed', e); }
      }

      yield result;

      // Small delay to allow garbage collection and UI updates.
      await getPulse(100);
    }
  } finally {
    if (tesseractWorker) {
      try { await tesseractWorker.terminate(); } catch { /* ignore */ }
    }
    try { await pdf.destroy(); } catch { /* ignore */ }
    URL.revokeObjectURL(fileUrl);

    canvas.width = 0;
    canvas.height = 0;
    thumbCanvas.width = 0;
    thumbCanvas.height = 0;
  }
};
