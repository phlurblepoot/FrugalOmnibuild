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
  /** Medium-resolution JPEG (~1600px long side) for local AI sheet reading.
   *  Only produced when the caller opts in via includeAiImage; transient (not
   *  stored) — the 400px thumbnail is too low-res for the model to read a title
   *  block, so this is sent to /api/ai/read-sheet instead. */
  aiImageDataUrl?: string;
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
  /** When true, also produce a ~1600px `aiImageDataUrl` per page for local AI
   *  sheet reading. Defaults to false (skips the extra render when AI is off). */
  includeAiImage?: boolean;
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

    // Medium-res image for local AI reading (the 400px thumbnail can't resolve a
    // title block). Rendered directly at AI scale for vector pages, or downscaled
    // from the already-rendered full canvas when we have one.
    let aiImageDataUrl = '';
    if (includeAiImage) {
      const aiScale = Math.min(1, 1600 / Math.max(viewport.width, viewport.height));
      const aiCanvas = document.createElement('canvas');
      aiCanvas.width = Math.round(viewport.width * aiScale);
      aiCanvas.height = Math.round(viewport.height * aiScale);
      const aiCtx = aiCanvas.getContext('2d');
      if (aiCtx) {
        aiCtx.fillStyle = 'white';
        aiCtx.fillRect(0, 0, aiCanvas.width, aiCanvas.height);
        if (needsFullRender) {
          aiCtx.drawImage(canvas, 0, 0, aiCanvas.width, aiCanvas.height);
        } else {
          const aiVp = page.getViewport({ scale: scale * aiScale });
          await page.render({ canvasContext: aiCtx, viewport: aiVp, intent: 'print' } as any).promise;
        }
        aiImageDataUrl = aiCanvas.toDataURL('image/jpeg', 0.72);
      }
    }

    page.cleanup();

    return {
      dataUrl,
      thumbnailDataUrl,
      aiImageDataUrl,
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
