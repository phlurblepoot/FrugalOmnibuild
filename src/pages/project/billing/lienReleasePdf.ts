// src/pages/project/billing/lienReleasePdf.ts
//
// A Florida release of lien as a letterhead PDF, built like the change order
// (changeOrderPdf.ts): jsPDF, Letter portrait, branded header and footer from
// src/utils/documentLetterhead.ts. All wording comes from lienReleaseWording.ts.
// Layout: title, the statutory body, the signature block, then
// the notary acknowledgment (printed on every release). Anything that does not
// fit continues on page 2 with the letterhead repeated.
import { jsPDF } from 'jspdf';
import {
  LetterheadContext,
  drawLetterheadHeader,
  drawLetterheadFooter,
} from '../../../utils/documentLetterhead';
import {
  type LienRelease, type Seg, type Para,
  lienReleaseTitle, lienReleaseParagraphs, lienReleaseSignatureLines, lienReleaseNotary,
  NOTARY_BOX,
} from './lienReleaseWording';

export interface LienReleasePdfContext {
  release: LienRelease;
  projectName: string;
  /** "Pay App #2" or "Invoice 1005" when the release was started from one. */
  sourceLabel?: string | null;
  /** Branded header/footer + brand accent colour. */
  letterhead: LetterheadContext;
  /** The user's saved signature (PNG/JPEG data URL), drawn on the By: line.
   *  Pass it only when the release has `signatureFileId` set. */
  signatureDataUrl?: string;
  /** When provided and non-empty, overrides the company email shown in the header. */
  headerEmail?: string;
}

interface Chunk { text: string; bold: boolean; fill: boolean; glue: boolean }
interface PlacedChunk { text: string; bold: boolean; fill: boolean; x: number; w: number; gapBefore: number }
type Line = PlacedChunk[];

const FONT = 'helvetica';

/** Split runs into chunks; a chunk with `glue` continues the chunk before it (no space between). */
function chunksOf(segs: Seg[]): (Chunk | 'nl')[] {
  const out: (Chunk | 'nl')[] = [];
  let pendingSpace = true;
  for (const s of segs) {
    for (const part of s.text.split(/(\n|[ \t]+)/)) {
      if (part === '') continue;
      if (part === '\n') { out.push('nl'); pendingSpace = true; continue; }
      if (/^[ \t]+$/.test(part)) { pendingSpace = true; continue; }
      out.push({ text: part, bold: !!s.bold, fill: !!s.fill, glue: !pendingSpace });
      pendingSpace = false;
    }
  }
  return out;
}

/** Word-wrap runs into lines of at most `width` points, at the given font size. */
function layoutRuns(doc: jsPDF, segs: Seg[], width: number, size: number): Line[] {
  doc.setFontSize(size);
  const measure = (text: string, bold: boolean) => {
    doc.setFont(FONT, bold ? 'bold' : 'normal');
    return doc.getTextWidth(text);
  };
  doc.setFont(FONT, 'normal');
  const space = doc.getTextWidth(' ');

  // Group glued chunks into words that must not be split across lines.
  const words: (Chunk[] | 'nl')[] = [];
  for (const c of chunksOf(segs)) {
    if (c === 'nl') { words.push('nl'); continue; }
    const last = words[words.length - 1];
    if (c.glue && Array.isArray(last)) last.push(c); else words.push([c]);
  }

  const lines: Line[] = [[]];
  let x = 0;
  for (const word of words) {
    if (word === 'nl') { lines.push([]); x = 0; continue; }
    const widths = word.map(c => measure(c.text, c.bold));
    const wordW = widths.reduce((a, b) => a + b, 0);
    let line = lines[lines.length - 1];
    let gap = line.length ? space : 0;
    if (line.length && x + gap + wordW > width) {
      line = [];
      lines.push(line);
      x = 0;
      gap = 0;
    }
    x += gap;
    word.forEach((c, i) => {
      line.push({ text: c.text, bold: c.bold, fill: c.fill, x, w: widths[i], gapBefore: i === 0 ? gap : 0 });
      x += widths[i];
    });
  }
  return lines;
}

export function buildLienReleasePdf(ctx: LienReleasePdfContext): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const M = 56;
  const textW = W - 2 * M;
  const lc: LetterheadContext = ctx.headerEmail
    ? { ...ctx.letterhead, company: { ...ctx.letterhead.company, email: ctx.headerEmail } }
    : ctx.letterhead;
  const [ar, ag, ab] = lc.brandRgb;
  const r = ctx.release;

  const top = drawLetterheadHeader(doc, lc);
  const bottom = drawLetterheadFooter(doc, lc);
  let y = top;
  const newPage = () => {
    doc.addPage();
    drawLetterheadHeader(doc, lc);
    drawLetterheadFooter(doc, lc);
    y = top;
  };
  const ensure = (h: number) => { if (y + h > bottom) newPage(); };

  const LINE_H = 13;
  const SIZE = 10.5;

  /** Draw wrapped lines at x0; page-breaks between lines. */
  const drawLines = (lines: Line[], x0: number, lineH: number, size: number) => {
    for (const line of lines) {
      ensure(lineH);
      let prevFillEnd: number | null = null;
      for (const c of line) {
        doc.setFont(FONT, c.bold ? 'bold' : 'normal').setFontSize(size).setTextColor(20, 20, 20);
        doc.text(c.text, x0 + c.x, y);
        if (c.fill) {
          doc.setDrawColor(20, 20, 20).setLineWidth(0.5);
          // Join the underline across the space between two filled words.
          const from = prevFillEnd !== null && c.gapBefore > 0 ? prevFillEnd : x0 + c.x;
          doc.line(from, y + 1.5, x0 + c.x + c.w, y + 1.5);
          prevFillEnd = x0 + c.x + c.w;
        } else {
          prevFillEnd = null;
        }
      }
      y += lineH;
    }
  };

  const drawPara = (p: Para) => {
    const lines = layoutRuns(doc, p.segs, textW, SIZE);
    // A condition or exceptions paragraph reads as one block.
    if (p.kind === 'condition' || p.kind === 'exceptions') ensure(Math.min(lines.length, 6) * LINE_H);
    drawLines(lines, M, LINE_H, SIZE);
    y += p.kind === 'body' ? 3 : 6;
  };

  // (1) Title (no reference line under the letterhead: owner feedback).
  y += 6;
  const [t1, t2] = lienReleaseTitle(r);
  doc.setFont(FONT, 'bold').setFontSize(15).setTextColor(ar, ag, ab);
  doc.text(t1, W / 2, y, { align: 'center' });
  y += 19;
  doc.text(t2, W / 2, y, { align: 'center' });
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y + 8, W - M, y + 8);
  y += 28;

  // (3) The release itself, up to and including the DATED line.
  for (const p of lienReleaseParagraphs(r)) drawPara(p);

  // (4) Signature block, kept together with the DATED line's page.
  const sig = lienReleaseSignatureLines(r);
  const SIG_H = 76;
  ensure(SIG_H);
  y += 8;
  doc.setFont(FONT, 'bold').setFontSize(SIZE).setTextColor(20, 20, 20);
  doc.text(sig.company, M, y);
  y += 26;
  const lineX2 = M + 250;
  if (ctx.signatureDataUrl) {
    try {
      const props = doc.getImageProperties(ctx.signatureDataUrl);
      const maxW = 170, maxH = 40;
      const scale = Math.min(maxW / props.width, maxH / props.height);
      const w = props.width * scale, h = props.height * scale;
      doc.addImage(ctx.signatureDataUrl, props.fileType, M + 24, y - 3 - h, w, h);
    } catch { /* skip a missing or bad signature image: the line stays blank */ }
  }
  doc.setFont(FONT, 'normal').setFontSize(SIZE).setTextColor(20, 20, 20);
  doc.text(sig.by, M, y);
  doc.setDrawColor(20, 20, 20).setLineWidth(0.6).line(M + 22, y + 1, lineX2, y + 1);
  y += 15;
  doc.text(sig.signer, M, y);
  y += 26;

  // (5) Notary acknowledgment (Fla. Stat. 695.25 short form), on every release.
  const notary = lienReleaseNotary(r);
  // helvetica has no ballot-box glyph; draw the statute's boxes as "[  ]" (non-breaking spaces, so a box never splits).
  const boxed = notary.text.map(s => ({ ...s, text: s.text.split(NOTARY_BOX).join('[\u00a0\u00a0]') }));
  const notaryLines = layoutRuns(doc, boxed, textW, 10);
  const NOTARY_H = notary.venue.length * 14 + 6 + notaryLines.length * 12.5 + 8 + notary.captions.length * 31;
  ensure(NOTARY_H);
  doc.setDrawColor(190, 190, 190).setLineWidth(0.5).line(M, y - 14, W - M, y - 14);
  doc.setFont(FONT, 'normal').setFontSize(10).setTextColor(20, 20, 20);
  for (const v of notary.venue) { doc.text(v, M, y); y += 14; }
  y += 6;
  drawLines(notaryLines, M, 12.5, 10);
  y += 8;
  const sigX = W / 2 - 20;
  for (const caption of notary.captions) {
    y += 18;
    doc.setDrawColor(20, 20, 20).setLineWidth(0.6).line(sigX, y, W - M, y);
    doc.setFont(FONT, 'normal').setFontSize(8).setTextColor(90, 90, 90);
    doc.text(caption, sigX, y + 9);
    y += 13;
  }

  return doc.output('arraybuffer') as unknown as Uint8Array;
}
