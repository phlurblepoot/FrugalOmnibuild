// src/pages/project/ProjectBilling.test.tsx
import { describe, it, expect } from 'vitest';
import { lineCents, draftTotalCents } from './ProjectBilling';

describe('invoice draft math', () => {
  it('lineCents rounds a single line to cents', () => {
    expect(lineCents({ description: 'x', qty: 2.5, unitPrice: 4 })).toBe(1000);
    expect(lineCents({ description: 'x', qty: 1, unitPrice: 25.5 })).toBe(2550);
  });
  it('draftTotalCents sums lines with no float drift', () => {
    expect(draftTotalCents([
      { description: 'a', qty: 1, unitPrice: 0.1 },
      { description: 'b', qty: 1, unitPrice: 0.1 },
      { description: 'c', qty: 1, unitPrice: 0.1 },
    ])).toBe(30);
  });
});
