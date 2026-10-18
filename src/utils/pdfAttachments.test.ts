// src/utils/pdfAttachments.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { jsPDF } from 'jspdf';

const h = vi.hoisted(() => ({ fetchFileBlob: vi.fn() }));
vi.mock('./store', () => ({ fetchFileBlob: h.fetchFileBlob }));

import { appendPdfAttachments, appendAttachedPdfs } from './pdfAttachments';

// Each page gets its own width so the merged document's page order can be read
// back: [base pages…, first attachment's…, second attachment's…].
const makePdf = async (widths: number[]) => {
  const d = await PDFDocument.create();
  for (const w of widths) d.addPage([w, 792]);
  return d.save();
};
const pageWidths = async (bytes: Uint8Array | ArrayBuffer) =>
  (await PDFDocument.load(bytes)).getPages().map(p => Math.round(p.getWidth()));
const toBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

beforeEach(() => { h.fetchFileBlob.mockReset(); });

describe('appendPdfAttachments', () => {
  it('merges attachment pages onto the end of the base document, in order', async () => {
    const out = await appendPdfAttachments(await makePdf([100]), [toBuffer(await makePdf([201, 202])), toBuffer(await makePdf([301, 302, 303]))]);
    expect(await pageWidths(out)).toEqual([100, 201, 202, 301, 302, 303]);
  });

  it('returns the base unchanged when there are no attachments', async () => {
    const base = await makePdf([100]);
    expect(await appendPdfAttachments(base, [])).toBe(base);
  });

  it('skips an unreadable attachment and keeps the rest', async () => {
    const garbage = new TextEncoder().encode('not a pdf').buffer as ArrayBuffer;
    const out = await appendPdfAttachments(await makePdf([100]), [garbage, toBuffer(await makePdf([201, 202]))]);
    expect(await pageWidths(out)).toEqual([100, 201, 202]); // garbage skipped, good merged
  });

  it('takes the ArrayBuffer a jsPDF generator hands back (its photo pages stay ahead of the attachments)', async () => {
    const doc = new jsPDF({ unit: 'pt', format: [100, 792] });
    doc.addPage([150, 792]); // stands in for a photos page
    const out = await appendPdfAttachments(doc.output('arraybuffer'), [toBuffer(await makePdf([201]))]);
    expect(await pageWidths(out)).toEqual([100, 150, 201]);
  });
});

describe('appendAttachedPdfs', () => {
  it('fetches each attached file and appends them in the order given', async () => {
    const files: Record<string, Uint8Array> = { a: await makePdf([201]), b: await makePdf([301, 302]) };
    h.fetchFileBlob.mockImplementation(async (id: string) => new Blob([files[id]], { type: 'application/pdf' }));
    const out = await appendAttachedPdfs(await makePdf([100]), [{ fileId: 'b' }, { fileId: 'a' }]);
    expect(h.fetchFileBlob.mock.calls.map(c => c[0])).toEqual(['b', 'a']);
    expect(await pageWidths(out)).toEqual([100, 301, 302, 201]);
  });

  it('skips a file that cannot be fetched and still builds the document', async () => {
    const good = await makePdf([201]);
    h.fetchFileBlob.mockImplementation(async (id: string) => {
      if (id === 'gone') throw new Error('404');
      return new Blob([good], { type: 'application/pdf' });
    });
    const out = await appendAttachedPdfs(await makePdf([100]), [{ fileId: 'gone' }, { fileId: 'ok' }]);
    expect(await pageWidths(out)).toEqual([100, 201]);
  });

  it('fetches nothing and returns the base when the record has no attachments', async () => {
    const base = await makePdf([100]);
    expect(await appendAttachedPdfs(base, [])).toBe(base);
    expect(h.fetchFileBlob).not.toHaveBeenCalled();
  });
});
