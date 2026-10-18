// src/utils/multiplier.test.ts
// A length/area measurement can count more than once ("× 4"); count markers
// never do. The helpers read the multiplier, parse its input, word the math and
// decide which measurements may merge.
import { describe, it, expect } from 'vitest';
import {
  measurementMultiplier,
  multiplierPatch,
  parseMultiplierInput,
  multipliedText,
  formatMultiplied,
  multipliersMatch,
  MIN_MULTIPLIER,
  MAX_MULTIPLIER,
} from './multiplier';

describe('measurementMultiplier', () => {
  it('a length or area measurement counts its multiplier times', () => {
    expect(measurementMultiplier({ type: 'area', multiplier: 4 })).toBe(4);
    expect(measurementMultiplier({ type: 'length', multiplier: 2 })).toBe(2);
  });

  it('unset or 1 counts once', () => {
    expect(measurementMultiplier({ type: 'area' })).toBe(1);
    expect(measurementMultiplier({ type: 'length', multiplier: 1 })).toBe(1);
  });

  it('a count marker never multiplies, even with a stray multiplier', () => {
    expect(measurementMultiplier({ type: 'count', multiplier: 4 })).toBe(1);
  });

  it('anything malformed counts once', () => {
    expect(measurementMultiplier({ type: 'area', multiplier: 0 })).toBe(1);
    expect(measurementMultiplier({ type: 'area', multiplier: -3 })).toBe(1);
    expect(measurementMultiplier({ type: 'area', multiplier: 2.5 })).toBe(1);
    expect(measurementMultiplier({ type: 'area', multiplier: NaN })).toBe(1);
    expect(measurementMultiplier({ type: 'area', multiplier: '4' as unknown as number })).toBe(1);
  });
});

describe('multiplierPatch', () => {
  it('stores a multiplier above 1 and clears the field at 1', () => {
    expect(multiplierPatch(4)).toEqual({ multiplier: 4 });
    const cleared = multiplierPatch(1);
    expect(cleared).toHaveProperty('multiplier', undefined);
    // The key is present, so updateMeasurement's undo snapshot records the old value.
    expect(Object.keys(cleared)).toEqual(['multiplier']);
  });
});

describe('parseMultiplierInput', () => {
  it(`accepts whole numbers from ${MIN_MULTIPLIER} to ${MAX_MULTIPLIER}`, () => {
    expect(parseMultiplierInput('1')).toBe(1);
    expect(parseMultiplierInput(' 4 ')).toBe(4);
    expect(parseMultiplierInput('999')).toBe(999);
  });

  it('rejects zero, out of range, fractions, negatives and text', () => {
    for (const bad of ['', '0', '1000', '2.5', '-2', 'four', '4x', '1e2']) {
      expect(parseMultiplierInput(bad)).toBeNull();
    }
  });
});

describe('multipliedText / formatMultiplied', () => {
  const sqft = (v: number) => `${v.toFixed(2)} sq ft`;

  it('shows the math with the formatter the caller uses', () => {
    expect(multipliedText(1250, 4, sqft)).toEqual({ math: '1250.00 sq ft × 4 =', total: '5000.00 sq ft' });
    expect(formatMultiplied(1250, 4, sqft)).toBe('1250.00 sq ft × 4 = 5000.00 sq ft');
  });

  it('is just the value at × 1', () => {
    expect(multipliedText(1250, 1, sqft)).toEqual({ total: '1250.00 sq ft' });
    expect(formatMultiplied(1250, 1, sqft)).toBe('1250.00 sq ft');
  });

  it('keeps a deduction sign the formatter adds', () => {
    expect(formatMultiplied(12.5, 4, v => `−${sqft(v)}`)).toBe('−12.50 sq ft × 4 = −50.00 sq ft');
  });
});

describe('multipliersMatch (the merge rule)', () => {
  it('measurements that count the same number of times may merge', () => {
    expect(multipliersMatch([{ type: 'area', multiplier: 4 }, { type: 'area', multiplier: 4 }])).toBe(true);
    // Unset and 1 are the same: once.
    expect(multipliersMatch([{ type: 'length' }, { type: 'length', multiplier: 1 }])).toBe(true);
  });

  it('different multipliers may not', () => {
    expect(multipliersMatch([{ type: 'area', multiplier: 4 }, { type: 'area' }])).toBe(false);
    expect(multipliersMatch([{ type: 'area', multiplier: 2 }, { type: 'area', multiplier: 2 }, { type: 'area', multiplier: 3 }])).toBe(false);
  });
});
