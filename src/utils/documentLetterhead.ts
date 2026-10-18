import { jsPDF } from 'jspdf';

// ---------------------------------------------------------------------------
// Shared branded letterhead (header + footer) for generated documents.
//
// Reproduces a branded letterhead design:
//   - HEADER: a short BRAND-GREEN band at the top-left, an angled diagonal
//     transition, then a tall BLACK band filling the top-right. The company
//     contact block sits in white inside the black band, with the logo at the
//     top-right (white-on-dark). A thin brand-green rule spans the full width
//     just below the band.
//   - FOOTER: mirrored decorative angled GREEN + BLACK banners at the bottom
//     (no text).
//
// Geometry is built with jsPDF vector ops (Letter portrait, 612x792 pt) so it
// scales/prints crisply and needs no embedded raster background. The template's
// own banners are a 300-DPI background image; these coordinates approximate that
// look (clearly evocative, not pixel-perfect).
// ---------------------------------------------------------------------------

/** Brand green (lime) from the template — used as the colour fallback. */
export const BRAND_GREEN: [number, number, number] = [153, 203, 56]; // #99CB38

/**
 * Parse a CSS-ish hex colour (#rgb / #rrggbb, with or without the leading '#')
 * into an [r, g, b] triple (0..255). Invalid/empty input falls back to the
 * brand green so documents always get a sensible accent.
 */
export function hexToRgb(hex: string): [number, number, number] {
  if (typeof hex !== 'string') return [...BRAND_GREEN];
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) {
    s = s
      .split('')
      .map(ch => ch + ch)
      .join('');
  }
  if (s.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(s)) return [...BRAND_GREEN];
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

/**
 * Invert an image (data URL) so a dark logo shows white on the black banner.
 * Loads the image onto a canvas, applies an `invert(1)` filter, and returns a
 * PNG data URL. On ANY failure (no DOM/canvas, load error, tainted canvas) the
 * original data URL is returned unchanged.
 */
export async function invertImageDataUrl(dataUrl: string): Promise<string> {
  try {
    if (typeof document === 'undefined' || !dataUrl) return dataUrl;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image load failed'));
      el.src = dataUrl;
    });

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return dataUrl;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;

    // Prefer the cheap GPU filter path; fall back to per-pixel inversion.
    const supportsFilter = typeof ctx.filter === 'string';
    if (supportsFilter) {
      ctx.filter = 'invert(1)';
      ctx.drawImage(img, 0, 0, w, h);
    } else {
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        d[i] = 255 - d[i];
        d[i + 1] = 255 - d[i + 1];
        d[i + 2] = 255 - d[i + 2];
      }
      ctx.putImageData(data, 0, 0);
    }

    return canvas.toDataURL('image/png');
  } catch {
    return dataUrl;
  }
}

export interface LetterheadContext {
  /** Brand accent colour (RGB 0..255) — drives the green bands/rule. */
  brandRgb: [number, number, number];
  /** Company contact block; blank fields are skipped. */
  company: { name?: string; phone?: string; email?: string; address?: string };
  /** Optional logo (PNG/JPEG data URL); caller pre-inverts when configured. */
  logoDataUrl?: string;
}

// --- Letterhead geometry (Letter portrait, pt) ---------------------------------
// Matches the letterhead design:
//   • HEADER — a tall BRAND-GREEN parallelogram on the left and a tall BLACK
//     block on the right, meeting along a diagonal seam that slopes down-right
//     (the green widens toward the bottom). A thin white bevel runs along the
//     seam. The company block + logo sit white-on-black in the right block.
//   • FOOTER — the same green-left / black-right arrangement (decorative, no
//     text); the green sweeps larger and the seam sits further right.
// Built with jsPDF vector ops so it scales/prints crisply, no raster background.
const PAGE_W = 612;
const PAGE_H = 792;

const BAND_H = 84; // banner height (both shapes are full height)
const BEVEL = 5;   // white gap along the diagonal seam

// Header seam (green→black): x at the top and bottom of the band.
const HDR_SEAM_TOP = 207.6;
const HDR_SEAM_BOT = 287.8;

// Footer seam (green→black): green sweeps larger, seam sits further right.
const FTR_SEAM_TOP = 328;
const FTR_SEAM_BOT = 402;

/** Fill a quadrilateral (p1→p2→p3→p4) via two triangles. */
function fillQuad(
  doc: jsPDF,
  p1: [number, number], p2: [number, number], p3: [number, number], p4: [number, number],
): void {
  doc.triangle(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1], 'F');
  doc.triangle(p1[0], p1[1], p3[0], p3[1], p4[0], p4[1], 'F');
}

/**
 * Draw the branded header on the CURRENT page. Returns the contentTop Y where
 * body content may begin (below the banner).
 */
export function drawLetterheadHeader(doc: jsPDF, ctx: LetterheadContext): number {
  const [gr, gg, gb] = ctx.brandRgb;
  const top = 0;
  const bot = BAND_H;

  // --- Green parallelogram (left), up to the seam. ---
  doc.setFillColor(gr, gg, gb);
  fillQuad(
    doc,
    [0, top],
    [HDR_SEAM_TOP, top],
    [HDR_SEAM_BOT, bot],
    [0, bot],
  );

  // --- Black block (right), starting a white bevel gap past the seam. ---
  doc.setFillColor(0, 0, 0);
  fillQuad(
    doc,
    [HDR_SEAM_TOP + BEVEL, top],
    [PAGE_W, top],
    [PAGE_W, bot],
    [HDR_SEAM_BOT + BEVEL, bot],
  );

  // --- Company contact block (white) inside the black band. ---
  const c = ctx.company || {};
  const textRight = PAGE_W - 120; // leave room for the logo at the far right
  let ty = 26;
  if (c.name) {
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(255, 255, 255);
    doc.text(String(c.name), textRight, ty, { align: 'right' });
    ty += 15;
  }
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(235, 235, 235);
  for (const line of [c.phone, c.address, c.email].filter(Boolean)) {
    doc.text(String(line), textRight, ty, { align: 'right' });
    ty += 12;
  }

  // --- Logo at the top-right (fit a ~58pt-tall box, ~609x456 aspect). ---
  if (ctx.logoDataUrl) {
    try {
      const boxH = 58;
      const boxW = boxH * (609 / 456); // ~77pt wide
      const lx = PAGE_W - 22 - boxW;
      const ly = (BAND_H - boxH) / 2;
      doc.addImage(ctx.logoDataUrl, 'PNG', lx, ly, boxW, boxH);
    } catch {
      /* skip missing/bad logo */
    }
  }

  return BAND_H + 24; // contentTop
}

/**
 * Draw the decorative footer banner (green-left / black-right, mirroring the
 * header's style) on the CURRENT page. Returns the contentBottom Y (top of the
 * banner) so callers keep body content above it.
 */
export function drawLetterheadFooter(doc: jsPDF, ctx: LetterheadContext): number {
  const [gr, gg, gb] = ctx.brandRgb;
  const top = PAGE_H - BAND_H;
  const bot = PAGE_H;

  // --- Green parallelogram (bottom-left), up to the seam. ---
  doc.setFillColor(gr, gg, gb);
  fillQuad(
    doc,
    [0, top],
    [FTR_SEAM_TOP, top],
    [FTR_SEAM_BOT, bot],
    [0, bot],
  );

  // --- Black block (bottom-right), starting a white bevel gap past the seam. ---
  doc.setFillColor(0, 0, 0);
  fillQuad(
    doc,
    [FTR_SEAM_TOP + BEVEL, top],
    [PAGE_W, top],
    [PAGE_W, bot],
    [FTR_SEAM_BOT + BEVEL, bot],
  );

  return top - 16; // contentBottom (keep body above the banner)
}
