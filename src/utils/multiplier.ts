// src/utils/multiplier.ts
// A length or area measurement can count more than once — "× 4" when one floor
// plan stands in for four identical floors. Every place that measures a
// measurement keeps its own maths and multiplies only the result; wherever one
// measurement's quantity is shown, the math is shown with it:
// "1250.00 sq ft × 4 = 5000.00 sq ft". Count markers never multiply.
import { Measurement } from '../types';

// What the multiplier input accepts: a whole number from 1 to 999.
export const MIN_MULTIPLIER = 1;
export const MAX_MULTIPLIER = 999;

// How many times a measurement counts: its multiplier when it is a length or
// area measurement with a whole number above 1, else 1 (a count marker, unset,
// or anything malformed).
export const measurementMultiplier = (m: Pick<Measurement, 'type' | 'multiplier'>): number => {
  if (m.type === 'count') return 1;
  const n = m.multiplier;
  return typeof n === 'number' && Number.isInteger(n) && n > 1 ? n : 1;
};

// The stored form of a chosen multiplier: 1 clears the field rather than
// storing a no-op.
export const multiplierPatch = (n: number): Pick<Measurement, 'multiplier'> => ({ multiplier: n > 1 ? n : undefined });

// The multiplier input as typed, or null unless it is a whole number in range.
export const parseMultiplierInput = (input: string): number | null => {
  const t = input.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  return n >= MIN_MULTIPLIER && n <= MAX_MULTIPLIER ? n : null;
};

export interface MultipliedText {
  /** "1250.00 sq ft × 4 =" — only when the multiplier is above 1. */
  math?: string;
  /** The value it counts for, formatted: "5000.00 sq ft". */
  total: string;
}

// A measured value and what it counts for, each worded by the formatter the
// caller already uses for that value.
export const multipliedText = (base: number, multiplier: number, format: (value: number) => string): MultipliedText =>
  multiplier > 1
    ? { math: `${format(base)} × ${multiplier} =`, total: format(base * multiplier) }
    : { total: format(base) };

// The same on one line: "1250.00 sq ft × 4 = 5000.00 sq ft", or just the
// formatted value at × 1.
export const formatMultiplied = (base: number, multiplier: number, format: (value: number) => string): string => {
  const t = multipliedText(base, multiplier, format);
  return t.math ? `${t.math} ${t.total}` : t.total;
};

// Merge folds measurements into one; a multiplier belongs to the whole
// measurement, so only measurements that count the same number of times merge.
export const multipliersMatch = (ms: Pick<Measurement, 'type' | 'multiplier'>[]): boolean =>
  ms.every(m => measurementMultiplier(m) === measurementMultiplier(ms[0]));
