import { jsPDF } from 'jspdf';
import { DailyReport } from '../../../utils/store';
import {
  LetterheadContext,
  drawLetterheadHeader,
  drawLetterheadFooter,
} from '../../../utils/documentLetterhead';
import { manCountLabel, weatherLine, formatReportDate, formatStartTime, manCountTotal } from './dailyReportForm';

// The crew comes before the job name: one date can hold a report per crew, and
// a long job name is what gets cut off at the end of the line.
export const dailyReportHeading = (r: { reportDate: string; jobName: string; crewName?: string | null }): string =>
  `Daily Report — ${formatReportDate(r.reportDate)}${r.crewName ? ' · ' + r.crewName : ''}${r.jobName ? ' · ' + r.jobName : ''}`;

// Strips characters illegal in filenames and collapses whitespace, so a
// project/job name can drop straight into a filename.
const sanitizeForFileName = (s: string): string =>
  s.replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '-');

// Spec letter: `DailyReport-<project>-<crew>-<date>.pdf` — the crew because
// one date can hold a report per crew. Each name part is left out when blank
// (`name` is optional), down to the date-only form.
export const dailyReportFileName = (r: { reportDate: string; crewName?: string | null }, name?: string): string => {
  const parts = [name ? sanitizeForFileName(name) : '', r.crewName ? sanitizeForFileName(r.crewName) : ''].filter(Boolean);
  return `DailyReport-${[...parts, r.reportDate].join('-')}.pdf`;
};

// The header's label/value rows. Start time only when the report has one —
// a report made before start times existed prints as it always did. The crew
// whenever its name is known.
export const dailyReportFieldRows = (r: Pick<DailyReport, 'jobName' | 'contractorName' | 'reportDate' | 'startTime'> & { crewName?: string | null }): Array<[string, string]> => [
  ['Job name:', r.jobName || ''],
  ['Contractor:', r.contractorName || ''],
  ...(r.crewName ? [['Crew:', r.crewName] as [string, string]] : []),
  ['Date:', formatReportDate(r.reportDate)],
  ...(r.startTime ? [['Start time:', formatStartTime(r.startTime)] as [string, string]] : []),
];

export interface DailyReportPdfContext {
  report: DailyReport;
  photoDataUrls: string[]; // pre-fetched (caller resolves each fileId → dataURL)
  letterhead: LetterheadContext;
  headerEmail?: string;
}

// Builds the Daily Report PDF and returns the bytes. Shared branded letterhead
// on every page; body is a fields block, weather, a two-column man-count/notes
// layout (each column's overflow queues as a continuation section), issues,
// then a photos grid. Structure copied from rfiPdf.ts.
export function buildDailyReportPdf(ctx: DailyReportPdfContext): ArrayBuffer {
  const { report } = ctx;
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

  // Remembers the current section label so a mid-section page break can
  // prefix the new page with "<Label> (continued)".
  let currentSectionLabel = '';
  const newPage = () => {
    doc.addPage();
    drawLetterheadHeader(doc, lc);
    drawLetterheadFooter(doc, lc);
    y = top;
    if (currentSectionLabel) {
      doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
      doc.text(`${currentSectionLabel} (continued)`, M, y); y += 14;
    }
  };

  const sectionLabel = (label: string) => {
    if (y + 28 > bottom) newPage();
    currentSectionLabel = label;
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
    doc.text(label, M, y); y += 14;
  };

  const paragraph = (text: string, size = 11) => {
    doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(30, 30, 30);
    const lines = doc.splitTextToSize(text, W - 2 * M) as string[];
    for (const line of lines) {
      if (y + 14 > bottom) { newPage(); doc.setFont('helvetica', 'normal').setFontSize(size).setTextColor(30, 30, 30); }
      doc.text(line, M, y); y += 14;
    }
    y += 12;
    currentSectionLabel = '';
  };

  // 1. Title + rule
  doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(ar, ag, ab);
  const titleLine = doc.splitTextToSize(dailyReportHeading(report), W - 2 * M)[0] ?? '';
  doc.text(titleLine, M, y); y += 10;
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y, W - M, y); y += 20;

  // 2. Fields block
  const fieldRows = dailyReportFieldRows(report);
  doc.setFontSize(11);
  const fieldValueW = W - M - (M + 90);
  for (const [label, value] of fieldRows) {
    doc.setFont('helvetica', 'bold').setTextColor(120, 120, 120);
    doc.text(label, M, y);
    doc.setFont('helvetica', 'normal').setTextColor(30, 30, 30);
    doc.text(doc.splitTextToSize(value, fieldValueW)[0] ?? '', M + 90, y);
    y += 16;
  }
  y += 8;

  // 3. Weather
  sectionLabel('Weather');
  paragraph(weatherLine(report.weatherSummary, report.temperature));
  const hourly = report.weatherHourly;
  if (hourly.length) {
    const stripH = 34;
    if (y + stripH > bottom) newPage();
    const full = (W - 2 * M) / hourly.length;
    const cells = full >= 36 ? hourly : hourly.filter((_, i) => i % 2 === 0);
    const cellW = Math.max((W - 2 * M) / cells.length, 36);
    let x = M;
    for (const h of cells) {
      const cx = x + cellW / 2;
      doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(120, 120, 120);
      doc.text(h.hour, cx, y, { align: 'center' });
      doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(30, 30, 30);
      doc.text(h.tempF != null ? `${h.tempF}°` : '—', cx, y + 12, { align: 'center' });
      doc.setFont('helvetica', 'normal').setFontSize(6).setTextColor(120, 120, 120);
      const cond = doc.splitTextToSize(h.condition || '', cellW)[0] ?? '';
      doc.text(cond, cx, y + 22, { align: 'center' });
      x += cellW;
    }
    y += stripH;
  }
  y += 8;

  // 4. Man count | Field notes, two columns
  const gutter = 24;
  const colW = (W - 2 * M - gutter) / 2;
  const leftX = M;
  const rightX = M + colW + gutter;
  const startY = y;
  let yL = startY;
  let yR = startY;
  const continued: { label: string; lines: string[] }[] = [];

  // Left column: Man count
  doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
  if (yL + 14 <= bottom) { doc.text('Man count', leftX, yL); yL += 16; }
  const manLines = report.manCounts.map(manCountLabel);
  const manRemainder: string[] = [];
  doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(30, 30, 30);
  for (let i = 0; i < manLines.length; i++) {
    if (yL < bottom) { doc.text(manLines[i], leftX, yL); yL += 12; }
    else manRemainder.push(manLines[i]);
  }
  const totalLine = `Total: ${manCountTotal(report.manCounts)} men`;
  if (manRemainder.length === 0 && yL < bottom) {
    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(30, 30, 30);
    doc.text(totalLine, leftX, yL); yL += 14;
  } else {
    manRemainder.push(totalLine);
  }
  if (manRemainder.length) continued.push({ label: 'Man count', lines: manRemainder });

  // Right column: Field notes
  doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
  if (yR + 14 <= bottom) { doc.text('Field notes', rightX, yR); yR += 16; }
  const noteLines = report.fieldNotes ? (doc.splitTextToSize(report.fieldNotes, colW) as string[]) : [];
  const noteRemainder: string[] = [];
  doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(30, 30, 30);
  for (let i = 0; i < noteLines.length; i++) {
    if (yR < bottom) { doc.text(noteLines[i], rightX, yR); yR += 14; }
    else noteRemainder.push(noteLines[i]);
  }
  if (noteRemainder.length) continued.push({ label: 'Field notes', lines: noteRemainder });

  y = Math.max(yL, yR) + 16;
  currentSectionLabel = '';

  // 5. Issues
  if (report.issues) {
    sectionLabel('Issues');
    paragraph(report.issues);
  }

  // 6. Continuation pages for overflowed columns
  for (const c of continued) {
    if (y + 28 > bottom) newPage();
    currentSectionLabel = c.label;
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(60, 60, 60);
    doc.text(`${c.label} (continued)`, M, y); y += 16;
    doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(30, 30, 30);
    for (const line of c.lines) {
      if (y + 14 > bottom) { newPage(); doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(30, 30, 30); }
      doc.text(line, M, y); y += 14;
    }
    y += 12;
    currentSectionLabel = '';
  }

  // 7. Photos grid (2 per row)
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

  return doc.output('arraybuffer');
}
