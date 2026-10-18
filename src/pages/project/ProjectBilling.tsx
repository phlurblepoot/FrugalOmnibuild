// src/pages/project/ProjectBilling.tsx
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { DollarSign, ShieldAlert } from 'lucide-react';
import {
  BillingSummary, AiaSettings, AiaSovLine, AiaPayApp,
  getBillingSummary, getAiaSettings, getSov, getPayApps,
} from '../../utils/store';
import { formatMoney } from '../../utils/money';
import {
  Card, CardBody, CardHeader, EmptyState, Skeleton,
} from '../../components/ui';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { AiaSettingsForm } from './billing/AiaSettingsForm';
import { AiaScheduleOfValues } from './billing/AiaScheduleOfValues';
import { ChangeOrdersSection } from './billing/ChangeOrdersSection';
import { AiaPayApplications } from './billing/AiaPayApplications';
import { PaymentsSection } from './billing/PaymentsSection';
import { InvoicesSection } from './billing/InvoicesSection';
import { LienReleasesSection } from './billing/LienReleasesSection';

export { lineCents, draftTotalCents } from './billing/InvoiceEditor';

const isAdmin = () => (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';

const BILLING_TABS = [
  { value: 'sov', label: 'Schedule of Values' },
  { value: 'change-orders', label: 'Change Orders' },
  { value: 'pay-apps', label: 'Pay Applications' },
  { value: 'invoices', label: 'Invoices' },
  { value: 'lien-releases', label: 'Lien Releases' },
  { value: 'payments', label: 'Payments' },
  { value: 'settings', label: 'Settings' },
] as const;

type BillingTab = (typeof BILLING_TABS)[number]['value'];
const BILLING_TAB_VALUES = BILLING_TABS.map(t => t.value) as readonly string[];

export const ProjectBilling: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [aiaSettings, setAiaSettings] = useState<AiaSettings | null>(null);
  const [sovLines, setSovLines] = useState<AiaSovLine[] | null>(null);
  const [payApps, setPayApps] = useState<AiaPayApp[] | null>(null);

  const admin = isAdmin();

  const tabParam = searchParams.get('tab');
  const activeTab: BillingTab = BILLING_TAB_VALUES.includes(tabParam ?? '')
    ? (tabParam as BillingTab)
    : 'sov';
  const setActiveTab = (tab: BillingTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  };

  const reloadSummary = () => {
    if (!projectId || !admin) return;
    getBillingSummary(projectId).then(setSummary).catch(() => setSummary(null));
  };
  const load = () => {
    if (!projectId || !admin) return;
    reloadSummary();
    getAiaSettings(projectId).then(setAiaSettings).catch(() => setAiaSettings({}));
    // Needed (not just for the SOV tab) so AiaSettingsForm can infer a
    // sensible default retainage mode for legacy projects that never wrote
    // aiaSettings.retainageMode — see resolveRetainageMode in utils/store.
    getSov(projectId).then(setSovLines).catch(() => setSovLines([]));
    // Also for AiaSettingsForm: switching the retainage mode recomputes every
    // existing pay application, so the form confirms the save when there are
    // any — it needs their count.
    getPayApps(projectId).then(setPayApps).catch(() => setPayApps([]));
  };
  useLiveQuery(load, { types: ['invoice', 'changeOrder', 'lienRelease', 'payment', 'aiaSov', 'aiaPayApp', 'project'], projectId });

  // Refresh the always-visible summary totals whenever the active tab changes,
  // so edits made in any tab (e.g. SOV / change orders affecting the contract
  // total) are reflected without a manual reload.
  useEffect(reloadSummary, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!admin) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12 md:px-8">
        <EmptyState icon={<ShieldAlert size={22} />} title="Billing is admin-only"
          description="Ask an administrator for access to invoices and change orders." />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Billing</h1>
      </div>

      {/* Summary */}
      <Card className="mb-5">
        <CardHeader title="Summary" actions={<DollarSign size={15} className="text-ink-faint" />} />
        <CardBody>
          {summary === null ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="space-y-4">
              <div data-testid="billing-summary-contract">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Contract</div>
                <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                  {[
                    ['Contract total', summary.contractTotalCents],
                    ['Billed', summary.payAppBilledCents],
                    ['Outstanding', summary.payAppOutstandingCents],
                    ['Paid', summary.payAppPaidCents],
                  ].map(([label, cents]) => (
                    <div key={label as string}>
                      <div className="text-ink-faint">{label}</div>
                      <div className="text-lg font-bold text-ink">{formatMoney(cents as number)}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div data-testid="billing-summary-invoices">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Invoices</div>
                {/* Same 4-column grid as the Contract row above, with the middle
                    two cells left empty so "Paid" lands in the same column as
                    the Contract row's "Paid" — they align when scanning. */}
                <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                  <div>
                    <div className="text-ink-faint">Invoiced</div>
                    <div className="text-lg font-bold text-ink">{formatMoney(summary.invoiceBilledCents)}</div>
                  </div>
                  <div className="hidden sm:block" aria-hidden="true" />
                  <div className="hidden sm:block" aria-hidden="true" />
                  <div>
                    <div className="text-ink-faint">Paid</div>
                    <div className="text-lg font-bold text-ink">{formatMoney(summary.invoicePaidCents)}</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Tabs */}
      <nav aria-label="Billing sections" className="flex gap-1 mb-6 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
        {BILLING_TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === tab.value ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Active section */}
      <div key={activeTab} className="anim-tab-in">
        {projectId && activeTab === 'sov' && <AiaScheduleOfValues projectId={projectId} aiaSettings={aiaSettings} />}
        {projectId && activeTab === 'change-orders' && (
          <ChangeOrdersSection projectId={projectId} onChange={reloadSummary} />
        )}
        {projectId && activeTab === 'pay-apps' && (
          <AiaPayApplications projectId={projectId} contractTotalCents={summary?.contractTotalCents} />
        )}
        {projectId && activeTab === 'invoices' && (
          <InvoicesSection projectId={projectId} onChange={reloadSummary} />
        )}
        {projectId && activeTab === 'lien-releases' && (
          <LienReleasesSection projectId={projectId} onChange={reloadSummary} />
        )}
        {projectId && activeTab === 'payments' && (
          <PaymentsSection projectId={projectId} onChange={reloadSummary} />
        )}
        {activeTab === 'settings' && (
          aiaSettings === null || sovLines === null || payApps === null ? (
            // AiaSettingsForm seeds its fields from props at mount only (no prop
            // sync), so wait for settings AND the SOV lines to load before
            // mounting it — the lines are needed to infer a default retainage
            // mode for legacy projects — otherwise a direct reload on
            // ?tab=settings would show defaults. The pay apps are waited on for
            // the same reason: a mode-change save must never slip through
            // unconfirmed just because the list hadn't arrived yet.
            <Card className="mb-5"><CardBody><Skeleton className="h-10 w-full" /></CardBody></Card>
          ) : (
            <AiaSettingsForm projectId={projectId ?? ''} settings={aiaSettings} sovLines={sovLines} payApps={payApps} onSaved={setAiaSettings} defaultOpen />
          )
        )}
      </div>
    </div>
  );
};
