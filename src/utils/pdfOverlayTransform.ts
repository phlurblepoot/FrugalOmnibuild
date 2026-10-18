// src/utils/pdfOverlayTransform.ts
// Maps screen-space overlays (measurement highlights, flattened annotations)
// onto a copied PDF page's user space.
//
// The screen contract (PdfCanvas): pdf.js rasterizes a page's *view box* —
// the normalized intersection of CropBox and MediaBox, with /Rotate applied —
// and the app stretches that raster onto [0,0]–[imageWidth,imageHeight].
// All stored coordinates live in that image space (Y-down).
//
// A copied page's user space, however, is the raw content space: unrotated,
// and NOT guaranteed to start at (0,0) — CAD/plotter exports commonly use a
// center-origin MediaBox (e.g. [-1512 -1080 1512 1080]), and scans sometimes
// carry an inset CropBox. Assuming (0,0) shifts every overlay by the origin
// (the "highlights offset diagonally" bug). These helpers compute the true
// view box and the transform that carries displayed space into content space.

export interface PdfBox { x: number; y: number; width: number; height: number; }
export interface ViewRect { x0: number; y0: number; x1: number; y1: number; }

// Min/max-normalizes a pdf-lib box. Producers may store corners in reverse
// order, which pdf-lib reports as negative width/height.
export function normalizeRect(b: PdfBox): ViewRect {
  const xa = b.x, xb = b.x + b.width;
  const ya = b.y, yb = b.y + b.height;
  return {
    x0: Math.min(xa, xb), x1: Math.max(xa, xb),
    y0: Math.min(ya, yb), y1: Math.max(ya, yb),
  };
}

// The rectangle pdf.js actually renders: CropBox ∩ MediaBox, normalized.
// A degenerate or disjoint intersection falls back to the MediaBox (matching
// pdf.js's own fallback).
export function viewBox(mediaBox: PdfBox, cropBox: PdfBox): ViewRect {
  const media = normalizeRect(mediaBox);
  const crop = normalizeRect(cropBox);
  const x0 = Math.max(media.x0, crop.x0), x1 = Math.min(media.x1, crop.x1);
  const y0 = Math.max(media.y0, crop.y0), y1 = Math.min(media.y1, crop.y1);
  if (x1 - x0 > 0 && y1 - y0 > 0) return { x0, y0, x1, y1 };
  return media;
}

export type OverlayMatrix = [number, number, number, number, number, number];

export interface OverlayPlacement {
  /** Image px → PDF points (1/(2·UserUnit) for pages captured at 2.0×). */
  sf: number;
  /** Displayed (viewer-orientation) page height in PDF points. */
  dispH: number;
  /** Concat matrix carrying displayed space (Y-up, origin bottom-left) into content space. */
  matrix: OverlayMatrix;
  /** True when the matrix is a no-op (unrotated page with a (0,0) view origin). */
  isIdentity: boolean;
}

// view: the page's view box; rotationDeg: the page's /Rotate; imageWidth: the
// stored displayed raster width the coordinates were captured against.
export function overlayPlacement(view: ViewRect, rotationDeg: number, imageWidth: number): OverlayPlacement {
  const rot = ((Math.round(rotationDeg) % 360) + 360) % 360;
  const swapsAxes = rot === 90 || rot === 270;
  const viewW = view.x1 - view.x0;
  const viewH = view.y1 - view.y0;
  // Displayed width in points is the view height when /Rotate swaps axes.
  const sf = (swapsAxes ? viewH : viewW) / imageWidth;
  const dispH = swapsAxes ? viewW : viewH;
  // Derived by mapping displayed corners onto view corners for each /Rotate
  // (viewer rotates content clockwise): identical to the legacy hardcoded
  // matrices when the view origin is (0,0).
  let matrix: OverlayMatrix;
  if (rot === 90) matrix = [0, 1, -1, 0, view.x1, view.y0];
  else if (rot === 180) matrix = [-1, 0, 0, -1, view.x1, view.y1];
  else if (rot === 270) matrix = [0, -1, 1, 0, view.x0, view.y1];
  else matrix = [1, 0, 0, 1, view.x0, view.y0];
  const isIdentity = rot === 0 && view.x0 === 0 && view.y0 === 0;
  return { sf, dispH, matrix, isIdentity };
}
