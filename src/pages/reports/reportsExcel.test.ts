// src/pages/reports/reportsExcel.test.ts — the Reports page's Excel download.
// The sheet builders are pure (cents and 'YYYY-MM-DD' in, rows out); the
// workbook writer turns cents into dollars and days into real dates.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  openInvoicesSheet, paymentsSheet, changeOrdersSheet, retainageSheet,
  buildReportWorkbook, buildReportXlsxBlob, downloadReportXlsx,
} from './reportsExcel';
import { downloadBlob } from '../../utils/download';
import type { OpenInvoicesReport, PaymentsReport, ChangeOrdersReport, RetainageReport } from '../../utils/reportsApi';

vi.mock('../../utils/download', () => ({ downloadBlob: vi.fn() }));
beforeEach(() => { vi.mocked(downloadBlob).mockReset(); });

const proj = { projectId: 'p1', projectName: 'Dunmore Heights', customerId: 'c1', customerName: 'Acme', archived: false };

const openInvoices: OpenInvoicesReport = {
  rows: [
    { ...proj, kind: 'invoice', id: 'i1', document: 'Invoice 1001', status: 'sent', date: '2026-08-01', daysOutstanding: 66, bucket: 'days61plus', totalCents: 50000, paidCents: 10000, balanceCents: 40000 },
    { ...proj, customerName: null, kind: 'payapp', id: 'a1', document: 'Pay App #2', status: 'finalized', date: null, daysOutstanding: null, bucket: null, totalCents: 25050, paidCents: 0, balanceCents: 25050 },
  ],
  totals: { count: 2, totalCents: 75050, paidCents: 10000, balanceCents: 65050 },
  buckets: { current: 0, days31to60: 0, days61plus: 40000, undated: 25050 },
};

describe('sheet builders', () => {
  it('open invoices: one row per document, then the total and the aging subtotals', () => {
    const s = openInvoicesSheet(openInvoices, ['Customer: All customers']);
    expect(s.columns.map(c => c.header)).toEqual(['Customer', 'Project', 'Document', 'Date', 'Days outstanding', 'Aging', 'Total', 'Paid', 'Balance']);
    expect(s.rows).toEqual([
      ['Acme', 'Dunmore Heights', 'Invoice 1001', '2026-08-01', 66, '61+ days', 50000, 10000, 40000],
      ['', 'Dunmore Heights', 'Pay App #2', null, null, 'No date', 25050, 0, 25050],
    ]);
    expect(s.summary).toEqual([
      ['Total (2)', null, null, null, null, null, 75050, 10000, 65050],
      ['0–30 days', null, null, null, null, null, null, null, 0],
      ['31–60 days', null, null, null, null, null, null, null, 0],
      ['61+ days', null, null, null, null, null, null, null, 40000],
      ['No date', null, null, null, null, null, null, null, 25050],
    ]);
    expect(s.details).toEqual(['Customer: All customers']);
  });

  it('payments: method labels, notes, total — and no attachments', () => {
    const report: PaymentsReport = {
      rows: [{ ...proj, id: 'pay1', date: '2026-10-01', targetType: 'invoice', targetId: 'i1', target: 'Invoice 1001', method: 'ach', note: null, amountCents: 12345 }],
      totals: { count: 1, amountCents: 12345 },
    };
    const s = paymentsSheet(report, []);
    expect(s.columns.map(c => c.header)).toEqual(['Date', 'Customer', 'Project', 'Applied to', 'Method', 'Note', 'Amount']);
    expect(s.rows).toEqual([['2026-10-01', 'Acme', 'Dunmore Heights', 'Invoice 1001', 'ACH', '', 12345]]);
    expect(s.summary).toEqual([['Total (1)', null, null, null, null, null, 12345]]);
  });

  it('change orders: legacy pending reads as Draft; a subtotal per status present, then the total', () => {
    const report: ChangeOrdersReport = {
      rows: [
        { ...proj, id: 'co0', number: '000', title: 'Old extra', status: 'pending', statusGroup: 'draft', date: null, amountCents: 7500, scheduleImpactDays: null },
        { ...proj, id: 'co1', number: '001', title: 'Soffit', status: 'sent', statusGroup: 'sent', date: '2026-09-15', amountCents: 120000, scheduleImpactDays: 3 },
      ],
      byStatus: {
        draft: { count: 1, amountCents: 7500, scheduleImpactDays: 0 },
        sent: { count: 1, amountCents: 120000, scheduleImpactDays: 3 },
        approved: { count: 0, amountCents: 0, scheduleImpactDays: 0 },
        rejected: { count: 0, amountCents: 0, scheduleImpactDays: 0 },
      },
      totals: { count: 2, amountCents: 127500, scheduleImpactDays: 3 },
    };
    const s = changeOrdersSheet(report, []);
    expect(s.rows.map(r => [r[2], r[4], r[6], r[7]])).toEqual([['CO-000', 'Draft', 7500, null], ['CO-001', 'Sent', 120000, 3]]);
    expect(s.summary).toEqual([
      ['Draft (1)', null, null, null, null, null, 7500, 0],
      ['Sent (1)', null, null, null, null, null, 120000, 3],
      ['Total (2)', null, null, null, null, null, 127500, 3],
    ]);
  });

  it('retainage: % complete as a fraction and the rate in words', () => {
    const report: RetainageReport = {
      rows: [{ ...proj, payAppId: 'a2', payAppNumber: 2, applicationDate: '2026-09-30', contractSumCents: 1000000, completedStoredCents: 600000,
        retainageHeldCents: 36000, retainageReleasedCents: 24000, retainageMode: 'uniform', retainagePercent: 10, releasedPoints: 4 }],
      totals: { contractSumCents: 1000000, completedStoredCents: 600000, retainageHeldCents: 36000, retainageReleasedCents: 24000 },
    };
    const s = retainageSheet(report, []);
    expect(s.rows).toEqual([['Acme', 'Dunmore Heights', 'Pay App #2', '2026-09-30', 1000000, 600000, 0.6, '10% − 4 pts released', 36000, 24000]]);
    expect(s.summary).toEqual([['Total (1)', null, null, null, 1000000, 600000, 0.6, null, 36000, 24000]]);
  });
});

describe('buildReportWorkbook', () => {
  it('writes the title, filters, a filterable header row, dollars, real dates, and bold totals', async () => {
    const spec = openInvoicesSheet(openInvoices, ['Customer: Acme · Project: All projects', 'As of today']);
    const wb = await buildReportWorkbook(spec);
    const ws = wb.getWorksheet('Open invoices')!;
    expect(ws.getCell('A1').value).toBe('Open invoices / AR aging');
    expect(ws.getCell('A1').font?.bold).toBe(true);
    expect(ws.getCell('A2').value).toBe('Customer: Acme · Project: All projects');
    expect(ws.getCell('A3').value).toBe('As of today');

    // Header on row 5 (title, two detail lines, a blank row).
    expect(ws.getRow(5).values).toEqual([undefined, 'Customer', 'Project', 'Document', 'Date', 'Days outstanding', 'Aging', 'Total', 'Paid', 'Balance']);
    expect(ws.autoFilter).toEqual({ from: { row: 5, column: 1 }, to: { row: 7, column: 9 } });
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 5 });

    // Cents → dollars with a currency format; the day → a real date.
    expect(ws.getCell('I6').value).toBe(400);
    expect(ws.getCell('I6').numFmt).toBe('$#,##0.00');
    expect(ws.getCell('G7').value).toBe(250.5);
    expect(ws.getCell('D6').value).toEqual(new Date(Date.UTC(2026, 7, 1)));
    expect(ws.getCell('D6').numFmt).toBe('m/d/yyyy');
    expect(ws.getCell('D7').value).toBeNull();

    // A blank row, then the totals, bold.
    expect(ws.getCell('A8').value).toBeNull();
    expect(ws.getCell('A9').value).toBe('Total (2)');
    expect(ws.getCell('I9').value).toBe(650.5);
    expect(ws.getCell('I9').font?.bold).toBe(true);
    expect(ws.getCell('A13').value).toBe('No date');
  });

  it('downloads the workbook under the given name', async () => {
    const spec = openInvoicesSheet(openInvoices, []);
    const blob = await buildReportXlsxBlob(spec);
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(blob.size).toBeGreaterThan(0);
    await downloadReportXlsx(spec, 'Open-Invoices-2026-10-06.xlsx');
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Open-Invoices-2026-10-06.xlsx');
  });
});
