// src/cards/project/coreCards.tsx — the three default Project cards (Wave 2
// Task 8): pj-financial-band, pj-open-items, pj-happenings. Registers itself
// with the card registry as a side effect on import — see src/cards/index.ts's
// header comment for why that import lives there and not in registry.tsx.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, ClipboardCheck, Clock, FileText, DollarSign, Mail, CalendarDays,
} from 'lucide-react';
import {
  BillingSummary, AiaPayAppListItem, ProjectSummary, RfiListItem, TaskListItem, HappeningItem,
  getBillingSummary, getPayApps, getProjectSummary, getRfis, getTasks, getProjectHappenings,
} from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { activityTarget } from '../../utils/activityLink';
import { CountUp } from '../../components/motion/CountUp';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { CardShell } from '../CardShell';
import { registerCards } from '../registry';
import type { CardContext, CardWidth } from '../types';
import { timeAgo } from '../../utils/time';

// ── pj-financial-band ───────────────────────────────────────────────────────
// Ledger-family math only — see task-8-brief.md / controller ruling: paid and
// awaiting are the ledger totals, remaining is what's left of the contract
// after billing. Retainage is intentionally absent (not derivable from these
// fields as a truthful figure). Exported for direct unit testing.
export interface FinancialBand {
  paid: number; awaiting: number; remaining: number;
  paidPct: number; awaitingPct: number; remainingPct: number;
}
export function computeFinancialBand(b: BillingSummary): FinancialBand {
  const paid = b.paid.invoicesCents + b.payAppPaidCents;
  const awaiting = b.invoiceOutstandingBilledCents + b.payAppOutstandingCents;
  const billed = b.invoiceBilledCents + b.payAppBilledCents;
  const remaining = Math.max(0, b.contractTotalCents - billed);
  const total = b.contractTotalCents;
  const pct = (v: number) => (total > 0 ? Math.max(0, Math.min(100, (v / total) * 100)) : 0);
  return { paid, awaiting, remaining, paidPct: pct(paid), awaitingPct: pct(awaiting), remainingPct: pct(remaining) };
}

const LegendChip: React.FC<{ swatch: string; label: string; value: string }> = ({ swatch, label, value }) => (
  <span className="flex items-center gap-1.5">
    <span className={`size-2 rounded-full ${swatch}`} aria-hidden="true" />
    {label} <span className="font-medium text-ink-soft">{value}</span>
  </span>
);

const FinancialBandCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width, ctx }) => {
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [payApps, setPayApps] = useState<AiaPayAppListItem[] | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getBillingSummary(projectId).then(setBilling).catch(() => setBilling(null));
    getPayApps(projectId).then(setPayApps).catch(() => setPayApps([]));
  };
  useLiveQuery(load, { types: ['invoice', 'payment', 'aiaPayApp', 'changeOrder', 'project'], projectId });

  // A project page always supplies projectId — cards are generic, so guard
  // per src/cards/types.ts's CardContext (projectId is optional there).
  if (!projectId) return null;

  const loading = billing === null;
  const band = billing ? computeFinancialBand(billing) : null;
  const draftApp = (payApps ?? [])
    .filter(p => p.status === 'draft')
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  return (
    <CardShell title="Financial progress" icon={<DollarSign size={13} />} loading={loading}>
      {billing && band && (
        <div className="space-y-3">
          <CountUp value={billing.contractTotalCents} format={formatMoney} className="text-2xl font-bold text-ink" />
          <div className="flex h-3 overflow-hidden rounded-full bg-sunken" data-testid="pj-band-bar">
            <div data-testid="pj-band-paid" className="bg-gradient-to-r from-emerald-400 to-emerald-600" style={{ width: `${band.paidPct}%` }} />
            <div data-testid="pj-band-awaiting" className="bg-gradient-to-r from-accent-400 to-accent-600" style={{ width: `${band.awaitingPct}%` }} />
            <div data-testid="pj-band-remaining" className="bg-edge-strong" style={{ width: `${band.remainingPct}%` }} />
          </div>
          {width !== 2 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
              <LegendChip swatch="bg-emerald-500" label="Paid" value={formatMoney(band.paid)} />
              <LegendChip swatch="bg-accent-500" label="Awaiting" value={formatMoney(band.awaiting)} />
              <LegendChip swatch="bg-edge-strong" label="Remaining" value={formatMoney(band.remaining)} />
            </div>
          )}
          {draftApp && (
            <p className="text-xs text-ink-soft">
              Next: Pay app #{draftApp.number} in draft · {formatMoney(draftApp.totalCents)}
            </p>
          )}
        </div>
      )}
    </CardShell>
  );
};

// ── pj-open-items ────────────────────────────────────────────────────────────
const todayISO = () => new Date().toISOString().slice(0, 10);
const isTaskOverdue = (t: TaskListItem, today: string) => !!t.dueDate && t.dueDate < today && t.status !== 'done';
const isRfiOpen = (r: RfiListItem) => r.status !== 'answered' && r.status !== 'closed';

const OpenItemsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width, ctx }) => {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [rfis, setRfis] = useState<RfiListItem[] | null>(null);
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(setSummary).catch(() => setSummary(null));
    getRfis(projectId).then(setRfis).catch(() => setRfis([]));
    getTasks({ projectId }).then(setTasks).catch(() => setTasks([]));
  };
  useLiveQuery(load, { types: ['project', 'issue', 'punch', 'rfi', 'task'], projectId });

  if (!projectId) return null;

  const loading = summary === null || rfis === null || tasks === null;
  const openIssues = summary?.openIssueCount ?? 0;
  const punchLeft = summary ? Math.max(0, summary.punchTotal - summary.punchDone) : 0;
  const openRfis = (rfis ?? []).filter(isRfiOpen).length;
  const today = todayISO();
  const overdueTasks = (tasks ?? []).filter(t => isTaskOverdue(t, today)).length;

  const tiles: { label: string; value: number; icon: React.FC<{ size?: number; className?: string }>; href: string }[] = [
    { label: 'Open issues', value: openIssues, icon: AlertCircle, href: `/project/${projectId}/issues` },
    { label: 'Punch left', value: punchLeft, icon: ClipboardCheck, href: `/project/${projectId}/punch` },
    { label: 'Open RFIs', value: openRfis, icon: FileText, href: `/project/${projectId}/rfis` },
    { label: 'Overdue tasks', value: overdueTasks, icon: Clock, href: `/tasks?projectId=${projectId}` },
  ];

  return (
    <CardShell title="Open items" icon={<ClipboardCheck size={13} />} loading={loading}>
      <div className={`grid gap-3 ${width === 1 ? 'grid-cols-2' : 'grid-cols-4'}`}>
        {tiles.map(t => (
          <Link
            key={t.label}
            to={t.href}
            className="rounded-lg border border-edge p-3 text-center transition-colors hover:bg-hover"
          >
            <t.icon size={16} className="mx-auto mb-1 text-ink-faint" />
            <div className="text-xl font-bold text-ink">{t.value}</div>
            <div className="text-[11px] text-ink-faint">{t.label}</div>
          </Link>
        ))}
      </div>
    </CardShell>
  );
};

// ── pj-happenings ────────────────────────────────────────────────────────────
type LucideIcon = React.FC<{ size?: number; className?: string }>;

// Icon per kind/type — a "mail" happening always gets the mail icon; an
// "activity" happening's icon follows the same section grouping as
// activityLink.ts's SECTION_BY_PREFIX, folded down to one icon per group.
export function iconForHappening(item: HappeningItem): LucideIcon {
  if (item.kind === 'mail') return Mail;
  const type = item.type ?? '';
  if (/^(invoice_|payment_|change_order_)/.test(type)) return DollarSign;
  if (/^punch_/.test(type)) return ClipboardCheck;
  if (/^daily_report_/.test(type)) return CalendarDays;
  return FileText;
}

const HappeningsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [items, setItems] = useState<HappeningItem[] | null>(null);
  const { projectId, isAdmin } = ctx;

  const load = () => {
    if (!projectId) return;
    getProjectHappenings(projectId).then(setItems).catch(() => setItems([]));
  };
  useLiveQuery(load, {
    types: ['project', 'task', 'issue', 'rfi', 'punch', 'invoice', 'changeOrder', 'payment', 'timeEntry', 'customer', 'file', 'proposal', 'mailThread'],
    projectId,
  });

  if (!projectId) return null;

  const loading = items === null;
  const list = items ?? [];

  return (
    <CardShell
      title="Recent happenings"
      icon={<CalendarDays size={13} />}
      loading={loading}
      empty={!loading && list.length === 0}
      emptyTitle="Nothing happening yet."
      emptyIllustration="clear"
      flush
    >
      <ul className="divide-y divide-edge">
        {list.map(item => {
          const Icon = iconForHappening(item);
          const target = item.kind === 'mail'
            ? `/project/${projectId}/mail`
            : activityTarget({ type: item.type ?? '', projectId }, { admin: isAdmin });
          const body = (
            <>
              <Icon size={14} className="mt-0.5 shrink-0 text-ink-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{item.message}</span>
                <span className="block truncate text-xs text-ink-faint">
                  {item.username ? `${item.username} · ` : ''}{timeAgo(item.createdAt)}
                </span>
              </span>
            </>
          );
          return (
            <li key={`${item.kind}-${item.id}`}>
              {target ? (
                <Link to={target} className="flex items-start gap-2 px-4 py-2 transition-colors hover:bg-hover">{body}</Link>
              ) : (
                <div className="flex items-start gap-2 px-4 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

registerCards([
  {
    id: 'pj-financial-band', title: 'Financial progress', icon: DollarSign, page: 'project',
    widths: [2, 3], defaultWidth: 3, adminOnly: true, Component: FinancialBandCard,
  },
  {
    id: 'pj-open-items', title: 'Open items', icon: ClipboardCheck, page: 'project',
    widths: [1, 2], defaultWidth: 1, Component: OpenItemsCard,
  },
  {
    id: 'pj-happenings', title: 'Recent happenings', icon: CalendarDays, page: 'project',
    widths: [1, 2, 3], defaultWidth: 2, Component: HappeningsCard,
  },
]);
