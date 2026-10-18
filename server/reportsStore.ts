// server/reportsStore.ts
//
// The Reports page (admin-only, spec
// docs/superpowers/specs/2026-10-06-reports-design.md): four read-only reports
// across every project — open invoices / AR aging, payments received, change
// orders by status, retainage held. Each takes the page's filters and returns
// its rows plus totals, all money in integer cents. No tables of its own:
// every figure comes from the store that already owns it (listBilledDocuments,
// listChangeOrders, computeG702), and aging from the dashboard's own helpers,
// so a report never disagrees with the billing screens or the dashboard.
import type Database from 'better-sqlite3';
import { listBilledDocuments, listChangeOrders, toCents, CHANGE_ORDER_STATUSES } from './billingStore';
import { listPayAppRows, computeG702, retainageReleasedCents, type RetainageMode } from './aiaStore';
import { billedDocDateMs, ageDays, agingBucket, type AgingBucket } from './dashboardStore';
import { billingDay } from '../src/utils/billingDates';

export class ValidationError extends Error {}

export interface ReportFilters {
  projectId?: string;
  customerId?: string;
  // Archived projects are included unless this is false: money owed on a job
  // doesn't go away when the job is archived. (The dashboard leaves them out,
  // so unticking this is how the open-invoices figures match it.)
  includeArchived?: boolean;
  // Payments received: calendar days 'YYYY-MM-DD', both inclusive.
  from?: string;
  to?: string;
  // Change orders: one of CHANGE_ORDER_STATUSES; omitted = every status.
  status?: string;
}

/** Who and what a report row belongs to. */
interface RowProject {
  projectId: string;
  projectName: string;
  customerId: string | null;
  customerName: string | null;
  archived: boolean;
}

interface ScopeProject { id: string; name: string; customerId: string | null; customerName: string | null; archived: boolean }

// Every project the filters keep, by name.
function projectsInScope(db: Database.Database, f: ReportFilters): ScopeProject[] {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.customerId, c.name AS customerName,
           COALESCE(json_extract(p.meta, '$.archived'), 0) AS archived
    FROM projects p LEFT JOIN customers c ON c.id = p.customerId
    ORDER BY p.name COLLATE NOCASE, p.id
  `).all() as { id: string; name: string | null; customerId: string | null; customerName: string | null; archived: number }[];
  return rows
    .map(r => ({
      id: r.id, name: r.name ?? 'Untitled', customerId: r.customerId ?? null,
      customerName: r.customerName ?? null, archived: !!Number(r.archived),
    }))
    .filter(p =>
      (!f.projectId || p.id === f.projectId) &&
      (!f.customerId || p.customerId === f.customerId) &&
      (f.includeArchived !== false || !p.archived));
}

const rowProject = (p: ScopeProject): RowProject => ({
  projectId: p.id, projectName: p.name, customerId: p.customerId, customerName: p.customerName, archived: p.archived,
});

// A stored date as the calendar day it stands for, by billing's one rule
// (src/utils/billingDates.ts): invoice, change order and payment dates are
// epoch ms of the day picked in the editor (UTC midnight, `new Date('YYYY-MM-DD')`),
// read back as that day; a payment stamped "now" is this server's local day;
// a pay app's applicationDate is already 'YYYY-MM-DD'.
const dayOf = billingDay;

// What a document is called on every report: 'Invoice 1001' / 'Pay App #3'.
function documentLabel(kind: 'invoice' | 'payapp', number: string | number | null | undefined): string {
  if (kind === 'payapp') return `Pay App #${number ?? ''}`;
  return number != null && number !== '' ? `Invoice ${number}` : 'Invoice';
}

const byText = (a: string | null, b: string | null): number =>
  (a ?? '').localeCompare(b ?? '', undefined, { sensitivity: 'base', numeric: true });

// ── Open invoices / AR aging ─────────────────────────────────────────────────

export interface OpenInvoiceRow extends RowProject {
  kind: 'invoice' | 'payapp';
  id: string;
  document: string;
  status: string;
  date: string | null;
  // Counted from the document date — there are no due dates — exactly as the
  // dashboard's aging does. Null (and no bucket) for an undated document.
  daysOutstanding: number | null;
  bucket: AgingBucket | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
}

export interface OpenInvoicesReport {
  rows: OpenInvoiceRow[];
  totals: { count: number; totalCents: number; paidCents: number; balanceCents: number };
  // Balance per bucket. The three dated buckets are the dashboard's;
  // `undated` holds documents with no date, which the dashboard leaves out of
  // its buckets (but not out of Outstanding).
  buckets: Record<AgingBucket | 'undated', number>;
}

// Every billed (non-draft) invoice and AIA pay application with a balance over
// $0, whatever its status says — the same population and balances as the
// dashboard's Outstanding and Aging (listBilledDocuments).
export function openInvoicesReport(db: Database.Database, f: ReportFilters = {}, nowMs = Date.now()): OpenInvoicesReport {
  const rows: OpenInvoiceRow[] = [];
  for (const p of projectsInScope(db, f)) {
    for (const doc of listBilledDocuments(db, p.id)) {
      if (doc.balanceCents <= 0) continue;
      const dateMs = billedDocDateMs(doc.date);
      const daysOutstanding = dateMs == null ? null : ageDays(dateMs, nowMs);
      rows.push({
        ...rowProject(p),
        kind: doc.kind, id: doc.id, document: documentLabel(doc.kind, doc.number), status: doc.status,
        date: dayOf(doc.date), daysOutstanding,
        bucket: daysOutstanding == null ? null : agingBucket(daysOutstanding),
        totalCents: doc.totalCents, paidCents: doc.paidCents, balanceCents: doc.balanceCents,
      });
    }
  }
  // Oldest first (undated last), then by customer, project and document.
  rows.sort((a, b) =>
    (b.daysOutstanding ?? -1) - (a.daysOutstanding ?? -1) ||
    byText(a.customerName, b.customerName) || byText(a.projectName, b.projectName) || byText(a.document, b.document));

  const totals = { count: rows.length, totalCents: 0, paidCents: 0, balanceCents: 0 };
  const buckets: OpenInvoicesReport['buckets'] = { current: 0, days31to60: 0, days61plus: 0, undated: 0 };
  for (const r of rows) {
    totals.totalCents += r.totalCents;
    totals.paidCents += r.paidCents;
    totals.balanceCents += r.balanceCents;
    buckets[r.bucket ?? 'undated'] += r.balanceCents;
  }
  return { rows, totals, buckets };
}

// ── Payments received ────────────────────────────────────────────────────────

export interface PaymentReportRow extends RowProject {
  id: string;
  date: string | null;
  targetType: 'invoice' | 'payapp';
  targetId: string;
  // What it paid: 'Invoice 1001' / 'Pay App #3'.
  target: string;
  method: string | null;
  note: string | null;
  amountCents: number;
}

export interface PaymentsReport {
  rows: PaymentReportRow[];
  totals: { count: number; amountCents: number };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function checkDay(value: string | undefined, label: string): void {
  if (value !== undefined && !DAY_RE.test(value)) throw new ValidationError(`${label} must be a date (YYYY-MM-DD)`);
}

// Payments whose date falls in [from, to] (either end may be open), newest
// first like the Payments tab. Payment attachments are never part of it — they
// show on the payment only.
export function paymentsReport(db: Database.Database, f: ReportFilters = {}): PaymentsReport {
  checkDay(f.from, 'From');
  checkDay(f.to, 'To');
  const scope = new Map(projectsInScope(db, f).map(p => [p.id, p]));
  const payments = db.prepare(`
    SELECT p.id, p.targetType, p.targetId, p.date, p.amount, p.method, p.note,
           COALESCE(i.projectId, a.projectId) AS projectId, i.number AS invoiceNumber, a.number AS payAppNumber
    FROM payments p
    LEFT JOIN invoices i ON p.targetType = 'invoice' AND p.targetId = i.id
    LEFT JOIN aia_pay_apps a ON p.targetType = 'payapp' AND p.targetId = a.id
    ORDER BY p.date DESC, p.createdAt DESC, p.rowid DESC
  `).all() as {
    id: string; targetType: 'invoice' | 'payapp'; targetId: string; date: number | null; amount: number;
    method: string | null; note: string | null; projectId: string | null; invoiceNumber: string | null; payAppNumber: number | null;
  }[];

  const rows: PaymentReportRow[] = [];
  for (const pay of payments) {
    const p = pay.projectId ? scope.get(pay.projectId) : undefined;
    if (!p) continue; // out of scope, or what it paid is gone
    const date = dayOf(pay.date);
    if ((f.from || f.to) && !date) continue;
    if (f.from && date! < f.from) continue;
    if (f.to && date! > f.to) continue;
    rows.push({
      ...rowProject(p),
      id: pay.id, date, targetType: pay.targetType, targetId: pay.targetId,
      target: documentLabel(pay.targetType, pay.targetType === 'invoice' ? pay.invoiceNumber : pay.payAppNumber),
      method: pay.method ?? null, note: pay.note ?? null, amountCents: toCents(pay.amount),
    });
  }
  return { rows, totals: { count: rows.length, amountCents: rows.reduce((a, r) => a + r.amountCents, 0) } };
}

// ── Change orders by status ──────────────────────────────────────────────────

export type ChangeOrderStatusGroup = (typeof CHANGE_ORDER_STATUSES)[number];

export interface ChangeOrderReportRow extends RowProject {
  id: string;
  number: string | null;
  title: string | null;
  // As stored (a legacy row may say 'pending'), and the status it counts
  // under: 'pending' — or anything else outside the four — counts as draft.
  status: string;
  statusGroup: ChangeOrderStatusGroup;
  date: string | null;
  amountCents: number;
  scheduleImpactDays: number | null;
}

interface StatusTotals { count: number; amountCents: number; scheduleImpactDays: number }

export interface ChangeOrdersReport {
  rows: ChangeOrderReportRow[];
  byStatus: Record<ChangeOrderStatusGroup, StatusTotals>;
  totals: StatusTotals;
}

export function changeOrdersReport(db: Database.Database, f: ReportFilters = {}): ChangeOrdersReport {
  if (f.status !== undefined && !(CHANGE_ORDER_STATUSES as readonly string[]).includes(f.status)) {
    throw new ValidationError(`Invalid change order status: ${f.status}`);
  }
  const rows: ChangeOrderReportRow[] = [];
  for (const p of projectsInScope(db, f)) {
    const cos = listChangeOrders(db, p.id)
      .sort((a, b) => byText(a.number, b.number) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
    for (const co of cos) {
      const statusGroup = ((CHANGE_ORDER_STATUSES as readonly string[]).includes(co.status) ? co.status : 'draft') as ChangeOrderStatusGroup;
      if (f.status && statusGroup !== f.status) continue;
      rows.push({
        ...rowProject(p),
        id: co.id, number: co.number ?? null, title: co.title || co.description || null,
        status: co.status, statusGroup, date: dayOf(co.date),
        // The canonical persisted total (billingStore: Σ line cents + lump sum,
        // written on save) — what the contract total adds for an approved CO.
        // A legacy row from before line items carries its value only here.
        amountCents: toCents(co.amount), scheduleImpactDays: co.scheduleImpactDays ?? null,
      });
    }
  }
  const zero = (): StatusTotals => ({ count: 0, amountCents: 0, scheduleImpactDays: 0 });
  const byStatus = Object.fromEntries(CHANGE_ORDER_STATUSES.map(s => [s, zero()])) as ChangeOrdersReport['byStatus'];
  const totals = zero();
  for (const r of rows) {
    for (const t of [byStatus[r.statusGroup], totals]) {
      t.count++;
      t.amountCents += r.amountCents;
      t.scheduleImpactDays += r.scheduleImpactDays ?? 0;
    }
  }
  return { rows, byStatus, totals };
}

// ── Retainage held ───────────────────────────────────────────────────────────

export interface RetainageReportRow extends RowProject {
  payAppId: string;
  payAppNumber: number;
  applicationDate: string | null;
  // G702 of the project's latest non-draft pay application: line 3 (contract
  // sum to date), line 4 (completed & stored to date), line 5 (retainage held).
  contractSumCents: number;
  completedStoredCents: number;
  retainageHeldCents: number;
  // Let go by releases up to that application (aiaStore.retainageReleasedCents).
  retainageReleasedCents: number;
  retainageMode: RetainageMode;
  retainagePercent: number;   // the base rate
  releasedPoints: number;     // percentage points released so far
}

export interface RetainageReport {
  rows: RetainageReportRow[];
  totals: { contractSumCents: number; completedStoredCents: number; retainageHeldCents: number; retainageReleasedCents: number };
}

// One row per project with a non-draft pay application. Retainage is
// cumulative on a G702, so the latest application holds the whole picture.
export function retainageReport(db: Database.Database, f: ReportFilters = {}): RetainageReport {
  const rows: RetainageReportRow[] = [];
  for (const p of projectsInScope(db, f)) {
    const billed = listPayAppRows(db, p.id).filter(a => a.status !== 'draft');
    const latest = billed[billed.length - 1];
    if (!latest) continue;
    const g = computeG702(db, latest.id);
    rows.push({
      ...rowProject(p),
      payAppId: latest.id, payAppNumber: latest.number, applicationDate: dayOf(latest.applicationDate),
      contractSumCents: g.L3contractSumToDateCents,
      completedStoredCents: g.L4totalCompletedStoredCents,
      retainageHeldCents: g.L5retainageCents,
      retainageReleasedCents: retainageReleasedCents(db, latest.id),
      retainageMode: g.retainage.mode,
      retainagePercent: g.retainage.baseWorkPercent,
      releasedPoints: g.retainage.cumulativeReleasedPoints,
    });
  }
  const totals = { contractSumCents: 0, completedStoredCents: 0, retainageHeldCents: 0, retainageReleasedCents: 0 };
  for (const r of rows) {
    totals.contractSumCents += r.contractSumCents;
    totals.completedStoredCents += r.completedStoredCents;
    totals.retainageHeldCents += r.retainageHeldCents;
    totals.retainageReleasedCents += r.retainageReleasedCents;
  }
  return { rows, totals };
}

// ── Filter choices ───────────────────────────────────────────────────────────

export interface ReportFilterOptions {
  projects: { id: string; name: string; customerId: string | null; archived: boolean }[];
  customers: { id: string; name: string }[];
}

export function reportFilterOptions(db: Database.Database): ReportFilterOptions {
  const projects = projectsInScope(db, {}).map(p => ({ id: p.id, name: p.name, customerId: p.customerId, archived: p.archived }));
  const customers = db.prepare('SELECT id, name FROM customers ORDER BY name COLLATE NOCASE, id').all() as { id: string; name: string }[];
  return { projects, customers };
}
