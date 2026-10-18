// server/pdfMerge.ts
// Joins PDFs, or inserts chosen pages of one PDF into another. Pages are
// copied whole (pdf-lib copyPages), so page sizes, rotation and content stay
// as they were. Merge PDFs and Append pages both go through insertPages.
import { PDFDocument } from 'pdf-lib';

export class PdfMergeError extends Error {
  constructor(message: string, readonly index?: number) {
    super(message);
    this.name = 'PdfMergeError';
  }
}

/** Where the pages land in the target: the start, the end, or after page N (1-based, 0 = start). */
export type InsertPosition = 'start' | 'end' | { afterPage: number };

export interface InsertOptions {
  /** 1-based source pages, in the order they should land. Default: all pages. */
  pages?: number[];
  /** Default: 'end'. */
  position?: InsertPosition;
}

const load = async (bytes: Uint8Array, index?: number): Promise<PDFDocument> => {
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch {
    throw new PdfMergeError(index == null ? 'PDF could not be read' : `PDF ${index + 1} could not be read`, index);
  }
};

async function insertInto(target: PDFDocument, src: PDFDocument, opts: InsertOptions, index?: number): Promise<void> {
  const count = src.getPageCount();
  const pages = opts.pages ?? Array.from({ length: count }, (_, i) => i + 1);
  if (pages.length === 0) throw new PdfMergeError('Pick at least one page', index);
  for (const n of pages) {
    if (!Number.isInteger(n) || n < 1 || n > count) throw new PdfMergeError(`Page ${n} is not in the PDF (it has ${count})`, index);
  }
  const total = target.getPageCount();
  const pos = opts.position ?? 'end';
  let at: number;
  if (pos === 'start') at = 0;
  else if (pos === 'end') at = total;
  else {
    const a = pos.afterPage;
    if (!Number.isInteger(a) || a < 0 || a > total) throw new PdfMergeError(`Cannot insert after page ${a}: the target has ${total}`, index);
    at = a;
  }
  const copied = await target.copyPages(src, pages.map(n => n - 1));
  copied.forEach((p, i) => target.insertPage(at + i, p));
}

/** Inserts pages of `source` into `target` and returns the new PDF. */
export async function insertPages(target: Uint8Array, source: Uint8Array, opts: InsertOptions = {}): Promise<Buffer> {
  const doc = await load(target, 0);
  const src = await load(source, 1);
  await insertInto(doc, src, opts, 1);
  return Buffer.from(await doc.save());
}

/** Joins PDFs, all pages, in the order given. */
export async function mergePdfs(inputs: Uint8Array[]): Promise<Buffer> {
  if (inputs.length < 2) throw new PdfMergeError('Pick at least two PDFs to merge');
  const out = await PDFDocument.create();
  for (let i = 0; i < inputs.length; i++) {
    await insertInto(out, await load(inputs[i], i), { position: 'end' }, i);
  }
  return Buffer.from(await out.save());
}

/**
 * Reads "1-3, 5, 9-7" into [1,2,3,5,9,8,7] (1-based). Blank means every page.
 * Throws PdfMergeError for anything that is not a page or a range.
 */
export function parsePageRanges(text: string | undefined | null, pageCount: number, index?: number): number[] {
  const t = (text ?? '').trim();
  if (!t) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out: number[] = [];
  for (const part of t.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) throw new PdfMergeError(`"${part}" is not a page or a range like 2-4`, index);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) {
      throw new PdfMergeError(`Page ${a < 1 || a > pageCount ? a : b} is not in the PDF (it has ${pageCount})`, index);
    }
    const step = a <= b ? 1 : -1;
    for (let n = a; n !== b + step; n += step) out.push(n);
    if (out.length > 5000) throw new PdfMergeError('Too many pages picked', index);
  }
  return out;
}

export interface AppendSource {
  bytes: Uint8Array;
  /** Page list text such as "1-3, 5"; blank = all pages. */
  pages?: string;
}

/**
 * Append pages: puts chosen pages of each source into `target` at one spot.
 * Sources land in the order given, one after the other.
 */
export async function appendPages(target: Uint8Array, sources: AppendSource[], position: InsertPosition = 'end'): Promise<Buffer> {
  if (sources.length === 0) throw new PdfMergeError('Pick at least one PDF to add pages from');
  const doc = await load(target);
  let at: number;
  if (position === 'start') at = 0;
  else if (position === 'end') at = doc.getPageCount();
  else at = position.afterPage;
  for (let i = 0; i < sources.length; i++) {
    const src = await load(sources[i].bytes, i);
    const pages = parsePageRanges(sources[i].pages, src.getPageCount(), i);
    await insertInto(doc, src, { pages, position: { afterPage: at } }, i);
    at += pages.length;
  }
  return Buffer.from(await doc.save());
}
