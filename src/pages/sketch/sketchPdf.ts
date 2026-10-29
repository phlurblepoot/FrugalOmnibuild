// src/pages/sketch/sketchPdf.ts
// A sketch's drawing sheet as a PDF: the views laid out third-angle at one
// drawing scale (the 3D view fitted to its corner), hidden edges dashed,
// overall sizes dimensioned, the lengths of the profiles each view looks
// straight at, and a title block. Landscape, on Letter, 11×17, A4 or A3.
import { jsPDF } from 'jspdf';
import { formatLength, type SketchUnits } from './sketchModel';
import type { ProjectedView } from './geometryTypes';
import {
  VIEW_PAD, boxOf, layoutSheet, onSheet,
  type Box, type DrawingScale, type IsoSize, type Placed, type SheetView, type ViewLabel,
} from './sketchViews';


export type Paper = 'letter' | 'tabloid' | 'a4' | 'a3';
export const PAPERS: Record<Paper, { label: string; w: number; h: number }> = {
  letter: { label: 'Letter (11 × 8.5 in)', w: 792, h: 612 },
  tabloid: { label: 'Tabloid (17 × 11 in)', w: 1224, h: 792 },
  a4: { label: 'A4', w: 841.89, h: 595.28 },
  a3: { label: 'A3', w: 1190.55, h: 841.89 },
};

export interface SheetViewInput {
  name: SheetView;
  label: string;
  projected: ProjectedView;
  /** Shapes not made into solids, as polylines. */
  loose: number[][];
  labels: ViewLabel[];
}

export interface SheetInput {
  title: string;
  projectName?: string | null;
  company?: { name?: string; logoDataUrl?: string };
  notes?: string;
  units: SketchUnits;
  paper: Paper;
  /** A chosen scale for the flat views; otherwise the largest that fits. */
  scale?: DrawingScale;
  showDims: boolean;
  /** How much of the sheet the 3D view may take. */
  isoSize?: IsoSize;
  views: SheetViewInput[];
  date: Date;
}

const MARGIN = 24;
const TITLE_H = 64;
const INK: [number, number, number] = [20, 24, 32];

/** Draws a polyline (x, y pairs in model mm) of a placed view. */
const polyline = (doc: jsPDF, p: Placed, pl: number[]) => {
  if (pl.length < 4) return;
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < pl.length; i += 2) pts.push(onSheet(p, pl[i], pl[i + 1]));
  const steps = pts.slice(1).map((q, i) => [q[0] - pts[i][0], q[1] - pts[i][1]]);
  doc.lines(steps, pts[0][0], pts[0][1], [1, 1], 'S', false);
};

const arrow = (doc: jsPDF, x: number, y: number, dx: number, dy: number) => {
  const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, s = 4.5, wdt = 1.6;
  doc.triangle(x, y, x - ux * s - uy * wdt, y - uy * s + ux * wdt, x - ux * s + uy * wdt, y - uy * s - ux * wdt, 'F');
};

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Text on a small white patch, so it reads over lines. With `taken`, it is left out where it would
 *  cover another label (and otherwise added to them). */
const tag = (doc: jsPDF, text: string, x: number, y: number, size: number, angle = 0, taken?: Rect[]) => {
  doc.setFontSize(size);
  const w = doc.getTextWidth(text), h = size * 0.95;
  const rect = angle === 90 ? { x: x - h / 2 - 1, y: y - w / 2 - 1.5, w: h + 2, h: w + 3 } : { x: x - w / 2 - 1.5, y: y - h / 2 - 1, w: w + 3, h: h + 2 };
  if (taken) {
    if (taken.some(r => overlaps(r, rect))) return;
    taken.push(rect);
  }
  doc.setFillColor(255, 255, 255);
  if (angle === 90) doc.rect(x - h / 2 - 1, y - w / 2 - 1.5, h + 2, w + 3, 'F');
  else doc.rect(x - w / 2 - 1.5, y - h / 2 - 1, w + 3, h + 2, 'F');
  doc.setTextColor(...INK);
  if (angle === 90) doc.text(text, x + size * 0.35, y + w / 2, { angle: 90 });
  else doc.text(text, x - w / 2, y + size * 0.35);
};

/** Overall width (below) and height (left) of a flat view. */
const overallDims = (doc: jsPDF, p: Placed, units: SketchUnits, taken: Rect[]) => {
  const b = p.box;
  const [x1, y1] = onSheet(p, b.minX, b.minY), [x2, y2] = onSheet(p, b.maxX, b.maxY);
  doc.setDrawColor(70, 80, 95);
  doc.setFillColor(70, 80, 95);
  doc.setLineWidth(0.4);
  doc.setLineDashPattern([], 0);
  if (x2 - x1 > 4) {
    const y = y1 + 12;
    doc.line(x1, y1 + 3, x1, y + 4);
    doc.line(x2, y1 + 3, x2, y + 4);
    doc.line(x1, y, x2, y);
    arrow(doc, x1, y, -1, 0);
    arrow(doc, x2, y, 1, 0);
    tag(doc, formatLength(b.maxX - b.minX, units), (x1 + x2) / 2, y, 7.5, 0, taken);
    doc.setFillColor(70, 80, 95);
  }
  if (y1 - y2 > 4) {
    const x = x1 - 12;
    doc.line(x1 - 3, y1, x - 4, y1);
    doc.line(x1 - 3, y2, x - 4, y2);
    doc.line(x, y1, x, y2);
    arrow(doc, x, y1, 0, 1);
    arrow(doc, x, y2, 0, -1);
    tag(doc, formatLength(b.maxY - b.minY, units), x, (y1 + y2) / 2, 7.5, 90, taken);
  }
};

/** Builds the sheet. Views with nothing to draw are left out. */
export const buildSketchPdf = (input: SheetInput): jsPDF => {
  const paper = PAPERS[input.paper];
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [paper.w, paper.h] });
  doc.setFont('helvetica', 'normal');
  const frame = { x: MARGIN, y: MARGIN, w: paper.w - 2 * MARGIN, h: paper.h - 2 * MARGIN };
  const area = { x: frame.x + 10, y: frame.y + 10, w: frame.w - 20, h: frame.h - TITLE_H - 20 };

  const boxes: Partial<Record<SheetView, Box>> = {};
  const byName = new Map<SheetView, SheetViewInput>();
  for (const v of input.views) {
    const b = boxOf([...v.projected.visible, ...v.projected.hidden, ...v.loose]);
    if (!b) continue;
    // A view of something flat seen edge-on still gets a sliver of height, so it can be placed.
    if (b.maxX - b.minX < 1e-6) { b.minX -= 0.5; b.maxX += 0.5; }
    if (b.maxY - b.minY < 1e-6) { b.minY -= 0.5; b.maxY += 0.5; }
    boxes[v.name] = b;
    byName.set(v.name, v);
  }
  const layout = layoutSheet(boxes, area, input.units, input.scale, input.isoSize ?? 'small');

  // Frame.
  doc.setDrawColor(...INK);
  doc.setLineWidth(1);
  doc.rect(frame.x, frame.y, frame.w, frame.h);

  for (const [name, placed] of Object.entries(layout.views) as [SheetView, Placed][]) {
    const v = byName.get(name)!;
    // Hidden edges first, light and dashed; then the seen edges over them.
    doc.setDrawColor(130, 136, 146);
    doc.setLineWidth(0.5);
    doc.setLineDashPattern([3, 2], 0);
    for (const pl of v.projected.hidden) polyline(doc, placed, pl);
    doc.setLineDashPattern([], 0);
    doc.setDrawColor(90, 98, 110);
    doc.setLineWidth(0.6);
    for (const pl of v.loose) polyline(doc, placed, pl);
    doc.setDrawColor(...INK);
    doc.setLineWidth(name === 'iso' ? 0.7 : 0.9);
    doc.setLineCap('round');
    for (const pl of v.projected.visible) polyline(doc, placed, pl);

    const [, bottomY] = onSheet(placed, placed.box.minX, placed.box.minY);
    const [cx] = onSheet(placed, (placed.box.minX + placed.box.maxX) / 2, 0);
    if (input.showDims && name !== 'iso') {
      const taken: Rect[] = [];
      overallDims(doc, placed, input.units, taken);
      for (const l of v.labels) {
        const [x, y] = onSheet(placed, l.at.x, l.at.y);
        tag(doc, l.text, x, y, 6.5, 0, taken);
      }
    }
    // The view's name and scale under it.
    const labelY = name === 'iso' ? bottomY + 18 : bottomY + VIEW_PAD - 4;
    doc.setTextColor(...INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    const sub = name === 'iso' ? 'not to scale' : `scale ${placed.scaleLabel}`;
    const head = `${v.label}`;
    const headW = doc.getTextWidth(head);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    const subText = `   ${sub}`;
    const total = headW + doc.getTextWidth(subText);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.text(head, cx - total / 2, labelY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(90, 98, 110);
    doc.text(subText, cx - total / 2 + headW, labelY);
  }

  // ── Title block ──────────────────────────────────────────────────────────
  const tb = { x: frame.x, y: frame.y + frame.h - TITLE_H, w: frame.w, h: TITLE_H };
  doc.setDrawColor(...INK);
  doc.setLineWidth(1);
  doc.line(tb.x, tb.y, tb.x + tb.w, tb.y);
  const cols = [0.24, 0.36, 0.22, 0.18].map(f => f * tb.w);
  let cx = tb.x;
  const colX: number[] = [];
  cols.forEach((cw, i) => { colX.push(cx); if (i > 0) { doc.setLineWidth(0.5); doc.line(cx, tb.y, cx, tb.y + tb.h); } cx += cw; });
  const small = (text: string, x: number, y: number) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6); doc.setTextColor(110, 116, 126); doc.text(text.toUpperCase(), x, y);
  };
  // Company.
  let textX = colX[0] + 10;
  if (input.company?.logoDataUrl) {
    try {
      const props = doc.getImageProperties(input.company.logoDataUrl);
      const lh = TITLE_H - 20, lw = Math.min(cols[0] * 0.4, (props.width / props.height) * lh);
      const h2 = (props.height / props.width) * lw;
      doc.addImage(input.company.logoDataUrl, colX[0] + 10, tb.y + (TITLE_H - h2) / 2, lw, h2);
      textX = colX[0] + 18 + lw;
    } catch { /* no logo */ }
  }
  if (input.company?.name) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...INK);
    doc.text(doc.splitTextToSize(input.company.name, colX[0] + cols[0] - textX - 8).slice(0, 3), textX, tb.y + 26);
  }
  // Title and project.
  small('Drawing', colX[1] + 10, tb.y + 13);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...INK);
  doc.text(doc.splitTextToSize(input.title, cols[1] - 20)[0] ?? '', colX[1] + 10, tb.y + 32);
  if (input.projectName) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(70, 78, 90);
    doc.text(doc.splitTextToSize(input.projectName, cols[1] - 20)[0] ?? '', colX[1] + 10, tb.y + 48);
  }
  // Notes.
  small('Notes', colX[2] + 8, tb.y + 13);
  if (input.notes?.trim()) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...INK);
    doc.text(doc.splitTextToSize(input.notes.trim(), cols[2] - 16).slice(0, 5), colX[2] + 8, tb.y + 24);
  }
  // Date, units, scale.
  const info: [string, string][] = [
    ['Date', input.date.toLocaleDateString()],
    ['Units', input.units === 'metric' ? 'Millimetres' : 'Feet and inches'],
    ['Scale', layout.scaleLabel],
  ];
  info.forEach(([k, val], i) => {
    const y = tb.y + 16 + i * 16;
    small(k, colX[3] + 8, y - 5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...INK);
    doc.text(val, colX[3] + 8, y + 4);
  });
  return doc;
};
