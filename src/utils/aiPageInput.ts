// What AI Scan sends Claude for one page. Always full-size images — the whole
// sheet at 1568 px and the sheet in quarters at twice the detail — never the
// 400 px preview thumbnail; plus, for PDF pages, the page's large text with
// where it sits and which way it is turned. Kept apart from aiSheets.ts so
// that module stays free of pdf.js.
import { getImageUrl } from './store';
import { renderAiImagesFromImage, renderAiImagesFromSourcePdf } from './pdf';
import { createSetMemory, readSheet, runWithConcurrency, type AiPageImages, type AiScanProgress, type SheetRead } from './aiSheets';

export interface AiReadInput {
  imageBase64: string;
  detailBase64s: string[];
  /** The page's large text with positions (see pdf.ts layoutTextOf). */
  layoutText?: string;
  /** All of the page's text (the same text search uses). */
  embeddedText?: string;
}

export interface AiInputPage {
  id: string;
  sourcePdfFileId?: string;
  sourcePdfPageNum?: number;
  imageId?: string;
  extractedText?: string;
}

/** One scan's open PDFs, shared by its pages. */
export type PdfCache = Map<string, Promise<any>>;

/**
 * The input for one page, best source first:
 *   1. the stored source PDF, rendered now (images plus the large text);
 *   2. images rendered during this upload (a page whose PDF could not be stored);
 *   3. an older page's full-size stored image.
 * Null when there is none: the page is reported as unread rather than sent blurry.
 */
export async function aiReadInputFor(page: AiInputPage, uploaded: AiPageImages | undefined, cache: PdfCache): Promise<AiReadInput | null> {
  const embeddedText = page.extractedText || undefined;
  if (page.sourcePdfFileId && page.sourcePdfPageNum) {
    try {
      const r = await renderAiImagesFromSourcePdf(getImageUrl(page.sourcePdfFileId), page.sourcePdfPageNum, cache);
      if (r.page) return { imageBase64: r.page, detailBase64s: r.details, layoutText: r.layoutText || undefined, embeddedText };
    } catch (err) {
      console.warn('AI Scan: could not render the source PDF page', err);
    }
  }
  if (uploaded?.page) return { imageBase64: uploaded.page, detailBase64s: uploaded.details, embeddedText };
  if (page.imageId) {
    try {
      const r = await renderAiImagesFromImage(getImageUrl(page.imageId));
      if (r.page) return { imageBase64: r.page, detailBase64s: r.details, embeddedText };
    } catch (err) {
      console.warn('AI Scan: could not load the stored page image', err);
    }
  }
  return null;
}

/**
 * Has Claude read every page, in order, as one set: the first page alone, so
 * the rest start from what it taught, then two at a time (the server reads one
 * at a time anyway; this just renders the next page while Claude reads).
 * `noImage` counts pages there was no full-size image of.
 */
export async function readPagesWithClaude(
  pages: AiInputPage[],
  uploaded: Record<string, AiPageImages>,
  report: (p: AiScanProgress) => void,
): Promise<{ reads: Array<SheetRead | null>; noImage: number }> {
  const cache: PdfCache = new Map();
  const memory = createSetMemory();
  const reads: Array<SheetRead | null> = new Array(pages.length).fill(null);
  let done = 0;
  let noImage = 0;
  report({ phase: 'scanning', done: 0, total: pages.length });
  const readOne = (i: number) => async () => {
    const input = await aiReadInputFor(pages[i], uploaded[pages[i].id], cache);
    if (!input) noImage++;
    const read = input ? await readSheet({ ...input, setContext: memory.context() }) : null;
    if (read) memory.learn(read);
    reads[i] = read;
    report({ phase: 'scanning', done: ++done, total: pages.length });
  };
  if (pages.length) await readOne(0)();
  await runWithConcurrency(pages.slice(1).map((_, i) => readOne(i + 1)), 2);
  return { reads, noImage };
}
