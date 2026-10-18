// src/pages/reports/ReportsPage.test.tsx — the Reports page: admin gate, tabs,
// filters (what each tab sends), live refresh and the Excel download.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ToastProvider } from '../../components/Toast';
import type {
  OpenInvoicesReport, PaymentsReport, ChangeOrdersReport, RetainageReport, ReportFilterOptions,
} from '../../utils/reportsApi';
import { presetRange } from './reportDates';

const h = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(x => x !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return {
    fakeSocket,
    getReportOptions: vi.fn(),
    getOpenInvoicesReport: vi.fn(),
    getPaymentsReport: vi.fn(),
    getChangeOrdersReport: vi.fn(),
    getRetainageReport: vi.fn(),
    downloadReportXlsx: vi.fn(),
  };
});
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: h.fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
vi.mock('../../utils/reportsApi', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getReportOptions: h.getReportOptions,
  getOpenInvoicesReport: h.getOpenInvoicesReport,
  getPaymentsReport: h.getPaymentsReport,
  getChangeOrdersReport: h.getChangeOrdersReport,
  getRetainageReport: h.getRetainageReport,
}));
vi.mock('./reportsExcel', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  downloadReportXlsx: h.downloadReportXlsx,
}));

import { ReportsPage } from './ReportsPage';

const proj = { projectId: 'p1', projectName: 'Dunmore Heights', customerId: 'c1', customerName: 'Acme Builders', archived: false };

const OPTIONS: ReportFilterOptions = {
  projects: [
    { id: 'p1', name: 'Dunmore Heights', customerId: 'c1', archived: false },
    { id: 'p2', name: 'Hartwell', customerId: 'c2', archived: false },
    { id: 'p3', name: 'Old Job', customerId: 'c1', archived: true },
  ],
  customers: [{ id: 'c1', name: 'Acme Builders' }, { id: 'c2', name: 'Beta GC' }],
};
const OPEN: OpenInvoicesReport = {
  rows: [
    { ...proj, kind: 'invoice', id: 'i1', document: 'Invoice 1001', status: 'sent', date: '2026-08-01', daysOutstanding: 66, bucket: 'days61plus', totalCents: 50000, paidCents: 10000, balanceCents: 40000 },
    { ...proj, projectId: 'p3', projectName: 'Old Job', archived: true, kind: 'payapp', id: 'a1', document: 'Pay App #2', status: 'finalized', date: '2026-10-01', daysOutstanding: 5, bucket: 'current', totalCents: 25050, paidCents: 0, balanceCents: 25050 },
  ],
  totals: { count: 2, totalCents: 75050, paidCents: 10000, balanceCents: 65050 },
  buckets: { current: 25050, days31to60: 0, days61plus: 40000, undated: 0 },
};
const PAYMENTS: PaymentsReport = {
  rows: [{ ...proj, id: 'pay1', date: '2026-10-02', targetType: 'invoice', targetId: 'i1', target: 'Invoice 1001', method: 'ach', note: 'Remit #55', amountCents: 10000 }],
  totals: { count: 1, amountCents: 10000 },
};
const COS: ChangeOrdersReport = {
  rows: [
    { ...proj, id: 'co0', number: '000', title: 'Old extra', status: 'pending', statusGroup: 'draft', date: null, amountCents: 7500, scheduleImpactDays: null },
    { ...proj, id: 'co1', number: '001', title: 'Extra soffit', status: 'sent', statusGroup: 'sent', date: '2026-09-15', amountCents: 120000, scheduleImpactDays: 3 },
  ],
  byStatus: {
    draft: { count: 1, amountCents: 7500, scheduleImpactDays: 0 },
    sent: { count: 1, amountCents: 120000, scheduleImpactDays: 3 },
    approved: { count: 0, amountCents: 0, scheduleImpactDays: 0 },
    rejected: { count: 0, amountCents: 0, scheduleImpactDays: 0 },
  },
  totals: { count: 2, amountCents: 127500, scheduleImpactDays: 3 },
};
const RETAINAGE: RetainageReport = {
  rows: [{ ...proj, payAppId: 'a2', payAppNumber: 2, applicationDate: '2026-09-30', contractSumCents: 1000000, completedStoredCents: 600000,
    retainageHeldCents: 36000, retainageReleasedCents: 24000, retainageMode: 'uniform', retainagePercent: 10, releasedPoints: 4 }],
  totals: { contractSumCents: 1000000, completedStoredCents: 600000, retainageHeldCents: 36000, retainageReleasedCents: 24000 },
};

const LocationProbe: React.FC = () => {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}{loc.search}</div>;
};
const mount = (path = '/reports') => render(
  <MemoryRouter initialEntries={[path]}>
    <ToastProvider><ReportsPage /><LocationProbe /></ToastProvider>
  </MemoryRouter>
);
const money = (cents: number) => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0];

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify({ id: 'u1', username: 'noah', role: 'admin' }));
  h.getReportOptions.mockReset().mockResolvedValue(OPTIONS);
  h.getOpenInvoicesReport.mockReset().mockResolvedValue(OPEN);
  h.getPaymentsReport.mockReset().mockResolvedValue(PAYMENTS);
  h.getChangeOrdersReport.mockReset().mockResolvedValue(COS);
  h.getRetainageReport.mockReset().mockResolvedValue(RETAINAGE);
  h.downloadReportXlsx.mockReset().mockResolvedValue(undefined);
  for (const k of Object.keys(h.fakeSocket.handlers)) delete h.fakeSocket.handlers[k];
});
afterEach(() => localStorage.removeItem('user'));

describe('ReportsPage', () => {
  it('is admin-only: anyone else gets a notice and nothing is fetched', () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u2', username: 'crew', role: 'user' }));
    mount();
    expect(screen.getByText('Reports are admin-only')).toBeInTheDocument();
    expect(h.getOpenInvoicesReport).not.toHaveBeenCalled();
    expect(h.getReportOptions).not.toHaveBeenCalled();
  });

  it('opens on Open invoices across every project, archived included: rows, aging tiles and totals', async () => {
    mount();
    const table = await screen.findByTestId('report-table');
    expect(h.getOpenInvoicesReport).toHaveBeenCalledTimes(1);
    expect(lastCall(h.getOpenInvoicesReport)).toEqual({ projectId: undefined, customerId: undefined, includeArchived: true });

    const rows = within(table).getAllByTestId('report-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Invoice 1001');
    expect(rows[0]).toHaveTextContent('61+ days');
    expect(rows[0]).toHaveTextContent(money(40000));
    expect(within(rows[0]).getByRole('link', { name: 'Invoice 1001' })).toHaveAttribute('href', '/project/p1/billing?tab=invoices&open=i1');
    expect(within(rows[1]).getByRole('link', { name: 'Pay App #2' })).toHaveAttribute('href', '/project/p3/billing?tab=pay-apps');
    expect(rows[1]).toHaveTextContent('Archived');
    expect(screen.getByTestId('report-total')).toHaveTextContent(money(65050));
    expect(screen.getByTestId('report-outstanding')).toHaveTextContent(money(65050));
    expect(screen.getByTestId('report-bucket-current')).toHaveTextContent(money(25050));
    expect(screen.getByTestId('report-bucket-days61plus')).toHaveTextContent(money(40000));
    expect(screen.queryByTestId('report-bucket-undated')).not.toBeInTheDocument();
  });

  it('filters by customer (narrowing the project list), project, and archived projects', async () => {
    mount();
    await screen.findByTestId('report-table');
    await waitFor(() => expect(screen.getAllByRole('option', { name: /Dunmore Heights/ })).toHaveLength(1));

    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c1' } });
    await waitFor(() => expect(lastCall(h.getOpenInvoicesReport)).toMatchObject({ customerId: 'c1' }));
    const projectSelect = screen.getByLabelText('Project') as HTMLSelectElement;
    expect(Array.from(projectSelect.options).map(o => o.text)).toEqual(['All projects', 'Dunmore Heights', 'Old Job (archived)']);

    fireEvent.change(projectSelect, { target: { value: 'p3' } });
    await waitFor(() => expect(lastCall(h.getOpenInvoicesReport)).toMatchObject({ customerId: 'c1', projectId: 'p3' }));

    // Leaving archived projects out drops the archived project picked.
    fireEvent.click(screen.getByLabelText('Include archived projects'));
    await waitFor(() => expect(lastCall(h.getOpenInvoicesReport)).toEqual({ customerId: 'c1', projectId: undefined, includeArchived: false }));
    expect(Array.from(projectSelect.options).map(o => o.text)).toEqual(['All projects', 'Dunmore Heights']);

    // A customer that doesn't own the picked project clears it.
    fireEvent.change(projectSelect, { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c2' } });
    await waitFor(() => expect(lastCall(h.getOpenInvoicesReport)).toMatchObject({ customerId: 'c2', projectId: undefined }));
  });

  it('Payments received: this month by default; presets and custom dates set the range', async () => {
    mount('/reports?tab=payments');
    expect(await screen.findByText('Remit #55')).toBeInTheDocument();
    const month = presetRange('this-month');
    expect(lastCall(h.getPaymentsReport)).toMatchObject({ from: month.from, to: month.to });
    expect((screen.getByLabelText('Dates') as HTMLSelectElement).value).toBe('this-month');
    const row = screen.getByTestId('report-row');
    expect(row).toHaveTextContent('ACH');
    expect(row).toHaveTextContent('Invoice 1001');
    expect(within(row).getByRole('link')).toHaveAttribute('href', '/project/p1/billing?tab=payments&open=pay1');
    expect(screen.getByTestId('report-received')).toHaveTextContent(money(10000));

    fireEvent.change(screen.getByLabelText('Dates'), { target: { value: 'last-year' } });
    await waitFor(() => expect(lastCall(h.getPaymentsReport)).toMatchObject(presetRange('last-year')));

    fireEvent.change(screen.getByLabelText('Dates'), { target: { value: 'all' } });
    await waitFor(() => expect(lastCall(h.getPaymentsReport)).toMatchObject({ from: undefined, to: undefined }));

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(lastCall(h.getPaymentsReport)).toMatchObject({ from: '2026-09-01', to: undefined }));
    expect((screen.getByLabelText('Dates') as HTMLSelectElement).value).toBe('custom');
    // The other reports never get a date range.
    expect(h.getOpenInvoicesReport).not.toHaveBeenCalled();
  });

  it('Change orders: status tiles filter (sent = waiting on approval); a legacy pending row shows as such', async () => {
    mount('/reports?tab=change-orders');
    const table = await screen.findByTestId('report-table');
    expect(lastCall(h.getChangeOrdersReport)).not.toHaveProperty('status');
    expect(within(table).getByText('Pending')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'CO-001' })).toHaveAttribute('href', '/project/p1/billing?tab=change-orders&open=co1');
    expect(screen.getByTestId('report-subtotal-draft')).toHaveTextContent(money(7500));
    expect(screen.getByTestId('report-status-sent')).toHaveTextContent('waiting on approval');

    fireEvent.click(screen.getByTestId('report-status-sent'));
    await waitFor(() => expect(lastCall(h.getChangeOrdersReport)).toMatchObject({ status: 'sent' }));
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('sent');
    expect(screen.getByTestId('report-status-sent')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('report-status-sent')); // again: back to every status
    await waitFor(() => expect(lastCall(h.getChangeOrdersReport)).not.toHaveProperty('status'));
  });

  it('Retainage: one row per project with held, released and the rate', async () => {
    mount('/reports?tab=retainage');
    const row = await screen.findByTestId('report-row');
    expect(row).toHaveTextContent('Pay App #2');
    expect(row).toHaveTextContent('60.0%');
    expect(row).toHaveTextContent('10% − 4 pts released');
    expect(row).toHaveTextContent(money(36000));
    expect(row).toHaveTextContent(money(24000));
    expect(screen.getByTestId('report-retainage-held')).toHaveTextContent(money(36000));
  });

  it('switching tabs keeps the tab in the address and loads that report', async () => {
    mount();
    await screen.findByTestId('report-table');
    fireEvent.click(screen.getByTestId('report-tab-retainage'));
    expect(screen.getByTestId('location')).toHaveTextContent('/reports?tab=retainage');
    expect(await screen.findByText('Pay App #2')).toBeInTheDocument();
    expect(h.getRetainageReport).toHaveBeenCalledTimes(1);
  });

  it('refreshes when billing changes anywhere', async () => {
    mount();
    await screen.findByTestId('report-table');
    expect(h.getOpenInvoicesReport).toHaveBeenCalledTimes(1);
    act(() => { h.fakeSocket.fire('entity-changed', { type: 'payment', id: 'pay9', projectId: 'p2', action: 'created', bySessionId: 'other-tab' }); });
    await waitFor(() => expect(h.getOpenInvoicesReport).toHaveBeenCalledTimes(2));
  });

  it('downloads the report on screen, as filtered, as Excel', async () => {
    mount('/reports?tab=change-orders');
    await screen.findByTestId('report-table');
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'sent' } });
    await waitFor(() => expect(lastCall(h.getChangeOrdersReport)).toMatchObject({ customerId: 'c1', status: 'sent' }));
    await screen.findByTestId('report-table');

    fireEvent.click(screen.getByRole('button', { name: /Download Excel/ }));
    await waitFor(() => expect(h.downloadReportXlsx).toHaveBeenCalledTimes(1));
    const [spec, fileName] = h.downloadReportXlsx.mock.calls[0];
    expect(fileName).toMatch(/^Change-Orders-Sent-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(spec.title).toBe('Change orders by status');
    expect(spec.details[0]).toBe('Customer: Acme Builders · Project: All projects · Archived projects included');
    expect(spec.details[1]).toBe('Status: Sent');
    expect(spec.rows).toHaveLength(2);
  });

  it('shows a failed report with a way to try again', async () => {
    h.getOpenInvoicesReport.mockRejectedValueOnce(new Error('Server is down'));
    mount();
    expect(await screen.findByText('Server is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download Excel/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('report-table')).toBeInTheDocument();
  });
});
