// src/pages/reports/reportsExcel.ts — the Reports page's Excel download: the
// report on screen, as currently filtered, as a one-sheet .xlsx.
//
// Two steps, so the layout is testable without exceljs: a pure *Sheet()
// builder turns a report into a SheetSpec (money still in cents, dates still
// 'YYYY-MM-DD'), and buildReportWorkbook writes it — money as dollars with a
// currency format, days as real Excel dates — under a title, the filters it
// was run with, a header row with Excel's filter buttons (so it sorts in
// Excel), the rows, and its totals. exceljs is lazy-loaded, as in aiaExcel.ts.
import type ExcelJS from 'exceljs';
import type {
  OpenInvoicesReport, PaymentsReport, ChangeOrdersReport, RetainageReport,
} from '../../utils/reportsApi';
import { CHANGE_ORDER_REPORT_STATUSES } from '../../utils/reportsApi';
import { CO_STATUS_META } from '../../components/ui/BillingPills';
import { downloadBlob } from '../../utils/download';
import { XLSX_MIME } from '../project/billing/aiaExcel';
import { paymentMethodLabel } from '../project/billing/PaymentDetailModal';
import { AGING_LABELS, fractionComplete, retainageRateLabel } from './reportLabels';
import { parseDay } from './reportDates';

export type SheetCell = string | number | null;
export type ColumnKind = 'text' | 'money' | 'date' | 'int' | 'pct';
export interface SheetColumn { header: string; width: number; kind?: ColumnKind }

export interface SheetSpec {
  sheetName: string;
  title: string;
  /** Lines under the title: the filters the report was run with. */
  details: string[];
  columns: SheetColumn[];
  /** One cell per column: cents for 'money', 'YYYY-MM-DD' for 'date', a fraction for 'pct'. */
  rows: SheetCell[][];
  /** Bold rows under the data (totals, subtotals), laid out like rows. */
  summary: SheetCell[][];
}

const MONEY_FMT = '$#,##0.00';
const DATE_FMT = 'm/d/yyyy';

// ── Report → SheetSpec ───────────────────────────────────────────────────────

export function openInvoicesSheet(report: OpenInvoicesReport, details: string[]): SheetSpec {
  const columns: SheetColumn[] = [
    { header: 'Customer', width: 24 }, { header: 'Project', width: 28 }, { header: 'Document', width: 16 },
    { header: 'Date', width: 12, kind: 'date' }, { header: 'Days outstanding', width: 12, kind: 'int' },
    { header: 'Aging', width: 12 },
    { header: 'Total', width: 14, kind: 'money' }, { header: 'Paid', width: 14, kind: 'money' }, { header: 'Balance', width: 14, kind: 'money' },
  ];
  const rows = report.rows.map(r => [
    r.customerName ?? '', r.projectName, r.document, r.date, r.daysOutstanding,
    AGING_LABELS[r.bucket ?? 'undated'], r.totalCents, r.paidCents, r.balanceCents,
  ]);
  const t = report.totals;
  const bucketRow = (key: keyof OpenInvoicesReport['buckets']): SheetCell[] =>
    [AGING_LABELS[key], null, null, null, null, null, null, null, report.buckets[key]];
  const summary: SheetCell[][] = [
    [`Total (${t.count})`, null, null, null, null, null, t.totalCents, t.paidCents, t.balanceCents],
    bucketRow('current'), bucketRow('days31to60'), bucketRow('days61plus'),
    ...(report.buckets.undated ? [bucketRow('undated')] : []),
  ];
  return { sheetName: 'Open invoices', title: 'Open invoices / AR aging', details, columns, rows, summary };
}

export function paymentsSheet(report: PaymentsReport, details: string[]): SheetSpec {
  const columns: SheetColumn[] = [
    { header: 'Date', width: 12, kind: 'date' }, { header: 'Customer', width: 24 }, { header: 'Project', width: 28 },
    { header: 'Applied to', width: 16 }, { header: 'Method', width: 10 }, { header: 'Note', width: 32 },
    { header: 'Amount', width: 14, kind: 'money' },
  ];
  const rows = report.rows.map(r => [
    r.date, r.customerName ?? '', r.projectName, r.target, paymentMethodLabel(r.method), r.note ?? '', r.amountCents,
  ]);
  const summary: SheetCell[][] = [[`Total (${report.totals.count})`, null, null, null, null, null, report.totals.amountCents]];
  return { sheetName: 'Payments received', title: 'Payments received', details, columns, rows, summary };
}

export function changeOrdersSheet(report: ChangeOrdersReport, details: string[]): SheetSpec {
  const columns: SheetColumn[] = [
    { header: 'Project', width: 28 }, { header: 'Customer', width: 24 }, { header: 'CO', width: 10 },
    { header: 'Title', width: 32 }, { header: 'Status', width: 11 }, { header: 'Date', width: 12, kind: 'date' },
    { header: 'Amount', width: 14, kind: 'money' }, { header: 'Schedule impact (days)', width: 12, kind: 'int' },
  ];
  const rows = report.rows.map(r => [
    r.projectName, r.customerName ?? '', r.number ? `CO-${r.number}` : '', r.title ?? '',
    CO_STATUS_META[r.statusGroup].label, r.date, r.amountCents, r.scheduleImpactDays,
  ]);
  const summary: SheetCell[][] = [
    ...CHANGE_ORDER_REPORT_STATUSES
      .filter(s => report.byStatus[s].count > 0)
      .map(s => {
        const b = report.byStatus[s];
        return [`${CO_STATUS_META[s].label} (${b.count})`, null, null, null, null, null, b.amountCents, b.scheduleImpactDays];
      }),
    [`Total (${report.totals.count})`, null, null, null, null, null, report.totals.amountCents, report.totals.scheduleImpactDays],
  ];
  return { sheetName: 'Change orders', title: 'Change orders by status', details, columns, rows, summary };
}

export function retainageSheet(report: RetainageReport, details: string[]): SheetSpec {
  const columns: SheetColumn[] = [
    { header: 'Customer', width: 24 }, { header: 'Project', width: 28 }, { header: 'Latest pay app', width: 14 },
    { header: 'Application date', width: 12, kind: 'date' },
    { header: 'Contract sum to date', width: 16, kind: 'money' }, { header: 'Completed & stored', width: 16, kind: 'money' },
    { header: '% complete', width: 10, kind: 'pct' }, { header: 'Retainage rate', width: 24 },
    { header: 'Retainage held', width: 14, kind: 'money' }, { header: 'Retainage released', width: 14, kind: 'money' },
  ];
  const rows = report.rows.map(r => [
    r.customerName ?? '', r.projectName, `Pay App #${r.payAppNumber}`, r.applicationDate,
    r.contractSumCents, r.completedStoredCents, fractionComplete(r), retainageRateLabel(r),
    r.retainageHeldCents, r.retainageReleasedCents,
  ]);
  const t = report.totals;
  const summary: SheetCell[][] = [[
    `Total (${report.rows.length})`, null, null, null, t.contractSumCents, t.completedStoredCents,
    fractionComplete({ contractSumCents: t.contractSumCents, completedStoredCents: t.completedStoredCents }), null,
    t.retainageHeldCents, t.retainageReleasedCents,
  ]];
  return { sheetName: 'Retainage', title: 'Retainage held', details, columns, rows, summary };
}

// ── SheetSpec → workbook ─────────────────────────────────────────────────────

function cellValue(kind: ColumnKind | undefined, v: SheetCell): ExcelJS.CellValue {
  if (v == null) return null;
  if (kind === 'money' && typeof v === 'number') return v / 100;
  if (kind === 'date' && typeof v === 'string') {
    const d = parseDay(v);
    // exceljs writes a Date by its UTC day: build the day at UTC midnight.
    return d ? new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) : v;
  }
  return v;
}

const FORMATS: Partial<Record<ColumnKind, string>> = { money: MONEY_FMT, date: DATE_FMT, int: '0', pct: '0.0%' };

export async function buildReportWorkbook(spec: SheetSpec): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSlib } = await import('exceljs');
  const wb = new ExcelJSlib.Workbook();
  wb.creator = 'FrugalOmnibuild';
  wb.created = new Date();
  const headerRow = spec.details.length + 3; // title, details, a blank row
  const ws = wb.addWorksheet(spec.sheetName, { views: [{ state: 'frozen', ySplit: headerRow }] });
  ws.columns = spec.columns.map(c => ({ width: c.width }));
  ws.pageSetup = {
    orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
  };

  const title = ws.getCell(1, 1);
  title.value = spec.title;
  title.font = { bold: true, size: 14 };
  spec.details.forEach((line, i) => {
    const c = ws.getCell(2 + i, 1);
    c.value = line;
    c.font = { size: 10, color: { argb: 'FF555555' } };
  });

  const header = ws.getRow(headerRow);
  spec.columns.forEach((col, i) => {
    const c = header.getCell(i + 1);
    c.value = col.header;
    c.font = { bold: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    c.border = { bottom: { style: 'thin' } };
    c.alignment = { vertical: 'middle', wrapText: true, horizontal: col.kind && col.kind !== 'text' ? 'right' : 'left' };
  });
  // Filter/sort buttons over the data rows only — the totals stay put below.
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + spec.rows.length, column: spec.columns.length } };

  const write = (rowNum: number, cells: SheetCell[], bold: boolean) => {
    const row = ws.getRow(rowNum);
    spec.columns.forEach((col, i) => {
      const c = row.getCell(i + 1);
      c.value = cellValue(col.kind, cells[i] ?? null);
      const fmt = col.kind ? FORMATS[col.kind] : undefined;
      if (fmt) c.numFmt = fmt;
      if (bold) c.font = { bold: true };
    });
  };
  spec.rows.forEach((cells, i) => write(headerRow + 1 + i, cells, false));
  // One blank row between the data and its totals.
  spec.summary.forEach((cells, i) => write(headerRow + spec.rows.length + 2 + i, cells, true));
  return wb;
}

export async function buildReportXlsxBlob(spec: SheetSpec): Promise<Blob> {
  const wb = await buildReportWorkbook(spec);
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_MIME });
}

export async function downloadReportXlsx(spec: SheetSpec, fileName: string): Promise<void> {
  downloadBlob(await buildReportXlsxBlob(spec), fileName);
}
