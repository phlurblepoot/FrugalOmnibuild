// src/pages/project/issues/issuePdf.ts
import { jsPDF } from 'jspdf';
import { Issue } from '../../../utils/store';
import {
  LetterheadContext,
  drawLetterheadHeader,
  drawLetterheadFooter,
} from '../../../utils/documentLetterhead';

export const issueHeading = (issue: Pick<Issue, 'number' | 'title'>): string =>
  `ISS-${String(issue.number).padStart(3, '0')} · ${issue.title || '(untitled)'}`;

export interface IssuePdfContext {
  issue: Issue;
  projectName: string;
  contractor?: string | null;
  photoDataUrls: string[]; // pre-fetched (caller resolves each fileId → dataURL)
  /** Branded header/footer + brand accent colour (replaces the per-user UI accent). */
  letterhead: LetterheadContext;
  /** When provided and non-empty, overrides the company email shown in the document header. */
  headerEmail?: string;
}

// Builds the issue report PDF and returns the bytes. Draws the shared branded
// letterhead (header + footer on every page); body is the issue number / title /
// description; a photos grid follows.
export function buildIssuePdf(ctx: IssuePdfContext): Uint8Array {
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

  // Title + date (body area, below the header)
  doc.setFont('helvetica', 'bold').setFontSize(20).setTextColor(ar, ag, ab);
  doc.text('ISSUE REPORT', M, y + 8);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(60, 60, 60);
  doc.text(new Date(ctx.issue.createdAt).toLocaleDateString(), W - M, y, { align: 'right' });
  y += 28;

  // Project / contractor
  doc.setFontSize(10).setTextColor(30, 30, 30);
  for (const line of [`Project: ${ctx.projectName}`, ctx.contractor ? `Contractor: ${ctx.contractor}` : null].filter(Boolean)) {
    doc.text(String(line), M, y); y += 14;
  }
  y += 8;

  // Issue heading + status
  doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(ar, ag, ab);
  doc.text(issueHeading(ctx.issue), M, y); y += 8;
  doc.setDrawColor(ar, ag, ab).setLineWidth(1).line(M, y, W - M, y); y += 18;
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(120, 120, 120);
  doc.text(`Status: ${ctx.issue.status}`, M, y); y += 18;

  // Description
  if (ctx.issue.description) {
    doc.setFontSize(11).setTextColor(30, 30, 30);
    const lines = doc.splitTextToSize(ctx.issue.description, W - 2 * M) as string[];
    for (const line of lines) {
      if (y + 14 > bottom) { newPage(); doc.setFont('helvetica', 'normal').setFontSize(11).setTextColor(30, 30, 30); }
      doc.text(line, M, y); y += 14;
    }
    y += 12;
  }

  // Photos grid (2 per row)
  if (ctx.photoDataUrls.length) {
    if (y + 28 > bottom) newPage();
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
