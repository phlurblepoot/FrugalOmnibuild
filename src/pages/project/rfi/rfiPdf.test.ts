import { describe, it, expect } from 'vitest';
import { rfiHeading } from './rfiPdf';

describe('rfiHeading', () => {
  it('pads the number and joins the title', () => {
    expect(rfiHeading({ number: 7, title: 'Finish at column 5' })).toBe('RFI-007 · Finish at column 5');
  });
  it('handles a missing title', () => {
    expect(rfiHeading({ number: 12, title: null })).toBe('RFI-012 · (untitled)');
  });
});
