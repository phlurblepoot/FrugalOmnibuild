// src/utils/money.test.ts
import { describe, it, expect } from 'vitest';
import { formatMoney, dollarsToCents, centsToDollars } from './money';

describe('money helpers', () => {
  it('formatMoney renders cents as USD', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(12550)).toBe('$125.50');
    expect(formatMoney(-3450)).toBe('-$34.50');
  });
  it('dollarsToCents rounds half-up and tolerates strings', () => {
    expect(dollarsToCents(10)).toBe(1000);
    expect(dollarsToCents('10.005')).toBe(1001);
    expect(dollarsToCents('')).toBe(0);
    expect(dollarsToCents(0.1 + 0.2)).toBe(30);
  });
  it('centsToDollars returns a number for form fields', () => {
    expect(centsToDollars(12550)).toBe(125.5);
  });
});
