import { describe, it, expect } from 'vitest';
import { buildChangeOrderPdf, coRows, coTotalsBlock, scheduleImpactLabel } from './changeOrderPdf';
import { useTimeZone } from '../../../test/timeZone';

describe('change order pdf data shaping', () => {
  it('coRows maps lines to [desc, qty, unit, amount] display strings', () => {
    const rows = coRows([{ description: 'Extra outlets', qty: 3, unitPrice: 40 } as any]);
    expect(rows[0]).toEqual(['Extra outlets', '3', '$40.00', '$120.00']);
  });

  it('coRows tolerates missing/zero values', () => {
    const rows = coRows([{ description: '', qty: 0, unitPrice: 0 } as any]);
    expect(rows[0]).toEqual(['', '0', '$0.00', '$0.00']);
  });

  it('coTotalsBlock includes a lump-sum row when lump sum > 0', () => {
    // 3 × $40 = $120 lines + $50 lump sum = $170 total
    expect(coTotalsBlock(17000, 5000)).toEqual([
      ['Lump Sum', '$50.00'],
      ['Total', '$170.00'],
    ]);
  });

  it('coTotalsBlock omits the lump-sum row when lump sum is 0', () => {
    expect(coTotalsBlock(12000, 0)).toEqual([
      ['Total', '$120.00'],
    ]);
  });

  it('scheduleImpactLabel formats days (plural) and singular', () => {
    expect(scheduleImpactLabel(5)).toBe('Schedule impact: +5 days');
    expect(scheduleImpactLabel(1)).toBe('Schedule impact: +1 day');
  });

  it('scheduleImpactLabel returns empty when not set', () => {
    expect(scheduleImpactLabel(null)).toBe('');
    expect(scheduleImpactLabel(undefined)).toBe('');
  });
});

// The strings jsPDF drew (its content streams are uncompressed).
const pdfText = (bytes: Uint8Array): string[] =>
  [...Buffer.from(bytes).toString('latin1').matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)].map(m => m[1]);

describe('buildChangeOrderPdf — date, west of UTC', () => {
  useTimeZone('America/Los_Angeles');

  it('prints the day that was picked, not the day before', () => {
    const changeOrder = {
      id: 'co1', projectId: 'p1', number: '001', date: new Date('2026-10-01').getTime(), title: 'Extra wall',
      description: null, lumpSumAmount: 0, scheduleImpactDays: null, status: 'draft', version: 1,
      createdAt: 0, updatedAt: 0, amount: 0, lines: [], photos: [], attachments: [], totalCents: 0, lumpSumCents: 0,
    } as any;
    const letterhead = { brandRgb: [153, 203, 56] as [number, number, number], company: { name: 'Birchwood' } };
    const bytes = buildChangeOrderPdf({ changeOrder, projectName: 'Job', letterhead, photoDataUrls: [] });
    expect(pdfText(bytes)).toContain(`Date: ${new Date(2026, 9, 1).toLocaleDateString()}`);
  });
});
