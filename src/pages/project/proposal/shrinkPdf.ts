import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// Email providers cap messages around 25MB *after* base64 encoding (~35%
// inflation), so 18MB of file reliably clears Gmail/Outlook with headroom.
export const EMAIL_TARGET_BYTES = 18 * 1024 * 1024;

export const JPEG_QUALITY_LADDER = [0.75, 0.65, 0.55, 0.45] as const;
export const START_LONG_SIDE = 2200;
export const MIN_LONG_SIDE = 1000;
const SCALE_STEP = 0.8;
const FIXED_OVERHEAD_BYTES = 64 * 1024;

export interface ShrinkResult {
  bytes: ArrayBuffer;
  /** true → floors were hit and the result still exceeds the budget; caller warns. */
  overBudget: boolean;
}

export interface LadderStep { longSide: number; quality: number }

/** Budget available for page images once pdf-lib structure overhead is reserved. */
export function usableBudget(budgetBytes: number): number {
  return Math.max(0, budgetBytes * 0.97 - FIXED_OVERHEAD_BYTES);
}

/** Even split of what's left over the pages still to encode — pages that come
 *  in under their share automatically roll their surplus forward. */
export function pageBudget(remainingBudget: number, remainingPages: number): number {
  return Math.max(0, remainingBudget) / Math.max(1, remainingPages);
}

/** All (longSide, quality) attempts for one page, best first: the full quality
 *  ladder at each scale, scales shrinking 0.8× per round down to the floor. */
export function attemptSequence(startLongSide: number = START_LONG_SIDE): LadderStep[] {
  const steps: LadderStep[] = [];
  let ls = Math.max(startLongSide, MIN_LONG_SIDE);
  for (;;) {
    for (const quality of JPEG_QUALITY_LADDER) steps.push({ longSide: ls, quality });
    if (ls === MIN_LONG_SIDE) break;
    ls = Math.max(Math.round(ls * SCALE_STEP), MIN_LONG_SIDE);
  }
  return steps;
}

/** Fraction of a page's budget under which the page is considered to have
 *  finished "comfortably" — small enough to justify spending a render on
 *  recovering quality for the next page. */
export const COMFORTABLE_UNDER_RATIO = 0.7;

/** Ladder index the next page's walk should start from, given the index in
 *  `attemptSequence()` that satisfied the previous page. Carrying the index
 *  forward means a page that needed a small/low-quality encoding doesn't
 *  force every later page to re-walk the same doomed high-quality attempts
 *  (the degenerate case on large page counts: an early overshoot used to
 *  drive every later page through a full ~20-step walk, including full
 *  pdf.js re-renders). Backing off one step toward higher quality when the
 *  previous page landed comfortably under its budget lets quality recover
 *  once the content allows it. */
export function nextStartIndex(succeededIndex: number, succeededBytes: number, budgetBytes: number): number {
  const comfortablyUnder = budgetBytes > 0 && succeededBytes <= budgetBytes * COMFORTABLE_UNDER_RATIO;
  return comfortablyUnder ? Math.max(0, succeededIndex - 1) : succeededIndex;
}

/** Decoded byte size of a base64 data URL (without materializing the bytes). */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

// Shrinks an already-generated PDF under a byte budget by re-rendering each
// page to a JPEG (overlays are already burned into the page content, so no
// measurement math is involved). Under-budget inputs pass through untouched —
// email mode on a small job keeps full vector quality.
export async function shrinkPdfToBudget(
  pdfBytes: ArrayBuffer,
  budgetBytes: number,
  onProgress?: (msg: string) => void,
): Promise<ShrinkResult> {
  if (pdfBytes.byteLength <= budgetBytes) {
    return { bytes: pdfBytes, overBudget: false };
  }

  const { PDFDocument } = await import('pdf-lib');
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes.slice(0)) });
  const srcPdf = await loadingTask.promise;
  const outDoc = await PDFDocument.create();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create canvas context for PDF compression');

  try {
    const pageCount = srcPdf.numPages;
    let remaining = usableBudget(budgetBytes);
    // Full ladder walked once; each page starts partway through it (carried
    // forward from the previous page) instead of restarting at the top.
    const ladder = attemptSequence();
    let startIndex = 0;

    for (let i = 1; i <= pageCount; i++) {
      onProgress?.(`Compressing page ${i} of ${pageCount}…`);
      const page = await srcPdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 }); // PDF points
      const maxDim = Math.max(vp1.width, vp1.height);
      const budget = pageBudget(remaining, pageCount - i + 1);
      // Reset every page: the canvas may hold the previous page's content at
      // a scale that happens to match this page's first attempt, and a
      // stale-content skip would silently reuse the wrong page's raster.
      let renderedScale = 0;

      const attempt = async (idx: number) => {
        const step = ladder[idx];
        // Cap at 2× — matches the app's standard raster space; upscaling a
        // small (e.g. letter-size) page past that only inflates bytes. Keyed
        // on the *effective* scale (not the raw longSide target) so rounds
        // the cap flattens to the same scale don't re-render identically.
        const scale = Math.min(2, step.longSide / maxDim);
        if (Math.round(vp1.width * scale) !== canvas.width || scale !== renderedScale) {
          const vp = page.getViewport({ scale });
          canvas.width = Math.round(vp.width);
          canvas.height = Math.round(vp.height);
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' } as any).promise;
          renderedScale = scale;
        }
        const dataUrl = canvas.toDataURL('image/jpeg', step.quality);
        return { dataUrl, bytes: dataUrlBytes(dataUrl) };
      };

      const startAt = Math.min(startIndex, ladder.length - 1);
      let bestIndex = startAt;
      let best = await attempt(startAt);
      for (let idx = startAt + 1; best.bytes > budget && idx < ladder.length; idx++) {
        const candidate = await attempt(idx);
        if (candidate.bytes < best.bytes) { best = candidate; bestIndex = idx; }
        if (candidate.bytes <= budget) break;
      }

      const jpg = await outDoc.embedJpg(best.dataUrl);
      // Page keeps its original physical size in points so prints stay to scale.
      const outPage = outDoc.addPage([vp1.width, vp1.height]);
      outPage.drawImage(jpg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      remaining -= best.bytes;
      startIndex = nextStartIndex(bestIndex, best.bytes, budget);
      page.cleanup();
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    try { await srcPdf.destroy(); } catch { /* ignore */ }
  }

  const out = await outDoc.save();
  const bytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  return { bytes, overBudget: bytes.byteLength > budgetBytes };
}
