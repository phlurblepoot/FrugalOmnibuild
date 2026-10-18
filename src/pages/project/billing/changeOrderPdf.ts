import { jsPDF } from 'jspdf';
import { ChangeOrder, ChangeOrderLine } from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { formatBillingDate } from '../../../utils/billingDates';
import {
  LetterheadContext,
  drawLetterheadHeader,
  drawLetterheadFooter,
} from '../../../utils/documentLetterhead';

const fmtQty = (n: number) => String(n);

// Pure data-shaping (unit-tested).
export const coRows = (lines: ChangeOrderLine[]): string[][] =>
  lines.map(l => [
    l.description || '',
    fmtQty(Number(l.qty) || 0),
    formatMoney(Math.round((Number(l.unitPrice) || 0) * 100)),
    formatMoney(Math.round((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * 100)),
  ]);

// Totals block: lump sum row (only when > 0) followed by the bold Total.
export const coTotalsBlock = (totalCents: number, lumpSumCents: number): [string, string][] => {
  const block: [string, string][] = [];
  if (lumpSumCents > 0) block.push(['Lump Sum', formatMoney(lumpSumCents)]);
  block.push(['Total', formatMoney(totalCents)]);
  return block;
};

// "Schedule impact: +N days" (singular for 1), or '' when not set.
export const scheduleImpactLabel = (days: number | null | undefined): string => {
  if (days === null || days === undefined) return '';
  const n = Number(days);
  if (!Number.isFinite(n)) return '';
  return `Schedule impact: +${n} day${Math.abs(n) === 1 ? '' : 's'}`;
};

export interface ChangeOrderPdfContext {
  changeOrder: ChangeOrder;
  projectName: string;
  contractor?: string | null;
  address?: string | null;
  /** Branded header/footer + brand accent colour (replaces the per-user UI accent). */
  letterhead: LetterheadContext;
  photoDataUrls: string[]; // pre-fetched (caller resolves each fileId → dataURL)
  /** When provided and non-empty, overrides the company email shown in the document header. */
  headerEmail?: string;
}

export function buildChangeOrderPdf(ctx: ChangeOrderPdfContext): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const M = 48;
  const lc: LetterheadContext = ctx.headerEmail
    ? { ...ctx.letterhead, company: { ...ctx.letterhead.company, email: ctx.headerEmail } }
    : ctx.letterhead;
  const [ar, ag, ab] = lc.brandRgb;
  const co = ctx.changeOrder;

  // Branded header + footer on the first page; body sits between top/bottom.
  const top = drawLetterheadHeader(doc, lc);
  const bottom = drawLetterheadFooter(doc, lc);
  let y = top;
  const newPage = () => {
    doc.addPage();
    drawLetterheadHeader(doc, lc);
    drawLetterheadFooter(doc, lc);
    y = top;
  };

  // (1) Title + meta (body area, below the header)
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(ar, ag, ab);
  doc.text('CHANGE ORDER REQUEST', M, y + 8);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60, 60, 60);
  let metaY = y;
  doc.text(`No: CO-${co.number ?? ''}`, W - M, metaY, { align: 'right' }); metaY += 14;
  if (co.date) { doc.text(`Date: ${formatBillingDate(co.date)}`, W - M, metaY, { align: 'right' }); metaY += 14; }
  const impact = scheduleImpactLabel(co.scheduleImpactDays);
  if (impact) { doc.text(impact, W - M, metaY, { align: 'right' }); metaY += 14; }

  y = Math.max(y + 28, metaY) + 12;

  // (2) Bill To
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(120, 120, 120);
  doc.text('BILL TO', M, y); y += 14;
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
  for (const line of [ctx.contractor, ctx.projectName, ctx.address].filter(Boolean)) {
    doc.text(String(line), M, y); y += 13;
  }
  y += 14;

  // (3) Description block (narrative, wrapped)
  if (co.description) {
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(120, 120, 120);
    doc.text('DESCRIPTION', M, y); y += 14;
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
    const lines = doc.splitTextToSize(co.description, W - 2 * M) as string[];
    for (const line of lines) {
      if (y + 13 > bottom) { newPage(); doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30); }
      doc.text(line, M, y); y += 13;
    }
    y += 14;
  }

  const xQty = 320, xUnit = 396, xAmt = W - M;

  // (4) Line-item table (only if any lines)
  if (co.lines.length) {
    const drawCoTableHead = () => {
      doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(60, 60, 60);
      doc.text('DESCRIPTION', M, y);
      doc.text('QTY', xQty, y, { align: 'right' });
      doc.text('UNIT', xUnit, y, { align: 'right' });
      doc.text('AMOUNT', xAmt, y, { align: 'right' });
      y += 6;
      doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y, W - M, y);
      y += 16;
    };
    if (y + 40 > bottom) newPage();
    drawCoTableHead();

    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
    for (const [desc, qty, unit, amount] of coRows(co.lines)) {
      if (y + 18 > bottom) { newPage(); drawCoTableHead(); doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30); }
      doc.text(desc, M, y, { maxWidth: 260 });
      doc.text(qty, xQty, y, { align: 'right' });
      doc.text(unit, xUnit, y, { align: 'right' });
      doc.text(amount, xAmt, y, { align: 'right' });
      y += 18;
    }
    doc.setDrawColor(210, 210, 210).setLineWidth(0.5).line(M, y, W - M, y);
    y += 8;
  }

  // (5) Lump sum + (6) Total (bottom-right) — keep the block together.
  if (y + 60 > bottom) newPage();
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(xUnit - 20, y, W - M, y);
  y += 16;
  for (const [label, value] of coTotalsBlock(co.totalCents, co.lumpSumCents)) {
    const bold = label === 'Total';
    doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(bold ? 12 : 10).setTextColor(30, 30, 30);
    doc.text(label, xUnit, y, { align: 'right' });
    doc.text(value, xAmt, y, { align: 'right' });
    y += bold ? 18 : 15;
  }
  y += 16;

  // (7) Signature / acceptance block
  if (y + 60 > bottom) newPage();
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
  doc.text('Accepted by (Owner): ______________________________    Date: ______________', M, y); y += 28;
  doc.text('Submitted by (Contractor): _________________________    Date: ______________', M, y); y += 18;

  // (8) Photos appended as pages (fresh page after the signature block).
  if (ctx.photoDataUrls.length) {
    newPage();
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
    doc.text('Photos', M, y); y += 14;
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
