import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

import { jsPDF } from 'jspdf';
import { Project, MeasurementTakeoff } from '../../../types';
import { getFile, getImage } from '../../../utils/store';
import type { Proposal, ProposalLine } from '../../../utils/store';
import { proposalTotals, scheduleAmountCents } from './proposalMath';
import { viewBox, overlayPlacement } from '../../../utils/pdfOverlayTransform';
import { shrinkPdfToBudget, EMAIL_TARGET_BYTES } from './shrinkPdf';
import {
  LetterheadContext,
  drawLetterheadHeader,
  drawLetterheadFooter,
} from '../../../utils/documentLetterhead';
import {
  calculatePolylineLength,
  calculateRealValue,
  formatMeasurement,
  calculateSurfaceAreaPx,
  convertUnit,
  UNIT_LABELS,
  calculateTakeoffCostDetails,
  expandArcPoints,
  measurementAreaPx,
  measurementRings,
} from '../../../utils/math';
import { measurementMultiplier, formatMultiplied } from '../../../utils/multiplier';

// Converts a data URL (e.g. "data:application/pdf;base64,...") to a fresh Uint8Array.
export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Hex "#rrggbb" → 0-1 RGB components for pdf-lib's rgb(). Defaults gracefully.
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return { r: 0.231, g: 0.510, b: 0.965 };
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
}

// Builds the highlighted-plans PDF. For vector-source pages it copies the
// original PDF page (preserving all native vectors and text) and stamps
// measurements + legend on top as pdf-lib drawing primitives — output is
// fully vector, dramatically smaller and crisp at any zoom. Legacy pages
// without a sourcePdfFileId fall back to embedding the rasterized JPEG.
export async function buildHighlightsPdf(
  project: Project,
  selectedTakeoffIds: Set<string>,
  onProgress?: (msg: string) => void,
  currentPageIds?: Set<string>,
): Promise<ArrayBuffer | null> {
  // Only print the current revision of each sheet; superseded pages with
  // leftover measurements are excluded so printouts match the takeoff totals.
  const pagesToPrint = project.pages.filter(page =>
    page.measurements.some(m => selectedTakeoffIds.has(m.takeoffId || '')) &&
    (!currentPageIds || currentPageIds.has(page.id))
  );
  if (pagesToPrint.length === 0) return null;

  const { PDFDocument, StandardFonts, rgb, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = await import('pdf-lib');

  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);

  // Cache source PDFs so multi-page documents only round-trip once.
  const sourceDocs = new Map<string, any>();
  const loadSourceDoc = async (fileId: string): Promise<any | null> => {
    if (sourceDocs.has(fileId)) return sourceDocs.get(fileId);
    try {
      const dataUrl = await getFile(fileId);
      if (!dataUrl) return null;
      const bytes = dataUrlToUint8Array(dataUrl);
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      sourceDocs.set(fileId, doc);
      return doc;
    } catch (e) {
      console.warn('Failed to load source PDF', fileId, e);
      sourceDocs.set(fileId, null);
      return null;
    }
  };

  for (let i = 0; i < pagesToPrint.length; i++) {
    onProgress?.(`Adding page ${i + 1} of ${pagesToPrint.length}…`);
    const page = pagesToPrint[i];

    // Build the destination page. Two paths:
    //   • Vector: copy the original PDF page so its native content (text,
    //     vectors, embedded images) survives. The measurements were captured
    //     against the page's *view box* (CropBox ∩ MediaBox) rendered at 2.0×,
    //     so the overlay must be scaled AND translated into that box — CAD
    //     exports often have an offset (e.g. center-origin) MediaBox, and
    //     assuming (0,0) shifts every highlight diagonally.
    //   • Legacy: a blank page sized to the stored raster dimensions, with
    //     that raster embedded as a full-page JPEG. Measurements are drawn
    //     in their native 1:1 coord space.
    let outPage: any = null;
    // Legacy default: page IS the image rect — sf 1, origin (0,0), no rotation.
    let placement = overlayPlacement(
      { x0: 0, y0: 0, x1: page.imageWidth, y1: page.imageHeight }, 0, page.imageWidth);

    if (page.sourcePdfFileId && page.sourcePdfPageNum) {
      const srcDoc = await loadSourceDoc(page.sourcePdfFileId);
      if (srcDoc) {
        try {
          const idx = page.sourcePdfPageNum - 1;
          if (idx >= 0 && idx < srcDoc.getPageCount()) {
            const [copied] = await outDoc.copyPages(srcDoc, [idx]);
            outDoc.addPage(copied);
            outPage = copied;
            placement = overlayPlacement(
              viewBox(copied.getMediaBox(), copied.getCropBox()),
              copied.getRotation().angle,
              page.imageWidth);
          }
        } catch (e) {
          console.warn(`Failed to copy source page ${page.sourcePdfPageNum} of ${page.sourcePdfFileId}`, e);
        }
      }
    }

    if (!outPage) {
      // Legacy raster fallback.
      const pageWidth = page.imageWidth;
      const pageHeight = page.imageHeight;
      outPage = outDoc.addPage([pageWidth, pageHeight]);
      if (page.imageId) {
        try {
          const dataUrl = await getImage(page.imageId);
          if (dataUrl) {
            const imgBytes = dataUrlToUint8Array(dataUrl);
            const isPng = dataUrl.startsWith('data:image/png');
            const embedded = isPng ? await outDoc.embedPng(imgBytes) : await outDoc.embedJpg(imgBytes);
            outPage.drawImage(embedded, { x: 0, y: 0, width: pageWidth, height: pageHeight });
          }
        } catch (e) {
          console.warn('Failed to embed legacy page image', e);
        }
      }
    }

    // Measurements are captured on the *displayed* page — pdf.js rasterizes the
    // view box via getViewport({ scale: 2.0 }), which honours /Rotate and
    // subtracts the box origin, so the coords live in the rotated, origin-zero,
    // viewer-facing image space. The page we copied, however, exposes its raw
    // unrotated content space, whose view box may start anywhere. Compose the
    // overlay in displayed space and concat the placement matrix that carries
    // it into content space (rotation + view-origin translation together); the
    // viewer's /Rotate then renders both the page and our marks as one.
    const { sf, dispH } = placement;
    if (!placement.isIdentity) {
      outPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(...placement.matrix));
    }

    // ── Vector overlay: measurements ────────────────────────────────────────
    // SVG path origin is top-left with Y-down (pdf-lib flips to PDF Y-up when
    // drawn at y=dispH). All measurement coords are scaled into PDF points
    // first so the drawSvgPath origin maps cleanly.
    const pdfX = (mx: number) => mx * sf;
    const pdfY = (my: number) => dispH - my * sf; // for non-SVG primitives (Y-up)

    for (const m of page.measurements) {
      if (!selectedTakeoffIds.has(m.takeoffId || '')) continue;
      if (!m.points || m.points.length === 0) continue;
      const takeoff = project.takeoffs.find(t => t.id === m.takeoffId);
      const colorHex = takeoff?.color || m.color || '#3b82f6';
      const c = hexToRgb(colorHex);
      const stroke = m.type === 'length' ? 8 * sf : 3 * sf;

      if (m.type === 'count') {
        const p = m.points[0];
        const cx = pdfX(p.x);
        const cy = pdfY(p.y);
        outPage.drawCircle({
          x: cx, y: cy,
          size: 12 * sf,
          color: rgb(c.r, c.g, c.b),
          opacity: 0.25,
          borderColor: rgb(c.r, c.g, c.b),
          borderWidth: stroke,
        });
        // White cross on top.
        const armCss = 6 * sf;
        outPage.drawLine({
          start: { x: cx - armCss, y: cy }, end: { x: cx + armCss, y: cy },
          thickness: 2 * sf, color: rgb(1, 1, 1),
        });
        outPage.drawLine({
          start: { x: cx, y: cy - armCss }, end: { x: cx, y: cy + armCss },
          thickness: 2 * sf, color: rgb(1, 1, 1),
        });
        continue;
      }

      // Polyline / polygon for length & area, with arcs expanded.
      if (m.type === 'area') {
        // measurementRings arc-expands, drops degenerate rings, and winds
        // additive and subtract rings oppositely — one compound path filled
        // under pdf-lib's nonzero rule punches real holes instead of
        // re-filling over them.
        const rings = measurementRings(m);
        const ringPath = (pts: typeof m.points) => {
          const cmds: string[] = [`M ${pts[0].x * sf} ${pts[0].y * sf}`];
          for (let j = 1; j < pts.length; j++) cmds.push(`L ${pts[j].x * sf} ${pts[j].y * sf}`);
          cmds.push('Z');
          return cmds.join(' ');
        };
        if (rings.length > 0) {
          const compoundPath = rings.map(r => ringPath(r.points)).join(' ');
          outPage.drawSvgPath(compoundPath, {
            x: 0, y: dispH,
            color: rgb(c.r, c.g, c.b),
            opacity: 0.25,
          });
        }
        // Borders drawn per ring: solid for the additive outline, dashed for
        // subtract (cutout) rings so a punch-out reads distinctly on paper.
        for (const ring of rings) {
          outPage.drawSvgPath(ringPath(ring.points), {
            x: 0, y: dispH,
            borderColor: rgb(c.r, c.g, c.b),
            borderWidth: stroke,
            ...(ring.subtract ? { borderDashArray: [10 * sf, 7 * sf] } : {}),
          });
        }
      } else {
        const allSegs: { points: typeof m.points; arcMidIndices?: number[] }[] = [
          { points: m.points, arcMidIndices: m.arcMidIndices },
          ...(m.segments ?? []),
        ];
        for (const seg of allSegs) {
          if (!seg.points || seg.points.length === 0) continue;
          const dispPts = expandArcPoints(seg.points, seg.arcMidIndices);
          if (dispPts.length < 2) continue;
          const cmds: string[] = [`M ${dispPts[0].x * sf} ${dispPts[0].y * sf}`];
          for (let j = 1; j < dispPts.length; j++) cmds.push(`L ${dispPts[j].x * sf} ${dispPts[j].y * sf}`);
          const path = cmds.join(' ');
          outPage.drawSvgPath(path, {
            x: 0, y: dispH,
            borderColor: rgb(c.r, c.g, c.b),
            borderWidth: stroke,
          });
        }
      }

      // Label centered on the primary segment.
      let centerX = 0, centerY = 0;
      if (m.type === 'length') {
        const midIdx = Math.floor((m.points.length - 1) / 2);
        centerX = (m.points[midIdx].x + m.points[midIdx + 1].x) / 2;
        centerY = (m.points[midIdx].y + m.points[midIdx + 1].y) / 2;
      } else {
        m.points.forEach(p => { centerX += p.x; centerY += p.y; });
        centerX /= m.points.length;
        centerY /= m.points.length;
      }
      const isSurfaceArea = takeoff?.type === 'area' && m.type === 'length';
      const allSegPts = [m.points, ...(m.segments ?? []).map(s => s.points)];
      // A multiplied measurement shows its math: "1250.00 sq ft × 4 = 5000.00 sq ft".
      const multiplier = measurementMultiplier(m);
      let text = '';
      if (isSurfaceArea) text = formatMultiplied(allSegPts.reduce((sum, pts) => sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, page.scaleConfig), 0), multiplier, v => formatMeasurement(v, 'area', page.scaleConfig, takeoff));
      else if (m.type === 'length') text = formatMultiplied(allSegPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0), multiplier, v => formatMeasurement(v, 'length', page.scaleConfig, takeoff));
      else text = formatMultiplied(measurementAreaPx(m), multiplier, v => formatMeasurement(v, 'area', page.scaleConfig, takeoff));

      if (text) {
        const fontSize = 14 * sf;
        const textWidth = font.widthOfTextAtSize(text, fontSize);
        const bgX = pdfX(centerX) - textWidth / 2 - 4 * sf;
        const bgY = pdfY(centerY) - fontSize * 0.7;
        outPage.drawRectangle({
          x: bgX, y: bgY,
          width: textWidth + 8 * sf,
          height: fontSize * 1.4,
          color: rgb(1, 1, 1),
          opacity: 0.8,
        });
        outPage.drawText(text, {
          x: pdfX(centerX) - textWidth / 2,
          y: pdfY(centerY) - fontSize * 0.3,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
      }
    }

    // ── Vector overlay: legend ──────────────────────────────────────────────
    if ((page.showLegend ?? project.legendOnAllPages) && project.takeoffs.length > 0) {
      const legendItems: { color: string; name: string; total: string }[] = [];
      for (const takeoff of project.takeoffs) {
        let totalRealValue = 0;
        let hasMeasurements = false;
        for (const m of page.measurements.filter(m => m.takeoffId === takeoff.id)) {
          if (!selectedTakeoffIds.has(m.takeoffId || '')) continue;
          hasMeasurements = true;
          let currentScale = page.scaleConfig;
          if (page.isMultiRegion && m.regionId) {
            const region = page.scaleRegions?.find(r => r.id === m.regionId);
            if (region?.scaleConfig) currentScale = region.scaleConfig;
          }
          const allMPts = [m.points, ...(m.segments ?? []).map(s => s.points)];
          let pixelValue = 0;
          if (takeoff.type === 'length' && m.type === 'length') pixelValue = allMPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
          else if (takeoff.type === 'area' && m.type === 'area') pixelValue = measurementAreaPx(m);
          else if (takeoff.type === 'area' && m.type === 'length') pixelValue = allMPts.reduce((sum, pts) => sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
          else if (takeoff.type === 'count' && m.type === 'count') pixelValue = 1;
          if (pixelValue > 0) {
            const realValue = calculateRealValue(pixelValue, takeoff.type as 'length' | 'area' | 'count', currentScale);
            const targetUnit = takeoff.unit || page.scaleConfig?.unit || 'ft';
            const sourceUnit = currentScale?.unit || 'ft';
            if (takeoff.type === 'count') totalRealValue += realValue;
            else totalRealValue += convertUnit(realValue, sourceUnit, targetUnit.replace('sq ', ''), takeoff.type as 'length' | 'area' | 'count') * measurementMultiplier(m);
          }
        }
        if (hasMeasurements) {
          const targetUnit = takeoff.unit || page.scaleConfig?.unit || 'ft';
          const unitLabel = ` ${UNIT_LABELS[takeoff.type as keyof typeof UNIT_LABELS]?.[targetUnit] || targetUnit}`;
          const formattedTotal = takeoff.type === 'count' ? Math.round(totalRealValue).toString() : totalRealValue.toFixed(2);
          legendItems.push({ color: takeoff.color, name: takeoff.name, total: page.showLegendTotals !== false ? `${formattedTotal}${unitLabel}` : '' });
        }
      }

      if (legendItems.length > 0) {
        const fontSize = (page.legendFontSize || 24) * sf;
        const padding = fontSize * 0.9;
        const itemHeight = fontSize * 1.7;
        const colorBoxSize = fontSize;
        const textOffsetX = colorBoxSize + Math.round(fontSize * 0.5);
        const width = (page.legendWidth || 500) * sf;
        const headerH = padding * 2 + fontSize * 1.4;
        const height = headerH + legendItems.length * itemHeight + padding;
        const pos = page.legendPosition || { x: 20, y: 20 };
        const legendX = pdfX(pos.x);
        const legendTopY = pdfY(pos.y); // PDF y of the top edge of the legend card

        // Card background + 1px border (no rounded corners — pdf-lib's drawRectangle
        // doesn't support radii, and the rest of the printout already uses sharp
        // rectangles for measurement labels).
        outPage.drawRectangle({
          x: legendX, y: legendTopY - height,
          width, height,
          color: rgb(1, 1, 1),
          borderColor: rgb(0.792, 0.835, 0.882), // #cbd5e1
          borderWidth: 1 * sf,
        });
        // Header band.
        outPage.drawRectangle({
          x: legendX, y: legendTopY - headerH,
          width, height: headerH,
          color: rgb(0.945, 0.961, 0.976), // #f1f5f9
        });
        // Header text.
        outPage.drawText('Legend', {
          x: legendX + padding,
          y: legendTopY - padding * 0.8 - (fontSize + 2),
          size: fontSize + 2,
          font: fontBold,
          color: rgb(0.118, 0.161, 0.231), // #1e293b
        });

        legendItems.forEach((item, index) => {
          const rowTop = legendTopY - (headerH + padding * 0.5 + index * itemHeight);
          const boxBottom = rowTop - itemHeight + (itemHeight - colorBoxSize) / 2;
          const textBaseline = rowTop - itemHeight + (itemHeight - fontSize) / 2;

          // Color swatch.
          const swatch = hexToRgb(item.color);
          outPage.drawRectangle({
            x: legendX + padding, y: boxBottom,
            width: colorBoxSize, height: colorBoxSize,
            color: rgb(swatch.r, swatch.g, swatch.b),
          });

          // Name — truncate with "…" if it would overlap the totals column.
          const maxNameWidth = width - padding * 2 - textOffsetX - (page.showLegendTotals !== false ? fontSize * 8 : 0);
          let nameText = item.name;
          while (nameText.length > 0 && font.widthOfTextAtSize(nameText + '...', fontSize) > maxNameWidth) {
            nameText = nameText.slice(0, -1);
          }
          if (nameText.length < item.name.length) nameText += '...';

          outPage.drawText(nameText, {
            x: legendX + padding + textOffsetX,
            y: textBaseline,
            size: fontSize,
            font,
            color: rgb(0.2, 0.255, 0.333), // #334155
          });

          if (page.showLegendTotals !== false && item.total) {
            const totalWidth = fontBold.widthOfTextAtSize(item.total, fontSize);
            outPage.drawText(item.total, {
              x: legendX + width - padding - totalWidth,
              y: textBaseline,
              size: fontSize,
              font: fontBold,
              color: rgb(0.059, 0.090, 0.165), // #0f172a
            });
          }
        });

        // `degrees` is imported above but only needed if we ever stamp rotated
        // text; silence the unused-variable warning by referencing it once.
        void degrees;
      }
    }

    // Balance the graphics-state push from the placement transform above.
    if (!placement.isIdentity) {
      outPage.pushOperators(popGraphicsState());
    }
  }

  const out = await outDoc.save();
  // pdf-lib returns a Uint8Array; turn it into an ArrayBuffer for the existing
  // saveFile path.
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

// ── Highlight quality presets ────────────────────────────────────────────────
// 'best' keeps the copied vector pages untouched. 'email' post-shrinks the
// result to EMAIL_TARGET_BYTES (see shrinkPdf.ts) so it survives provider
// attachment limits. The old Full/Large/Standard/Compact raster presets died
// with the raster pipeline — stored prefs holding them normalize to 'best'.
export const HIGHLIGHT_QUALITY_PRESETS = {
  best:  { label: 'Best quality (vector)' },
  email: { label: 'Email-ready (under 25MB sent)' },
} as const;
export type HighlightQuality = keyof typeof HIGHLIGHT_QUALITY_PRESETS;

export function normalizeHighlightQuality(value: unknown): HighlightQuality {
  return value === 'email' || value === 'best' ? value : 'best';
}

// One measurement's row in a takeoff's page breakdown. realValue is what it
// counts for — its measured baseValue × its multiplier (measurementMultiplier;
// 1 for most) — and is what every total and cost share adds up.
export type TakeoffMeasurementTotal = {
  id: string;
  name: string;
  realValue: number;
  unit: string;
  baseValue: number;
  multiplier: number;
};

// Per-takeoff totals as produced by ProjectView's getTakeoffTotals(): the base
// takeoff augmented with computed totals + per-page breakdown.
export type TakeoffTotals = MeasurementTakeoff & {
  totalRealValue: number;
  unit: string;
  pageBreakdown: {
    pageId: string;
    pageName: string;
    realValue: number;
    unit: string;
    measurements: TakeoffMeasurementTotal[];
  }[];
};

// Pure per-takeoff totals computation. Extracted verbatim from ProjectView's
// getTakeoffTotals() so both the legacy modal and the new /proposal section
// share ONE implementation. Only the current revision of each sheet counts —
// the caller passes `currentPageIds` (from computeRevisionModel) so that
// measurements stranded on superseded sheets don't inflate the totals.
export function computeTakeoffTotals(
  project: Project,
  currentPageIds: Set<string>,
): TakeoffTotals[] {
  const pagesToCalculate = project.pages.filter(p => currentPageIds.has(p.id));

  return project.takeoffs.map(takeoff => {
    let totalRealValue = 0;
    let displayUnit = takeoff.unit || '';

    const pageBreakdown: TakeoffTotals['pageBreakdown'] = [];

    pagesToCalculate.forEach(page => {
      const takeoffMeasurements = page.measurements.filter(m => m.takeoffId === takeoff.id);

      if (takeoffMeasurements.length > 0) {
        let pageRealValue = 0;
        let pageUnit = '';
        const measurementBreakdown: TakeoffMeasurementTotal[] = [];

        takeoffMeasurements.forEach(m => {
          // Determine which scale to use
          let currentScale = page.scaleConfig;
          if (page.isMultiRegion && m.regionId) {
            const region = page.scaleRegions?.find(r => r.id === m.regionId);
            if (region?.scaleConfig) {
              currentScale = region.scaleConfig;
            }
          }

          let measurementRealValue = 0;
          let measurementUnit = '';
          // Count markers never multiply.
          let multiplier = 1;

          if (takeoff.type === 'count') {
            measurementRealValue = 1;
            measurementUnit = 'each';
          } else if (currentScale) {
            const allMPtsTotals = [m.points, ...(m.segments ?? []).map(s => s.points)];
            let pixelValue = 0;
            if (takeoff.type === 'length' && m.type === 'length') {
              pixelValue = allMPtsTotals.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
            } else if (takeoff.type === 'area' && m.type === 'area') {
              pixelValue = measurementAreaPx(m);
            } else if (takeoff.type === 'area' && m.type === 'length') {
              pixelValue = allMPtsTotals.reduce((sum, pts) => sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
            }

            if (pixelValue > 0) {
              const realVal = calculateRealValue(pixelValue, takeoff.type as 'length' | 'area' | 'count', currentScale);

              // Convert to a consistent unit
              // If takeoff has a specific unit, use that. Otherwise use page scale unit.
              const targetUnit = takeoff.unit || page.scaleConfig?.unit || currentScale.unit;
              const convertedVal = convertUnit(realVal, currentScale.unit, targetUnit.replace('sq ', ''), takeoff.type as 'length' | 'area' | 'count');

              measurementRealValue = convertedVal;
              measurementUnit = targetUnit.startsWith('sq ') ? targetUnit : (takeoff.type === 'area' && !targetUnit.startsWith('sq ') ? `sq ${targetUnit}` : targetUnit);
              multiplier = measurementMultiplier(m);
            }
          }

          if (measurementRealValue > 0) {
            // What the measurement counts for: its measured value × its multiplier.
            const countedValue = measurementRealValue * multiplier;
            pageRealValue += countedValue;
            pageUnit = measurementUnit;
            measurementBreakdown.push({
              id: m.id,
              name: m.name,
              realValue: countedValue,
              unit: measurementUnit,
              baseValue: measurementRealValue,
              multiplier,
            });
          }
        });

        if (pageRealValue > 0) {
          totalRealValue += pageRealValue;
          if (!displayUnit) displayUnit = pageUnit;

          pageBreakdown.push({
            pageId: page.id,
            pageName: page.name,
            realValue: pageRealValue,
            unit: pageUnit,
            measurements: measurementBreakdown,
          });
        }
      }
    });

    return {
      ...takeoff,
      totalRealValue,
      unit: takeoff.unit || displayUnit, // Keep the original unit if it was set, otherwise use the detected one
      pageBreakdown,
    };
  });
}

// ── Proposal PDF renderer ────────────────────────────────────────────────────
// Everything below renders a SAVED proposal snapshot. The generator never looks
// at live takeoff data for pricing — the snapshot's lines are the record — so a
// proposal re-rendered a year later reproduces exactly what the client saw.
// `takeoffTotals` is consulted only for the optional cost-detail page.

/** Everything the renderer needs. Resolved by the caller (files → bytes/data URLs). */
export interface ProposalRenderInput {
  /** The saved snapshot: lines, inclusions, terms, options… */
  proposal: Proposal;
  project: Project;
  /** Live per-takeoff totals — cost-detail page only. */
  takeoffTotals: TakeoffTotals[];
  /** Current (non-superseded) page ids, for the highlights merge. */
  currentPageIds: Set<string>;
  letterhead: LetterheadContext;
  photos: { dataUrl: string; caption: string | null }[];
  /** Attachment PDF bytes, in arranged order — appended untouched. */
  attachments: ArrayBuffer[];
  includeHighlights: boolean;
}

export interface ProposalGenResult {
  pdfBytes: ArrayBuffer;
  suggestedName: string;
  overBudget?: boolean;
  /** 1-based page index where each section STARTS (absent when not rendered). */
  sections: Record<string, number>;
}

export const formatCurrency = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * `Proposal – <project> – <YYYY-MM-DD>`. The proposal NUMBER is internal and
 * never appears in the filename (spec §2). Uses the LOCAL date — an ISO slice
 * would show tomorrow's (or yesterday's) date either side of UTC midnight.
 */
export const proposalFileName = (project: Project, when: Date = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Proposal – ${project.name} – ${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
};

/** Vertical space one inline section divider consumes (pad + rule + title + pad). */
const DIVIDER_H = 43;

export async function generateProposalPdf(
  input: ProposalRenderInput,
  onProgress?: (msg: string) => void,
): Promise<ProposalGenResult> {
  const { proposal, project, takeoffTotals, currentPageIds, letterhead: lc, photos, attachments, includeHighlights } = input;
  const font = proposal.fontFamily ?? 'helvetica';

  // Letter portrait so the shared (Letter-based) letterhead fits exactly.
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = pdf.internal.pageSize.getWidth();
  const M = 40; // body margin

  const [hR, hG, hB] = lc.brandRgb;
  // Lighter accent tint (60% brand + 40% white) for thin rules / sub-accents.
  const [accentR, accentG, accentB] = lc.brandRgb.map(c => Math.round(c + (255 - c) * 0.4));

  // The letterhead banners bracket the body on every page.
  const pageBottom = drawLetterheadFooter(pdf, lc); // also draws the first footer
  const pageTop = drawLetterheadHeader(pdf, lc);
  const drawFrame = (): number => {
    const t = drawLetterheadHeader(pdf, lc);
    drawLetterheadFooter(pdf, lc);
    return t;
  };

  const pageNo = () => (pdf as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
  const sections: Record<string, number> = {};
  const totals = proposalTotals(proposal.lines);
  const money = (cents: number) => formatCurrency(cents / 100);
  const projNameTrunc = project.name.length > 45 ? project.name.substring(0, 45) + '…' : project.name;

  // Sections are MEASURED before they are drawn (see `keepTogether`) so that
  // none of them gets cut by a page break it could have stepped over. The
  // measuring pass replays a section's own draw code against this scratch
  // document — same format and fonts, so splitTextToSize wraps identically —
  // with `measuring` set, which makes ensure() stop breaking and newPage()
  // inert. `doc` is what every section actually draws through: the real output
  // normally, the scratch while measuring, so a measured pass leaves no ink.
  const scratch = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  let doc: jsPDF = pdf;
  let measuring = false;
  /** Deepest Y any ensure() reserved during the current measuring pass. */
  let measurePeak = 0;

  // ── Text styles ────────────────────────────────────────────────────────────
  const styleHeading = () => { doc.setFontSize(9); doc.setFont(font, 'bold'); doc.setTextColor(hR, hG, hB); };
  const styleBody = () => { doc.setFontSize(10); doc.setFont(font, 'normal'); doc.setTextColor(71, 85, 105); };
  const styleStrong = () => { doc.setFontSize(10); doc.setFont(font, 'bold'); doc.setTextColor(15, 23, 42); };
  const styleMuted = () => { doc.setFontSize(8); doc.setFont(font, 'normal'); doc.setTextColor(100, 116, 139); };

  /** Section title band in the BODY area. Returns the Y where content may begin. */
  const drawSectionBand = (titleText: string): number => {
    doc.setFillColor(hR, hG, hB);
    doc.rect(0, pageTop, W, 30, 'F');
    doc.setFontSize(13);
    doc.setFont(font, 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text(titleText, M, pageTop + 20);
    doc.setFontSize(10);
    doc.setFont(font, 'normal');
    doc.text(projNameTrunc, W - M, pageTop + 20, { align: 'right' });
    return pageTop + 30 + 18;
  };

  // Cursor-based flow: `y` is the next free baseline. `ensure(h)` starts a fresh
  // framed page when h points won't fit; `onBreak` lets a caller redraw whatever
  // the break scrolled off (column heads, table rules).
  //
  // Banding: a section's FIRST page carries its plain title and only genuine
  // continuations get "(cont.)". `sectionOpen` is what tells the two apart — a
  // section that `keepTogether` moves to a fresh page STARTS there, so it gets
  // the plain band and no inline divider; anything that breaks after content
  // has landed is a continuation.
  let y = 0;
  let bandTitle = '';
  let sectionOpen = false;
  /** Begin a section that flows on from the current page. */
  const startSection = (title: string) => {
    bandTitle = title;
    sectionOpen = false;
  };
  const newPage = (title: string) => {
    if (measuring) return; // measurement flows as though the sheet were endless
    pdf.addPage();
    drawFrame();
    y = drawSectionBand(title);
  };
  const ensure = (h: number, onBreak?: () => void) => {
    // A reserve can exceed what the caller then draws (a table head asks for 60
    // and a row's worth of room), and it is the RESERVE that triggers a break —
    // so measurement has to remember the deepest one, or a section could be
    // measured as fitting and still break on a reserve once drawn.
    if (measuring) measurePeak = Math.max(measurePeak, y + h);
    if (!measuring && y + h > pageBottom - 12) {
      newPage(sectionOpen ? `${bandTitle} (cont.)` : bandTitle);
      onBreak?.();
    }
    // Whatever the caller reserved is drawn right after this returns, so the
    // section now owns content on this page.
    sectionOpen = true;
  };

  /**
   * Opens a section INLINE, on the page the previous one ended on: a full-width
   * brand rule with the section title in brand small-caps under it, generously
   * padded so it reads as a hard separator without costing a whole sheet.
   *
   * Room is the caller's problem: `keepTogether` only reaches for this once it
   * has measured that the divider — and content worth putting under it — fits.
   */
  const drawDivider = (title: string) => {
    y += 14; // padding above
    doc.setDrawColor(hR, hG, hB);
    doc.setLineWidth(0.75);
    doc.line(M, y, W - M, y);
    y += 15;
    doc.setFontSize(11);
    doc.setFont(font, 'bold');
    doc.setTextColor(hR, hG, hB);
    doc.text(title.toUpperCase(), M, y);
    y += 14; // padding below
    sectionOpen = true; // the section owns content on this page now
  };

  /** First content baseline on a freshly banded page, and the room below it. */
  const FRESH_TOP = pageTop + 48;
  const USABLE_H = pageBottom - 12 - FRESH_TOP;
  /** A chunk this small is not worth stranding at the foot of a page. */
  const ORPHAN_MIN = 48;

  /**
   * Height `draw` would consume with no page breaks in its way. Runs against
   * the scratch document from a fresh-page cursor, restores every cursor/band
   * variable afterwards, and draws nothing into the real output. A section that
   * throws while measuring reports Infinity, which simply falls back to the old
   * flow-and-split behaviour rather than losing the section.
   */
  const measureSection = (draw: () => void): number => {
    const saved = { y, doc, measuring, sectionOpen, bandTitle };
    let h = Infinity;
    doc = scratch;
    measuring = true;
    measurePeak = FRESH_TOP;
    y = FRESH_TOP;
    try {
      draw();
      h = Math.max(y, measurePeak) - FRESH_TOP;
    } catch (e) {
      console.warn('[proposal] section measurement failed; flowing it inline', e);
    }
    ({ y, doc, measuring, sectionOpen, bandTitle } = saved);
    return h;
  };

  /**
   * Draws one section, whole wherever whole is possible. Three outcomes:
   *   • it fits under an inline divider here            → draw it here;
   *   • it doesn't, but would fit a sheet of its own    → start it on the next
   *     page, introduced by that page's plain title band (no inline divider —
   *     the two must never double up);
   *   • it is taller than any sheet                     → start it here and let
   *     it paginate under "(cont.)" bands, UNLESS so little of it would land
   *     here that the break would leave an orphan, in which case it starts on
   *     the next page too.
   * The reason the whole thing exists: a section that almost fits should not
   * spill one stranded line onto the following sheet.
   */
  const keepTogether = (title: string, key: string | null, draw: () => void) => {
    const h = measureSection(draw);
    const room = pageBottom - 12 - y;
    startSection(title);
    if (h + DIVIDER_H <= room) {
      drawDivider(title);
    } else if (h <= USABLE_H || room - DIVIDER_H < ORPHAN_MIN) {
      newPage(title);
      sectionOpen = true; // the band introduced it; any later break is a cont.
    } else {
      drawDivider(title);
    }
    // Only the real pass records where a section starts — the measuring pass
    // must not touch the map (or the progress callback).
    if (key) sections[key] = pageNo();
    draw();
  };

  // ── Cover ──────────────────────────────────────────────────────────────────
  doc.setTextColor(hR, hG, hB);
  doc.setFontSize(38);
  doc.setFont(font, 'bold');
  doc.text('PROPOSAL', W / 2, 210, { align: 'center' });
  doc.setFillColor(hR, hG, hB);
  doc.rect(W / 2 - 50, 220, 100, 3, 'F'); // short bold accent bar
  doc.setDrawColor(accentR, accentG, accentB);
  doc.setLineWidth(0.5);
  doc.line(M, 230, W - M, 230);

  const title = proposal.title?.trim() || project.name;
  doc.setFontSize(22);
  doc.setFont(font, 'bold');
  doc.setTextColor(15, 23, 42);
  // Clamped to 3 lines, the last one truncated with an ellipsis. Everything
  // below on the cover — address, "Prepared …", and the 84pt total box — is
  // positioned from titleLines.length, so an unbounded title walks the box
  // down into the footer (~11 wrapped lines clears pageBottom) and spills the
  // cover onto a second page. ProposalOptionsCard also caps the field at 120
  // characters; this is the backstop for titles already stored.
  // ASCII '...', not '…': jsPDF's standard-font encoding silently DROPS U+2026
  // (verified against the output bytes — the line rendered with no marker at
  // all), which would leave a clamped title looking arbitrarily cut off.
  const MAX_TITLE_LINES = 3;
  const ELLIPSIS = '...';
  const wrapped = doc.splitTextToSize(title, W - 80) as string[];
  const titleLines = wrapped.length <= MAX_TITLE_LINES ? wrapped : [
    ...wrapped.slice(0, MAX_TITLE_LINES - 1),
    // Trim the last kept line until it fits WITH the marker at this font size —
    // appending blind would push it past the wrap width.
    (() => {
      let last = wrapped[MAX_TITLE_LINES - 1].trimEnd();
      while (last.length > 1 && doc.getTextWidth(last + ELLIPSIS) > W - 80) last = last.slice(0, -1).trimEnd();
      return last + ELLIPSIS;
    })(),
  ];
  doc.text(titleLines, W / 2, 265, { align: 'center' });
  let coverY = 265 + titleLines.length * 28;

  if (project.address) {
    doc.setFontSize(12);
    doc.setFont(font, 'normal');
    doc.setTextColor(71, 85, 105);
    doc.text(project.address, W / 2, coverY, { align: 'center' });
    coverY += 22;
  }

  doc.setFontSize(9);
  doc.setFont(font, 'italic');
  doc.setTextColor(148, 163, 184);
  doc.text(`Prepared ${new Date().toLocaleDateString()}`, W / 2, coverY, { align: 'center' });
  y = coverY + 34;

  // ── Cover: the number the client actually opens the document for ───────────
  // The total leads, immediately under the cover block and ahead of the itemised
  // pricing, so page 1 answers "how much?" before it explains "for what?".
  // The cover block has fixed geometry — the title is clamped to 3 lines above,
  // which bounds everything below it — so this always leaves room and draws
  // straight onto page 1 without a break check.
  if (proposal.showGrandTotal) {
    sections.grandTotal = pageNo();
    const boxTop = y;
    doc.setFillColor(241, 245, 249);
    doc.setDrawColor(accentR, accentG, accentB);
    doc.setLineWidth(0.75);
    doc.roundedRect(W / 2 - 115, boxTop, 230, 84, 8, 8, 'FD');
    doc.setFillColor(hR, hG, hB);
    doc.rect(W / 2 - 115, boxTop, 4, 84, 'F');
    doc.setFontSize(9);
    doc.setFont(font, 'bold');
    doc.setTextColor(100, 116, 139);
    doc.text('TOTAL PROPOSAL VALUE', W / 2, boxTop + 24, { align: 'center' });
    doc.setFontSize(28);
    doc.setFont(font, 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text(money(totals.totalCents), W / 2, boxTop + 60, { align: 'center' });
    y = boxTop + 100;
  }

  // Printed whether or not the total box is shown — an expiry the client can't
  // see is worthless.
  if (proposal.validUntil) {
    doc.setFontSize(9);
    doc.setFont(font, 'italic');
    doc.setTextColor(100, 116, 139);
    doc.text(
      `This proposal is valid until ${new Date(proposal.validUntil + 'T00:00:00').toLocaleDateString()}.`,
      W / 2, y, { align: 'center' },
    );
    y += 20;
  }

  // ── Pricing ────────────────────────────────────────────────────────────────
  // Every section from here down flows on from the current cursor and is
  // introduced by an inline divider; a section claims the next page only when
  // it would otherwise be split, and only when it fits a page whole.

  /** One priced table (heading + rows + subtotal). `withSummary` prints each
   *  takeoff line's measurement totals under its description. */
  const drawLineTable = (heading: string, lines: ProposalLine[], withSummary: boolean) => {
    if (!lines.length) return;
    ensure(60);
    const drawHead = () => {
      styleHeading();
      doc.text(heading.toUpperCase(), M, y);
      doc.setDrawColor(accentR, accentG, accentB);
      doc.setLineWidth(0.5);
      doc.line(M, y + 5, W - M, y + 5);
      y += 20;
    };
    drawHead();

    for (const l of lines) {
      styleStrong();
      const descLines = doc.splitTextToSize(l.description || '—', W - 260) as string[];
      const summary = withSummary && l.measurementSummary ? l.measurementSummary : '';
      const rowH = 18 + (summary ? 12 : 0) + (descLines.length - 1) * 12;
      ensure(rowH + 6, drawHead);

      styleStrong();
      descLines.forEach((t, i) => doc.text(t, M, y + i * 12));
      doc.text(money(l.amountCents), W - M, y, { align: 'right' });
      if (summary) {
        styleMuted();
        doc.text(summary, M, y + descLines.length * 12);
      }
      y += rowH;
      doc.setDrawColor(226, 232, 240);
      doc.setLineWidth(0.3);
      doc.line(M, y - 6, W - M, y - 6);
    }

    // A single line IS its own subtotal — only worth a row once there are two.
    if (lines.length >= 2) {
      ensure(24);
      styleMuted();
      doc.setFont(font, 'bold');
      doc.text('Subtotal', M, y + 6);
      doc.setTextColor(15, 23, 42);
      doc.text(money(lines.reduce((s, l) => s + l.amountCents, 0)), W - M, y + 6, { align: 'right' });
      y += 24;
    }
    y += 10;
  };

  // Both tables and their subtotals are ONE section here: breaking the pricing
  // between a heading and its numbers is exactly what this rule exists to stop.
  keepTogether('Pricing', null, () => {
    drawLineTable('Takeoff pricing', totals.takeoffLines, true);
    drawLineTable('Additional pricing', totals.manualLines, false);
  });

  // Stays with the pricing — it prices out the total the cover already stated.
  if (proposal.paymentSchedule?.length) {
    const schedule = proposal.paymentSchedule;
    keepTogether('Payment Schedule', 'paymentSchedule', () => {
      for (const row of schedule) {
        ensure(16);
        styleBody();
        const label = row.percent != null ? `${row.description} (${row.percent}%)` : row.description;
        doc.text(label, M, y);
        doc.setFont(font, 'bold');
        doc.setTextColor(15, 23, 42);
        doc.text(money(scheduleAmountCents(row, totals.totalCents)), W - M, y, { align: 'right' });
        y += 16;
      }
      y += 10;
    });
  }

  // ── Inclusions / Exclusions ────────────────────────────────────────────────
  if (proposal.inclusions.length || proposal.exclusions.length) {
    const colW = (W - 100) / 2;
    const colX = [M, M + colW + 20];
    const drawColumnHeads = () => {
      styleHeading();
      doc.text('INCLUDED', colX[0], y);
      doc.text('EXCLUDED', colX[1], y);
      doc.setDrawColor(accentR, accentG, accentB);
      doc.setLineWidth(0.5);
      doc.line(colX[0], y + 5, colX[0] + colW, y + 5);
      doc.line(colX[1], y + 5, colX[1] + colW, y + 5);
      y += 20;
    };
    keepTogether('Inclusions & Exclusions', 'inclusions', () => {
      drawColumnHeads();

      // Walked row-wise so the two columns stay aligned across page breaks.
      const rowCount = Math.max(proposal.inclusions.length, proposal.exclusions.length);
      for (let i = 0; i < rowCount; i++) {
        styleBody();
        doc.setFontSize(9);
        const cells = [proposal.inclusions[i], proposal.exclusions[i]].map(text =>
          text ? (doc.splitTextToSize(`•  ${text}`, colW - 6) as string[]) : []);
        const rowH = Math.max(cells[0].length, cells[1].length) * 13 + 4;
        ensure(rowH, drawColumnHeads);
        styleBody();
        doc.setFontSize(9);
        cells.forEach((cellLines, col) =>
          cellLines.forEach((t, j) => doc.text(t, colX[col], y + j * 13)));
        y += rowH;
      }
      y += 12;
    });
  }

  // ── Notes (flowing) ───────────────────────────────────────────────────────
  const coverNotes = proposal.coverNotes?.trim();
  if (coverNotes) {
    keepTogether('Notes', 'notes', () => {
      styleBody();
      for (const t of doc.splitTextToSize(coverNotes, W - 80) as string[]) {
        ensure(16, styleBody);
        styleBody();
        doc.text(t, M, y);
        y += 16;
      }
      y += 12;
    });
  }

  // ── Alternates ────────────────────────────────────────────────────────────
  // Same takeoff/manual split as the pricing, no grand total — they are priced
  // separately and must never read as part of the contract sum.
  if (totals.altTakeoff.length || totals.altManual.length) {
    keepTogether('Alternates', 'alternates', () => {
      doc.setFontSize(9);
      doc.setFont(font, 'italic');
      doc.setTextColor(100, 116, 139);
      const intro = doc.splitTextToSize(
        'The following are optional add-ons priced separately and not included in the total above.',
        W - 80) as string[];
      intro.forEach((t, i) => doc.text(t, M, y + i * 13));
      y += intro.length * 13 + 14;
      drawLineTable('Takeoff alternates', totals.altTakeoff, true);
      drawLineTable('Additional alternates', totals.altManual, false);
    });
  }

  // ── Cost detail (takeoff lines only) ──────────────────────────────────────
  if (proposal.includeCostDetail && totals.takeoffLines.length) {
    const byId = new Map(takeoffTotals.map(t => [t.id, t]));
    const detailed = totals.takeoffLines.filter(l => l.takeoffId && byId.has(l.takeoffId));
    if (detailed.length) {
      keepTogether('Cost Detail', 'costDetail', () => {
        for (const l of detailed) {
          const t = byId.get(l.takeoffId as string) as TakeoffTotals;
          ensure(34);
          styleStrong();
          doc.text(l.description || t.name, M, y);
          doc.text(money(l.amountCents), W - M, y, { align: 'right' });
          y += 16;

          const subRow = (label: string, amount?: string) => {
            ensure(16);
            doc.setFontSize(8);
            doc.setFont(font, 'normal');
            doc.setTextColor(148, 163, 184);
            doc.text(label, M + 12, y);
            if (amount) doc.text(amount, W - M, y, { align: 'right' });
            y += 14;
          };
          if (t.isAdvancedCost && t.customCosts?.length) {
            for (const d of calculateTakeoffCostDetails(t, t.totalRealValue)) {
              subRow(`·  ${d.name}`, formatCurrency(d.costValue));
            }
          } else if (t.costPerUnit) {
            const unit = UNIT_LABELS[t.unit || ''] || t.unit ||
              (t.type === 'area' ? 'sq ft' : t.type === 'length' ? 'ft' : 'ea');
            subRow(`·  ${formatCurrency(t.costPerUnit)} / ${unit}`);
          }
          y += 10;
        }
      });
    }
  }

  // ── Terms + signature ─────────────────────────────────────────────────────
  const terms = proposal.terms?.trim();
  if (terms || proposal.includeSignature) {
    keepTogether('Terms & Conditions', 'terms', () => {
      if (terms) {
        styleBody();
        for (const t of doc.splitTextToSize(terms, W - 80) as string[]) {
          ensure(16, styleBody);
          styleBody();
          doc.text(t, M, y);
          y += 16;
        }
      }
      if (proposal.includeSignature) {
        // Just the block itself (rules + labels) — it is allowed to sit tight
        // under the terms rather than demanding a whole page's worth of room.
        ensure(70);
        if (measuring) {
          // Only the block's own height counts here. Its drawn Y is pinned near
          // the foot of whatever page it lands on, and measuring that pin from a
          // fresh-page cursor would price a lone signature at half a sheet and
          // send every signed proposal onto a page of its own.
          y += 70;
        } else {
          // Sit the block low on the page when there's room, but never under the
          // letterhead footer banner.
          const sigY = Math.min(Math.max(y + 40, pageBottom - 110), pageBottom - 40);
          doc.setFontSize(9);
          doc.setFont(font, 'bold');
          doc.setTextColor(hR, hG, hB);
          doc.text('ACCEPTED BY', M, sigY - 14);
          doc.setDrawColor(accentR, accentG, accentB);
          doc.setLineWidth(0.5);
          doc.line(M, sigY, 220, sigY);
          doc.line(260, sigY, 380, sigY);
          doc.line(W / 2 + 20, sigY, W - M, sigY);
          doc.setFontSize(8);
          doc.setFont(font, 'normal');
          doc.setTextColor(100, 116, 139);
          doc.text('Authorized Signature', M, sigY + 12);
          doc.text('Date', 260, sigY + 12);
          doc.text('Printed Name', W / 2 + 20, sigY + 12);
          y = sigY + 24;
        }
      }
    });
  }

  // ── Photos (2-up, captions under each) ────────────────────────────────────
  if (photos.length) {
    onProgress?.('Adding photos…');
    const gap = 12, cellW = (W - 2 * M - gap) / 2, cellH = 150, capH = 14;
    keepTogether('Photos', 'photos', () => {
      let col = 0;
      for (const ph of photos) {
        // Only the START of a row may break, so an image never parts company
        // with its caption. A grid taller than a sheet fills rows and continues.
        if (col === 0) ensure(cellH + capH);
        const x = M + col * (cellW + gap);
        if (!measuring) {
          try {
            doc.addImage(ph.dataUrl, 'JPEG', x, y, cellW, cellH, undefined, 'FAST');
          } catch (e) {
            console.warn('[proposal] skipped unreadable photo', e);
          }
        }
        if (ph.caption) {
          doc.setFontSize(8);
          doc.setFont(font, 'italic');
          doc.setTextColor(71, 85, 105);
          doc.text((doc.splitTextToSize(ph.caption, cellW) as string[])[0], x, y + cellH + 10);
        }
        col++;
        if (col === 2) { col = 0; y += cellH + capH + gap; }
      }
      if (col === 1) y += cellH + capH + gap; // a lone trailing image owns its row
    });
  }

  // ── Page numbers ───────────────────────────────────────────────────────────
  // Stamped just above the letterhead footer banner so they don't sit under it.
  // Attachment pages are appended AFTER this and stay untouched (spec §6.10).
  const totalPages = pageNo();
  for (let i = 1; i <= totalPages; i++) {
    pdf.setPage(i);
    pdf.setFontSize(8);
    pdf.setFont(font, 'normal');
    pdf.setTextColor(148, 163, 184);
    pdf.text(`Page ${i} of ${totalPages}`, W - M, pageBottom + 4, { align: 'right' });
  }

  // ── Merge: highlights, then attachments ────────────────────────────────────
  onProgress?.('Assembling…');
  const { PDFDocument } = await import('pdf-lib');
  const merged = await PDFDocument.create();
  const body = await PDFDocument.load(pdf.output('arraybuffer') as ArrayBuffer);
  (await merged.copyPages(body, body.getPageIndices())).forEach(p => merged.addPage(p));

  if (includeHighlights) {
    const takeoffIds = new Set(
      [...totals.takeoffLines, ...totals.altTakeoff]
        .map(l => l.takeoffId)
        .filter((id): id is string => !!id));
    const hl = await buildHighlightsPdf(project, takeoffIds, msg => onProgress?.(msg), currentPageIds);
    if (hl) {
      sections.highlightsStart = merged.getPageCount() + 1;
      const d = await PDFDocument.load(hl);
      (await merged.copyPages(d, d.getPageIndices())).forEach(p => merged.addPage(p));
    }
  }

  if (attachments.length) sections.attachmentsStart = merged.getPageCount() + 1;
  for (const bytes of attachments) {
    try {
      const d = await PDFDocument.load(bytes, { ignoreEncryption: true });
      (await merged.copyPages(d, d.getPageIndices())).forEach(p => merged.addPage(p));
    } catch (e) {
      console.warn('[proposal] skipped unreadable attachment', e);
    }
  }

  const out = await merged.save();
  let pdfBytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;

  // Email-ready mode post-shrinks the final (merged) PDF to the attachment
  // budget — attachments and highlights count toward it.
  let overBudget = false;
  if (proposal.highlightQuality === 'email') {
    const shrunk = await shrinkPdfToBudget(pdfBytes, EMAIL_TARGET_BYTES, onProgress);
    pdfBytes = shrunk.bytes;
    overBudget = shrunk.overBudget;
  }

  return { pdfBytes, suggestedName: proposalFileName(project), overBudget, sections };
}
