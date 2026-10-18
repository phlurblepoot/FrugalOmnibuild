import { jsPDF } from 'jspdf';
import { Invoice } from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { formatBillingDate } from '../../../utils/billingDates';
import {
  LetterheadContext,
  drawLetterheadHeader,
  drawLetterheadFooter,
} from '../../../utils/documentLetterhead';

const fmtQty = (n: number) => String(n);

// Pure data-shaping (unit-tested).
export const invoiceRows = (lines: Invoice['lines']): string[][] =>
  lines.map(l => [
    l.description || '',
    fmtQty(Number(l.qty) || 0),
    formatMoney(Math.round((Number(l.unitPrice) || 0) * 100)),
    formatMoney(Math.round((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) * 100)),
  ]);

export const invoiceTotalsBlock = (totalCents: number, paidCents: number): [string, string][] => [
  ['Total', formatMoney(totalCents)],
  ['Paid', formatMoney(paidCents)],
  ['Balance Due', formatMoney(totalCents - paidCents)],
];

// Resolve the app's accent color (configurable theme) to an RGB triple.
// Browsers compute the oklch CSS var to rgb() for a probe element's color.
export function resolveAccentRgb(): [number, number, number] {
  try {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-accent-600)';
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color; // "rgb(r, g, b)"
    document.body.removeChild(probe);
    const m = rgb.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  } catch { /* fall through */ }
  return [37, 99, 235]; // sane blue fallback
}

export interface InvoicePdfContext {
  invoice: Invoice;
  projectName: string;
  contractor?: string | null;
  address?: string | null;
  /** Branded header/footer + brand accent colour (replaces the per-user UI accent). */
  letterhead: LetterheadContext;
  /** pre-fetched (caller resolves each fileId → dataURL) — appended as pages
   *  after the totals/PAID stamp, same layout as change orders' photo section. */
  photoDataUrls?: string[];
  /** When provided and non-empty, overrides the company email shown in the document header. */
  headerEmail?: string;
}

export function buildInvoicePdf(ctx: InvoicePdfContext): Uint8Array {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const M = 48;
  const lc: LetterheadContext = ctx.headerEmail
    ? { ...ctx.letterhead, company: { ...ctx.letterhead.company, email: ctx.headerEmail } }
    : ctx.letterhead;
  const [ar, ag, ab] = lc.brandRgb; // brand accent for body rules/titles
  // Branded header + footer on the (single) page. Body starts below `top`.
  const top = drawLetterheadHeader(doc, lc);
  drawLetterheadFooter(doc, lc);
  let y = top;

  // Title + meta (body area, just below the header)
  doc.setFont('helvetica', 'bold').setFontSize(22).setTextColor(ar, ag, ab);
  doc.text('INVOICE', M, y + 8);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60, 60, 60);
  let metaY = y;
  doc.text(`No: ${ctx.invoice.number ?? ''}`, W - M, metaY, { align: 'right' }); metaY += 14;
  if (ctx.invoice.date) { doc.text(`Date: ${formatBillingDate(ctx.invoice.date)}`, W - M, metaY, { align: 'right' }); metaY += 14; }
  if (ctx.invoice.terms) { doc.text(`Terms: ${ctx.invoice.terms}`, W - M, metaY, { align: 'right' }); metaY += 14; }

  y = Math.max(y + 28, metaY) + 12;

  // Bill To
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(120, 120, 120);
  doc.text('BILL TO', M, y); y += 14;
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
  for (const line of [ctx.contractor, ctx.projectName, ctx.address].filter(Boolean)) {
    doc.text(String(line), M, y); y += 13;
  }
  y += 14;

  // Bottom limit for body content (above the footer banners).
  const bottom = drawLetterheadFooter(doc, lc);
  const newPage = () => {
    doc.addPage();
    drawLetterheadHeader(doc, lc);
    drawLetterheadFooter(doc, lc);
    y = top;
  };

  // Line table header
  const xQty = 320, xUnit = 396, xAmt = W - M;
  const drawTableHead = () => {
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(60, 60, 60);
    doc.text('DESCRIPTION', M, y);
    doc.text('QTY', xQty, y, { align: 'right' });
    doc.text('UNIT', xUnit, y, { align: 'right' });
    doc.text('AMOUNT', xAmt, y, { align: 'right' });
    y += 6;
    doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y, W - M, y);
    y += 16;
  };
  drawTableHead();

  // Rows
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
  for (const [desc, qty, unit, amount] of invoiceRows(ctx.invoice.lines)) {
    if (y + 18 > bottom) { newPage(); drawTableHead(); doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30); }
    doc.text(desc, M, y, { maxWidth: 260 });
    doc.text(qty, xQty, y, { align: 'right' });
    doc.text(unit, xUnit, y, { align: 'right' });
    doc.text(amount, xAmt, y, { align: 'right' });
    y += 18;
  }
  doc.setDrawColor(210, 210, 210).setLineWidth(0.5).line(M, y, W - M, y);
  y += 8;

  // Totals (bottom-right) — keep the whole totals block on one page.
  if (y + 90 > bottom) newPage();
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(xUnit - 20, y, W - M, y);
  y += 16;
  const totals = invoiceTotalsBlock(ctx.invoice.totalCents, ctx.invoice.paidCents);
  for (const [label, value] of totals) {
    const bold = label === 'Balance Due';
    doc.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(bold ? 12 : 10).setTextColor(30, 30, 30);
    doc.text(label, xUnit, y, { align: 'right' });
    doc.text(value, xAmt, y, { align: 'right' });
    y += bold ? 18 : 15;
  }

  // PAID stamp when fully paid
  if (ctx.invoice.totalCents > 0 && ctx.invoice.totalCents - ctx.invoice.paidCents === 0) {
    doc.setFont('helvetica', 'bold').setFontSize(56).setTextColor(22, 163, 74);
    doc.text('PAID', W / 2 - 40, y + 40, { angle: 18 });
  }

  // Photos appended as pages (fresh page after the totals/PAID stamp) — same
  // layout as change orders' photo section (changeOrderPdf.ts).
  const photoDataUrls = ctx.photoDataUrls ?? [];
  if (photoDataUrls.length) {
    newPage();
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
    doc.text('Photos', M, y); y += 14;
    const cellW = (W - 2 * M - 12) / 2, cellH = 150;
    let col = 0;
    for (const url of photoDataUrls) {
      if (y + cellH > bottom) { newPage(); col = 0; }
      const x = M + col * (cellW + 12);
      try { doc.addImage(url, 'JPEG', x, y, cellW, cellH, undefined, 'FAST'); } catch { /* skip bad image */ }
      col++;
      if (col === 2) { col = 0; y += cellH + 12; }
    }
  }

  return doc.output('arraybuffer') as unknown as Uint8Array;
}
