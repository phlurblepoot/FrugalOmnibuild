// src/pages/reports/ReportTables.tsx — the four reports on screen: a row of
// summary tiles and the report's table, with its totals as the last rows.
// Ordering is fixed (the server sorts each report); the Excel download's
// filter buttons are the way to re-sort.
import React from 'react';
import { Link } from 'react-router-dom';
import { CreditCard, FileText, Landmark } from 'lucide-react';
import type {
  OpenInvoicesReport, PaymentsReport, ChangeOrdersReport, RetainageReport, AgingBucket, ChangeOrderStatusGroup,
} from '../../utils/reportsApi';
import { CHANGE_ORDER_REPORT_STATUSES } from '../../utils/reportsApi';
import { formatMoney } from '../../utils/money';
import { Card, CardBody, EmptyState, StatusPill, Table, TBody, TD, TH, THead, TR } from '../../components/ui';
import type { PillTone } from '../../components/ui';
import { ChangeOrderStatusPill, CO_STATUS_META } from '../../components/ui/BillingPills';
import { paymentMethodLabel } from '../project/billing/PaymentDetailModal';
import { AGING_LABELS, fractionComplete, retainageRateLabel } from './reportLabels';
import { formatDay } from './reportDates';

const AGING_TONES: Record<AgingBucket, PillTone> = { current: 'emerald', days31to60: 'amber', days61plus: 'red' };

const NUM = 'text-right tabular-nums';
const billingLink = (projectId: string, tab: string, open?: string) =>
  `/project/${projectId}/billing?tab=${tab}${open ? `&open=${encodeURIComponent(open)}` : ''}`;
const ProjectCell: React.FC<{ name: string; archived: boolean }> = ({ name, archived }) => (
  <span className="inline-flex items-center gap-1.5">{name}{archived && <StatusPill>Archived</StatusPill>}</span>
);

// A summary figure above a report. `onClick` makes it a filter toggle.
const Tile: React.FC<{
  label: string; value: string; sub?: string; tone?: string; testId?: string;
  onClick?: () => void; pressed?: boolean;
}> = ({ label, value, sub, tone = 'border-edge bg-raised', testId, onClick, pressed }) => {
  const body = (
    <>
      <p className="text-[11px] font-medium text-ink-faint">{label}</p>
      <p className="text-lg font-bold text-ink tabular-nums">{value}</p>
      {sub && <p className="text-xs text-ink-faint">{sub}</p>}
    </>
  );
  const cls = `rounded-lg border p-3 text-left ${tone}`;
  return onClick ? (
    <button type="button" data-testid={testId} onClick={onClick} aria-pressed={pressed}
      className={`${cls} transition-shadow hover:shadow-sm ${pressed ? 'ring-2 ring-accent-500' : ''}`}>{body}</button>
  ) : <div data-testid={testId} className={cls}>{body}</div>;
};

const BUCKET_TILE_TONES: Record<AgingBucket | 'undated', string> = {
  current: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-400/10 dark:border-emerald-400/20',
  days31to60: 'bg-amber-50 border-amber-200 dark:bg-amber-400/10 dark:border-amber-400/20',
  days61plus: 'bg-red-50 border-red-200 dark:bg-red-400/10 dark:border-red-400/20',
  undated: 'border-edge bg-raised',
};

const TotalRow: React.FC<{ children: React.ReactNode; testId?: string }> = ({ children, testId }) => (
  <TR className="bg-sunken font-semibold text-ink" data-testid={testId}>{children}</TR>
);

// ── Open invoices / AR aging ─────────────────────────────────────────────────

export const OpenInvoicesView: React.FC<{ report: OpenInvoicesReport }> = ({ report }) => {
  const { totals, buckets } = report;
  const bucketKeys: (AgingBucket | 'undated')[] = ['current', 'days31to60', 'days61plus', ...(buckets.undated ? ['undated' as const] : [])];
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        <Tile label="Outstanding" value={formatMoney(totals.balanceCents)}
          sub={`${totals.count} open document${totals.count === 1 ? '' : 's'}`} testId="report-outstanding" />
        {bucketKeys.map(k => (
          <Tile key={k} label={AGING_LABELS[k]} value={formatMoney(buckets[k])} tone={BUCKET_TILE_TONES[k]} testId={`report-bucket-${k}`} />
        ))}
      </div>
      <Card>
        <CardBody className={report.rows.length ? 'p-0' : undefined}>
          {report.rows.length === 0 ? (
            <EmptyState icon={<FileText size={20} />} title="Nothing outstanding"
              description="Every billed invoice and pay application matching these filters is paid in full." />
          ) : (
            <Table data-testid="report-table">
              <THead><TR>
                <TH>Customer</TH><TH>Project</TH><TH>Document</TH><TH>Date</TH><TH className="text-right">Days</TH>
                <TH>Aging</TH><TH className="text-right">Total</TH><TH className="text-right">Paid</TH><TH className="text-right">Balance</TH>
              </TR></THead>
              <TBody>
                {report.rows.map(r => (
                  <TR key={`${r.kind}-${r.id}`} data-testid="report-row">
                    <TD className="text-ink-soft">{r.customerName ?? '—'}</TD>
                    <TD className="text-ink-soft"><ProjectCell name={r.projectName} archived={r.archived} /></TD>
                    <TD className="font-medium text-ink whitespace-nowrap">
                      <Link className="hover:underline" to={r.kind === 'invoice' ? billingLink(r.projectId, 'invoices', r.id) : billingLink(r.projectId, 'pay-apps')}>{r.document}</Link>
                    </TD>
                    <TD className="text-ink-soft whitespace-nowrap">{formatDay(r.date)}</TD>
                    <TD className={`${NUM} text-ink-soft`}>{r.daysOutstanding ?? '—'}</TD>
                    <TD>{r.bucket ? <StatusPill tone={AGING_TONES[r.bucket]}>{AGING_LABELS[r.bucket]}</StatusPill> : <span className="text-ink-faint">{AGING_LABELS.undated}</span>}</TD>
                    <TD className={`${NUM} text-ink-soft`}>{formatMoney(r.totalCents)}</TD>
                    <TD className={`${NUM} text-ink-soft`}>{formatMoney(r.paidCents)}</TD>
                    <TD className={`${NUM} font-semibold text-ink`}>{formatMoney(r.balanceCents)}</TD>
                  </TR>
                ))}
                <TotalRow testId="report-total">
                  <TD colSpan={6}>Total ({totals.count})</TD>
                  <TD className={NUM}>{formatMoney(totals.totalCents)}</TD>
                  <TD className={NUM}>{formatMoney(totals.paidCents)}</TD>
                  <TD className={NUM}>{formatMoney(totals.balanceCents)}</TD>
                </TotalRow>
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  );
};

// ── Payments received ────────────────────────────────────────────────────────

export const PaymentsView: React.FC<{ report: PaymentsReport; rangeText: string }> = ({ report, rangeText }) => (
  <>
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Tile label="Received" value={formatMoney(report.totals.amountCents)} sub={rangeText} testId="report-received" />
      <Tile label="Payments" value={String(report.totals.count)} />
    </div>
    <Card>
      <CardBody className={report.rows.length ? 'p-0' : undefined}>
        {report.rows.length === 0 ? (
          <EmptyState icon={<CreditCard size={20} />} title="No payments in this range"
            description="Pick another date range, or clear the customer and project filters." />
        ) : (
          <Table data-testid="report-table">
            <THead><TR>
              <TH>Date</TH><TH>Customer</TH><TH>Project</TH><TH>Applied to</TH><TH>Method</TH><TH>Note</TH><TH className="text-right">Amount</TH>
            </TR></THead>
            <TBody>
              {report.rows.map(r => (
                <TR key={r.id} data-testid="report-row">
                  <TD className="text-ink-soft whitespace-nowrap">
                    <Link className="hover:underline" to={billingLink(r.projectId, 'payments', r.id)}>{formatDay(r.date)}</Link>
                  </TD>
                  <TD className="text-ink-soft">{r.customerName ?? '—'}</TD>
                  <TD className="text-ink-soft"><ProjectCell name={r.projectName} archived={r.archived} /></TD>
                  <TD className="font-medium text-ink whitespace-nowrap">{r.target}</TD>
                  <TD className="text-ink-soft">{paymentMethodLabel(r.method)}</TD>
                  <TD className="max-w-[16rem] truncate text-ink-soft" title={r.note ?? ''}>{r.note || '—'}</TD>
                  <TD className={`${NUM} font-semibold text-ink`}>{formatMoney(r.amountCents)}</TD>
                </TR>
              ))}
              <TotalRow testId="report-total">
                <TD colSpan={6}>Total ({report.totals.count})</TD>
                <TD className={NUM}>{formatMoney(report.totals.amountCents)}</TD>
              </TotalRow>
            </TBody>
          </Table>
        )}
      </CardBody>
    </Card>
  </>
);

// ── Change orders by status ──────────────────────────────────────────────────

const impact = (days: number | null) => (days ? `${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'}` : '—');

export const ChangeOrdersView: React.FC<{
  report: ChangeOrdersReport;
  status: ChangeOrderStatusGroup | '';
  onStatus: (s: ChangeOrderStatusGroup | '') => void;
}> = ({ report, status, onStatus }) => (
  <>
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {CHANGE_ORDER_REPORT_STATUSES.map(s => {
        const b = report.byStatus[s];
        return (
          <Tile key={s} testId={`report-status-${s}`}
            label={s === 'sent' ? 'Sent — waiting on approval' : CO_STATUS_META[s].label}
            value={formatMoney(b.amountCents)}
            sub={`${b.count} change order${b.count === 1 ? '' : 's'}${b.scheduleImpactDays ? ` · ${impact(b.scheduleImpactDays)}` : ''}`}
            pressed={status === s} onClick={() => onStatus(status === s ? '' : s)} />
        );
      })}
    </div>
    <Card>
      <CardBody className={report.rows.length ? 'p-0' : undefined}>
        {report.rows.length === 0 ? (
          <EmptyState icon={<FileText size={20} />} title="No change orders"
            description={status ? `No ${CO_STATUS_META[status].label.toLowerCase()} change orders match these filters.` : 'No change orders match these filters.'} />
        ) : (
          <Table data-testid="report-table">
            <THead><TR>
              <TH>Project</TH><TH>Customer</TH><TH>CO</TH><TH>Title</TH><TH>Status</TH><TH>Date</TH>
              <TH className="text-right">Amount</TH><TH className="text-right">Schedule impact</TH>
            </TR></THead>
            <TBody>
              {report.rows.map(r => (
                <TR key={r.id} data-testid="report-row">
                  <TD className="text-ink-soft"><ProjectCell name={r.projectName} archived={r.archived} /></TD>
                  <TD className="text-ink-soft">{r.customerName ?? '—'}</TD>
                  <TD className="font-medium text-ink whitespace-nowrap">
                    <Link className="hover:underline" to={billingLink(r.projectId, 'change-orders', r.id)}>CO-{r.number || '—'}</Link>
                  </TD>
                  <TD className="text-ink-soft">{r.title || '—'}</TD>
                  <TD><ChangeOrderStatusPill status={r.status} /></TD>
                  <TD className="text-ink-soft whitespace-nowrap">{formatDay(r.date)}</TD>
                  <TD className={`${NUM} text-ink`}>{formatMoney(r.amountCents)}</TD>
                  <TD className={`${NUM} text-ink-soft`}>{impact(r.scheduleImpactDays)}</TD>
                </TR>
              ))}
              {/* Per-status subtotals only when the table mixes statuses. */}
              {!status && CHANGE_ORDER_REPORT_STATUSES.filter(s => report.byStatus[s].count > 0).map(s => (
                <TR key={`sub-${s}`} className="text-ink-soft" data-testid={`report-subtotal-${s}`}>
                  <TD colSpan={6}>{CO_STATUS_META[s].label} ({report.byStatus[s].count})</TD>
                  <TD className={NUM}>{formatMoney(report.byStatus[s].amountCents)}</TD>
                  <TD className={NUM}>{impact(report.byStatus[s].scheduleImpactDays)}</TD>
                </TR>
              ))}
              <TotalRow testId="report-total">
                <TD colSpan={6}>Total ({report.totals.count})</TD>
                <TD className={NUM}>{formatMoney(report.totals.amountCents)}</TD>
                <TD className={NUM}>{impact(report.totals.scheduleImpactDays)}</TD>
              </TotalRow>
            </TBody>
          </Table>
        )}
      </CardBody>
    </Card>
  </>
);

// ── Retainage held ───────────────────────────────────────────────────────────

const pct = (f: number | null) => (f == null ? '—' : `${(f * 100).toFixed(1)}%`);

export const RetainageView: React.FC<{ report: RetainageReport }> = ({ report }) => {
  const t = report.totals;
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Retainage held" value={formatMoney(t.retainageHeldCents)}
          sub={`${report.rows.length} project${report.rows.length === 1 ? '' : 's'}`} testId="report-retainage-held" />
        <Tile label="Released" value={formatMoney(t.retainageReleasedCents)} />
        <Tile label="Completed & stored" value={formatMoney(t.completedStoredCents)} sub={`${pct(fractionComplete(t))} of ${formatMoney(t.contractSumCents)}`} />
      </div>
      <Card>
        <CardBody className={report.rows.length ? 'p-0' : undefined}>
          {report.rows.length === 0 ? (
            <EmptyState icon={<Landmark size={20} />} title="No finalized pay applications"
              description="Retainage shows here once a project has a finalized AIA pay application." />
          ) : (
            <Table data-testid="report-table">
              <THead><TR>
                <TH>Customer</TH><TH>Project</TH><TH>Latest pay app</TH><TH className="text-right">Contract sum</TH>
                <TH className="text-right">Completed &amp; stored</TH><TH className="text-right">%</TH><TH>Rate</TH>
                <TH className="text-right">Held</TH><TH className="text-right">Released</TH>
              </TR></THead>
              <TBody>
                {report.rows.map(r => (
                  <TR key={r.projectId} data-testid="report-row">
                    <TD className="text-ink-soft">{r.customerName ?? '—'}</TD>
                    <TD className="text-ink-soft"><ProjectCell name={r.projectName} archived={r.archived} /></TD>
                    <TD className="font-medium text-ink whitespace-nowrap">
                      <Link className="hover:underline" to={billingLink(r.projectId, 'pay-apps')}>Pay App #{r.payAppNumber}</Link>
                      <span className="block text-xs font-normal text-ink-faint">{formatDay(r.applicationDate)}</span>
                    </TD>
                    <TD className={`${NUM} text-ink-soft`}>{formatMoney(r.contractSumCents)}</TD>
                    <TD className={`${NUM} text-ink-soft`}>{formatMoney(r.completedStoredCents)}</TD>
                    <TD className={`${NUM} text-ink-soft`}>{pct(fractionComplete(r))}</TD>
                    <TD className="text-ink-soft">{retainageRateLabel(r)}</TD>
                    <TD className={`${NUM} font-semibold text-ink`}>{formatMoney(r.retainageHeldCents)}</TD>
                    <TD className={`${NUM} text-ink-soft`}>{formatMoney(r.retainageReleasedCents)}</TD>
                  </TR>
                ))}
                <TotalRow testId="report-total">
                  <TD colSpan={3}>Total ({report.rows.length})</TD>
                  <TD className={NUM}>{formatMoney(t.contractSumCents)}</TD>
                  <TD className={NUM}>{formatMoney(t.completedStoredCents)}</TD>
                  <TD className={NUM}>{pct(fractionComplete(t))}</TD>
                  <TD />
                  <TD className={NUM}>{formatMoney(t.retainageHeldCents)}</TD>
                  <TD className={NUM}>{formatMoney(t.retainageReleasedCents)}</TD>
                </TotalRow>
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  );
};

