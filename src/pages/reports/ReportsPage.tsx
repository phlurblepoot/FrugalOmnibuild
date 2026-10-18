// src/pages/reports/ReportsPage.tsx — Reports (admin-only, spec
// docs/superpowers/specs/2026-10-06-reports-design.md): billing reports
// across every project — open invoices / AR aging, payments received, change
// orders by status, retainage held — filtered by customer and project, with an
// Excel download of the report as filtered. The tab is kept in the address
// (?tab=), like the Billing tabs; filters are per visit.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, ShieldAlert } from 'lucide-react';
import {
  type ReportFilters, type ReportFilterOptions, type ChangeOrderStatusGroup,
  type OpenInvoicesReport, type PaymentsReport, type ChangeOrdersReport, type RetainageReport,
  CHANGE_ORDER_REPORT_STATUSES,
  getReportOptions, getOpenInvoicesReport, getPaymentsReport, getChangeOrdersReport, getRetainageReport,
} from '../../utils/reportsApi';
import { Button, Card, CardBody, Checkbox, EmptyState, Field, Input, Select, Skeleton } from '../../components/ui';
import { CO_STATUS_META } from '../../components/ui/BillingPills';
import { useLiveQuery, type EntityType } from '../../hooks/useLiveQuery';
import { useToast } from '../../components/Toast';
import { OpenInvoicesView, PaymentsView, ChangeOrdersView, RetainageView } from './ReportTables';
import {
  type SheetSpec, openInvoicesSheet, paymentsSheet, changeOrdersSheet, retainageSheet, downloadReportXlsx,
} from './reportsExcel';
import { DATE_PRESETS, DEFAULT_DATE_PRESET, type DatePreset, presetRange, rangeLabel, ymd } from './reportDates';

export const REPORT_TABS = [
  { value: 'open-invoices', label: 'Open invoices' },
  { value: 'payments', label: 'Payments received' },
  { value: 'change-orders', label: 'Change orders' },
  { value: 'retainage', label: 'Retainage' },
] as const;
type ReportTab = (typeof REPORT_TABS)[number]['value'];
const REPORT_TAB_VALUES = REPORT_TABS.map(t => t.value) as readonly string[];

type AnyReport = OpenInvoicesReport | PaymentsReport | ChangeOrdersReport | RetainageReport;
const FETCHERS: Record<ReportTab, (f: ReportFilters) => Promise<AnyReport>> = {
  'open-invoices': getOpenInvoicesReport,
  payments: getPaymentsReport,
  'change-orders': getChangeOrdersReport,
  retainage: getRetainageReport,
};

// Anything that can move a figure on any report.
const LIVE_TYPES: EntityType[] = ['invoice', 'payment', 'aiaPayApp', 'aiaSov', 'changeOrder', 'project', 'customer'];

const isAdmin = () => { try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; } catch { return false; } };

type Result = { key: string; data: AnyReport } | { key: string; error: string };

export const ReportsPage: React.FC = () => {
  const admin = isAdmin();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: ReportTab = REPORT_TAB_VALUES.includes(tabParam ?? '') ? (tabParam as ReportTab) : 'open-invoices';
  const setTab = (next: ReportTab) => setSearchParams(prev => {
    const p = new URLSearchParams(prev);
    p.set('tab', next);
    return p;
  }, { replace: true });

  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [customerId, setCustomerId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [includeArchived, setIncludeArchived] = useState(true);
  const [datePreset, setDatePreset] = useState<DatePreset>(DEFAULT_DATE_PRESET);
  const [from, setFrom] = useState(() => presetRange(DEFAULT_DATE_PRESET).from);
  const [to, setTo] = useState(() => presetRange(DEFAULT_DATE_PRESET).to);
  const [coStatus, setCoStatus] = useState<ChangeOrderStatusGroup | ''>('');
  const [result, setResult] = useState<Result | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Only what this tab's report takes, so switching tabs or changing another
  // tab's filter never refetches for nothing.
  const filters = useMemo<ReportFilters>(() => ({
    projectId: projectId || undefined,
    customerId: customerId || undefined,
    includeArchived,
    ...(tab === 'payments' ? { from: from || undefined, to: to || undefined } : {}),
    ...(tab === 'change-orders' && coStatus ? { status: coStatus } : {}),
  }), [tab, projectId, customerId, includeArchived, from, to, coStatus]);
  const key = JSON.stringify([tab, filters]);

  // The latest request wins: a slow answer for filters already changed again
  // is dropped.
  const seq = useRef(0);
  const load = () => {
    if (!admin) return;
    const id = ++seq.current;
    FETCHERS[tab](filters)
      .then(data => { if (id === seq.current) setResult({ key, data }); })
      .catch(e => { if (id === seq.current) setResult({ key, error: e instanceof Error ? e.message : 'Failed to load the report' }); });
  };
  // useLiveQuery runs the first load and every live refresh; this effect
  // covers a tab or filter change after that.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useLiveQuery(load, { types: LIVE_TYPES });
  useLiveQuery(() => { if (admin) getReportOptions().then(setOptions).catch(() => setOptions({ projects: [], customers: [] })); }, { types: ['project', 'customer'] });

  if (!admin) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 md:px-8">
        <EmptyState icon={<ShieldAlert size={22} />} title="Reports are admin-only"
          description="Ask an administrator for access to billing reports." />
      </div>
    );
  }

  const projectChoices = (options?.projects ?? [])
    .filter(p => (!customerId || p.customerId === customerId) && (includeArchived || !p.archived));
  const changeCustomer = (id: string) => {
    setCustomerId(id);
    const p = options?.projects.find(x => x.id === projectId);
    if (id && p && p.customerId !== id) setProjectId('');
  };
  const changeArchived = (on: boolean) => {
    setIncludeArchived(on);
    if (!on && options?.projects.find(x => x.id === projectId)?.archived) setProjectId('');
  };
  const changePreset = (preset: DatePreset) => {
    setDatePreset(preset);
    if (preset === 'custom') return;
    const r = presetRange(preset);
    setFrom(r.from);
    setTo(r.to);
  };

  const current = result && result.key === key ? result : null;
  const data = current && 'data' in current ? current.data : null;

  // ── Excel ──
  const customerName = options?.customers.find(c => c.id === customerId)?.name;
  const projectName = options?.projects.find(p => p.id === projectId)?.name;
  const today = ymd(new Date());
  const details = (): string[] => [
    [
      `Customer: ${customerName ?? 'All customers'}`,
      `Project: ${projectName ?? 'All projects'}`,
      includeArchived ? 'Archived projects included' : 'Archived projects left out',
    ].join(' · '),
    ...(tab === 'payments' ? [`Dates: ${rangeLabel(from, to)}`] : []),
    ...(tab === 'change-orders' ? [`Status: ${coStatus ? CO_STATUS_META[coStatus].label : 'All statuses'}`] : []),
    `As of ${new Date().toLocaleString()}`,
  ];
  const sheetFor = (report: AnyReport): { spec: SheetSpec; fileName: string } => {
    switch (tab) {
      case 'open-invoices':
        return { spec: openInvoicesSheet(report as OpenInvoicesReport, details()), fileName: `Open-Invoices-${today}.xlsx` };
      case 'payments':
        return {
          spec: paymentsSheet(report as PaymentsReport, details()),
          fileName: from && to ? `Payments-Received-${from}-to-${to}.xlsx` : `Payments-Received-${today}.xlsx`,
        };
      case 'change-orders':
        return {
          spec: changeOrdersSheet(report as ChangeOrdersReport, details()),
          fileName: `Change-Orders${coStatus ? `-${CO_STATUS_META[coStatus].label}` : ''}-${today}.xlsx`,
        };
      case 'retainage':
        return { spec: retainageSheet(report as RetainageReport, details()), fileName: `Retainage-${today}.xlsx` };
    }
  };
  const download = async () => {
    if (!data) return;
    setDownloading(true);
    try {
      const { spec, fileName } = sheetFor(data);
      await downloadReportXlsx(spec, fileName);
    } catch {
      toast('Could not build the Excel file', { type: 'error' });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Reports</h1>
          <p className="text-sm text-ink-faint">Billing across every project.</p>
        </div>
        <Button variant="secondary" onClick={() => { void download(); }} disabled={!data || downloading}>
          <Download size={15} />{downloading ? 'Preparing…' : 'Download Excel'}
        </Button>
      </div>

      <nav aria-label="Reports" className="mb-4 flex gap-1 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
        {REPORT_TABS.map(t => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            data-testid={`report-tab-${t.value}`}
            aria-current={tab === t.value ? 'page' : undefined}
            className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              tab === t.value ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <Card className="mb-5">
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Customer" htmlFor="report-customer">
              <Select id="report-customer" value={customerId} onChange={e => changeCustomer(e.target.value)} className="w-full sm:w-52">
                <option value="">All customers</option>
                {(options?.customers ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Project" htmlFor="report-project">
              <Select id="report-project" value={projectId} onChange={e => setProjectId(e.target.value)} className="w-full sm:w-56">
                <option value="">All projects</option>
                {projectChoices.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? ' (archived)' : ''}</option>)}
              </Select>
            </Field>
            {tab === 'payments' && (
              <>
                <Field label="Dates" htmlFor="report-range">
                  <Select id="report-range" value={datePreset} onChange={e => changePreset(e.target.value as DatePreset)} className="w-full sm:w-40">
                    {DATE_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </Select>
                </Field>
                <Field label="From" htmlFor="report-from">
                  <Input id="report-from" type="date" value={from} className="w-40"
                    onChange={e => { setFrom(e.target.value); setDatePreset('custom'); }} />
                </Field>
                <Field label="To" htmlFor="report-to">
                  <Input id="report-to" type="date" value={to} className="w-40"
                    onChange={e => { setTo(e.target.value); setDatePreset('custom'); }} />
                </Field>
              </>
            )}
            {tab === 'change-orders' && (
              <Field label="Status" htmlFor="report-status">
                <Select id="report-status" value={coStatus} onChange={e => setCoStatus(e.target.value as ChangeOrderStatusGroup | '')} className="w-full sm:w-52">
                  <option value="">All statuses</option>
                  {CHANGE_ORDER_REPORT_STATUSES.map(s => (
                    <option key={s} value={s}>{s === 'sent' ? 'Sent — waiting on approval' : CO_STATUS_META[s].label}</option>
                  ))}
                </Select>
              </Field>
            )}
            <Checkbox label="Include archived projects" checked={includeArchived}
              onChange={e => changeArchived(e.target.checked)} className="pb-2" />
          </div>
        </CardBody>
      </Card>

      <div key={tab} className="anim-tab-in">
        {current && 'error' in current ? (
          <Card><CardBody>
            <EmptyState title="Couldn't load the report" description={current.error}
              action={<Button variant="secondary" size="sm" onClick={load}>Try again</Button>} />
          </CardBody></Card>
        ) : !data ? (
          <div className="space-y-3" data-testid="report-loading">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : tab === 'open-invoices' ? (
          <OpenInvoicesView report={data as OpenInvoicesReport} />
        ) : tab === 'payments' ? (
          <PaymentsView report={data as PaymentsReport} rangeText={rangeLabel(from, to)} />
        ) : tab === 'change-orders' ? (
          <ChangeOrdersView report={data as ChangeOrdersReport} status={coStatus} onStatus={setCoStatus} />
        ) : (
          <RetainageView report={data as RetainageReport} />
        )}
      </div>
    </div>
  );
};
