// src/utils/costAllocation.test.ts
// CHARACTERIZATION tests: these lock in what src/utils/costAllocation.ts does
// TODAY. The expected values were derived by running the real functions against
// each fixture; do not "fix" surprising behavior — assert the current output.
//
// These helpers were extracted verbatim from three byte-for-byte-identical
// inline copies in ProjectView (Excel export, desktop takeoffs table, mobile
// cards). The point of these tests is to guarantee the relocation is
// behavior-preserving for flat / yield / unit / amount_per_units allocations,
// mixed custom costs, and the non-advanced costPerUnit fallback.
import { describe, it, expect } from 'vitest';
import { allocateSubsetCost, allocateSubsetDetails } from './costAllocation';
import { TakeoffTotals, computeTakeoffTotals } from '../pages/project/proposal/proposalGenerator';
import type { Project } from '../types';

// Build a minimal TakeoffTotals fixture; only the fields the allocation
// functions read (isAdvancedCost, customCosts, totalRealValue, costPerUnit)
// matter, but we populate the rest so the structural type is satisfied.
const makeTakeoff = (overrides: Partial<TakeoffTotals>): TakeoffTotals => ({
  id: 't1',
  name: 'Takeoff',
  color: '#000000',
  type: 'area',
  unit: 'sq ft',
  totalRealValue: 0,
  pageBreakdown: [],
  ...overrides,
});

describe('allocateSubsetCost', () => {
  it('non-advanced takeoff falls back to costPerUnit * subsetValue', () => {
    const t = makeTakeoff({ isAdvancedCost: false, costPerUnit: 2.5, totalRealValue: 100 });
    // 40 * 2.5
    expect(allocateSubsetCost(t, 40)).toBe(100);
    // 100 * 2.5
    expect(allocateSubsetCost(t, 100)).toBe(250);
  });

  it('non-advanced takeoff with no costPerUnit returns 0', () => {
    const t = makeTakeoff({ isAdvancedCost: false, totalRealValue: 100 });
    expect(allocateSubsetCost(t, 40)).toBe(0);
  });

  it('flat advanced cost is prorated by subset share of total', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 100,
      customCosts: [{ id: 'c1', name: 'Mobilization', type: 'flat', cost: 500 }],
    });
    // 500 * (40 / 100)
    expect(allocateSubsetCost(t, 40)).toBe(200);
    // full total -> full flat cost
    expect(allocateSubsetCost(t, 100)).toBe(500);
  });

  it('flat advanced cost with zero total prorates to 0', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 0,
      customCosts: [{ id: 'c1', name: 'Mobilization', type: 'flat', cost: 500 }],
    });
    expect(allocateSubsetCost(t, 40)).toBe(0);
  });

  it('yield advanced cost = (subset / yield) * cost; guards zero/missing yield', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 1000,
      customCosts: [{ id: 'c1', name: 'Mud', type: 'yield', yield: 50, cost: 12 }],
    });
    // (500 / 50) * 12 = 120
    expect(allocateSubsetCost(t, 500)).toBe(120);

    const zeroYield = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 1000,
      customCosts: [{ id: 'c1', name: 'Mud', type: 'yield', yield: 0, cost: 12 }],
    });
    expect(allocateSubsetCost(zeroYield, 500)).toBe(0);
  });

  it('unit advanced cost = subset * costPerUnit', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 1000,
      customCosts: [{ id: 'c1', name: 'Tape', type: 'unit', costPerUnit: 0.15 }],
    });
    // 500 * 0.15 = 75
    expect(allocateSubsetCost(t, 500)).toBe(75);
  });

  it('amount_per_units advanced cost = (subset / perUnits) * amount; guards zero/missing perUnits', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 1000,
      customCosts: [{ id: 'c1', name: 'Screws', type: 'amount_per_units', perUnits: 100, amount: 8 }],
    });
    // (500 / 100) * 8 = 40
    expect(allocateSubsetCost(t, 500)).toBe(40);

    const zeroPer = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 1000,
      customCosts: [{ id: 'c1', name: 'Screws', type: 'amount_per_units', perUnits: 0, amount: 8 }],
    });
    expect(allocateSubsetCost(zeroPer, 500)).toBe(0);
  });

  it('sums multiple custom costs of mixed types', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 100,
      customCosts: [
        { id: 'c1', name: 'Mobilization', type: 'flat', cost: 500 },
        { id: 'c2', name: 'Mud', type: 'yield', yield: 50, cost: 12 },
        { id: 'c3', name: 'Tape', type: 'unit', costPerUnit: 0.15 },
        { id: 'c4', name: 'Screws', type: 'amount_per_units', perUnits: 100, amount: 8 },
      ],
    });
    // subset = 40, total = 100:
    //   flat:  500 * (40/100)        = 200
    //   yield: (40/50) * 12          = 9.6
    //   unit:  40 * 0.15             = 6
    //   apu:   (40/100) * 8          = 3.2
    //   sum                          = 218.8
    expect(allocateSubsetCost(t, 40)).toBeCloseTo(218.8, 10);
  });

  it('advanced takeoff without customCosts falls back to calculateTakeoffTotalCost (costPerUnit)', () => {
    const t = makeTakeoff({ isAdvancedCost: true, costPerUnit: 3, totalRealValue: 100 });
    // no customCosts -> falls through to math fallback: 40 * 3
    expect(allocateSubsetCost(t, 40)).toBe(120);
  });
});

describe('allocateSubsetDetails', () => {
  it('returns [] for non-advanced takeoffs', () => {
    const t = makeTakeoff({ isAdvancedCost: false, costPerUnit: 2.5, totalRealValue: 100 });
    expect(allocateSubsetDetails(t, 40)).toEqual([]);
  });

  it('returns [] for advanced takeoffs with no customCosts', () => {
    const t = makeTakeoff({ isAdvancedCost: true, totalRealValue: 100 });
    expect(allocateSubsetDetails(t, 40)).toEqual([]);
  });

  it('flat: cost prorated, quantity undefined', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 100,
      customCosts: [{ id: 'c1', name: 'Mobilization', type: 'flat', cost: 500, unit: 'ea' }],
    });
    const details = allocateSubsetDetails(t, 40);
    expect(details).toEqual([
      { id: 'c1', name: 'Mobilization', type: 'flat', cost: 500, unit: 'ea', costValue: 200, quantity: undefined, quantityUnit: 'ea' },
    ]);
  });

  it('yield: quantity = subset / yield, cost = quantity * cost', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 1000,
      customCosts: [{ id: 'c1', name: 'Mud', type: 'yield', yield: 50, cost: 12, unit: 'box' }],
    });
    const [d] = allocateSubsetDetails(t, 500);
    expect(d.quantity).toBe(10); // 500 / 50
    expect(d.costValue).toBe(120); // 10 * 12
    expect(d.quantityUnit).toBe('box');
  });

  it('unit: cost = subset * costPerUnit, quantity undefined', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 1000,
      customCosts: [{ id: 'c1', name: 'Tape', type: 'unit', costPerUnit: 0.15, unit: 'ft' }],
    });
    const [d] = allocateSubsetDetails(t, 500);
    expect(d.costValue).toBe(75); // 500 * 0.15
    expect(d.quantity).toBeUndefined();
  });

  it('amount_per_units: quantity = subset / perUnits, cost = quantity * amount', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 1000,
      customCosts: [{ id: 'c1', name: 'Screws', type: 'amount_per_units', perUnits: 100, amount: 8, unit: 'box' }],
    });
    const [d] = allocateSubsetDetails(t, 500);
    expect(d.quantity).toBe(5); // 500 / 100
    expect(d.costValue).toBe(40); // 5 * 8
  });

  it('produces one detail row per custom cost for mixed types', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 100,
      customCosts: [
        { id: 'c1', name: 'Mobilization', type: 'flat', cost: 500 },
        { id: 'c2', name: 'Mud', type: 'yield', yield: 50, cost: 12 },
        { id: 'c3', name: 'Tape', type: 'unit', costPerUnit: 0.15 },
        { id: 'c4', name: 'Screws', type: 'amount_per_units', perUnits: 100, amount: 8 },
      ],
    });
    const details = allocateSubsetDetails(t, 40);
    expect(details).toHaveLength(4);
    // Real (characterized) outputs — note yield carries IEEE-754 float drift:
    // (40/50) * 12 evaluates to 9.600000000000001, not a clean 9.6.
    expect(details.map(d => d.costValue)).toEqual([
      200,                // flat: 500 * 40/100
      9.600000000000001,  // yield: (40/50) * 12
      6,                  // unit: 40 * 0.15
      3.2,                // apu: (40/100) * 8
    ]);
    // quantity present only for yield + amount_per_units
    expect(details.map(d => d.quantity)).toEqual([undefined, 0.8, undefined, 0.4]);
  });

  it('detail cost sum matches allocateSubsetCost for mixed types', () => {
    const t = makeTakeoff({
      isAdvancedCost: true,
      totalRealValue: 100,
      customCosts: [
        { id: 'c1', name: 'Mobilization', type: 'flat', cost: 500 },
        { id: 'c2', name: 'Mud', type: 'yield', yield: 50, cost: 12 },
        { id: 'c3', name: 'Tape', type: 'unit', costPerUnit: 0.15 },
        { id: 'c4', name: 'Screws', type: 'amount_per_units', perUnits: 100, amount: 8 },
      ],
    });
    const detailSum = allocateSubsetDetails(t, 40).reduce((s, d) => s + d.costValue, 0);
    expect(detailSum).toBeCloseTo(allocateSubsetCost(t, 40), 10);
  });
});

// A multiplied measurement (× N) counts N times in its takeoff's total, and its
// row's realValue is that multiplied value — so the Takeoffs tab's page and
// measurement cost shares (these functions, unchanged) price it N times, flat
// costs included, and the shares still add up to the takeoff.
describe('cost shares of a multiplied measurement', () => {
  // 1 px = 1 ft: a 100 px line is 100 ft; Base counts × 3, Trim once.
  const project = {
    id: 'pr', name: 'Job', createdAt: 0, planSets: [],
    takeoffs: [{
      id: 't1', name: 'Base', color: '#000', type: 'length', unit: 'ft', isAdvancedCost: true,
      customCosts: [
        { id: 'c1', name: 'Mobilization', type: 'flat', cost: 400 },
        { id: 'c2', name: 'Labor', type: 'unit', costPerUnit: 2 },
      ],
    }],
    pages: [{
      id: 'p1', name: 'A-1', imageId: '', imageWidth: 0, imageHeight: 0,
      scaleConfig: { pixelDistance: 1, realWorldDistance: 1, unit: 'ft' },
      measurements: [
        { id: 'm1', type: 'length', name: 'Base', color: '#000', takeoffId: 't1', multiplier: 3, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { id: 'm2', type: 'length', name: 'Trim', color: '#000', takeoffId: 't1', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      ],
    }],
  } as unknown as Project;

  it('prices the measurement row at its multiplied quantity, flat share included', () => {
    const [t] = computeTakeoffTotals(project, new Set(['p1']));
    expect(t.totalRealValue).toBe(400);
    const [base, trim] = t.pageBreakdown[0].measurements;
    // 300 of 400 ft: 400 * 300/400 + 300 * 2
    expect(allocateSubsetCost(t, base.realValue)).toBe(900);
    // 100 of 400 ft: 400 * 100/400 + 100 * 2
    expect(allocateSubsetCost(t, trim.realValue)).toBe(300);
    expect(allocateSubsetCost(t, base.realValue) + allocateSubsetCost(t, trim.realValue))
      .toBeCloseTo(allocateSubsetCost(t, t.totalRealValue), 10);
  });
});
