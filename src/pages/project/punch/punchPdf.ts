// src/pages/project/punch/punchPdf.ts
import { jsPDF } from 'jspdf';
import {
  LetterheadContext,
  drawLetterheadHeader,
  drawLetterheadFooter,
} from '../../../utils/documentLetterhead';

export interface PunchReportItem { area: string; description: string; done: number | boolean; }
export interface PunchAreaGroup { area: string; items: PunchReportItem[]; done: number; total: number; }

// Pure data-shaping (unit-tested). Groups punch items by trimmed area name,
// alphabetically, with the Unassigned bucket forced last (sentinel space sorts
// after real names). Each group carries done/total counts for progress display.
export function groupByArea(items: PunchReportItem[]): PunchAreaGroup[] {
  const UNASSIGNED = '￿'; // sentinel for Unassigned (sorts last vs real names)
  const map = new Map<string, PunchReportItem[]>();
  for (const it of items) {
    const key = (it.area ?? '').trim() || UNASSIGNED;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(it);
  }
  return [...map.keys()].sort().map(key => {
    const list = map.get(key)!;
    return {
      area: key === UNASSIGNED ? 'Unassigned' : key,
      items: list,
      done: list.filter(i => !!i.done).length,
      total: list.length,
    };
  });
}

export interface PunchPdfContext {
  items: PunchReportItem[];
  projectName: string;
  photoDataUrls?: Record<string, string>; // fileId -> dataUrl (optional; pass {} to skip photos)
  /** Branded header/footer + brand accent colour (replaces the per-user UI accent). */
  letterhead: LetterheadContext;
  /** When provided and non-empty, overrides the company email shown in the document header. */
  headerEmail?: string;
}

// Builds the printable punch-list PDF. Draws the shared branded letterhead
// (header + footer on every page); body is the area-grouped checklist plus an
// optional photo grid. Every addImage is wrapped in try/catch so a corrupt or
// oversized image can never throw.
export function buildPunchPdf(ctx: PunchPdfContext): jsPDF {
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
  const ensure = (need: number) => {
    if (y + need > bottom) newPage();
  };

  // Title + date (body area, below the header)
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(ar, ag, ab);
  doc.text('PUNCH LIST', M, y + 8);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60, 60, 60);
  doc.text(new Date().toLocaleDateString(), W - M, y, { align: 'right' });
  y += 28;

  // Subheader: project name + overall progress
  const groups = groupByArea(ctx.items);
  const overallDone = groups.reduce((s, g) => s + g.done, 0);
  const overallTotal = groups.reduce((s, g) => s + g.total, 0);
  doc.setFontSize(10).setTextColor(30, 30, 30);
  doc.text(`Project: ${ctx.projectName}`, M, y); y += 14;
  doc.setTextColor(90, 90, 90);
  doc.text(`Progress: ${overallDone} of ${overallTotal} complete`, M, y); y += 8;
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y, W - M, y); y += 18;

  // Groups: area heading (with done/total) + checkbox-prefixed items
  for (const g of groups) {
    ensure(28);
    doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(ar, ag, ab);
    doc.text(`${g.area}  (${g.done}/${g.total})`, M, y); y += 16;

    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(30, 30, 30);
    for (const item of g.items) {
      const box = item.done ? '[x] ' : '[ ] ';
      const lines = doc.splitTextToSize(box + (item.description || '(no description)'), W - 2 * M);
      const need = lines.length * 14 + 4;
      ensure(need);
      doc.text(lines, M, y); y += need;
    }
    y += 8;
  }

  // Optional photo grid (2 per row). Every addImage wrapped in try/catch.
  const photoUrls = ctx.photoDataUrls ? Object.values(ctx.photoDataUrls) : [];
  if (photoUrls.length) {
    ensure(28);
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
    doc.text('Photos', M, y); y += 14;
    const cellW = (W - 2 * M - 12) / 2, cellH = 150;
    let col = 0;
    for (const url of photoUrls) {
      if (y + cellH > bottom) { newPage(); col = 0; }
      const x = M + col * (cellW + 12);
      try { doc.addImage(url, 'JPEG', x, y, cellW, cellH, undefined, 'FAST'); } catch { /* skip bad image */ }
      col++;
      if (col === 2) { col = 0; y += cellH + 12; }
    }
  }

  return doc;
}
