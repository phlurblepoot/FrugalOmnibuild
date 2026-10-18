// src/utils/math.test.ts
// CHARACTERIZATION tests: these lock in what src/utils/math.ts does TODAY.
// Do not "fix" surprising behavior — assert the current output and comment.
import { describe, it, expect } from 'vitest';
import {
  calculateDistance,
  calculatePolylineLength,
  calculatePolygonArea,
  isPointInPolygon,
  calculateRealValue,
  calculateSurfaceAreaPx,
  convertUnit,
  calculateTakeoffTotalCost,
  calculateTakeoffCostDetails,
  roundUpTo100,
  evaluateMathExpression,
  parseFeetAndInches,
  formatFeetAndInches,
  formatRealValue,
  formatMeasurement,
  signedPolygonArea,
  measurementAreaPx,
  measurementRings,
} from './math';
import { Point, ScaleConfig, MeasurementTakeoff } from '../types';

describe('geometry & scale', () => {
  describe('calculateDistance', () => {
    it('3-4-5 right triangle', () => {
      expect(calculateDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    });
    it('identical points -> 0', () => {
      expect(calculateDistance({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
    });
  });

  describe('calculatePolylineLength', () => {
    it('two points', () => {
      expect(calculatePolylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBe(5);
    });
    it('L-shaped three points', () => {
      expect(
        calculatePolylineLength([
          { x: 0, y: 0 },
          { x: 0, y: 10 },
          { x: 10, y: 10 },
        ])
      ).toBe(20);
    });
    it('single point -> 0', () => {
      expect(calculatePolylineLength([{ x: 5, y: 5 }])).toBe(0);
    });
  });

  describe('calculatePolygonArea', () => {
    it('4x4 square = 16', () => {
      expect(
        calculatePolygonArea([
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 4, y: 4 },
          { x: 0, y: 4 },
        ])
      ).toBe(16);
    });
    it('triangle = 6', () => {
      expect(
        calculatePolygonArea([
          { x: 0, y: 0 },
          { x: 4, y: 0 },
          { x: 0, y: 3 },
        ])
      ).toBe(6);
    });
    it('fewer than 3 points -> 0', () => {
      expect(calculatePolygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }])).toBe(0);
    });
    it('reversed winding still 16 (abs)', () => {
      expect(
        calculatePolygonArea([
          { x: 0, y: 4 },
          { x: 4, y: 4 },
          { x: 4, y: 0 },
          { x: 0, y: 0 },
        ])
      ).toBe(16);
    });
  });

  describe('isPointInPolygon', () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    it('inside point -> true', () => {
      expect(isPointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    });
    it('outside point -> false', () => {
      expect(isPointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    });
    it('degenerate 2-point polygon -> false', () => {
      expect(
        isPointInPolygon({ x: 5, y: 5 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }])
      ).toBe(false);
    });
  });

  describe('calculateRealValue', () => {
    const scale: ScaleConfig = {
      pixelDistance: 50,
      realWorldDistance: 10,
      unit: 'ft',
    };
    it('length scales linearly', () => {
      expect(calculateRealValue(100, 'length', scale)).toBeCloseTo(20);
    });
    it('area scales by ratio squared', () => {
      expect(calculateRealValue(100, 'area', scale)).toBeCloseTo(4);
    });
    it('count returns pixel value unchanged', () => {
      expect(calculateRealValue(100, 'count', scale)).toBe(100);
    });
    it('null scale returns pixel value', () => {
      expect(calculateRealValue(100, 'length', null)).toBe(100);
    });
    it('zero pixelDistance returns pixel value', () => {
      expect(
        calculateRealValue(100, 'length', {
          pixelDistance: 0,
          realWorldDistance: 10,
          unit: 'ft',
        })
      ).toBe(100);
    });
  });

  describe('calculateSurfaceAreaPx', () => {
    const points: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const heights = [5, 5];
    const scale: ScaleConfig = {
      pixelDistance: 1,
      realWorldDistance: 1,
      unit: 'ft',
    };
    it('one-sided = 50', () => {
      expect(calculateSurfaceAreaPx(points, heights, false, scale)).toBe(50);
    });
    it('two-sided = 100', () => {
      expect(calculateSurfaceAreaPx(points, heights, true, scale)).toBe(100);
    });
    it('null scale -> 0', () => {
      expect(calculateSurfaceAreaPx(points, heights, false, null)).toBe(0);
    });
  });
});

describe('units & cost', () => {
  describe('convertUnit', () => {
    it('length ft -> in = 12', () => {
      expect(convertUnit(1, 'ft', 'in', 'length')).toBe(12);
    });
    it('length in -> ft = 1 (from 12)', () => {
      expect(convertUnit(12, 'in', 'ft', 'length')).toBe(1);
    });
    it('area ft -> in = 144', () => {
      expect(convertUnit(1, 'ft', 'in', 'area')).toBe(144);
    });
    it('same unit returns value', () => {
      expect(convertUnit(7, 'ft', 'ft', 'length')).toBe(7);
    });
    it('count type returns value unchanged', () => {
      expect(convertUnit(7, 'ft', 'in', 'count')).toBe(7);
    });
    it('unknown unit returns value unchanged', () => {
      expect(convertUnit(7, 'furlong', 'in', 'length')).toBe(7);
    });
    it('"sq ft" -> "sq in" area = 144 (sq prefix normalized)', () => {
      expect(convertUnit(1, 'sq ft', 'sq in', 'area')).toBe(144);
    });
  });

  const baseTakeoff: MeasurementTakeoff = {
    id: 't1',
    name: 'Test',
    color: '#000',
    type: 'area',
  };

  describe('calculateTakeoffTotalCost', () => {
    it('flat cost', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [{ id: 'c1', name: 'Flat', type: 'flat', cost: 100 }],
      };
      expect(calculateTakeoffTotalCost(t, 0)).toBe(100);
    });
    it('yield cost', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [{ id: 'c1', name: 'Y', type: 'yield', yield: 10, cost: 5 }],
      };
      expect(calculateTakeoffTotalCost(t, 100)).toBe(50);
    });
    it('yield of 0 -> 0', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [{ id: 'c1', name: 'Y', type: 'yield', yield: 0, cost: 5 }],
      };
      expect(calculateTakeoffTotalCost(t, 100)).toBe(0);
    });
    it('unit cost', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [{ id: 'c1', name: 'U', type: 'unit', costPerUnit: 2 }],
      };
      expect(calculateTakeoffTotalCost(t, 30)).toBe(60);
    });
    it('amount_per_units cost', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [
          { id: 'c1', name: 'A', type: 'amount_per_units', perUnits: 5, amount: 10 },
        ],
      };
      expect(calculateTakeoffTotalCost(t, 100)).toBe(200);
    });
    it('two costs sum (flat + unit)', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [
          { id: 'c1', name: 'Flat', type: 'flat', cost: 100 },
          { id: 'c2', name: 'U', type: 'unit', costPerUnit: 1 },
        ],
      };
      expect(calculateTakeoffTotalCost(t, 50)).toBe(150);
    });
    it('non-advanced uses costPerUnit', () => {
      const t: MeasurementTakeoff = { ...baseTakeoff, costPerUnit: 3 };
      expect(calculateTakeoffTotalCost(t, 10)).toBe(30);
    });
    it('empty takeoff -> 0', () => {
      const t: MeasurementTakeoff = { ...baseTakeoff };
      expect(calculateTakeoffTotalCost(t, 100)).toBe(0);
    });
  });

  describe('calculateTakeoffCostDetails', () => {
    it('advanced yield produces detail row', () => {
      const t: MeasurementTakeoff = {
        ...baseTakeoff,
        isAdvancedCost: true,
        customCosts: [
          { id: 'c1', name: 'Mud', type: 'yield', yield: 10, cost: 5, unit: 'bags' },
        ],
      };
      const details = calculateTakeoffCostDetails(t, 100);
      expect(details).toHaveLength(1);
      expect(details[0].costValue).toBe(50);
      expect(details[0].quantity).toBe(10);
      expect(details[0].quantityUnit).toBe('bags');
    });
    it('non-advanced returns []', () => {
      const t: MeasurementTakeoff = { ...baseTakeoff };
      expect(calculateTakeoffCostDetails(t, 100)).toEqual([]);
    });
  });

  describe('roundUpTo100', () => {
    it('0 -> 0', () => {
      expect(roundUpTo100(0)).toBe(0);
    });
    it('negative -> 0', () => {
      expect(roundUpTo100(-5)).toBe(0);
    });
    it('exact 100 -> 100', () => {
      expect(roundUpTo100(100)).toBe(100);
    });
    it('101 -> 200', () => {
      expect(roundUpTo100(101)).toBe(200);
    });
    it('250 -> 300', () => {
      expect(roundUpTo100(250)).toBe(300);
    });
  });
});

describe('parsing & formatting', () => {
  describe('evaluateMathExpression', () => {
    it('plain number string', () => {
      expect(evaluateMathExpression('5')).toBe(5);
    });
    it('addition expression', () => {
      expect(evaluateMathExpression('=2+3')).toBe(5);
    });
    it('multiplication expression', () => {
      expect(evaluateMathExpression('=10*2')).toBe(20);
    });
    it('percentage expression', () => {
      expect(evaluateMathExpression('=40%')).toBeCloseTo(0.4);
    });
    it('whitespace only -> null', () => {
      expect(evaluateMathExpression('   ')).toBeNull();
    });
    it('non-numeric -> null', () => {
      expect(evaluateMathExpression('abc')).toBeNull();
    });
    it('disallowed identifiers (=alert(1)) -> null', () => {
      expect(evaluateMathExpression('=alert(1)')).toBeNull();
    });
    it('incomplete expression (=2+) -> null', () => {
      // characterization: throws SyntaxError internally, caught -> null
      expect(evaluateMathExpression('=2+')).toBeNull();
    });
  });

  describe('formatFeetAndInches', () => {
    it('0 -> 0"', () => {
      expect(formatFeetAndInches(0)).toBe('0"');
    });
    it('1.5 -> 1\' - 6"', () => {
      expect(formatFeetAndInches(1.5)).toBe(`1' - 6"`);
    });
    it('0.03 ft -> sub-inch fraction "3/8\\""', () => {
      // characterization: 0.03 ft = 0.36 in, rounds to 6/16 = 3/8 inch
      expect(formatFeetAndInches(0.03)).toBe(`3/8"`);
    });
    it('0.5 ft -> 6"', () => {
      expect(formatFeetAndInches(0.5)).toBe(`6"`);
    });
  });

  describe('parseFeetAndInches', () => {
    it('plain "5" defaults to ft -> 5', () => {
      expect(parseFeetAndInches('5')).toBe(5);
    });
    it('"6" with default in -> 0.5 ft', () => {
      expect(parseFeetAndInches('6', 'in')).toBeCloseTo(0.5);
    });
    it('empty -> null', () => {
      expect(parseFeetAndInches('')).toBeNull();
    });
    it('feet+inches "5\' 6\\"" -> 5.5', () => {
      expect(parseFeetAndInches(`5' 6"`)).toBeCloseTo(5.5);
    });
    it('bare fraction "1/2" -> 0.5', () => {
      expect(parseFeetAndInches('1/2')).toBeCloseTo(0.5);
    });
    it('"3 1/2" default ft -> 3.5', () => {
      // characterization: whole+fraction treated as feet when no explicit units
      expect(parseFeetAndInches('3 1/2')).toBeCloseTo(3.5);
    });
  });

  describe('formatRealValue', () => {
    it('count rounds and labels "each"', () => {
      expect(formatRealValue(3.7, 'count', 'each')).toBe('4 each');
    });
    it('length in ft -> feet-and-inches', () => {
      // characterization: length ft routes through formatFeetAndInches
      expect(formatRealValue(10, 'length', 'ft')).toBe(`10' - 0"`);
    });
    it('area in ft -> "N.NN sq ft"', () => {
      expect(formatRealValue(10, 'area', 'ft')).toBe('10.00 sq ft');
    });
  });

  describe('formatMeasurement', () => {
    it('length with null scale -> px', () => {
      expect(formatMeasurement(12.5, 'length', null)).toBe('12.50 px');
    });
    it('area with null scale -> px²', () => {
      expect(formatMeasurement(12.5, 'area', null)).toBe('12.50 px²');
    });
    it('length with scale -> feet-and-inches', () => {
      const scale: ScaleConfig = {
        pixelDistance: 10,
        realWorldDistance: 5,
        unit: 'ft',
      };
      // characterization: 100px * (5/10) = 50 ft
      expect(formatMeasurement(100, 'length', scale)).toBe(`50' - 0"`);
    });
    it('area with scale -> sq ft', () => {
      const scale: ScaleConfig = {
        pixelDistance: 10,
        realWorldDistance: 5,
        unit: 'ft',
      };
      // characterization: 100px * (5/10)^2 = 25 sq ft
      expect(formatMeasurement(100, 'area', scale)).toBe('25.00 sq ft');
    });
  });

  describe('signedPolygonArea', () => {
    // On screen (y grows downward) this square winds clockwise, which is the
    // winding the shoelace formula scores positive.
    const screenCwSquare = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
    it('returns signed area (sign flips with winding)', () => {
      const a = signedPolygonArea(screenCwSquare);
      const b = signedPolygonArea([...screenCwSquare].reverse());
      expect(Math.abs(a)).toBe(16);
      expect(b).toBe(-a);
    });
    it('returns 0 for degenerate polygons', () => {
      expect(signedPolygonArea([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
    });
  });

  describe('measurementAreaPx', () => {
    const outer = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]; // 100
    const hole = [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }];      // 4

    it('sums plain measurements exactly like the old per-polygon sum', () => {
      expect(measurementAreaPx({ points: outer })).toBe(100);
      expect(measurementAreaPx({ points: outer, segments: [{ points: hole }] })).toBe(104);
    });
    it('subtract segments reduce the net area', () => {
      expect(measurementAreaPx({ points: outer, segments: [{ points: hole, subtract: true }] })).toBe(96);
    });
    it('multiple holes all deduct', () => {
      const hole2 = [{ x: 6, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 8 }, { x: 6, y: 8 }];
      expect(measurementAreaPx({
        points: outer,
        segments: [{ points: hole, subtract: true }, { points: hole2, subtract: true }],
      })).toBe(92);
    });
    it('clamps at 0 when holes exceed the parent', () => {
      const bigHole = [{ x: -10, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 20 }, { x: -10, y: 20 }]; // 900
      expect(measurementAreaPx({ points: outer, segments: [{ points: bigHole, subtract: true }] })).toBe(0);
    });
    it('hole winding direction does not matter (magnitudes subtract)', () => {
      expect(measurementAreaPx({ points: outer, segments: [{ points: [...hole].reverse(), subtract: true }] })).toBe(96);
    });
  });

  describe('measurementRings', () => {
    const outer = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const hole = [{ x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }];

    it('normalizes winding: additive rings positive, subtract rings negative', () => {
      const rings = measurementRings({
        points: [...outer].reverse(), // negative signed area — must be flipped
        segments: [{ points: hole, subtract: true }], // positive signed area — must be flipped
      });
      expect(rings).toHaveLength(2);
      expect(rings[0].subtract).toBe(false);
      expect(signedPolygonArea(rings[0].points)).toBeGreaterThan(0);
      expect(rings[1].subtract).toBe(true);
      expect(signedPolygonArea(rings[1].points)).toBeLessThan(0);
    });
    it('drops degenerate rings', () => {
      expect(measurementRings({ points: outer, segments: [{ points: [{ x: 0, y: 0 }] }] })).toHaveLength(1);
    });
  });
});
