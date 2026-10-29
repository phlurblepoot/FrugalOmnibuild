import { describe, it, expect, vi, afterEach } from 'vitest';
import { runWithConcurrency, applyReadToPage, applyMatchToPage, readSheet, getLastAiError, aiScanSummary, type AiPage } from './aiSheets';

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

describe('readSheet errors and the scan summary', () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body }));
  afterEach(() => vi.unstubAllGlobals());

  it('says why reads failed and that the pages keep their names', async () => {
    respond(502, { error: 'Claude usage or rate limit reached.', code: 'rate_limit' });
    expect(await readSheet({ imageBase64: 'x' })).toBeNull();
    expect(getLastAiError()).toBe('Claude usage or rate limit reached.');
    expect(aiScanSummary(1, 3)).toEqual({
      message: 'Claude read 1 of 3 pages. Claude usage or rate limit reached. The other pages keep their names; you can use Extract (text/OCR) for them.',
      type: 'warning',
    });
    expect(aiScanSummary(0, 3).type).toBe('error');
  });

  it('a 503 means Claude is not connected', async () => {
    respond(503, { error: 'ai unavailable' });
    await readSheet({ imageBase64: 'x' });
    expect(getLastAiError()).toMatch(/not connected/);
  });

  it('a success clears the error', async () => {
    respond(200, { sheetNumber: 'A-1', sheetTitle: '', confidence: 1 });
    expect(await readSheet({ imageBase64: 'x' })).toMatchObject({ sheetNumber: 'A-1' });
    expect(getLastAiError()).toBeNull();
    expect(aiScanSummary(2, 2)).toEqual({ message: 'Claude read 2 of 2 pages.', type: 'success' });
  });
});
