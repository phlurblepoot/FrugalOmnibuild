// src/utils/reportsApi.ts — client for the Reports page's API
// (server/reportRoutes.ts, admin-only). Types mirror server/reportsStore.ts.
// Money is integer cents; dates are calendar days ('YYYY-MM-DD').
import { getAuthHeaders, handleResponse } from './store';

export interface ReportFilters {
  projectId?: string;
  customerId?: string;
  /** Archived projects are included unless this is false. */
  includeArchived?: boolean;
  /** Payments received: calendar days, both inclusive. */
  from?: string;
  to?: string;
  /** Change orders: draft | sent | approved | rejected; omitted = all. */
  status?: string;
}

export type AgingBucket = 'current' | 'days31to60' | 'days61plus';
export const CHANGE_ORDER_REPORT_STATUSES = ['draft', 'sent', 'approved', 'rejected'] as const;
export type ChangeOrderStatusGroup = (typeof CHANGE_ORDER_REPORT_STATUSES)[number];

interface RowProject {
  projectId: string;
  projectName: string;
  customerId: string | null;
  customerName: string | null;
  archived: boolean;
}

export interface OpenInvoiceRow extends RowProject {
  kind: 'invoice' | 'payapp';
  id: string;
  document: string;            // 'Invoice 1001' / 'Pay App #3'
  status: string;
  date: string | null;
  daysOutstanding: number | null;
  bucket: AgingBucket | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}
export interface OpenInvoicesReport {
  rows: OpenInvoiceRow[];
  totals: { count: number; totalCents: number; paidCents: number; balanceCents: number };
  buckets: Record<AgingBucket | 'undated', number>;
}

export interface PaymentReportRow extends RowProject {
  id: string;
  date: string | null;
  targetType: 'invoice' | 'payapp';
  targetId: string;
  target: string;              // what it paid: 'Invoice 1001' / 'Pay App #3'
  method: string | null;
  note: string | null;
  amountCents: number;
}
export interface PaymentsReport {
  rows: PaymentReportRow[];
  totals: { count: number; amountCents: number };
}

export interface ChangeOrderReportRow extends RowProject {
  id: string;
  number: string | null;
  title: string | null;
  status: string;              // as stored (a legacy row may say 'pending')
  statusGroup: ChangeOrderStatusGroup;
  date: string | null;
  amountCents: number;
  scheduleImpactDays: number | null;
}
export interface StatusTotals { count: number; amountCents: number; scheduleImpactDays: number }
export interface ChangeOrdersReport {
  rows: ChangeOrderReportRow[];
  byStatus: Record<ChangeOrderStatusGroup, StatusTotals>;
  totals: StatusTotals;
}

export interface RetainageReportRow extends RowProject {
  payAppId: string;
  payAppNumber: number;
  applicationDate: string | null;
  contractSumCents: number;
  completedStoredCents: number;
  retainageHeldCents: number;
  retainageReleasedCents: number;
  retainageMode: 'uniform' | 'perLine';
  retainagePercent: number;
  releasedPoints: number;
}
export interface RetainageReport {
  rows: RetainageReportRow[];
  totals: { contractSumCents: number; completedStoredCents: number; retainageHeldCents: number; retainageReleasedCents: number };
}

export interface ReportFilterOptions {
  projects: { id: string; name: string; customerId: string | null; archived: boolean }[];
  customers: { id: string; name: string }[];
}

export const reportQuery = (f: ReportFilters): string => {
  const q = new URLSearchParams();
  if (f.projectId) q.set('projectId', f.projectId);
  if (f.customerId) q.set('customerId', f.customerId);
  if (f.includeArchived === false) q.set('includeArchived', '0');
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.status) q.set('status', f.status);
  const s = q.toString();
  return s ? `?${s}` : '';
};

const getJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, { headers: getAuthHeaders() });
  await handleResponse(res);
  return res.json();
};

export const getReportOptions = (): Promise<ReportFilterOptions> => getJson('/api/reports/options');
export const getOpenInvoicesReport = (f: ReportFilters): Promise<OpenInvoicesReport> =>
  getJson(`/api/reports/open-invoices${reportQuery(f)}`);
export const getPaymentsReport = (f: ReportFilters): Promise<PaymentsReport> =>
  getJson(`/api/reports/payments${reportQuery(f)}`);
export const getChangeOrdersReport = (f: ReportFilters): Promise<ChangeOrdersReport> =>
  getJson(`/api/reports/change-orders${reportQuery(f)}`);
export const getRetainageReport = (f: ReportFilters): Promise<RetainageReport> =>
  getJson(`/api/reports/retainage${reportQuery(f)}`);
