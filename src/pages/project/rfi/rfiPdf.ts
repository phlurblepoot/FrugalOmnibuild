import { jsPDF } from 'jspdf';
import { Rfi } from '../../../utils/store';
import {
  LetterheadContext,
  drawLetterheadHeader,
  drawLetterheadFooter,
} from '../../../utils/documentLetterhead';

export const rfiHeading = (rfi: Pick<Rfi, 'number' | 'title'>): string =>
  `RFI-${String(rfi.number).padStart(3, '0')} · ${rfi.title || '(untitled)'}`;

export interface RfiPdfContext {
  rfi: Rfi;
  projectName: string;
  contractor?: string | null;
  photoDataUrls: string[]; // pre-fetched (caller resolves each fileId → dataURL)
  letterhead: LetterheadContext;
  headerEmail?: string;
}

// Builds the RFI PDF and returns the bytes. Shared branded letterhead on every
// page; body is a two-column info block, the question, the response (when
// answered), then a photos grid.
export function buildRfiPdf(ctx: RfiPdfContext): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const M = 48;
  const lc: LetterheadContext = ctx.headerEmail
    ? { ...ctx.letterhead, company: { ...ctx.letterhead.company, email: ctx.headerEmail } }
    : ctx.letterhead;
  const [ar, ag, ab] = lc.brandRgb;

  const top = drawLetterheadHeader(doc, lc);
  const bottom = drawLetterheadFooter(doc, lc);
  let y = top;
  const newPage = () => {
    doc.addPage();
    drawLetterheadHeader(doc, lc);
    drawLetterheadFooter(doc, lc);
    y = top;
  };

  // Title + date
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(ar, ag, ab);
  doc.text('REQUEST FOR INFORMATION', M, y + 8);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60, 60, 60);
  doc.text(new Date(ctx.rfi.createdAt).toLocaleDateString(), W - M, y, { align: 'right' });
  y += 28;

  // Two-column info block (skip empty rows). Left/right pairs.
  const fmtDate = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(`${iso}T00:00:00`);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };
  const rows: Array<[string, string]> = [
    ['RFI No.', `RFI-${String(ctx.rfi.number).padStart(3, '0')}`],
    ['Project', ctx.projectName],
    ...(ctx.contractor ? [['Contractor', ctx.contractor] as [string, string]] : []),
    ...(ctx.rfi.attention ? [['Attention', ctx.rfi.attention] as [string, string]] : []),
    ...(ctx.rfi.responseNeededBy ? [['Response needed by', fmtDate(ctx.rfi.responseNeededBy)] as [string, string]] : []),
    ...(ctx.rfi.specRef ? [['Spec reference', ctx.rfi.specRef] as [string, string]] : []),
    ...(ctx.rfi.drawingRef ? [['Drawing reference', ctx.rfi.drawingRef] as [string, string]] : []),
  ];
  const colW = (W - 2 * M) / 2;
  doc.setFontSize(10);
  rows.forEach((row, i) => {
    const col = i % 2, x = M + col * colW;
    doc.setFont('helvetica', 'bold').setTextColor(120, 120, 120);
    doc.text(`${row[0]}:`, x, y);
    doc.setFont('helvetica', 'normal').setTextColor(30, 30, 30);
    doc.text(doc.splitTextToSize(row[1], colW - 110)[0] ?? '', x + 105, y);
    if (col === 1 || i === rows.length - 1) y += 15;
  });
  y += 8;

  // Heading + rule + status
  doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(ar, ag, ab);
  doc.text(rfiHeading(ctx.rfi), M, y); y += 8;
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y, W - M, y); y += 18;
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(120, 120, 120);
  doc.text(`Status: ${ctx.rfi.status}`, M, y); y += 18;

  // Wrapped-paragraph helper with page breaks
  const paragraph = (text: string, size = 11) => {
    doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(30, 30, 30);
    const lines = doc.splitTextToSize(text, W - 2 * M) as string[];
    for (const line of lines) {
      if (y + 14 > bottom) { newPage(); doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(30, 30, 30); }
      doc.text(line, M, y); y += 14;
    }
    y += 12;
  };
  const sectionLabel = (label: string) => {
    if (y + 28 > bottom) newPage();
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
    doc.text(label, M, y); y += 14;
  };

  // Question
  if (ctx.rfi.question) {
    sectionLabel('Question');
    paragraph(ctx.rfi.question);
  }

  // Response (only when answered)
  if (ctx.rfi.responseText || ctx.rfi.responseFileId) {
    sectionLabel('Response');
    if (ctx.rfi.answeredAt) {
      doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(120, 120, 120);
      doc.text(`Answered ${new Date(ctx.rfi.answeredAt).toLocaleDateString()}`, M, y); y += 14;
    }
    if (ctx.rfi.responseText) paragraph(ctx.rfi.responseText);
    if (ctx.rfi.responseFileId) paragraph('Response received — see attached response document.', 10);
  }

  // Photos grid (2 per row)
  if (ctx.photoDataUrls.length) {
    sectionLabel('Photos');
    const cellW = (W - 2 * M - 12) / 2, cellH = 150;
    let col = 0;
    for (const url of ctx.photoDataUrls) {
      if (y + cellH > bottom) { newPage(); col = 0; }
      const x = M + col * (cellW + 12);
      try { doc.addImage(url, 'JPEG', x, y, cellW, cellH, undefined, 'FAST'); } catch { /* skip bad image */ }
      col++;
      if (col === 2) { col = 0; y += cellH + 12; }
    }
  }

  return doc.output('arraybuffer') as unknown as Uint8Array;
}
