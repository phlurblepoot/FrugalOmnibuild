// src/pages/project/billing/aiaExcel.ts
//
// Faithful recreation of the AIA G702 (Application and Certificate for Payment)
// and G703 (Continuation Sheet) documents as a single .xlsx workbook (two
// sheets) built with exceljs. This is the DEFAULT export path.
//
// A separate "template-fill" export mode is intended to live beside this one in
// the future; keep `buildAiaWorkbook` a pure, side-effect-free builder so an
// alternate path (e.g. `buildAiaWorkbookFromTemplate`) can be added without
// touching the delivery plumbing (`buildAiaXlsxBlob` for callers that want the
// bytes, `exportAiaXlsx` for a straight save-to-disk).
//
// Money is stored as INTEGER CENTS everywhere; convert to dollars ONLY at the
// cell value (cents / 100) paired with a `$#,##0.00` number format.

// exceljs is LAZY-LOADED (dynamic import inside the build functions) so it
// stays out of the main bundle and only downloads when the user actually
// exports. Types are imported type-only (erased at build time).
import type ExcelJS from 'exceljs';
import type { AiaSettings, AiaPayApp, AiaSovLine, AiaG702, AiaG703Row } from '../../../utils/store';
import { lineTypeOf } from '../../../utils/store';
import { downloadBlob } from '../../../utils/download';

export interface AiaExportCtx {
  projectName: string;
  /** The project's general contractor — shown as "G. C." on G702 (distinct from
   *  the FROM company, which is the user's own company from settings). */
  contractor?: string;
  company: { name?: string; address?: string; phone?: string; email?: string; logoDataUrl?: string };
  aiaSettings: AiaSettings;
  app: AiaPayApp;
  sovLines: AiaSovLine[];
  g702: AiaG702;
  g703: AiaG703Row[];
}

// ---------------------------------------------------------------------------
// Template-fill mode — admin uploads their own AIA G702/G703 .xlsx and a cell
// mapping; we only SET values into the mapped cells, preserving the template's
// existing formatting, formulas, and any cells we don't touch.
// ---------------------------------------------------------------------------
export interface AiaTemplateMapping {
  g702Sheet: string; // worksheet name (or '1' / '' for the first sheet)
  cells: {
    ownerName?: string; ownerAddress?: string; projectName?: string;
    contractorName?: string; architectName?: string; contractFor?: string;
    applicationNo?: string; periodTo?: string; applicationDate?: string;
    contractDate?: string; ownerProjectNumber?: string; architectProjectNumber?: string;
    retainageWorkPct?: string; retainageStoredPct?: string;
    L1?: string; L2?: string; L3?: string; L4?: string;
    L5a?: string; L5b?: string; L5?: string; L6?: string; L7?: string; L8?: string; L9?: string;
    coAdditions?: string; coDeductions?: string; coNet?: string;
  };
  g703Sheet: string;
  g703StartRow: number; // first data row (1-based)
  g703Cols: {
    itemNo?: string; description?: string; scheduledValue?: string; previous?: string;
    thisPeriod?: string; stored?: string; total?: string; percent?: string;
    balance?: string; retainage?: string;
  };
  moneyAsDollars: boolean; // true → write cents/100 as a number
}

const MONEY_FMT = '$#,##0.00';
const PCT_FMT = '0%';

// Cents -> dollars; the single place the conversion happens.
const dollars = (cents: number): number => (cents || 0) / 100;

// Standard thin border on all four sides.
const THIN = { style: 'thin' as const };
const boxBorder = (): Partial<ExcelJS.Borders> => ({ top: THIN, left: THIN, bottom: THIN, right: THIN });

function setCell(
  ws: ExcelJS.Worksheet,
  addr: string,
  value: ExcelJS.CellValue,
  opts: {
    bold?: boolean;
    money?: boolean;
    pct?: boolean;
    border?: boolean;
    align?: 'left' | 'center' | 'right';
    wrap?: boolean;
    size?: number;
    fill?: string;
  } = {},
): ExcelJS.Cell {
  const cell = ws.getCell(addr);
  cell.value = value;
  if (opts.money) cell.numFmt = MONEY_FMT;
  if (opts.pct) cell.numFmt = PCT_FMT;
  cell.font = { bold: !!opts.bold, size: opts.size ?? 10, name: 'Arial' };
  if (opts.border) cell.border = boxBorder();
  cell.alignment = {
    horizontal: opts.align ?? (opts.money || opts.pct ? 'right' : 'left'),
    vertical: 'middle',
    wrapText: !!opts.wrap,
  };
  if (opts.fill) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
  }
  return cell;
}

// US Letter, landscape, every column fitted to the page width. `onePage`
// also fits the height (the G702 is one page); otherwise as many pages tall
// as the rows need (the G703). The owner's PDF rules (2026-09-26); Excel prints
// the same way, and the PDF ("Make PDF") is made from these settings.
function applyPageSetup(ws: ExcelJS.Worksheet, onePage: boolean): void {
  ws.pageSetup = {
    // Letter == 1; absent from exceljs's PaperSize enum (it lists non-default
    // sizes only), so cast the literal through the enum type.
    paperSize: 1 as unknown as ExcelJS.PaperSize, // Letter
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: onePage ? 1 : 0,
    margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
  };
}

/** The same rules on a sheet of an admin's own template, keeping its paper
 *  size and margins. */
function applyTemplatePageSetup(ws: ExcelJS.Worksheet, onePage: boolean): void {
  ws.pageSetup = { ...ws.pageSetup, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: onePage ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Dynamic G702/G703 builder — matches the standard AIA G702/G703 layout.
//
// Both sheets carry LIVE formulas (inputs in C/D/E/F, every G/H/I/J derived) so
// a GC can tweak the workbook in Excel and it recomputes, exactly like the
// template. The G703 contract section and the change-order section each scale
// to the actual number of lines: every TOTALS/GRAND-TOTAL SUM range and every
// G702→G703 cross-reference is computed from the list lengths, never hardcoded.
//
// RETAINAGE — effective rates, per ctx.g702.retainage (server-computed,
// post-release):
//
// - uniform mode: the template's ONE retainage rate cell `G702!G22` is
//   faithfully preserved, but it now holds the app's EFFECTIVE rate (base
//   minus cumulative released points), not the raw stored rate — every J
//   formula and G702 line 5/7 formula that reads G22 therefore already
//   reflects any releases with zero formula changes.
// - perLine mode: a single rate cell genuinely cannot represent per-line
//   rates, so G22 is repurposed to hold the (now-literal, dollar) 5b figure
//   and F22 the 5a figure — both taken straight from ctx.g702, which the
//   server already computed at each line's own effective rate. Line 5's
//   total (H22) becomes a formula summing those two literals instead of the
//   G703 cross-sheet SUM. G703's per-row J column stops referencing G22 (it
//   would no longer be a rate) and instead writes each row's already-correct
//   ctx.g703[].retainageCents as a literal — this is what closes the
//   single-rate-collapse gap for perLine projects. Line 7 (LESS PREVIOUS
//   CERTIFICATES) also can't use its old "prior cumulative x G22" trick once
//   G22 isn't a rate, so it's rewritten the same way: the server's already-
//   correct L7 value lands as a literal in an aux cell, referenced by a
//   trivial formula, so the sheet still "recalculates" from a literal input
//   rather than silently going wrong. Lines 6 and 8 need no changes — they
//   never depended on G22 directly.
// - The same literal L7 is used in UNIFORM mode whenever any retainage has
//   been released (cumulativeReleasedPoints > 0): the old formula assumes the
//   prior application billed at the rate G22 now holds, which is false the
//   moment G22 drops to the post-release effective rate. Uniform projects with
//   no releases keep the legacy formula byte-for-byte.
// ---------------------------------------------------------------------------

// Split a multi-line / comma-joined address into up to two display lines.
function splitAddress(address: string | undefined): [string, string] {
  const raw = (address ?? '').trim();
  if (!raw) return ['', ''];
  const parts = raw.includes('\n')
    ? raw.split(/\r?\n/)
    : raw.split(',');
  const line1 = (parts[0] ?? '').trim();
  const line2 = parts.slice(1).join(', ').trim();
  return [line1, line2];
}

// Computed dynamic row anchors for the G703 sheet, consumed by G702.
interface G703Anchors {
  contractStart: number; // first contract item row
  contractTotalRow: number; // contract TOTALS row
  coStart: number; // first change-order item row
  coTotalRow: number; // change-order TOTALS row
  grandRow: number; // GRAND TOTAL row
}

const COL_LETTERS = ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
const G703_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'] as const;

// ---------------------------------------------------------------------------
// G703 — Continuation Sheet (built FIRST; G702 references its dynamic rows).
// ---------------------------------------------------------------------------
function buildG703(wb: ExcelJS.Workbook, ctx: AiaExportCtx): G703Anchors {
  const ws = wb.addWorksheet('G703');
  applyPageSetup(ws, false); // as many pages as the rows need

  ws.columns = [
    { width: 11 }, // A item no
    { width: 37 }, // B description
    { width: 16 }, // C scheduled value
    { width: 14 }, // D previous applications
    { width: 13 }, // E this period
    { width: 16 }, // F materials stored
    { width: 16 }, // G total completed & stored
    { width: 14 }, // H % — also holds the "Application #:" header label on row 3
    { width: 14 }, // I balance to finish
    { width: 12 }, // J retainage
  ];

  const contract = ctx.g703.filter((row) => !row.isChangeOrder);
  const cos = ctx.g703.filter((row) => row.isChangeOrder);
  const perLine = ctx.g702.retainage.mode === 'perLine';

  // ── Header rows 1-5: company block + cross-refs back to G702 ──────────────
  const [coAddr1, coAddr2] = splitAddress(ctx.company.address);
  ws.mergeCells('A1:B1');
  setCell(ws, 'A1', 'CONTINUATION SHEET', { bold: true, size: 12 });
  setCell(ws, 'D1', 'AIA DOCUMENT G703', { bold: true, align: 'center', size: 9 });
  ws.mergeCells('D1:F1');

  setCell(ws, 'A2', ctx.company.name ?? '', { bold: true });
  setCell(ws, 'C2', 'PROJECT:', { bold: true });
  setCell(ws, 'D2', { formula: "'G702'!D3" });
  ws.mergeCells('D2:F2');

  setCell(ws, 'A3', coAddr1, {});
  setCell(ws, 'C3', 'GC:', { bold: true });
  setCell(ws, 'D3', { formula: "'G702'!D6" });
  ws.mergeCells('D3:F3');
  setCell(ws, 'H3', 'Application #:', { bold: true });
  setCell(ws, 'I3', { formula: "'G702'!H3" });

  setCell(ws, 'A4', coAddr2, {});
  setCell(ws, 'H4', 'Period From:', { bold: true });
  setCell(ws, 'I4', { formula: "'G702'!H5" });

  setCell(ws, 'H5', 'Period To:', { bold: true });
  setCell(ws, 'I5', { formula: "'G702'!H6" });

  // ── Row 6: decorative AIA column-letter row ───────────────────────────────
  const letterRow = (rowNum: number): void => {
    G703_COLS.forEach((col, i) => {
      setCell(ws, `${col}${rowNum}`, COL_LETTERS[i], { align: 'center', size: 8, border: true });
    });
  };
  letterRow(6);

  // ── Rows 7-10: tall merged column header ──────────────────────────────────
  const headerLabels: [string, string][] = [
    ['A', 'ITEM NO.'],
    ['B', 'DESCRIPTION OF WORK'],
    ['C', 'SCHEDULED VALUES'],
    ['D', 'PREVIOUS APPLICATIONS (D + E)'],
    ['E', 'THIS PERIOD'],
    ['F', 'MATERIALS PRESENTLY STORED (NOT IN D OR E)'],
    ['G', 'TOTAL COMPLETED AND STORED TO DATE (D+E+F)'],
    ['H', '% (G/C)'],
    ['I', 'BALANCE TO FINISH (C-G)'],
    ['J', 'RETAINAGE'],
  ];
  const writeColumnHeader = (topRow: number): void => {
    for (let rr = topRow; rr <= topRow + 3; rr++) ws.getRow(rr).height = 14;
    for (const [col, label] of headerLabels) {
      ws.mergeCells(`${col}${topRow}:${col}${topRow + 3}`);
      setCell(ws, `${col}${topRow}`, label, {
        bold: true, border: true, align: 'center', wrap: true, size: 8, fill: 'FFE7E6E6',
      });
    }
  };
  writeColumnHeader(7);

  // ── Per-row writer: inputs C/D/E/F, formulas G/H/I/J ──────────────────────
  const writeItemRow = (rowNum: number, row: AiaG703Row, seq: number): void => {
    const type = lineTypeOf(row);
    if (type === 'blank') {
      for (const col of G703_COLS) setCell(ws, `${col}${rowNum}`, '', { border: true });
      return;
    }
    if (type === 'header') {
      // Label only: description in bold, every money/formula column empty.
      // The section SUMs skip empty cells, so anchors and G702 refs are unchanged.
      setCell(ws, `A${rowNum}`, row.itemNo ?? '', { border: true, align: 'center' });
      setCell(ws, `B${rowNum}`, row.description, { border: true, wrap: true, bold: true });
      for (const col of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) setCell(ws, `${col}${rowNum}`, '', { border: true });
      return;
    }
    setCell(ws, `A${rowNum}`, row.itemNo ?? seq, { border: true, align: 'center' });
    setCell(ws, `B${rowNum}`, row.description, { border: true, wrap: true });
    setCell(ws, `C${rowNum}`, dollars(row.scheduledValueCents), { money: true, border: true });
    setCell(ws, `D${rowNum}`, dollars(row.previousCents), { money: true, border: true });
    setCell(ws, `E${rowNum}`, dollars(row.thisPeriodCents), { money: true, border: true });
    setCell(ws, `F${rowNum}`, dollars(row.storedCents), { money: true, border: true });
    setCell(ws, `G${rowNum}`, { formula: `D${rowNum}+E${rowNum}+F${rowNum}` }, { money: true, border: true });
    setCell(ws, `H${rowNum}`, { formula: `IFERROR(G${rowNum}/C${rowNum},0)` }, { border: true, align: 'center' }).numFmt = '0.00%';
    setCell(ws, `I${rowNum}`, { formula: `C${rowNum}-G${rowNum}` }, { money: true, border: true });
    if (perLine) {
      // A single rate cell can't represent per-line rates — write the row's
      // already-correct effective retainage (computed server-side) as a
      // literal instead of deriving it from 'G702'!$G$22.
      setCell(ws, `J${rowNum}`, dollars(row.retainageCents), { money: true, border: true });
    } else {
      setCell(ws, `J${rowNum}`, { formula: `SUM(D${rowNum}:E${rowNum})*'G702'!$G$22` }, { money: true, border: true });
    }
  };

  // ── Totals-row writer for a section (sum over [first..last]) ───────────────
  const writeSectionTotals = (totalRow: number, first: number, last: number): void => {
    setCell(ws, `A${totalRow}`, '', { border: true });
    setCell(ws, `B${totalRow}`, 'TOTALS', { bold: true, border: true });
    for (const col of ['C', 'D', 'E', 'F', 'G', 'I', 'J']) {
      const ref = last >= first ? `SUM(${col}${first}:${col}${last})` : '0';
      setCell(ws, `${col}${totalRow}`, { formula: ref }, { money: true, bold: true, border: true });
    }
    setCell(ws, `H${totalRow}`, { formula: `IFERROR(G${totalRow}/C${totalRow},0)` }, { bold: true, border: true, align: 'center' }).numFmt = '0.00%';
  };

  // ── Contract section ──────────────────────────────────────────────────────
  const contractStart = 11;
  let itemSeq = 0;
  contract.forEach((row, i) => writeItemRow(contractStart + i, row, lineTypeOf(row) === 'item' ? ++itemSeq : 0));
  const contractTotalRow = contractStart + contract.length;
  writeSectionTotals(contractTotalRow, contractStart, contractTotalRow - 1);

  // ── Change-order section ──────────────────────────────────────────────────
  const coLabelRow = contractTotalRow + 2;
  // It starts on a new page when printed (and in the PDF).
  ws.getRow(coLabelRow - 1).addPageBreak();
  setCell(ws, `B${coLabelRow}`, 'Change Orders', { bold: true });
  const coLetterRow = coLabelRow + 1;
  letterRow(coLetterRow);
  const coHeaderTop = coLetterRow + 1;
  writeColumnHeader(coHeaderTop);
  const coStart = coHeaderTop + 4;
  itemSeq = 0;
  cos.forEach((row, i) => writeItemRow(coStart + i, row, lineTypeOf(row) === 'item' ? ++itemSeq : 0));
  const coTotalRow = coStart + cos.length;
  writeSectionTotals(coTotalRow, coStart, coTotalRow - 1);

  // ── Grand total = contract TOTALS + CO TOTALS, per column ──────────────────
  const grandRow = coTotalRow + 1;
  setCell(ws, `A${grandRow}`, '', { border: true });
  setCell(ws, `B${grandRow}`, 'GRAND TOTAL', { bold: true, border: true });
  for (const col of ['C', 'D', 'E', 'F', 'G', 'I', 'J']) {
    setCell(ws, `${col}${grandRow}`, { formula: `${col}${contractTotalRow}+${col}${coTotalRow}` }, { money: true, bold: true, border: true });
  }
  setCell(ws, `H${grandRow}`, { formula: `IFERROR(G${grandRow}/C${grandRow},0)` }, { bold: true, border: true, align: 'center' }).numFmt = '0.00%';

  return { contractStart, contractTotalRow, coStart, coTotalRow, grandRow };
}

// ---------------------------------------------------------------------------
// G702 — Application and Certificate for Payment (uses G703's dynamic rows).
// ---------------------------------------------------------------------------
function buildG702(ws: ExcelJS.Worksheet, ctx: AiaExportCtx, g: G703Anchors): void {
  applyPageSetup(ws, true); // all on one page

  ws.columns = [
    { width: 12 }, // A
    { width: 35 }, // B
    { width: 18 }, // C
    { width: 14 }, // D
    { width: 20 }, // E
    { width: 12 }, // F
    { width: 16 }, // G — holds the "APPLICATION NO:" / "PERIOD FROM:" labels
    { width: 18 }, // H
  ];

  const a = ctx.aiaSettings;
  const app = ctx.app;
  const [coAddr1, coAddr2] = splitAddress(ctx.company.address);
  const retainage = ctx.g702.retainage;
  const perLine = retainage.mode === 'perLine';

  // Effective single rate (see file-top note): the server already folded any
  // releases into this; null only in perLine mode, where it isn't used.
  const R = (retainage.effectiveWorkPercent ?? app.retainagePercent ?? a.retainagePercent ?? 10) / 100;

  // ── Title + header inputs ─────────────────────────────────────────────────
  ws.mergeCells('A1:H1');
  setCell(ws, 'A1', 'APPLICATION AND CERTIFICATE FOR PAYMENT', { bold: true, align: 'center', size: 14 });

  setCell(ws, 'A3', 'TO (Owner):', { bold: true });
  setCell(ws, 'B3', a.ownerName ?? '', {});
  setCell(ws, 'C3', 'PROJECT:', { bold: true });
  setCell(ws, 'D3', ctx.projectName, {}); // input — referenced by G703 D2
  ws.mergeCells('D3:F3');
  setCell(ws, 'G3', 'APPLICATION NO:', { bold: true });
  setCell(ws, 'H3', app.number > 0 ? app.number : '', { align: 'right' }); // input — G703 I3

  setCell(ws, 'G5', 'PERIOD FROM:', { bold: true });
  setCell(ws, 'H5', '', { align: 'right' }); // input (blank — not tracked) — G703 I4

  setCell(ws, 'C6', 'G. C. :', { bold: true });
  // G.C. = the project's general contractor (who we're billing) — NOT the FROM
  // company (which is our own company from settings, in B7).
  setCell(ws, 'D6', ctx.contractor ?? '', {}); // input — referenced by G703 D3
  ws.mergeCells('D6:F6');
  setCell(ws, 'G6', 'TO:', { bold: true });
  setCell(ws, 'H6', app.periodTo ?? '', { align: 'right' }); // input — G703 I5

  // FROM company block.
  setCell(ws, 'A7', 'FROM:', { bold: true });
  setCell(ws, 'B7', ctx.company.name ?? '', { bold: true });
  setCell(ws, 'G7', 'TERMS:', { bold: true });
  setCell(ws, 'B8', coAddr1, {});
  setCell(ws, 'B9', coAddr2, {});

  setCell(ws, 'A11', "CONTRACTOR'S APPLICATION FOR PAYMENT", { bold: true });
  setCell(ws, 'E12', 'The present status of the account for this Contract is as follows:', { size: 9 });

  // ── Change Order Summary block (lists CO scheduled values from G703) ───────
  setCell(ws, 'A13', 'CHANGE ORDER SUMMARY', { bold: true });
  setCell(ws, 'A14', 'NUMBER', { bold: true, border: true, align: 'center' });
  setCell(ws, 'B14', 'ADDITIONS', { bold: true, border: true, align: 'center' });
  setCell(ws, 'C14', 'DEDUCTIONS', { bold: true, border: true, align: 'center' });

  const coCount = g.coTotalRow - g.coStart; // number of change-order lines
  const coBlockFirst = 15;
  for (let i = 0; i < coCount; i++) {
    const rowNum = coBlockFirst + i;
    const g703Row = g.coStart + i;
    setCell(ws, `A${rowNum}`, i + 1, { border: true, align: 'center' });
    // Addition references that CO's scheduled value on G703 (live cross-ref).
    setCell(ws, `B${rowNum}`, { formula: `'G703'!C${g703Row}` }, { money: true, border: true });
    setCell(ws, `C${rowNum}`, 0, { money: true, border: true });
  }
  const coBlockLast = coBlockFirst + Math.max(coCount, 1) - 1;
  const coSummaryTotalRow = coBlockLast + 1;
  setCell(ws, `A${coSummaryTotalRow}`, 'TOTALS', { bold: true, border: true });
  setCell(ws, `B${coSummaryTotalRow}`, { formula: `SUM(B${coBlockFirst}:B${coBlockLast})` }, { money: true, bold: true, border: true });
  setCell(ws, `C${coSummaryTotalRow}`, { formula: `SUM(C${coBlockFirst}:C${coBlockLast})` }, { money: true, bold: true, border: true });
  const coNetRow = coSummaryTotalRow + 1;
  setCell(ws, `A${coNetRow}`, 'Net by Change Orders', { bold: true });
  setCell(ws, `C${coNetRow}`, { formula: `B${coSummaryTotalRow}-C${coSummaryTotalRow}` }, { money: true, bold: true });

  // ── 9 G702 certificate lines (label D, desc E, amount H) ──────────────────
  // Anchored to the DYNAMIC G703 rows.
  const ct = g.contractTotalRow;
  const cot = g.coTotalRow;
  const grand = g.grandRow;
  const lineRows = [14, 16, 18, 20, 22, 24, 26, 28, 43];
  const L1row = lineRows[0];
  const L2row = lineRows[1];
  const L5row = lineRows[4];
  const L6row = lineRows[5];
  const L7row = lineRows[6];

  const line = (idx: number, label: string, formula: string): void => {
    const rowNum = lineRows[idx];
    setCell(ws, `D${rowNum}`, `${idx + 1}.`, { bold: true });
    setCell(ws, `E${rowNum}`, label, {});
    setCell(ws, `H${rowNum}`, { formula }, { money: true, border: true });
  };

  line(0, 'ORIGINAL CONTRACT SUM:', `'G703'!C${ct}`);
  line(1, 'Net Change by Change Orders & Extras', `C${coNetRow}`);
  line(2, 'CONTRACT SUM TO DATE:', `H${L1row}+H${L2row}`);
  line(3, 'TOTAL COMPLETED & STORED TO DATE:', `'G703'!G${ct}+'G703'!G${cot}`);

  if (perLine) {
    // No single rate to show — write the 5a (work) / 5b (stored) dollar
    // splits ctx.g702 already computed at each line's own effective rate,
    // and total them with a formula so the sheet still recalculates.
    setCell(ws, `D${L5row}`, '5.', { bold: true });
    setCell(ws, `E${L5row}`, 'RETAINAGE FROM CURRENT BILLING', {});
    setCell(ws, `F${L5row}`, dollars(ctx.g702.L5aRetainageWorkCents), { money: true });
    setCell(ws, `G${L5row}`, dollars(ctx.g702.L5bRetainageStoredCents), { money: true });
    setCell(ws, `H${L5row}`, { formula: `F${L5row}+G${L5row}` }, { money: true, border: true });
    setCell(ws, `E${L5row + 1}`, '(5a Work / 5b Stored, left to right in F / G)', { size: 9 });
  } else {
    // Line 5 — retainage; G22 holds the effective rate beside it.
    line(4, 'RETAINAGE FROM CURRENT BILLING', `'G703'!J${ct}+'G703'!J${cot}`);
    setCell(ws, `G22`, R, {}).numFmt = '0%';
  }

  line(5, 'TOTAL EARNED LESS RETAINAGE:', `'G703'!G${grand}-'G703'!J${grand}`);

  // The legacy L7 formula backs into "previous certificates" as
  // prior-cumulative x G22 — it assumes the PRIOR application was billed at
  // the same rate G22 now holds. That assumption breaks two ways: in perLine
  // mode G22 isn't a rate at all, and on any release application G22 holds the
  // NEW (lower) effective rate, so the back-derived L7 overstates and L8
  // (current payment due) collapses toward zero on exactly the application
  // that pays the retainage out. The server already computed L7 correctly (it
  // walks the prior app's own math), so in both cases write it as a literal in
  // an aux cell with H26 a trivial formula over it — same pattern as the
  // 5a/5b literals above. Zero-release uniform exports keep the old formula.
  const literalL7 = perLine || retainage.cumulativeReleasedPoints > 0;

  if (literalL7) {
    setCell(ws, `D${L7row}`, '7.', { bold: true });
    setCell(ws, `E${L7row}`, 'LESS PREVIOUS CERTIFICATES FOR PAYMENT:', {});
    setCell(ws, `G${L7row}`, dollars(ctx.g702.L7lessPreviousCents), { money: true });
    setCell(ws, `H${L7row}`, { formula: `G${L7row}` }, { money: true, border: true });
  } else {
    line(6, 'LESS PREVIOUS CERTIFICATES FOR PAYMENT:', `'G703'!D${grand}-('G703'!D${grand}*'G702'!G22)`);
  }
  setCell(ws, `E${L7row + 1}`, '(Line 6 from previous application)', { size: 9 });

  line(7, 'CURRENT PAYMENT DUE:', `H${L6row}-H${L7row}`);
  line(8, 'BALANCE TO FINISH PLUS RETAINAGE', `'G703'!I${ct}+'G703'!J${ct}+'G703'!I${cot}+'G703'!J${cot}`);
  setCell(ws, `E${lineRows[8] + 1}`, '(Line 3 minus Line 6)', { size: 9 });
}

// Builds the full two-sheet workbook. Pure builder — no DOM / download here so
// the alternate (template-fill) builder can sit beside it. G703 is built first
// so G702 can anchor its formulas to G703's computed dynamic row numbers, then
// the G702 sheet is moved to the front so the workbook opens on it.
export async function buildAiaWorkbook(ctx: AiaExportCtx): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSlib } = await import('exceljs');
  const wb = new ExcelJSlib.Workbook();
  wb.creator = ctx.company.name ?? 'FrugalOmnibuild';
  wb.created = new Date();
  // Add G702 FIRST so the workbook opens on it, but fill it AFTER G703 so its
  // formulas can anchor to G703's computed dynamic row numbers.
  const g702ws = wb.addWorksheet('G702');
  const anchors = buildG703(wb, ctx);
  buildG702(g702ws, ctx, anchors);
  return wb;
}

// Resolve a worksheet by name; fall back to the first sheet when the name is
// blank, '1', or not found. Returns undefined only if the workbook is empty.
function resolveSheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet | undefined {
  const trimmed = (name || '').trim();
  if (trimmed && trimmed !== '1') {
    const byName = wb.getWorksheet(trimmed);
    if (byName) return byName;
  }
  return wb.worksheets[0];
}

// Set a single cell's value, swallowing any error from a malformed cell ref so
// one bad mapping entry can never abort the whole export. Never touches styles.
function setMapped(ws: ExcelJS.Worksheet | undefined, ref: string | undefined, value: ExcelJS.CellValue): void {
  if (!ws || !ref || !ref.trim()) return;
  try {
    ws.getCell(ref.trim()).value = value;
  } catch { /* skip invalid cell ref */ }
}

// Fills an admin-supplied AIA template workbook. Only writes the mapped cells;
// the template's own formatting / formulas / totals rows are left intact.
export async function buildAiaWorkbookFromTemplate(
  templateBuf: ArrayBuffer,
  mapping: AiaTemplateMapping,
  ctx: AiaExportCtx,
): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSlib } = await import('exceljs');
  const wb = new ExcelJSlib.Workbook();
  await wb.xlsx.load(templateBuf);

  const asDollars = mapping.moneyAsDollars !== false; // default true
  const money = (cents: number): number => (asDollars ? dollars(cents) : (cents || 0));

  // ── G702 header + certificate lines ──────────────────────────────────────
  const g702ws = resolveSheet(wb, mapping.g702Sheet);
  const c = mapping.cells || {};
  const a = ctx.aiaSettings;
  const g = ctx.g702;
  const app = ctx.app;

  setMapped(g702ws, c.ownerName, a.ownerName ?? '');
  setMapped(g702ws, c.ownerAddress, a.ownerAddress ?? '');
  setMapped(g702ws, c.projectName, ctx.projectName);
  setMapped(g702ws, c.contractorName, ctx.company.name ?? '');
  setMapped(g702ws, c.architectName, a.architectName ?? '');
  setMapped(g702ws, c.contractFor, a.contractFor ?? '');
  setMapped(g702ws, c.applicationNo, app.number > 0 ? app.number : '');
  setMapped(g702ws, c.periodTo, app.periodTo ?? '');
  setMapped(g702ws, c.applicationDate, app.applicationDate ?? '');
  setMapped(g702ws, c.contractDate, a.contractDate ?? '');
  setMapped(g702ws, c.ownerProjectNumber, a.ownerProjectNumber ?? '');
  setMapped(g702ws, c.architectProjectNumber, a.architectProjectNumber ?? '');
  // Effective (post-release) rates: base minus cumulative released points,
  // clamped at 0. Legacy apps with zero releases reduce to their own raw
  // rates unchanged. perLine has no single work rate — fall back to the raw
  // app rate as a best-effort single number for the template's one cell.
  const effectiveWorkPct = g.retainage.effectiveWorkPercent ?? app.retainagePercent;
  const effectiveStoredPct = Math.max(0, app.storedRetainagePercent - g.retainage.cumulativeReleasedPoints);
  setMapped(g702ws, c.retainageWorkPct, effectiveWorkPct);
  setMapped(g702ws, c.retainageStoredPct, effectiveStoredPct);

  setMapped(g702ws, c.L1, money(g.L1originalContractCents));
  setMapped(g702ws, c.L2, money(g.L2changeOrdersCents));
  setMapped(g702ws, c.L3, money(g.L3contractSumToDateCents));
  setMapped(g702ws, c.L4, money(g.L4totalCompletedStoredCents));
  setMapped(g702ws, c.L5a, money(g.L5aRetainageWorkCents));
  setMapped(g702ws, c.L5b, money(g.L5bRetainageStoredCents));
  setMapped(g702ws, c.L5, money(g.L5retainageCents));
  setMapped(g702ws, c.L6, money(g.L6earnedLessRetainageCents));
  setMapped(g702ws, c.L7, money(g.L7lessPreviousCents));
  setMapped(g702ws, c.L8, money(g.L8currentPaymentDueCents));
  setMapped(g702ws, c.L9, money(g.L9balanceToFinishCents));
  setMapped(g702ws, c.coAdditions, money(g.changeOrders.additionsCents));
  setMapped(g702ws, c.coDeductions, money(g.changeOrders.deductionsCents));
  setMapped(g702ws, c.coNet, money(g.changeOrders.netCents));

  // ── G703 continuation rows (per-line only; no totals row) ────────────────
  const g703ws = resolveSheet(wb, mapping.g703Sheet);
  const cols = mapping.g703Cols || {};
  const startRow = Number.isFinite(mapping.g703StartRow) && mapping.g703StartRow > 0
    ? Math.floor(mapping.g703StartRow)
    : 1;

  // Print (and PDF) layout: G702 on one page; G703 fitted to the width over
  // as many pages as it needs, change orders starting on a new page. A
  // one-sheet template gets the G703 rules.
  if (g702ws && g702ws !== g703ws) applyTemplatePageSetup(g702ws, true);
  if (g703ws) {
    applyTemplatePageSetup(g703ws, false);
    const firstCo = ctx.g703.findIndex(r => r.isChangeOrder);
    if (firstCo > 0) g703ws.getRow(startRow + firstCo - 1).addPageBreak();
  }

  ctx.g703.forEach((row, i) => {
    const rowNum = startRow + i;
    const at = (col: string | undefined): string | undefined => (col && col.trim() ? `${col.trim()}${rowNum}` : undefined);
    const pct = row.scheduledValueCents > 0
      ? row.totalToDateCents / row.scheduledValueCents
      : (row.percentComplete || 0) / 100;

    if (lineTypeOf(row) !== 'item') {
      setMapped(g703ws, at(cols.itemNo), row.itemNo ?? '');
      setMapped(g703ws, at(cols.description), lineTypeOf(row) === 'header' ? row.description : '');
      for (const key of ['scheduledValue', 'previous', 'thisPeriod', 'stored', 'total', 'percent', 'balance', 'retainage'] as const) {
        setMapped(g703ws, at(cols[key]), '');
      }
      return;
    }

    setMapped(g703ws, at(cols.itemNo), row.itemNo ?? '');
    setMapped(g703ws, at(cols.description), row.description);
    setMapped(g703ws, at(cols.scheduledValue), money(row.scheduledValueCents));
    setMapped(g703ws, at(cols.previous), money(row.previousCents));
    setMapped(g703ws, at(cols.thisPeriod), money(row.thisPeriodCents));
    setMapped(g703ws, at(cols.stored), money(row.storedCents));
    setMapped(g703ws, at(cols.total), money(row.totalToDateCents));
    setMapped(g703ws, at(cols.percent), pct);
    setMapped(g703ws, at(cols.balance), money(row.balanceToFinishCents));
    setMapped(g703ws, at(cols.retainage), money(row.retainageCents));
  });

  return wb;
}

export function sanitizeFilename(name: string): string {
  return (name || 'project').replace(/[^a-zA-Z0-9 _.-]+/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'project';
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Builds the workbook and returns its bytes — no download, no persistence.
// DocumentActionsBar needs exactly this: it stores the blob as the pay app's
// living document and decides delivery itself, so a builder that also shoved a
// file at the browser would fire a stray download on every generate/send.
// When a configured template + mapping are supplied, the admin template is
// filled instead of the built-in recreation; otherwise the recreation is used.
export async function buildAiaXlsxBlob(
  ctx: AiaExportCtx,
  template?: { templateBuf: ArrayBuffer; mapping: AiaTemplateMapping },
): Promise<Blob> {
  const wb = template
    ? await buildAiaWorkbookFromTemplate(template.templateBuf, template.mapping, ctx)
    : await buildAiaWorkbook(ctx);
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_MIME });
}

// Build + optional persist + save-to-disk. Still the path for exports that
// aren't a record's living document (the Schedule of Values' blank-SOV
// download); pay-app exports go through the document bar instead.
export async function exportAiaXlsx(
  ctx: AiaExportCtx,
  template?: { templateBuf: ArrayBuffer; mapping: AiaTemplateMapping },
  filename?: string,
  // Handed the finished workbook before the download starts, so a caller can keep
  // a copy in Documents. It owns its own failures — the download always proceeds.
  persist?: (blob: Blob) => Promise<void>,
): Promise<void> {
  const blob = await buildAiaXlsxBlob(ctx, template);
  if (persist) await persist(blob);
  downloadBlob(blob, filename ?? `AIA-${sanitizeFilename(ctx.projectName)}-App${ctx.app.number}.xlsx`);
}
