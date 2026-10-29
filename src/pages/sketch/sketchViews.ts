// src/pages/sketch/sketchViews.ts
// Flat views of a sketch for drawing sheets: which way each view looks, the
// drawing scales people use, how the views share a sheet (third-angle: Top
// above Front, Right side to its right, the 3D view in the corner), and the
// lengths to label on each view. Pure, so it can be tested without a browser.
import {
  arcPoints, circleThrough, formatLength, frameOf, recipePieces, shapeOutline, toWorld, usedShapeIds,
  type SketchDoc, type SketchShape, type SketchUnits, type SolidPlan, type Vec2, type Vec3,
} from './sketchModel';
import type { ViewSpec } from './geometryTypes';

export type OrthoView = 'front' | 'top' | 'side';
export type SheetView = OrthoView | 'iso';

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The standard views, as the 3D view's Front, Top, Side and 3D buttons show them. */
export const SHEET_VIEWS: Record<SheetView, { dir: Vec3; xAxis: Vec3; label: string }> = {
  front: { dir: [0, -1, 0], xAxis: [1, 0, 0], label: 'FRONT' },
  top: { dir: [0, 0, 1], xAxis: [1, 0, 0], label: 'TOP' },
  side: { dir: [1, 0, 0], xAxis: [0, 1, 0], label: 'RIGHT SIDE' },
  iso: { dir: norm([1, -1.2, 0.9]), xAxis: norm([1.2, 1, 0]), label: '3D VIEW' },
};

export const viewSpec = (name: string, dir: Vec3, xAxis: Vec3, hidden: boolean): ViewSpec => ({ name, dir: norm(dir), xAxis: norm(xAxis), hidden });

/** A world point as seen in a view (x right, y up). */
export const toView = (spec: Pick<ViewSpec, 'dir' | 'xAxis'>, p: Vec3): Vec2 => {
  const y = cross(spec.dir, spec.xAxis);
  return { x: dot(p, spec.xAxis), y: dot(p, y) };
};

// ── Scales ──────────────────────────────────────────────────────────────────

/** A drawing scale: so many inches (or mm) on paper for each inch (mm) of the real thing. */
export interface DrawingScale { label: string; ratio: number }

export const IMPERIAL_SCALES: DrawingScale[] = [
  { label: 'Twice full size', ratio: 2 },
  { label: 'Full size', ratio: 1 },
  { label: '6" = 1\'-0"', ratio: 1 / 2 },
  { label: '3" = 1\'-0"', ratio: 1 / 4 },
  { label: '1 1/2" = 1\'-0"', ratio: 1 / 8 },
  { label: '1" = 1\'-0"', ratio: 1 / 12 },
  { label: '3/4" = 1\'-0"', ratio: 1 / 16 },
  { label: '1/2" = 1\'-0"', ratio: 1 / 24 },
  { label: '3/8" = 1\'-0"', ratio: 1 / 32 },
  { label: '1/4" = 1\'-0"', ratio: 1 / 48 },
  { label: '3/16" = 1\'-0"', ratio: 1 / 64 },
  { label: '1/8" = 1\'-0"', ratio: 1 / 96 },
  { label: '1/16" = 1\'-0"', ratio: 1 / 192 },
];

export const METRIC_SCALES: DrawingScale[] = [2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 25, 1 / 50, 1 / 100, 1 / 200, 1 / 500]
  .map(ratio => ({ ratio, label: ratio >= 1 ? `${ratio}:1` : `1:${Math.round(1 / ratio)}` }));

export const scalesFor = (units: SketchUnits) => (units === 'metric' ? METRIC_SCALES : IMPERIAL_SCALES);

// ── Layout ──────────────────────────────────────────────────────────────────

export interface Box { minX: number; minY: number; maxX: number; maxY: number }

export const boxOf = (polylines: number[][], extra: Vec2[] = []): Box | null => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const pl of polylines) for (let i = 0; i + 1 < pl.length; i += 2) add(pl[i], pl[i + 1]);
  for (const p of extra) add(p.x, p.y);
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
};

/** Where a view goes on the sheet: its model box, the sheet point (pt, y down) of the box's
 *  bottom-left corner, points per model millimetre, and its scale as written under it. */
export interface Placed { box: Box; left: number; bottom: number; k: number; scaleLabel: string }

export interface SheetLayout {
  /** The flat views' shared scale, as written in the title block ("As noted" when each has its own). */
  scaleLabel: string;
  views: Partial<Record<SheetView, Placed>>;
}

const scaleLabelOf = (scale: DrawingScale | null, ratio: number) =>
  scale ? scale.label : ratio >= 1 ? `${Math.round(ratio * 10) / 10}:1 (fitted)` : `1:${Math.round(1 / ratio)} (fitted)`;

/** The largest standard scale at which `fits` holds, or the exact largest ratio when none does. */
const bestScale = (units: SketchUnits, fits: (ratio: number) => boolean): { scale: DrawingScale | null; ratio: number } => {
  const scale = scalesFor(units).find(s => fits(s.ratio));
  if (scale) return { scale, ratio: scale.ratio };
  let lo = 1e-6, hi = 1;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  return { scale: null, ratio: lo };
};

/** Below this size on paper (pt) a flat view is too small to read, so views are not kept to one scale. */
const MIN_VIEW_PT = 90;

const PT_PER_MM = 72 / 25.4;
/** Room round each flat view for its dimensions and label, and between views. */
export const VIEW_PAD = 32;
const GAP = 14;
/** The least room a 3D view is left beside the flat views. */
const ISO_MIN = 120;

/** How much of the drawing area (across and down) the 3D view may take. */
export type IsoSize = 'small' | 'medium' | 'large';
export const ISO_SIZES: Record<IsoSize, { label: string; share: number }> = {
  small: { label: 'Small', share: 0.3 },
  medium: { label: 'Medium', share: 0.42 },
  large: { label: 'Large', share: 0.55 },
};

/**
 * Lays the views out in third-angle order inside `area` (sheet points, y down):
 * Top over Front, Right side beside Front, the 3D view in the top-right corner.
 * Flat views share one scale, the largest standard one that fits (or `fixed`);
 * Front and Top line up across, Front and Side line up and down. The 3D view is
 * fitted to whatever corner is left.
 */
type Area = { x: number; y: number; w: number; h: number };

const alignedLayout = (
  boxes: Partial<Record<SheetView, Box>>,
  area: Area,
  units: SketchUnits,
  isoSize: IsoSize,
  fixed?: DrawingScale,
): SheetLayout & { tooSmall: boolean } => {
  const { front, top, side, iso } = boxes;
  // The flat views come first: their scale only has to leave the 3D view a
  // small corner. The 3D view then grows into what is left, up to its size.
  const isoW = ISO_SIZES[isoSize].share * area.w, isoH = ISO_SIZES[isoSize].share * area.h;
  const w = (b?: Box) => (b ? b.maxX - b.minX : 0);
  const h = (b?: Box) => (b ? b.maxY - b.minY : 0);
  const hasCol0 = !!(front || top), hasCol1 = !!(side || iso);
  const hasRow0 = !!(top || iso), hasRow1 = !!(front || side);
  const col0X = front && top ? { min: Math.min(front.minX, top.minX), max: Math.max(front.maxX, top.maxX) } : null;
  const row1Y = front && side ? { min: Math.min(front.minY, side.minY), max: Math.max(front.maxY, side.maxY) } : null;
  const col0W = col0X ? col0X.max - col0X.min : Math.max(w(front), w(top));
  const row1H = row1Y ? row1Y.max - row1Y.min : Math.max(h(front), h(side));

  const sizes = (k: number) => {
    const c0 = hasCol0 ? col0W * k + 2 * VIEW_PAD : 0;
    const c1 = hasCol1 ? Math.max(side ? w(side) * k + 2 * VIEW_PAD : 0, iso ? ISO_MIN : 0) : 0;
    const r0 = hasRow0 ? Math.max(top ? h(top) * k + 2 * VIEW_PAD : 0, iso ? ISO_MIN : 0) : 0;
    const r1 = hasRow1 ? row1H * k + 2 * VIEW_PAD : 0;
    return { c0, c1, r0, r1, W: c0 + c1 + (hasCol0 && hasCol1 ? GAP : 0), H: r0 + r1 + (hasRow0 && hasRow1 ? GAP : 0) };
  };
  const fits = (ratio: number) => { const s = sizes(ratio * PT_PER_MM); return s.W <= area.w && s.H <= area.h; };

  const anyFlat = !!(front || top || side);
  let scale: DrawingScale | null = null;
  let ratio = 1;
  if (anyFlat) ({ scale, ratio } = fixed ? { scale: fixed, ratio: fixed.ratio } : bestScale(units, fits));
  const label = scaleLabelOf(scale, ratio);
  const k = ratio * PT_PER_MM;
  const s = sizes(k);
  const gapX = hasCol0 && hasCol1 ? GAP : 0, gapY = hasRow0 && hasRow1 ? GAP : 0;
  // With a 3D view, its corner stretches over the space the flat views leave.
  const c1 = iso ? Math.max(s.c1, area.w - s.c0 - gapX) : s.c1;
  const r0 = iso ? Math.max(s.r0, area.h - s.r1 - gapY) : s.r0;
  const W = s.c0 + gapX + c1, H = r0 + gapY + s.r1;
  const x0 = area.x + Math.max(0, (area.w - W) / 2), y0 = area.y + Math.max(0, (area.h - H) / 2);
  const col1X = x0 + s.c0 + gapX, row1Top = y0 + r0 + gapY;

  const views: SheetLayout['views'] = {};
  // Front and Top share their left edge (same x in the model); Front and Side their bottom.
  const leftOf = (b: Box) => x0 + VIEW_PAD + (col0X ? b.minX - col0X.min : 0) * k;
  const bottomOfRow1 = (b: Box) => row1Top + s.r1 - VIEW_PAD - (row1Y ? b.minY - row1Y.min : 0) * k;
  if (front) views.front = { box: front, k, left: leftOf(front), bottom: bottomOfRow1(front), scaleLabel: label };
  if (top) views.top = { box: top, k, left: leftOf(top), bottom: y0 + r0 - VIEW_PAD, scaleLabel: label };
  if (side) views.side = { box: side, k, left: col1X + VIEW_PAD, bottom: bottomOfRow1(side), scaleLabel: label };
  if (iso) views.iso = fitIso(iso, anyFlat ? { x: col1X, y: y0, w: c1, h: r0 } : area, anyFlat ? { w: isoW, h: isoH } : undefined);
  const tooSmall = ([front, top, side].filter(Boolean) as Box[]).some(b => Math.max(w(b), h(b)) * k < MIN_VIEW_PT);
  return { scaleLabel: anyFlat ? label : 'Not to scale', views, tooSmall };
};

/** The 3D view, as large as fits its cell (no larger than `cap`), with room for its name below. */
const fitIso = (b: Box, cell: Area, cap?: { w: number; h: number }): Placed => {
  const inner = { w: Math.min(cell.w, cap?.w ?? Infinity) - 2 * GAP, h: Math.min(cell.h, cap?.h ?? Infinity) - 2 * GAP - 24 };
  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const k = Math.min(inner.w / Math.max(bw, 1e-6), inner.h / Math.max(bh, 1e-6));
  return { box: b, k, left: cell.x + (cell.w - bw * k) / 2, bottom: cell.y + GAP + (inner.h + bh * k) / 2, scaleLabel: 'not to scale' };
};

/** Each view in its own quarter of the sheet (Top and the 3D view above, Front and Side below),
 *  each flat one at the largest standard scale that fits it, its scale written under it. */
const gridLayout = (boxes: Partial<Record<SheetView, Box>>, area: Area, units: SketchUnits, isoSize: IsoSize): SheetLayout => {
  const { front, top, side, iso } = boxes;
  const isoW = ISO_SIZES[isoSize].share * area.w, isoH = ISO_SIZES[isoSize].share * area.h;
  // Top row: Top (as wide as the 3D view leaves) and the 3D view in the corner;
  // bottom row: Front and Side, half each.
  const lower = !!(front || side);
  const h0 = !(top || iso) ? 0 : !lower ? area.h : Math.max(top ? (area.h - GAP) / 2 : 0, iso ? isoH : 0);
  const h1 = lower ? area.h - h0 - (h0 ? GAP : 0) : 0;
  const y1 = area.y + (h0 ? h0 + GAP : 0);
  const half = front && side ? (area.w - GAP) / 2 : area.w;
  const cells: Partial<Record<SheetView, Area>> = {
    top: { x: area.x, y: area.y, w: area.w - (iso ? isoW + GAP : 0), h: h0 },
    iso: { x: area.x + area.w - (top || lower ? isoW : area.w), y: area.y, w: top || lower ? isoW : area.w, h: h0 },
    front: { x: area.x, y: y1, w: half, h: h1 },
    side: { x: area.x + (front ? half + GAP : 0), y: y1, w: half, h: h1 },
  };
  const views: SheetLayout['views'] = {};
  const place = (name: OrthoView, b: Box, c: Area) => {
    const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    const { scale, ratio } = bestScale(units, r => bw * r * PT_PER_MM + 2 * VIEW_PAD <= c.w && bh * r * PT_PER_MM + 2 * VIEW_PAD <= c.h);
    const k = ratio * PT_PER_MM;
    views[name] = { box: b, k, left: c.x + (c.w - bw * k) / 2, bottom: c.y + (c.h + bh * k) / 2 - VIEW_PAD / 3, scaleLabel: scaleLabelOf(scale, ratio) };
  };
  if (top) place('top', top, cells.top!);
  if (front) place('front', front, cells.front!);
  if (side) place('side', side, cells.side!);
  if (iso) views.iso = fitIso(iso, cells.iso!);
  return { scaleLabel: 'As noted', views };
};

/**
 * Lays the views out. Flat views are kept to one scale and lined up when that
 * leaves each big enough to read (or when a scale is chosen); otherwise (a long
 * run whose profile would come out tiny) each view gets its own quarter and
 * its own scale.
 */
export const layoutSheet = (
  boxes: Partial<Record<SheetView, Box>>,
  area: Area,
  units: SketchUnits,
  fixed?: DrawingScale,
  isoSize: IsoSize = 'small',
): SheetLayout => {
  const aligned = alignedLayout(boxes, area, units, isoSize, fixed);
  if (fixed || !aligned.tooSmall) return { scaleLabel: aligned.scaleLabel, views: aligned.views };
  return gridLayout(boxes, area, units, isoSize);
};

/** A model point in a placed view → sheet point (pt, y down). */
export const onSheet = (p: Placed, x: number, y: number): [number, number] =>
  [p.left + (x - p.box.minX) * p.k, p.bottom - (y - p.box.minY) * p.k];

// ── Lengths to label ────────────────────────────────────────────────────────

export interface ViewLabel { at: Vec2; text: string }

/** The lengths of a shape's straight sides, its arcs' radii or a circle's diameter, where they sit in a view. */
const shapeLabels = (s: SketchShape, spec: Pick<ViewSpec, 'dir' | 'xAxis'>, units: SketchUnits): ViewLabel[] => {
  const at = (p: Vec2) => toView(spec, toWorld(s.plane, p));
  if (s.type === 'circle') return [{ at: at(s.center), text: `Ø ${formatLength(s.radius * 2, units)}` }];
  const out: ViewLabel[] = [];
  let prev = s.start;
  for (const seg of s.segments) {
    if (seg.kind === 'line') {
      const len = Math.hypot(seg.to.x - prev.x, seg.to.y - prev.y);
      if (len > 1e-6) out.push({ at: at({ x: (prev.x + seg.to.x) / 2, y: (prev.y + seg.to.y) / 2 }), text: formatLength(len, units) });
    } else {
      const c = circleThrough(prev, seg.through, seg.to);
      if (c) out.push({ at: at(arcPoints(prev, seg.through, seg.to, 2)[0]), text: `R ${formatLength(c.radius, units)}` });
    }
    prev = seg.to;
  }
  return out;
};

/** The shapes a view looks straight at (profiles and paths of the steps, and loose shapes): their labelled lengths. */
export const viewLabels = (doc: SketchDoc, plan: SolidPlan, spec: Pick<ViewSpec, 'dir' | 'xAxis'>): ViewLabel[] => {
  const facing = (s: SketchShape) => Math.abs(dot(frameOf(s.plane).normal, spec.dir)) > 0.999;
  const shapes: SketchShape[] = [];
  for (const planned of plan.solids) {
    for (const piece of recipePieces(planned.recipe)) {
      shapes.push(piece.shape);
      if (piece.op === 'run') shapes.push(piece.path);
    }
  }
  const used = usedShapeIds(doc);
  shapes.push(...doc.shapes.filter(s => !used.has(s.id)));
  return shapes.filter(facing).flatMap(s => shapeLabels(s, spec, doc.units));
};

/** The outlines of shapes not (yet) turned into solids, as polylines in a view. */
export const looseShapeLines = (doc: SketchDoc, spec: Pick<ViewSpec, 'dir' | 'xAxis'>): number[][] => {
  const used = usedShapeIds(doc);
  return doc.shapes.filter(s => !used.has(s.id)).map(s => shapeOutline(s, 32).flatMap(p => { const q = toView(spec, toWorld(s.plane, p)); return [q.x, q.y]; }));
};
