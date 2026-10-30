// What AI Scan sends for each page (never a preview thumbnail), and the scan
// loop that reads a set in order, carrying what earlier pages taught.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  fromPdf: vi.fn(),
  fromImage: vi.fn(),
  readSheet: vi.fn(),
}));
vi.mock('./pdf', () => ({ renderAiImagesFromSourcePdf: h.fromPdf, renderAiImagesFromImage: h.fromImage }));
vi.mock('./aiSheets', async orig => ({ ...(await orig<typeof import('./aiSheets')>()), readSheet: h.readSheet }));

import { aiReadInputFor, readPagesWithClaude } from './aiPageInput';

const QUARTERS = ['q1', 'q2', 'q3', 'q4'];

beforeEach(() => {
  h.fromPdf.mockReset().mockResolvedValue({ page: 'pdf-page', details: QUARTERS, layoutText: '[x 90%, y 95%, size 20] A-1' });
  h.fromImage.mockReset().mockResolvedValue({ page: 'img-page', details: QUARTERS });
  h.readSheet.mockReset();
});

describe('aiReadInputFor', () => {
  it('renders a stored PDF page at full size, with its large text and all its text', async () => {
    const input = await aiReadInputFor({ id: 'p', sourcePdfFileId: 'f1', sourcePdfPageNum: 3, extractedText: 'all text' }, undefined, new Map());
    expect(h.fromPdf).toHaveBeenCalledWith('/api/images/f1/raw', 3, expect.any(Map));
    expect(input).toEqual({ imageBase64: 'pdf-page', detailBase64s: QUARTERS, layoutText: '[x 90%, y 95%, size 20] A-1', embeddedText: 'all text' });
  });

  it('uses images from this upload when the PDF could not be stored', async () => {
    const input = await aiReadInputFor({ id: 'p' }, { page: 'up-page', details: ['d'] }, new Map());
    expect(input).toMatchObject({ imageBase64: 'up-page', detailBase64s: ['d'] });
    expect(h.fromPdf).not.toHaveBeenCalled();
  });

  it('cuts an older page\'s full-size stored image, not its thumbnail', async () => {
    const input = await aiReadInputFor({ id: 'p', imageId: 'img9' }, undefined, new Map());
    expect(h.fromImage).toHaveBeenCalledWith('/api/images/img9/raw');
    expect(input).toMatchObject({ imageBase64: 'img-page', detailBase64s: QUARTERS });
  });

  it('falls back from a PDF that will not render to the stored image', async () => {
    h.fromPdf.mockRejectedValue(new Error('bad pdf'));
    const input = await aiReadInputFor({ id: 'p', sourcePdfFileId: 'f1', sourcePdfPageNum: 1, imageId: 'img9' }, undefined, new Map());
    expect(input?.imageBase64).toBe('img-page');
  });

  it('gives nothing (rather than a thumbnail) when there is no full-size source', async () => {
    expect(await aiReadInputFor({ id: 'p' }, undefined, new Map())).toBeNull();
  });
});

describe('readPagesWithClaude', () => {
  const pages = [1, 2, 3].map(n => ({ id: `p${n}`, sourcePdfFileId: 'f', sourcePdfPageNum: n }));

  it('reads the first page alone, then passes later pages what the set taught', async () => {
    const contexts: unknown[] = [];
    h.readSheet.mockImplementation(async (input: any) => {
      contexts.push(input.setContext);
      const n = contexts.length;
      return n === 1
        ? { sheetNumber: '', sheetTitle: 'Cover Sheet', confidence: 0.7, setNotes: '' }
        : { sheetNumber: `A-10${n}`, sheetTitle: 'Floor Plan', confidence: 0.9, setNotes: 'Right strip.' };
    });
    const report = vi.fn();
    const { reads, noImage } = await readPagesWithClaude(pages, {}, report);
    expect(noImage).toBe(0);
    expect(reads.map(r => r?.sheetTitle)).toEqual(['Cover Sheet', 'Floor Plan', 'Floor Plan']);
    // The cover went alone and with nothing; the next page knew the cover was read.
    expect(contexts[0]).toBeUndefined();
    expect(contexts[1]).toEqual({ notes: undefined, sheets: [{ number: '', title: 'Cover Sheet' }] });
    expect(report).toHaveBeenLastCalledWith({ phase: 'scanning', done: 3, total: 3 });
  });

  it('carries notes forward once a page has given them', async () => {
    let n = 0;
    const contexts: any[] = [];
    h.readSheet.mockImplementation(async (input: any) => {
      contexts.push(input.setContext);
      n++;
      return { sheetNumber: `A-${n}`, sheetTitle: 'Plan', confidence: 0.9, setNotes: 'Bottom band, number at the right end.' };
    });
    // One at a time here, so each page sees the one before it.
    await readPagesWithClaude(pages.slice(0, 2), {}, vi.fn());
    expect(contexts[1].notes).toBe('Bottom band, number at the right end.');
    expect(contexts[1].sheets).toEqual([{ number: 'A-1', title: 'Plan' }]);
  });

  it('counts pages with no full-size image and does not send them', async () => {
    h.readSheet.mockResolvedValue({ sheetNumber: 'A-1', sheetTitle: 'Plan', confidence: 0.9 });
    const { reads, noImage } = await readPagesWithClaude([{ id: 'bare' }, pages[0]], {}, vi.fn());
    expect(noImage).toBe(1);
    expect(reads[0]).toBeNull();
    expect(h.readSheet).toHaveBeenCalledTimes(1);
  });
});
