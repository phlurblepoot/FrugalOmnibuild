// src/utils/segmentValue.ts
// What the current canvas selection is worth: a measurement's — or one of its
// segments' — own quantity, measured exactly like the canvas label measures it
// (arcs expanded, region-aware scale, the takeoff's unit), and its prorated
// share of the takeoff's dollars, priced exactly like the Takeoffs tab prices
// a page or measurement row (allocateSubsetCost) but in whole dollars, without
// the round-up to $100. A multiplied measurement (× N) counts — and prices —
// its whole and every segment N times, and says so: "420.00 sq ft × 4 =
// 1680.00 sq ft · $5,880". PdfCanvas (the selected-segment label) and
// CanvasView (the selection info bar) only call these.
import { Measurement, MeasurementSegment, MeasurementTakeoff, MeasurementType, Point, ProjectPage, ScaleConfig } from '../types';
import { TakeoffTotals } from '../pages/project/proposal/proposalGenerator';
import { allocateSubsetCost } from './costAllocation';
import { formatMultiplied, measurementMultiplier } from './multiplier';
import {
  calculatePolygonArea,
  calculatePolylineLength,
  calculateRealValue,
  calculateSurfaceAreaPx,
  convertUnit,
  expandArcPoints,
  formatMeasurement,
  measurementAreaPx,
} from './math';

export type QuantityType = 'length' | 'area' | 'count';

// A measurement's or one segment's quantity in canvas pixels: px for a length,
// px² for an area (surface area for a length measurement under an area
// takeoff), 1 for a count marker.
export interface PixelQuantity {
  type: QuantityType;
  /** Negative for a cutout: it deducts from the measurement. */
  pixelValue: number;
  /** Surface area only: the run length (px) the area was built from. */
  lengthPixelValue?: number;
}

type SegmentGeometry = Pick<MeasurementSegment, 'points' | 'arcMidIndices' | 'subtract'>;
type MeasurementShape = Pick<Measurement, 'type' | 'points' | 'arcMidIndices' | 'segments' | 'heights' | 'isTwoSided'>;

// The segment a selectedSegmentIdx points at: -1 = the primary shape
// (points/arcMidIndices), 0+ = m.segments[i]. null when the index is stale.
export const measurementSegmentAt = (m: MeasurementShape, segIdx: number): SegmentGeometry | null => {
  if (segIdx === -1) return { points: m.points, arcMidIndices: m.arcMidIndices };
  return m.segments?.[segIdx] ?? null;
};

// Cutouts only exist on area measurements; a stray subtract flag anywhere else
// is ignored, exactly as the totals ignore it.
export const isCutout = (m: Pick<Measurement, 'type'>, seg: SegmentGeometry): boolean =>
  m.type === 'area' && !!seg.subtract;

const isSurfaceArea = (m: Pick<Measurement, 'type'>, takeoffType: MeasurementType | undefined) =>
  takeoffType === 'area' && m.type === 'length';

// One segment's own gross quantity. Surface area uses the measurement's heights
// and sidedness against the arc-expanded points, as the canvas label does.
export const segmentPixelQuantity = (
  m: MeasurementShape,
  seg: SegmentGeometry,
  takeoffType: MeasurementType | undefined,
  scale: ScaleConfig | null,
): PixelQuantity => {
  if (m.type === 'count') return { type: 'count', pixelValue: 1 };
  const pts = expandArcPoints(seg.points, seg.arcMidIndices);
  if (isSurfaceArea(m, takeoffType)) {
    return {
      type: 'area',
      pixelValue: calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, scale),
      lengthPixelValue: calculatePolylineLength(pts),
    };
  }
  if (m.type === 'length') return { type: 'length', pixelValue: calculatePolylineLength(pts) };
  const area = calculatePolygonArea(pts);
  return { type: 'area', pixelValue: isCutout(m, seg) ? -area : area };
};

// The whole measurement's quantity — the same number as its canvas label:
// lengths and surface areas sum every segment, areas are net of cutouts.
export const measurementPixelQuantity = (
  m: MeasurementShape,
  takeoffType: MeasurementType | undefined,
  scale: ScaleConfig | null,
): PixelQuantity => {
  if (m.type === 'count') return { type: 'count', pixelValue: 1 };
  if (m.type !== 'length') return { type: 'area', pixelValue: measurementAreaPx(m) };
  const parts = [m, ...(m.segments ?? [])].map(s => segmentPixelQuantity(m, s, takeoffType, scale));
  const total: PixelQuantity = { type: parts[0].type, pixelValue: parts.reduce((sum, q) => sum + q.pixelValue, 0) };
  if (isSurfaceArea(m, takeoffType)) total.lengthPixelValue = parts.reduce((sum, q) => sum + (q.lengthPixelValue ?? 0), 0);
  return total;
};

// The scale a measurement was drawn at: its region's, when the page is
// multi-region and the region is calibrated, else the page's.
export const measurementScale = (
  page: Pick<ProjectPage, 'scaleConfig' | 'isMultiRegion' | 'scaleRegions'>,
  m: Pick<Measurement, 'regionId'>,
): ScaleConfig | null => {
  if (page.isMultiRegion && m.regionId) {
    const region = page.scaleRegions?.find(r => r.id === m.regionId);
    if (region?.scaleConfig) return region.scaleConfig;
  }
  return page.scaleConfig;
};

export interface QuantityContext {
  /** The scale the measurement was drawn at (measurementScale). */
  scale: ScaleConfig | null;
  takeoff?: MeasurementTakeoff;
  /** The takeoff's computeTakeoffTotals row: what its costs prorate against. */
  totals?: TakeoffTotals;
  /** The owning page's own scale unit — the totals' unit when the takeoff has none. */
  pageUnit?: string;
  /** The measurement's multiplier (measurementMultiplier); absent = 1. */
  multiplier?: number;
}

// A quantity in the unit the takeoff's totals are kept in (computeTakeoffTotals:
// the takeoff's unit, else the page's scale unit), sign kept. null when there is
// no usable scale, because the totals leave such a measurement out too.
export const quantityInTakeoffUnits = (q: PixelQuantity, ctx: QuantityContext): number | null => {
  if (q.type === 'count') return q.pixelValue;
  const { scale } = ctx;
  if (!scale || scale.pixelDistance === 0) return null;
  const real = calculateRealValue(q.pixelValue, q.type, scale);
  const targetUnit = ctx.takeoff?.unit || ctx.pageUnit || scale.unit;
  return convertUnit(real, scale.unit, targetUnit.replace('sq ', ''), q.type);
};

// Whether a takeoff carries any pricing at all. Follows allocateSubsetCost's
// branches: advanced custom costs when present, else the plain cost per unit.
export const takeoffHasPricing = (t: MeasurementTakeoff): boolean =>
  t.isAdvancedCost && t.customCosts
    ? t.customCosts.some(c => !!(c.cost || c.costPerUnit || c.amount))
    : !!t.costPerUnit;

// A quantity's share of its takeoff's dollars — the Takeoffs tab's page and
// measurement-row rule (allocateSubsetCost: flat costs by share of the takeoff
// total, rates by quantity). A negative quantity (a cutout) is a negative
// deduction. null when the takeoff has no pricing, so callers omit the $.
export const prorateQuantityCost = (totals: TakeoffTotals | undefined, quantity: number): number | null => {
  if (!totals || !takeoffHasPricing(totals)) return null;
  const dollars = allocateSubsetCost(totals, Math.abs(quantity));
  return quantity < 0 ? -dollars : dollars;
};

// Whole dollars with a true minus sign for a deduction: "$1,470", "−$44".
export const formatWholeDollars = (dollars: number): string => {
  const rounded = Math.round(Math.abs(dollars));
  return `${dollars < 0 && rounded > 0 ? '−' : ''}$${rounded.toLocaleString('en-US')}`;
};

export interface QuantityValue {
  /** Worded like the canvas label ("420.00 sq ft", `30' - 6"`, "1 each"); a cutout leads with "−".
   *  Multiplied, with its math: "420.00 sq ft × 4 = 1680.00 sq ft". */
  quantity: string;
  /** Surface area only: the run length, in the takeoff's linear unit. */
  length?: string;
  /** Prorated whole dollars; absent when unpriced, unscaled or the takeoff type doesn't match. */
  dollars?: string;
}

// An area takeoff's unit ("sqft") worded for a length: "ft".
const linearTakeoff = (takeoff: MeasurementTakeoff | undefined): MeasurementTakeoff | undefined =>
  takeoff?.unit ? { ...takeoff, unit: takeoff.unit.replace(/^sq\s*/, '') } : takeoff;

// The run length of a surface area stays the length drawn; only the quantity
// (and its dollars) is multiplied.
export const describeQuantity = (q: PixelQuantity, ctx: QuantityContext): QuantityValue => {
  const multiplier = ctx.multiplier ?? 1;
  const sign = q.pixelValue < 0 ? '−' : '';
  const value: QuantityValue = {
    quantity: formatMultiplied(Math.abs(q.pixelValue), multiplier, px => `${sign}${formatMeasurement(px, q.type, ctx.scale, ctx.takeoff)}`),
  };
  if (q.lengthPixelValue !== undefined) {
    value.length = formatMeasurement(q.lengthPixelValue, 'length', ctx.scale, linearTakeoff(ctx.takeoff));
  }
  const inTakeoffUnits = quantityInTakeoffUnits(q, ctx);
  if (inTakeoffUnits !== null && ctx.totals?.type === q.type) {
    const dollars = prorateQuantityCost(ctx.totals, inTakeoffUnits * multiplier);
    if (dollars !== null) value.dollars = formatWholeDollars(dollars);
  }
  return value;
};

// "420.00 sq ft · $1,470" — the $ part only when there is one.
export const formatQuantityValue = (v: QuantityValue): string =>
  v.dollars ? `${v.quantity} · ${v.dollars}` : v.quantity;

// The selected-segment label's text: the value, plus a length line for a
// surface area, like the measurement's own label.
export const segmentLabelText = (v: QuantityValue): string =>
  v.length ? `${formatQuantityValue(v)}\nLength: ${v.length}` : formatQuantityValue(v);

// Where a label sits on a shape — the convention the measurement label uses:
// a count's point, the middle edge of a line, the vertex average of a polygon.
export const labelAnchor = (type: MeasurementType, displayPoints: Point[]): Point => {
  if (type === 'count' || displayPoints.length === 1) return displayPoints[0];
  if (type === 'length') {
    const mid = Math.floor((displayPoints.length - 1) / 2);
    const next = displayPoints[Math.min(mid + 1, displayPoints.length - 1)];
    return { x: (displayPoints[mid].x + next.x) / 2, y: (displayPoints[mid].y + next.y) / 2 };
  }
  const sum = displayPoints.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / displayPoints.length, y: sum.y / displayPoints.length };
};

// Canvas label metrics, in screen px (divided by stageScale on the canvas):
// 14px text, 4px padding, nudged up 10px from its anchor.
export const LABEL_FONT_SIZE = 14;
export const LABEL_PADDING = 4;
export const LABEL_NUDGE_UP = 10;
const LABEL_GAP = 4;

// Rough on-screen box of a label at `anchor` — Konva measures the real one;
// this only decides whether two labels would collide.
const labelBox = (anchor: Point, text: string, stageScale: number) => {
  const lines = text.split('\n');
  const width = Math.max(...lines.map(l => l.length)) * LABEL_FONT_SIZE * 0.6 + LABEL_PADDING * 2;
  const height = lines.length * LABEL_FONT_SIZE + LABEL_PADDING * 2;
  const top = anchor.y - LABEL_NUDGE_UP / stageScale;
  return { left: anchor.x, top, right: anchor.x + width / stageScale, bottom: top + height / stageScale };
};

// Top-left of the selected segment's label. It sits on its own segment unless
// it would land on the measurement's total label (always so for the primary
// segment, which carries that label), in which case it stacks just below it.
export const placeSegmentLabel = (opts: {
  segmentAnchor: Point;
  segmentText: string;
  totalAnchor: Point;
  totalText: string;
  isPrimary: boolean;
  stageScale: number;
}): Point => {
  const { segmentAnchor, segmentText, totalAnchor, totalText, isPrimary, stageScale } = opts;
  const total = labelBox(totalAnchor, totalText, stageScale);
  const below = { x: totalAnchor.x, y: total.bottom + LABEL_GAP / stageScale };
  if (isPrimary) return below;
  const own = labelBox(segmentAnchor, segmentText, stageScale);
  const collides = own.left < total.right && total.left < own.right && own.top < total.bottom && total.top < own.bottom;
  return collides ? below : { x: own.left, y: own.top };
};

export interface SelectionSummary {
  measurementName: string;
  /** Absent for an ungrouped measurement. */
  takeoffName?: string;
  /** Swatch colour: the takeoff's, else the measurement's own. */
  color: string;
  /** Only while one segment of a multi-segment measurement is selected. */
  segment?: { label: 'Segment' | 'Cutout'; value: QuantityValue };
  total: QuantityValue;
  /** Count markers only: how many of this takeoff's markers are on the page. */
  countOnPage?: number;
}

// Everything the selection info bar shows for one selected measurement.
// segIdx: null = whole measurement, -1 = primary segment, 0+ = m.segments[i].
export const summarizeSelection = (
  page: Pick<ProjectPage, 'measurements' | 'scaleConfig' | 'isMultiRegion' | 'scaleRegions'>,
  m: Measurement,
  segIdx: number | null,
  takeoffs: MeasurementTakeoff[],
  costTotals: TakeoffTotals[],
): SelectionSummary => {
  const takeoff = takeoffs.find(t => t.id === m.takeoffId);
  const ctx: QuantityContext = {
    scale: measurementScale(page, m),
    takeoff,
    totals: costTotals.find(t => t.id === m.takeoffId),
    pageUnit: page.scaleConfig?.unit,
    multiplier: measurementMultiplier(m),
  };
  // A single-shape measurement's only segment is the whole measurement, so
  // there is no separate segment row to show.
  const seg = segIdx === null || m.type === 'count' || !m.segments?.length ? null : measurementSegmentAt(m, segIdx);
  const summary: SelectionSummary = {
    measurementName: m.name,
    takeoffName: takeoff?.name,
    color: takeoff?.color ?? m.color,
    total: describeQuantity(measurementPixelQuantity(m, takeoff?.type, ctx.scale), ctx),
  };
  if (seg) {
    summary.segment = {
      label: isCutout(m, seg) ? 'Cutout' : 'Segment',
      value: describeQuantity(segmentPixelQuantity(m, seg, takeoff?.type, ctx.scale), ctx),
    };
  }
  if (m.type === 'count') {
    summary.countOnPage = page.measurements.filter(x => x.type === 'count' && x.takeoffId === m.takeoffId).length;
  }
  return summary;
};
