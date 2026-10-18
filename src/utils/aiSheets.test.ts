import { describe, it, expect } from 'vitest';
import { runWithConcurrency, applyReadToPage, applyMatchToPage, type AiPage } from './aiSheets';

describe('runWithConcurrency', () => {
  it('runs all items, never exceeding the limit, preserving order', async () => {
    let active = 0, maxActive = 0;
    const work = (n: number) => async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 3));
      active--; return n * 2;
    };
    const results = await runWithConcurrency([1, 2, 3, 4, 5].map(work), 2);
    expect(results).toEqual([2, 4, 6, 8, 10]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe('applyReadToPage', () => {
  const base: AiPage = { id: 'p1', name: 'Page 1', pageNumber: '', description: '', detectionConfidence: 'low' };
  it('fills number/description/name from a confident read', () => {
    const out = applyReadToPage(base, { sheetNumber: 'A-201', sheetTitle: 'Second Floor Plan', confidence: 0.9 });
    expect(out.pageNumber).toBe('A-201');
    expect(out.description).toBe('Second Floor Plan');
    expect(out.name).toBe('A-201 - Second Floor Plan');
    expect(out.aiConfidence).toBe(0.9);
    expect(out.detectionConfidence).toBe('high');
  });
  it('marks low detectionConfidence when the read is weak', () => {
    const out = applyReadToPage(base, { sheetNumber: 'A1', sheetTitle: '', confidence: 0.2 });
    expect(out.detectionConfidence).toBe('low');
  });
  it('leaves the page unchanged when the read is empty', () => {
    const out = applyReadToPage(base, { sheetNumber: '', sheetTitle: '', confidence: 0 });
    expect(out).toEqual(base);
  });
});

describe('applyMatchToPage', () => {
  const base: AiPage = { id: 'p1', name: 'A-201', pageNumber: 'A-201', description: '', detectionConfidence: 'high' };
  it('sets matchSheetId from a confident match', () => {
    expect(applyMatchToPage(base, { matchSheetId: 's2', confidence: 0.9 }).matchSheetId).toBe('s2');
  });
  it('sets New sheet ("") when the match is null', () => {
    expect(applyMatchToPage(base, { matchSheetId: null, confidence: 0.9 }).matchSheetId).toBe('');
  });
  it('does not override when confidence is below 0.5', () => {
    expect(applyMatchToPage(base, { matchSheetId: 's2', confidence: 0.3 }).matchSheetId).toBeUndefined();
  });
});
