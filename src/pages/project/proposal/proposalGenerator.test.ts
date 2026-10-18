// src/pages/project/proposal/proposalGenerator.test.ts
// CHARACTERIZATION tests: lock in what the pure helpers in proposalGenerator.ts
// do TODAY.  Do not "fix" surprising behavior — assert the current output and
// comment where it differs from naive expectation.
import { describe, it, expect } from 'vitest';
import {
  hexToRgb,
  formatCurrency,
  dataUrlToUint8Array,
  HIGHLIGHT_QUALITY_PRESETS,
  computeTakeoffTotals,
} from './proposalGenerator';
import { computeRevisionModel } from '../../../utils/planSets';
import type { Project, ProjectPage } from '../../../types';

// ── hexToRgb ────────────────────────────────────────────────────────────────
// NOTE: hexToRgb returns 0-1 RGB components for pdf-lib's rgb(), NOT 0-255.
describe('hexToRgb', () => {
  it('#1e293b → correct fractional RGB', () => {
    // 0x1e=30, 0x29=41, 0x3b=59  →  /255 each
    const result = hexToRgb('#1e293b');
    expect(result.r).toBeCloseTo(30 / 255);
    expect(result.g).toBeCloseTo(41 / 255);
    expect(result.b).toBeCloseTo(59 / 255);
  });

  it('#ffffff → {r:1, g:1, b:1}', () => {
    const result = hexToRgb('#ffffff');
    expect(result.r).toBeCloseTo(1);
    expect(result.g).toBeCloseTo(1);
    expect(result.b).toBeCloseTo(1);
  });

  it('#000000 → {r:0, g:0, b:0}', () => {
    const result = hexToRgb('#000000');
    expect(result).toEqual({ r: 0, g: 0, b: 0 });
  });

  it('malformed input "xyz" → default blue fallback', () => {
    // characterization: regex /^#?([0-9a-f]{6})$/i does not match "xyz"
    // (only 3 non-hex chars), so the function returns the hard-coded default
    // { r: 0.231, g: 0.510, b: 0.965 }
    const result = hexToRgb('xyz');
    expect(result).toEqual({ r: 0.231, g: 0.510, b: 0.965 });
  });

  it('short-form "#fff" → default blue fallback', () => {
    // characterization: "#fff" is only 3 hex chars after the hash, regex
    // requires exactly 6, so the fallback fires — same as malformed input
    const result = hexToRgb('#fff');
    expect(result).toEqual({ r: 0.231, g: 0.510, b: 0.965 });
  });
});

// ── formatCurrency ───────────────────────────────────────────────────────────
describe('formatCurrency', () => {
  it('1234.5 → "$1,234.50"', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('0 → "$0.00"', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('-5 → "$-5.00"', () => {
    // characterization: toLocaleString produces "-5.00", prepend "$" → "$-5.00"
    expect(formatCurrency(-5)).toBe('$-5.00');
  });
});

// ── dataUrlToUint8Array ──────────────────────────────────────────────────────
describe('dataUrlToUint8Array', () => {
  it('decodes base64 "QUJD" (= "ABC") → [65, 66, 67]', () => {
    const dataUrl = 'data:application/pdf;base64,QUJD';
    const result = dataUrlToUint8Array(dataUrl);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([65, 66, 67]);
  });
});

// ── HIGHLIGHT_QUALITY_PRESETS ────────────────────────────────────────────────
// The old raster pipeline (Full/Large/Standard/Compact, maxDim/jpegQuality)
// was replaced by the vector pipeline's two live presets — see
// proposalGenerator.highlights.test.ts for the current preset + normalization
// coverage.
describe('HIGHLIGHT_QUALITY_PRESETS', () => {
  it('has keys: best, email', () => {
    const keys = Object.keys(HIGHLIGHT_QUALITY_PRESETS);
    expect(keys).toContain('best');
    expect(keys).toContain('email');
  });

  it.each(['best', 'email'] as const)(
    '%s preset has label (string)',
    (key) => {
      const preset = HIGHLIGHT_QUALITY_PRESETS[key];
      expect(typeof preset.label).toBe('string');
    }
  );
});

// ── computeTakeoffTotals: revision (sheetId) de-duplication ───────────────────
// Guards against the old double-counting bug: a sheet with multiple revisions
// (older + newer page sharing one sheetId) must contribute ONLY the current
// (newest) revision's measurements to the takeoff totals — never the sum of both.
describe('computeTakeoffTotals only counts the current living revision', () => {
  // Same fixture style as planSets.test.ts.
  const mkPage = (o: Partial<ProjectPage>): ProjectPage => ({
    id: 'p', name: '', pageNumber: '', description: '', imageId: '', thumbnailId: '',
    imageWidth: 0, imageHeight: 0, measurements: [], scaleConfig: null, ...o,
  } as ProjectPage);

  const mkProj = (pages: ProjectPage[], planSets: any[], takeoffs: any[]): Project => ({
    id: 'pr', name: 'x', createdAt: 0, pages, takeoffs, planSets,
  } as Project);

  it('two revisions of sheet A-101 sharing a sheetId count once (newest), not summed', () => {
    // 1:1 scale (100px = 100 ft) so a 100px polyline → 100 ft. Reused by both pages.
    const scaleConfig = { pixelDistance: 100, realWorldDistance: 100, unit: 'ft' } as any;
    // A real-enough length measurement on takeoff t1: two points 100px apart.
    const lengthMeasurement = (id: string) => ({
      id, type: 'length', name: id, color: '#000', takeoffId: 't1',
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    } as any);

    const sets = [
      { id: 's1', name: 'Set 1', createdAt: 1 },
      { id: 's2', name: 'Set 2', createdAt: 2 },
    ];
    // Older revision (planSet s1) carries a measurement on t1.
    const a1 = mkPage({
      id: 'a1', name: 'A-101 (rev 1)', sheetId: 'A', pageNumber: 'A-101',
      planSetId: 's1', scaleConfig, measurements: [lengthMeasurement('m-old')],
    });
    // Newer revision (planSet s2) — SAME sheetId — also carries a measurement on t1.
    const a2 = mkPage({
      id: 'a2', name: 'A-101 (rev 2)', sheetId: 'A', pageNumber: 'A-101',
      planSetId: 's2', scaleConfig, measurements: [lengthMeasurement('m-new')],
    });
    const takeoffs = [{ id: 't1', name: 'Wall', color: '#000', type: 'length', unit: 'ft' }];
    const project = mkProj([a1, a2], sets, takeoffs);

    // The consumer derives current pages exactly as the proposal section does.
    const currentPageIds = computeRevisionModel(project, '').currentPageIds;
    expect([...currentPageIds]).toEqual(['a2']); // sanity: only the newest revision is current

    const totals = computeTakeoffTotals(project, currentPageIds);
    const t1 = totals.find(t => t.id === 't1')!;

    // ROBUST CHECK: pageBreakdown references ONLY the current page id — never both.
    expect(t1.pageBreakdown.map(b => b.pageId)).toEqual(['a2']);
    expect(t1.pageBreakdown.map(b => b.pageId)).not.toContain('a1');

    // CORROBORATING CHECK: total equals a SINGLE revision's value (100 ft), not 200.
    const singleRevisionValue = t1.pageBreakdown[0].realValue;
    expect(t1.totalRealValue).toBeCloseTo(singleRevisionValue);
    expect(t1.totalRealValue).toBeCloseTo(100);
    // Explicitly not the double-counted sum of both revisions.
    expect(t1.totalRealValue).not.toBeCloseTo(200);
  });
});

// ── computeTakeoffTotals: subtract (cutout) segments net out of the area ──────
// A subtract segment on an area measurement (src/pages/project/proposal
// buildHighlightsPdf task 5, math.ts task 1's measurementAreaPx) must reduce
// the takeoff total, not just get drawn as a visual hole.
describe('computeTakeoffTotals nets subtract segments out of area totals', () => {
  // Same fixture style as the revision-dedup describe above.
  const mkPage = (o: Partial<ProjectPage>): ProjectPage => ({
    id: 'p', name: '', pageNumber: '', description: '', imageId: '', thumbnailId: '',
    imageWidth: 0, imageHeight: 0, measurements: [], scaleConfig: null, ...o,
  } as ProjectPage);

  const mkProj = (pages: ProjectPage[], takeoffs: any[]): Project => ({
    id: 'pr', name: 'x', createdAt: 0, pages, takeoffs, planSets: [],
  } as Project);

  it('10x10 px square with a 2x2 px subtract hole totals net (96-based)', () => {
    // 1:1 scale so px² reads directly as sq ft — isolates the area math from
    // unit conversion.
    const scaleConfig = { pixelDistance: 1, realWorldDistance: 1, unit: 'ft' } as any;
    const areaMeasurement = {
      id: 'm1', type: 'area', name: 'm1', color: '#000', takeoffId: 't1',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], // 100 px²
      segments: [{
        points: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }], // 4 px² hole
        subtract: true,
      }],
    } as any;
    const page = mkPage({ id: 'a1', scaleConfig, measurements: [areaMeasurement] });
    const takeoffs = [{ id: 't1', name: 'Slab', color: '#000', type: 'area', unit: 'sq ft' }];
    const project = mkProj([page], takeoffs);

    const totals = computeTakeoffTotals(project, new Set(['a1']));
    const t1 = totals.find(t => t.id === 't1')!;

    expect(t1.totalRealValue).toBeCloseTo(96);
  });
});

// ── computeTakeoffTotals: a measurement's multiplier ────────────────────────
// A length or area measurement with a multiplier (× N) counts N times in every
// total; its row keeps the measured baseValue and the multiplier so the
// Takeoffs tab, Excel and the rest can show the math. Count markers never
// multiply. Each measurement's own maths is unchanged — only its result is
// multiplied.
describe('computeTakeoffTotals multiplies a measurement by its multiplier', () => {
  const mkPage = (o: Partial<ProjectPage>): ProjectPage => ({
    id: 'p', name: '', pageNumber: '', description: '', imageId: '', thumbnailId: '',
    imageWidth: 0, imageHeight: 0, measurements: [], scaleConfig: null, ...o,
  } as ProjectPage);
  const mkProj = (pages: ProjectPage[], takeoffs: any[]): Project => ({
    id: 'pr', name: 'x', createdAt: 0, pages, takeoffs, planSets: [],
  } as Project);
  // 1 px = 1 ft, so px reads as ft and px² as sq ft.
  const scaleConfig = { pixelDistance: 1, realWorldDistance: 1, unit: 'ft' } as any;
  const line = (id: string, len: number, o: any = {}) => ({
    id, type: 'length', name: id, color: '#000', takeoffId: 't-len',
    points: [{ x: 0, y: 0 }, { x: len, y: 0 }], ...o,
  } as any);

  it('length: totals, the page breakdown and each row count the multiplied value', () => {
    const p1 = mkPage({ id: 'p1', name: 'A-1', scaleConfig, measurements: [line('m1', 100, { multiplier: 4 }), line('m2', 50)] });
    const p2 = mkPage({ id: 'p2', name: 'A-2', scaleConfig, measurements: [line('m3', 30, { multiplier: 2 })] });
    const project = mkProj([p1, p2], [{ id: 't-len', name: 'Base', color: '#000', type: 'length', unit: 'ft' }]);

    const [t] = computeTakeoffTotals(project, new Set(['p1', 'p2']));
    expect(t.totalRealValue).toBeCloseTo(100 * 4 + 50 + 30 * 2); // 510
    expect(t.pageBreakdown.map(pb => pb.realValue)).toEqual([450, 60]);
    expect(t.pageBreakdown[0].measurements).toEqual([
      { id: 'm1', name: 'm1', realValue: 400, unit: 'ft', baseValue: 100, multiplier: 4 },
      { id: 'm2', name: 'm2', realValue: 50, unit: 'ft', baseValue: 50, multiplier: 1 },
    ]);
    expect(t.pageBreakdown[1].measurements[0]).toMatchObject({ realValue: 60, baseValue: 30, multiplier: 2 });
  });

  it('area (net of its cutout) and a length priced as wall surface area both multiply', () => {
    const slab = {
      id: 'a1', type: 'area', name: 'Floor', color: '#000', takeoffId: 't-area', multiplier: 3,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }], // 100 sq ft
      segments: [{ points: [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }], subtract: true }], // −4
    } as any;
    // 20 ft run × 10 ft high = 200 sq ft of wall, × 2.
    const wall = { ...line('w1', 20, { multiplier: 2 }), takeoffId: 't-area', heights: [10, 10] };
    const page = mkPage({ id: 'p1', scaleConfig, measurements: [slab, wall] });
    const project = mkProj([page], [{ id: 't-area', name: 'Plaster', color: '#000', type: 'area', unit: 'sq ft' }]);

    const [t] = computeTakeoffTotals(project, new Set(['p1']));
    expect(t.totalRealValue).toBeCloseTo(96 * 3 + 200 * 2); // 688
    const [a, w] = t.pageBreakdown[0].measurements;
    expect(a).toMatchObject({ baseValue: 96, multiplier: 3 });
    expect(a.realValue).toBeCloseTo(288);
    expect(w).toMatchObject({ baseValue: 200, multiplier: 2, realValue: 400 });
  });

  it('a count marker counts once, even carrying a stray multiplier', () => {
    const marker = (id: string, o: any = {}) => ({ id, type: 'count', name: id, color: '#000', takeoffId: 't-c', points: [{ x: 1, y: 1 }], ...o } as any);
    const page = mkPage({ id: 'p1', scaleConfig, measurements: [marker('c1', { multiplier: 5 }), marker('c2')] });
    const project = mkProj([page], [{ id: 't-c', name: 'Outlets', color: '#000', type: 'count' }]);

    const [t] = computeTakeoffTotals(project, new Set(['p1']));
    expect(t.totalRealValue).toBe(2);
    expect(t.pageBreakdown[0].measurements[0]).toMatchObject({ realValue: 1, baseValue: 1, multiplier: 1 });
  });
});
