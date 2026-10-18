// src/utils/segmentValue.test.ts
// The selected segment's own quantity and dollars (canvas label + info bar).
// Quantities must read exactly like the canvas label; dollars must be the
// Takeoffs tab's proration (allocateSubsetCost) in whole dollars.
import { describe, it, expect } from 'vitest';
import {
  measurementSegmentAt,
  isCutout,
  segmentPixelQuantity,
  measurementPixelQuantity,
  measurementScale,
  quantityInTakeoffUnits,
  takeoffHasPricing,
  prorateQuantityCost,
  formatWholeDollars,
  describeQuantity,
  formatQuantityValue,
  segmentLabelText,
  labelAnchor,
  placeSegmentLabel,
  summarizeSelection,
} from './segmentValue';
import { allocateSubsetCost } from './costAllocation';
import { calculatePolylineLength, expandArcPoints, formatMeasurement, measurementAreaPx } from './math';
import { computeTakeoffTotals, TakeoffTotals } from '../pages/project/proposal/proposalGenerator';
import { Measurement, MeasurementTakeoff, Point, Project, ProjectPage, ScaleConfig } from '../types';

// 10 px = 1 ft, so 100 px² = 1 sq ft.
const scale: ScaleConfig = { pixelDistance: 10, realWorldDistance: 1, unit: 'ft' };

const rect = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

const areaTakeoff: MeasurementTakeoff = { id: 't-area', name: 'Stucco', color: '#ef4444', type: 'area', unit: 'sqft', costPerUnit: 3.5 };

// Primary 200x210 px = 420 sq ft, an extra 100x100 px = 100 sq ft, and a
// 50x25 px cutout = 12.5 sq ft. Net 507.5 sq ft.
const wall = (): Measurement => ({
  id: 'm-wall', type: 'area', name: 'North wall', color: '#000', takeoffId: 't-area',
  points: rect(0, 0, 200, 210),
  segments: [
    { points: rect(300, 0, 100, 100) },
    { points: rect(50, 50, 50, 25), subtract: true },
  ],
});

const totalsFor = (takeoff: MeasurementTakeoff, totalRealValue: number): TakeoffTotals => ({
  ...takeoff, unit: takeoff.unit || '', totalRealValue, pageBreakdown: [],
});

describe('measurementSegmentAt', () => {
  it('-1 is the primary shape, 0+ an extra segment, a stale index null', () => {
    const m = wall();
    expect(measurementSegmentAt(m, -1)).toEqual({ points: m.points, arcMidIndices: undefined });
    expect(measurementSegmentAt(m, 1)).toBe(m.segments![1]);
    expect(measurementSegmentAt(m, 5)).toBeNull();
  });
});

describe('isCutout', () => {
  it('only a subtract segment of an area measurement is a cutout', () => {
    expect(isCutout({ type: 'area' }, { points: [], subtract: true })).toBe(true);
    expect(isCutout({ type: 'area' }, { points: [] })).toBe(false);
    expect(isCutout({ type: 'length' }, { points: [], subtract: true })).toBe(false);
  });
});

describe('segmentPixelQuantity', () => {
  it('an area segment is its own gross polygon area', () => {
    const m = wall();
    expect(segmentPixelQuantity(m, measurementSegmentAt(m, -1)!, 'area', scale)).toEqual({ type: 'area', pixelValue: 42000 });
    expect(segmentPixelQuantity(m, m.segments![0], 'area', scale)).toEqual({ type: 'area', pixelValue: 10000 });
  });

  it('a cutout is a negative area', () => {
    const m = wall();
    expect(segmentPixelQuantity(m, m.segments![1], 'area', scale)).toEqual({ type: 'area', pixelValue: -1250 });
  });

  it('a length segment is its own polyline length; a stray subtract flag is ignored', () => {
    const m: Measurement = {
      id: 'l', type: 'length', name: 'Base', color: '#000',
      points: [{ x: 0, y: 0 }, { x: 30, y: 40 }],
      segments: [{ points: [{ x: 0, y: 0 }, { x: 0, y: 70 }], subtract: true }],
    };
    expect(segmentPixelQuantity(m, measurementSegmentAt(m, -1)!, 'length', scale)).toEqual({ type: 'length', pixelValue: 50 });
    expect(segmentPixelQuantity(m, m.segments![0], 'length', scale)).toEqual({ type: 'length', pixelValue: 70 });
  });

  it('expands arcs exactly as the canvas label does', () => {
    const arc = { points: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }], arcMidIndices: [1] };
    const m: Measurement = { id: 'a', type: 'length', name: 'Arch', color: '#000', points: [], segments: [arc] };
    const q = segmentPixelQuantity(m, m.segments![0], 'length', scale);
    expect(q.pixelValue).toBe(calculatePolylineLength(expandArcPoints(arc.points, arc.arcMidIndices)));
    // A half circle of radius 50, not the 141 px of the two straight chords.
    expect(q.pixelValue).toBeCloseTo(Math.PI * 50, 0);
  });

  it('a length measurement under an area takeoff is surface area, with its run length', () => {
    // 100 px = 10 ft run, 8 ft high, both sides: 10 * 8 * 2 = 160 sq ft = 16000 px².
    const m: Measurement = {
      id: 's', type: 'length', name: 'Partition', color: '#000', heights: [8, 8], isTwoSided: true,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    };
    expect(segmentPixelQuantity(m, measurementSegmentAt(m, -1)!, 'area', scale)).toEqual({
      type: 'area', pixelValue: 16000, lengthPixelValue: 100,
    });
  });

  it('a count marker is 1', () => {
    const m: Measurement = { id: 'c', type: 'count', name: 'Count 1', color: '#000', points: [{ x: 5, y: 5 }] };
    expect(segmentPixelQuantity(m, measurementSegmentAt(m, -1)!, 'count', scale)).toEqual({ type: 'count', pixelValue: 1 });
  });
});

describe('measurementPixelQuantity', () => {
  it('an area is net of its cutouts (the label value)', () => {
    const m = wall();
    expect(measurementPixelQuantity(m, 'area', scale)).toEqual({ type: 'area', pixelValue: measurementAreaPx(m) });
    expect(measurementAreaPx(m)).toBe(42000 + 10000 - 1250);
  });

  it('a length sums its segments, which add up to the total', () => {
    const m: Measurement = {
      id: 'l', type: 'length', name: 'Base', color: '#000',
      points: [{ x: 0, y: 0 }, { x: 30, y: 40 }],
      segments: [{ points: [{ x: 0, y: 0 }, { x: 0, y: 70 }] }],
    };
    const total = measurementPixelQuantity(m, 'length', scale);
    expect(total).toEqual({ type: 'length', pixelValue: 120 });
    const parts = [-1, 0].map(i => segmentPixelQuantity(m, measurementSegmentAt(m, i)!, 'length', scale).pixelValue);
    expect(parts[0] + parts[1]).toBe(total.pixelValue);
  });

  it('a surface area sums both the area and the run length', () => {
    const m: Measurement = {
      id: 's', type: 'length', name: 'Partition', color: '#000', heights: [8, 8], isTwoSided: false,
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      segments: [{ points: [{ x: 0, y: 0 }, { x: 0, y: 50 }] }],
    };
    expect(measurementPixelQuantity(m, 'area', scale)).toEqual({ type: 'area', pixelValue: 8000 + 4000, lengthPixelValue: 150 });
  });

  it('a count is 1', () => {
    const m: Measurement = { id: 'c', type: 'count', name: 'Count 1', color: '#000', points: [{ x: 5, y: 5 }] };
    expect(measurementPixelQuantity(m, 'count', null)).toEqual({ type: 'count', pixelValue: 1 });
  });
});

describe('measurementScale', () => {
  const regionScale: ScaleConfig = { pixelDistance: 20, realWorldDistance: 1, unit: 'ft' };
  const page = {
    scaleConfig: scale,
    isMultiRegion: true,
    scaleRegions: [
      { id: 'r1', name: 'Detail', points: [], scaleConfig: regionScale, color: '#8b5cf6' },
      { id: 'r2', name: 'Uncalibrated', points: [], scaleConfig: null, color: '#8b5cf6' },
    ],
  };

  it("uses the measurement's calibrated region", () => {
    expect(measurementScale(page, { regionId: 'r1' })).toBe(regionScale);
  });

  it("falls back to the page scale for an uncalibrated region, no region, or a single-scale page", () => {
    expect(measurementScale(page, { regionId: 'r2' })).toBe(scale);
    expect(measurementScale(page, {})).toBe(scale);
    expect(measurementScale({ ...page, isMultiRegion: false }, { regionId: 'r1' })).toBe(scale);
  });
});

describe('quantityInTakeoffUnits', () => {
  it("converts to the takeoff's unit, keeping the sign", () => {
    // 1250 px² = 12.5 sq ft = 12.5/9 sq yd.
    const q = { type: 'area' as const, pixelValue: -1250 };
    expect(quantityInTakeoffUnits(q, { scale, takeoff: areaTakeoff })).toBeCloseTo(-12.5, 10);
    expect(quantityInTakeoffUnits(q, { scale, takeoff: { ...areaTakeoff, unit: 'sqyd' } })).toBeCloseTo(-12.5 / 9, 10);
  });

  it("falls back to the page's unit when the takeoff has none (computeTakeoffTotals' rule)", () => {
    // Region drawn in inches (1 px = 1 in), page in feet: 120 px = 10 ft.
    const inches: ScaleConfig = { pixelDistance: 1, realWorldDistance: 1, unit: 'in' };
    const q = { type: 'length' as const, pixelValue: 120 };
    expect(quantityInTakeoffUnits(q, { scale: inches, pageUnit: 'ft' })).toBeCloseTo(10, 10);
    expect(quantityInTakeoffUnits(q, { scale: inches })).toBe(120);
  });

  it('is null without a usable scale; a count needs none', () => {
    expect(quantityInTakeoffUnits({ type: 'area', pixelValue: 100 }, { scale: null })).toBeNull();
    expect(quantityInTakeoffUnits({ type: 'area', pixelValue: 100 }, { scale: { ...scale, pixelDistance: 0 } })).toBeNull();
    expect(quantityInTakeoffUnits({ type: 'count', pixelValue: 1 }, { scale: null })).toBe(1);
  });
});

describe('takeoffHasPricing', () => {
  it('a plain cost per unit is pricing; none is not', () => {
    expect(takeoffHasPricing(areaTakeoff)).toBe(true);
    expect(takeoffHasPricing({ ...areaTakeoff, costPerUnit: undefined })).toBe(false);
    expect(takeoffHasPricing({ ...areaTakeoff, costPerUnit: 0 })).toBe(false);
  });

  it('advanced costs count when any has a price; an empty list is unpriced', () => {
    const adv = { ...areaTakeoff, costPerUnit: undefined, isAdvancedCost: true };
    expect(takeoffHasPricing({ ...adv, customCosts: [{ id: 'c', name: 'Lath', type: 'flat', cost: 500 }] })).toBe(true);
    expect(takeoffHasPricing({ ...adv, customCosts: [{ id: 'c', name: 'Mud', type: 'yield', yield: 50, cost: 0 }] })).toBe(false);
    expect(takeoffHasPricing({ ...adv, customCosts: [] })).toBe(false);
  });

  it('an advanced takeoff without custom costs falls back to its cost per unit, as allocateSubsetCost does', () => {
    expect(takeoffHasPricing({ ...areaTakeoff, isAdvancedCost: true, costPerUnit: 2 })).toBe(true);
  });
});

describe('prorateQuantityCost', () => {
  it('is allocateSubsetCost — flat costs by share of the takeoff total, rates by quantity', () => {
    const totals = totalsFor({
      ...areaTakeoff, costPerUnit: undefined, isAdvancedCost: true,
      customCosts: [
        { id: 'c1', name: 'Mobilization', type: 'flat', cost: 1000 },
        { id: 'c2', name: 'Plaster', type: 'unit', costPerUnit: 2 },
      ],
    }, 500);
    // 1000 * 100/500 + 100 * 2
    expect(prorateQuantityCost(totals, 100)).toBe(400);
    expect(prorateQuantityCost(totals, 100)).toBe(allocateSubsetCost(totals, 100));
  });

  it('a negative quantity (a cutout) is a negative deduction', () => {
    expect(prorateQuantityCost(totalsFor(areaTakeoff, 500), -12.5)).toBe(-43.75);
  });

  it('is null when the takeoff has no pricing or no totals row', () => {
    expect(prorateQuantityCost(totalsFor({ ...areaTakeoff, costPerUnit: undefined }, 500), 100)).toBeNull();
    expect(prorateQuantityCost(undefined, 100)).toBeNull();
  });
});

describe('formatWholeDollars', () => {
  it('whole dollars with thousands separators and a true minus', () => {
    expect(formatWholeDollars(1470)).toBe('$1,470');
    expect(formatWholeDollars(1469.5)).toBe('$1,470');
    expect(formatWholeDollars(-43.75)).toBe('−$44');
    expect(formatWholeDollars(-0.4)).toBe('$0');
  });
});

describe('describeQuantity / formatQuantityValue / segmentLabelText', () => {
  const ctx = { scale, takeoff: areaTakeoff, totals: totalsFor(areaTakeoff, 507.5), pageUnit: 'ft' };

  it('quantity worded like the canvas label, plus prorated whole dollars', () => {
    const v = describeQuantity({ type: 'area', pixelValue: 42000 }, ctx);
    expect(v).toEqual({ quantity: '420.00 sq ft', dollars: '$1,470' });
    expect(v.quantity).toBe(formatMeasurement(42000, 'area', scale, areaTakeoff));
    expect(formatQuantityValue(v)).toBe('420.00 sq ft · $1,470');
  });

  it('a cutout reads as a deduction', () => {
    expect(formatQuantityValue(describeQuantity({ type: 'area', pixelValue: -1250 }, ctx))).toBe('−12.50 sq ft · −$44');
  });

  it('omits the $ when the takeoff is unpriced, unscaled or of another type', () => {
    const unpriced = { ...areaTakeoff, costPerUnit: undefined };
    expect(describeQuantity({ type: 'area', pixelValue: 42000 }, { ...ctx, takeoff: unpriced, totals: totalsFor(unpriced, 507.5) }))
      .toEqual({ quantity: '420.00 sq ft' });
    expect(describeQuantity({ type: 'area', pixelValue: 42000 }, { ...ctx, scale: null }))
      .toEqual({ quantity: '42000.00 px²' });
    expect(describeQuantity({ type: 'length', pixelValue: 100 }, { ...ctx, takeoff: undefined })).toEqual({ quantity: `10' - 0"` });
  });

  it("a surface area adds a length line in the takeoff's linear unit", () => {
    const v = describeQuantity({ type: 'area', pixelValue: 16000, lengthPixelValue: 100 }, ctx);
    expect(v).toEqual({ quantity: '160.00 sq ft', length: '10.00 ft', dollars: '$560' });
    expect(segmentLabelText(v)).toBe('160.00 sq ft · $560\nLength: 10.00 ft');
    // No takeoff unit: feet and inches, like an ungrouped length.
    expect(describeQuantity({ type: 'area', pixelValue: 16000, lengthPixelValue: 100 }, { scale }).length).toBe(`10' - 0"`);
  });

  it('a multiplied measurement shows its math and prices the multiplied quantity', () => {
    const v = describeQuantity({ type: 'area', pixelValue: 42000 }, { ...ctx, multiplier: 4 });
    // 1680 sq ft × $3.50 = $5,880.
    expect(v).toEqual({ quantity: '420.00 sq ft × 4 = 1680.00 sq ft', dollars: '$5,880' });
    expect(formatQuantityValue(v)).toBe('420.00 sq ft × 4 = 1680.00 sq ft · $5,880');
    // A cutout deducts four times too.
    expect(formatQuantityValue(describeQuantity({ type: 'area', pixelValue: -1250 }, { ...ctx, multiplier: 4 })))
      .toBe('−12.50 sq ft × 4 = −50.00 sq ft · −$175');
    // × 1 is no multiplier.
    expect(describeQuantity({ type: 'area', pixelValue: 42000 }, { ...ctx, multiplier: 1 })).toEqual({ quantity: '420.00 sq ft', dollars: '$1,470' });
  });

  it('a multiplied surface area multiplies the area; its length line stays the run drawn', () => {
    const v = describeQuantity({ type: 'area', pixelValue: 16000, lengthPixelValue: 100 }, { ...ctx, multiplier: 2 });
    expect(v).toEqual({ quantity: '160.00 sq ft × 2 = 320.00 sq ft', length: '10.00 ft', dollars: '$1,120' });
    expect(segmentLabelText(v)).toBe('160.00 sq ft × 2 = 320.00 sq ft · $1,120\nLength: 10.00 ft');
  });

  it('a count is "1 each" priced per marker', () => {
    const countTakeoff: MeasurementTakeoff = { id: 't-c', name: 'Outlets', color: '#22c55e', type: 'count', costPerUnit: 45 };
    expect(formatQuantityValue(describeQuantity({ type: 'count', pixelValue: 1 }, { scale: null, takeoff: countTakeoff, totals: totalsFor(countTakeoff, 12) })))
      .toBe('1 each · $45');
  });
});

describe('labelAnchor', () => {
  it("a line's middle edge, a polygon's vertex average, a count's point", () => {
    expect(labelAnchor('length', [{ x: 0, y: 0 }, { x: 10, y: 0 }])).toEqual({ x: 5, y: 0 });
    // Edge floor((n-1)/2) → the next one, as the measurement label picks it.
    expect(labelAnchor('length', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }])).toEqual({ x: 10, y: 10 });
    expect(labelAnchor('area', rect(0, 0, 100, 50))).toEqual({ x: 50, y: 25 });
    expect(labelAnchor('count', [{ x: 7, y: 9 }])).toEqual({ x: 7, y: 9 });
  });
});

describe('placeSegmentLabel', () => {
  const base = { totalAnchor: { x: 100, y: 100 }, totalText: '507.50 sq ft', segmentText: '420.00 sq ft · $1,470', stageScale: 1 };

  it('the primary segment stacks just below the total label it carries', () => {
    // Total label: top = 100 - 10, height = 14 + 8 → bottom 112; +4 gap.
    expect(placeSegmentLabel({ ...base, segmentAnchor: { x: 100, y: 100 }, isPrimary: true })).toEqual({ x: 100, y: 116 });
    // A two-line total (surface area) pushes it one line further down.
    expect(placeSegmentLabel({ ...base, totalText: 'a\nb', segmentAnchor: { x: 100, y: 100 }, isPrimary: true })).toEqual({ x: 100, y: 130 });
  });

  it('scales with the stage zoom', () => {
    expect(placeSegmentLabel({ ...base, stageScale: 2, segmentAnchor: { x: 100, y: 100 }, isPrimary: true })).toEqual({ x: 100, y: 108 });
  });

  it('another segment sits on its own anchor when clear of the total label', () => {
    expect(placeSegmentLabel({ ...base, segmentAnchor: { x: 400, y: 300 }, isPrimary: false })).toEqual({ x: 400, y: 290 });
  });

  it('another segment whose label would land on the total label stacks below it', () => {
    // A cutout centred near the wall's centre.
    expect(placeSegmentLabel({ ...base, segmentAnchor: { x: 90, y: 104 }, isPrimary: false })).toEqual({ x: 100, y: 116 });
  });
});

describe('summarizeSelection', () => {
  const mkPage = (measurements: Measurement[]): ProjectPage => ({
    id: 'p1', name: 'A-201', imageId: '', imageWidth: 1000, imageHeight: 1000, measurements, scaleConfig: scale,
  });

  it('whole measurement: name, takeoff, total only', () => {
    const page = mkPage([wall()]);
    const s = summarizeSelection(page, page.measurements[0], null, [areaTakeoff], [totalsFor(areaTakeoff, 507.5)]);
    expect(s).toEqual({
      measurementName: 'North wall',
      takeoffName: 'Stucco',
      color: '#ef4444',
      total: { quantity: '507.50 sq ft', dollars: '$1,776' },
    });
  });

  it('one segment: its own value next to the measurement total', () => {
    const page = mkPage([wall()]);
    const totals = [totalsFor(areaTakeoff, 507.5)];
    expect(summarizeSelection(page, page.measurements[0], -1, [areaTakeoff], totals).segment)
      .toEqual({ label: 'Segment', value: { quantity: '420.00 sq ft', dollars: '$1,470' } });
    expect(summarizeSelection(page, page.measurements[0], 0, [areaTakeoff], totals).segment)
      .toEqual({ label: 'Segment', value: { quantity: '100.00 sq ft', dollars: '$350' } });
    expect(summarizeSelection(page, page.measurements[0], 1, [areaTakeoff], totals).segment)
      .toEqual({ label: 'Cutout', value: { quantity: '−12.50 sq ft', dollars: '−$44' } });
  });

  it('a single-shape measurement has no separate segment row (its segment is the measurement)', () => {
    const page = mkPage([{ ...wall(), segments: [] }]);
    expect(summarizeSelection(page, page.measurements[0], -1, [areaTakeoff], [totalsFor(areaTakeoff, 420)]).segment)
      .toBeUndefined();
  });

  it('a stale segment index falls back to the whole measurement', () => {
    const page = mkPage([wall()]);
    expect(summarizeSelection(page, page.measurements[0], 7, [areaTakeoff], []).segment).toBeUndefined();
  });

  it("a count marker: 1 each priced, and how many of its takeoff are on the page", () => {
    const outlets: MeasurementTakeoff = { id: 't-c', name: 'Outlets', color: '#22c55e', type: 'count', costPerUnit: 45 };
    const marker = (id: string, takeoffId?: string): Measurement => ({ id, type: 'count', name: id, color: '#f59e0b', takeoffId, points: [{ x: 1, y: 1 }] });
    const page = mkPage([marker('c1', 't-c'), marker('c2', 't-c'), marker('c3', 't-c'), marker('other'), wall()]);
    const s = summarizeSelection(page, page.measurements[1], null, [outlets, areaTakeoff], [totalsFor(outlets, 3)]);
    expect(s.total).toEqual({ quantity: '1 each', dollars: '$45' });
    expect(s.countOnPage).toBe(3);
    expect(s.segment).toBeUndefined();
  });

  it("an ungrouped measurement uses its own colour and shows no $", () => {
    const page = mkPage([{ ...wall(), takeoffId: undefined, color: '#123456' }]);
    const s = summarizeSelection(page, page.measurements[0], null, [areaTakeoff], [totalsFor(areaTakeoff, 507.5)]);
    expect(s.takeoffName).toBeUndefined();
    expect(s.color).toBe('#123456');
    expect(s.total).toEqual({ quantity: '507.50 sq ft' });
  });

  it('a multiplied measurement: its total and the selected segment both show the math', () => {
    const page = mkPage([{ ...wall(), multiplier: 4 }]);
    // 507.5 × 4 = 2030 sq ft.
    const totals = [totalsFor(areaTakeoff, 2030)];
    const whole = summarizeSelection(page, page.measurements[0], null, [areaTakeoff], totals);
    expect(whole.total).toEqual({ quantity: '507.50 sq ft × 4 = 2030.00 sq ft', dollars: '$7,105' });
    expect(summarizeSelection(page, page.measurements[0], -1, [areaTakeoff], totals).segment)
      .toEqual({ label: 'Segment', value: { quantity: '420.00 sq ft × 4 = 1680.00 sq ft', dollars: '$5,880' } });
    expect(summarizeSelection(page, page.measurements[0], 1, [areaTakeoff], totals).segment)
      .toEqual({ label: 'Cutout', value: { quantity: '−12.50 sq ft × 4 = −50.00 sq ft', dollars: '−$175' } });
  });

  it('a count marker never shows a multiplier', () => {
    const outlets: MeasurementTakeoff = { id: 't-c', name: 'Outlets', color: '#22c55e', type: 'count', costPerUnit: 45 };
    const page = mkPage([{ id: 'c1', type: 'count', name: 'c1', color: '#000', takeoffId: 't-c', points: [{ x: 1, y: 1 }], multiplier: 3 }]);
    expect(summarizeSelection(page, page.measurements[0], null, [outlets], [totalsFor(outlets, 1)]).total)
      .toEqual({ quantity: '1 each', dollars: '$45' });
  });

  it("a multiplied measurement's $ agrees with its computeTakeoffTotals row, and its segments' $ add up to it", () => {
    const priced: MeasurementTakeoff = {
      ...areaTakeoff, costPerUnit: undefined, isAdvancedCost: true,
      customCosts: [
        { id: 'c1', name: 'Mobilization', type: 'flat', cost: 900 },
        { id: 'c2', name: 'Plaster', type: 'unit', costPerUnit: 3.5 },
      ],
    };
    const other: Measurement = { id: 'm-2', type: 'area', name: 'South wall', color: '#000', takeoffId: 't-area', points: rect(0, 0, 100, 100) };
    const page = mkPage([{ ...wall(), multiplier: 3 }, other]);
    const project = { id: 'pr', name: 'Job', createdAt: 0, pages: [page], takeoffs: [priced] } as unknown as Project;
    const totals = computeTakeoffTotals(project, new Set(['p1']));
    const row = totals[0].pageBreakdown[0].measurements.find(r => r.id === 'm-wall')!;
    expect(row.realValue).toBeCloseTo(507.5 * 3);

    const s = summarizeSelection(page, page.measurements[0], null, [priced], totals);
    expect(s.total.dollars).toBe(formatWholeDollars(allocateSubsetCost(totals[0], row.realValue)));

    const m = page.measurements[0];
    const segDollars = [-1, 0, 1].map(i => {
      const q = segmentPixelQuantity(m, measurementSegmentAt(m, i)!, 'area', scale);
      return prorateQuantityCost(totals[0], quantityInTakeoffUnits(q, { scale, takeoff: priced })! * 3)!;
    });
    expect(segDollars.reduce((a, b) => a + b, 0)).toBeCloseTo(allocateSubsetCost(totals[0], row.realValue), 6);
  });

  it("agrees with the Takeoffs tab: the measurement's $ is its computeTakeoffTotals row prorated", () => {
    // A flat cost makes the share of the takeoff total matter.
    const priced: MeasurementTakeoff = {
      ...areaTakeoff, costPerUnit: undefined, isAdvancedCost: true,
      customCosts: [
        { id: 'c1', name: 'Mobilization', type: 'flat', cost: 900 },
        { id: 'c2', name: 'Plaster', type: 'unit', costPerUnit: 3.5 },
      ],
    };
    const other: Measurement = { id: 'm-2', type: 'area', name: 'South wall', color: '#000', takeoffId: 't-area', points: rect(0, 0, 100, 100) };
    const page = mkPage([wall(), other]);
    const project = { id: 'pr', name: 'Job', createdAt: 0, pages: [page], takeoffs: [priced] } as unknown as Project;
    const totals = computeTakeoffTotals(project, new Set(['p1']));
    const row = totals[0].pageBreakdown[0].measurements.find(r => r.id === 'm-wall')!;

    const s = summarizeSelection(page, page.measurements[0], null, [priced], totals);
    expect(s.total.dollars).toBe(formatWholeDollars(allocateSubsetCost(totals[0], row.realValue)));
    // 507.5 of 607.5 sq ft: 900 * 507.5/607.5 + 507.5 * 3.5 = 2528.09…
    expect(s.total.dollars).toBe('$2,528');

    // Every segment's $ (cutout negative) adds back up to the measurement's.
    const m = page.measurements[0];
    const segDollars = [-1, 0, 1].map(i => {
      const q = segmentPixelQuantity(m, measurementSegmentAt(m, i)!, 'area', scale);
      return prorateQuantityCost(totals[0], quantityInTakeoffUnits(q, { scale, takeoff: priced })!)!;
    });
    expect(segDollars.reduce((a, b) => a + b, 0)).toBeCloseTo(allocateSubsetCost(totals[0], row.realValue), 6);
  });
});
