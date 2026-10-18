// src/utils/pdfOverlayTransform.test.ts
// Math for placing screen-space overlays (measurement highlights, annotations)
// onto a copied PDF page. The bug this guards against: printouts assumed every
// page's user space starts at (0,0) and equals the MediaBox, but CAD/plotter
// PDFs often have an offset origin (e.g. center-origin MediaBox) or a CropBox
// inset — which shifted all highlights diagonally (real case: a CAD plan set,
// MediaBox [-1512, -1080.12, 1512, 1080.12]).
import { describe, it, expect } from 'vitest';
import { normalizeRect, viewBox, overlayPlacement } from './pdfOverlayTransform';

describe('normalizeRect', () => {
  it('passes through a normal box', () => {
    expect(normalizeRect({ x: 10, y: 20, width: 100, height: 50 }))
      .toEqual({ x0: 10, y0: 20, x1: 110, y1: 70 });
  });

  it('normalizes a reversed (negative width/height) box', () => {
    // Some producers store [x1 y1 x0 y0]; pdf-lib then reports negative
    // width/height. Normalization must yield min/max corners.
    expect(normalizeRect({ x: 612, y: 792, width: -612, height: -792 }))
      .toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
  });
});

describe('viewBox', () => {
  const media = { x: 0, y: 0, width: 612, height: 792 };

  it('crop == media → media', () => {
    expect(viewBox(media, media)).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
  });

  it('crop inset from media → the crop', () => {
    expect(viewBox(media, { x: 36, y: 36, width: 540, height: 720 }))
      .toEqual({ x0: 36, y0: 36, x1: 576, y1: 756 });
  });

  it('crop partially outside media → the intersection', () => {
    expect(viewBox(media, { x: -100, y: 100, width: 300, height: 900 }))
      .toEqual({ x0: 0, y0: 100, x1: 200, y1: 792 });
  });

  it('degenerate/disjoint crop → falls back to media', () => {
    expect(viewBox(media, { x: 5000, y: 5000, width: 10, height: 10 }))
      .toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
    expect(viewBox(media, { x: 0, y: 0, width: 0, height: 0 }))
      .toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
  });

  it('negative-origin media (CAD center-origin) is preserved', () => {
    const cad = { x: -1512, y: -1080.12, width: 3024, height: 2160.24 };
    expect(viewBox(cad, cad)).toEqual({ x0: -1512, y0: -1080.12, x1: 1512, y1: 1080.12 });
  });
});

describe('overlayPlacement', () => {
  // The screen contract: pdf.js rasterizes the view box at scale 2.0, so
  // imageWidth = 2 × displayed view width. sf must come out 0.5 for such pages.
  it('rot 0, origin 0: sf 0.5, dispH = view height, identity matrix', () => {
    const p = overlayPlacement({ x0: 0, y0: 0, x1: 612, y1: 792 }, 0, 1224);
    expect(p.sf).toBeCloseTo(0.5);
    expect(p.dispH).toBeCloseTo(792);
    expect(p.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(p.isIdentity).toBe(true);
  });

  it('REAL CASE — CAD plan set: center-origin MediaBox translates by (x0, y0)', () => {
    // MediaBox [-1512 -1080.12 1512 1080.12], rendered at 2× → image 6048 wide.
    const view = { x0: -1512, y0: -1080.12, x1: 1512, y1: 1080.12 };
    const p = overlayPlacement(view, 0, 6048);
    expect(p.sf).toBeCloseTo(0.5);
    expect(p.dispH).toBeCloseTo(2160.24);
    expect(p.matrix).toEqual([1, 0, 0, 1, -1512, -1080.12]);
    expect(p.isIdentity).toBe(false);
    // Image top-left pixel (0,0) → displayed Y-up (0, dispH) → content space
    // must be the view's top-left corner (x0, y1).
    const [a, b, c, d, e, f] = p.matrix;
    const dx = 0, dy = p.dispH;
    expect(a * dx + c * dy + e).toBeCloseTo(-1512);   // view.x0
    expect(b * dx + d * dy + f).toBeCloseTo(1080.12); // view.y1
  });

  it('crop inset: overlay lands inside the crop, dispH is crop height', () => {
    const p = overlayPlacement({ x0: 36, y0: 36, x1: 576, y1: 756 }, 0, 1080);
    expect(p.sf).toBeCloseTo(540 / 1080);
    expect(p.dispH).toBeCloseTo(720);
    expect(p.matrix).toEqual([1, 0, 0, 1, 36, 36]);
    expect(p.isIdentity).toBe(false);
  });

  it('UserUnit-style scaling falls out of the width ratio (image 4× view → sf 0.25)', () => {
    const p = overlayPlacement({ x0: 0, y0: 0, x1: 612, y1: 792 }, 0, 2448);
    expect(p.sf).toBeCloseTo(0.25);
  });

  // Backward-compat: for origin-0 pages the rotation matrices must equal the
  // previous hardcoded ones ([0,1,-1,0,W,0] / [-1,0,0,-1,W,H] / [0,-1,1,0,0,H]).
  it('rot 90, origin 0 matches legacy matrix; axes swap', () => {
    const view = { x0: 0, y0: 0, x1: 612, y1: 792 };
    // displayed width = view height (792) at 2× → imageWidth 1584
    const p = overlayPlacement(view, 90, 1584);
    expect(p.sf).toBeCloseTo(0.5);
    expect(p.dispH).toBeCloseTo(612); // displayed height = view width
    expect(p.matrix).toEqual([0, 1, -1, 0, 612, 0]);
    expect(p.isIdentity).toBe(false);
  });

  it('rot 180, origin 0 matches legacy matrix', () => {
    const p = overlayPlacement({ x0: 0, y0: 0, x1: 612, y1: 792 }, 180, 1224);
    expect(p.matrix).toEqual([-1, 0, 0, -1, 612, 792]);
  });

  it('rot 270, origin 0 matches legacy matrix', () => {
    const p = overlayPlacement({ x0: 0, y0: 0, x1: 612, y1: 792 }, 270, 1584);
    expect(p.matrix).toEqual([0, -1, 1, 0, 0, 792]);
  });

  it('rot 90 with offset origin maps displayed corners onto the view corners', () => {
    const view = { x0: -100, y0: -50, x1: 500, y1: 350 }; // 600 × 400
    const p = overlayPlacement(view, 90, 800); // displayed W = view H (400) at 2×
    expect(p.sf).toBeCloseTo(0.5);
    expect(p.dispH).toBeCloseTo(600); // displayed H = view width
    expect(p.matrix).toEqual([0, 1, -1, 0, 500, -50]);
    const [a, b, c, d, e, f] = p.matrix;
    const apply = (dx: number, dy: number) => [a * dx + c * dy + e, b * dx + d * dy + f];
    // 90° CW display: displayed bottom-left ← content bottom-right corner.
    expect(apply(0, 0)).toEqual([500, -50]);       // (x1, y0)
    // displayed top-left ← content bottom-left corner.
    expect(apply(0, 600)).toEqual([-100, -50]);    // (x0, y0)
    // displayed bottom-right ← content top-right corner.
    expect(apply(400, 0)).toEqual([500, 350]);     // (x1, y1)
  });

  it('negative rotation normalizes (−90 ≡ 270)', () => {
    const a = overlayPlacement({ x0: 0, y0: 0, x1: 612, y1: 792 }, -90, 1584);
    const b = overlayPlacement({ x0: 0, y0: 0, x1: 612, y1: 792 }, 270, 1584);
    expect(a).toEqual(b);
  });
});
