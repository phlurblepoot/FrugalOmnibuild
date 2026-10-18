// src/cards/customer/coreCards.tsx — the four default Customer cards (Wave 2
// Task 10): cu-rollup, cu-projects, cu-correspondence, cu-attention. Replaces
// the old CustomerOverviewTab (deleted this task) — its stat tiles and
// "Needs attention" feed are now separate cards on the customer page's
// card grid. Registers itself with the card registry as a side effect on
// import — see src/cards/index.ts's header comment for why that import
// lives there and not in registry.tsx.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, Calendar, CheckSquare, DollarSign, FolderKanban, Mail,
} from 'lucide-react';
import {
  CustomerAttentionItem, CustomerOverview,
  getCustomerOverview, getCustomerThreads,
} from '../../utils/store';
import type { ProjectThreadRow } from '../../pages/mail/types';
import { formatMoney } from '../../utils/money';
import { billingDay, formatDay } from '../../utils/billingDates';
import { ProjectStatusPill, LostBadge } from '../../components/ui';
import { ReplyFlagChip } from '../../components/documents/ReplyFlagChip';
import { CountUp } from '../../components/motion/CountUp';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { CardShell } from '../CardShell';
import { registerCards } from '../registry';
import type { CardContext, CardWidth } from '../types';
import { timeAgo } from '../../utils/time';

// Local, private copy of project/libraryCards.tsx's threadNeedsReply — same
// link-date-floor rule (spec Goal 4 / Wave 2 Task 9 controller ruling):
// `lastInboundDate > max(lastOutboundDate, earliestLinkCreatedAt)`, never a
// bare lastInbound > lastOutbound. Duplicated rather than imported to keep
// each page's card module independent, mirroring timeAgo above.
function threadNeedsReply(
  row: Pick<ProjectThreadRow, 'lastInboundDate' | 'lastOutboundDate' | 'earliestLinkCreatedAt'>
): boolean {
  const floor = row.lastOutboundDate && row.lastOutboundDate > row.earliestLinkCreatedAt
    ? row.lastOutboundDate : row.earliestLinkCreatedAt;
  return !!row.lastInboundDate && row.lastInboundDate > floor;
}

const OVERVIEW_TYPES: import('../../hooks/useLiveQuery').EntityType[] =
  ['customer', 'project', 'invoice', 'payment', 'aiaPayApp', 'task'];

// ── cu-rollup ────────────────────────────────────────────────────────────
// Max ageDays across outstanding_invoice attention items — exported for
// direct unit testing.
export function computeOldestAgeDays(attention: CustomerAttentionItem[]): number | null {
  const ages = attention
    .filter((a): a is Extract<CustomerAttentionItem, { type: 'outstanding_invoice' }> => a.type === 'outstanding_invoice')
    .map(a => a.ageDays)
    .filter((d): d is number => d != null);
  return ages.length ? Math.max(...ages) : null;
}

const AgingTile: React.FC<{ label: string; value: number; tone: 'emerald' | 'amber' | 'red' }> = ({ label, value, tone }) => {
  const toneClass = tone === 'emerald'
    ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'amber'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-red-500 dark:text-red-400/80'; // muted vs. a hard alert red
  return (
    <div className="rounded-lg border border-edge p-2 text-center">
      <div className={`text-sm font-semibold ${toneClass}`}>{formatMoney(value)}</div>
      <div className="text-[10px] text-ink-faint">{label}</div>
    </div>
  );
};

const RollupCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [overview, setOverview] = useState<CustomerOverview | null>(null);
  const { customerId } = ctx;

  const load = () => {
    if (!customerId) return;
    getCustomerOverview(customerId).then(setOverview).catch(() => setOverview(null));
  };
  useLiveQuery(load, { types: OVERVIEW_TYPES });

  if (!customerId) return null;

  const loading = overview === null;
  const billing = overview?.billing;
  const oldestAge = overview ? computeOldestAgeDays(overview.attention) : null;

  return (
    <CardShell title="Financials" icon={<DollarSign size={13} />} loading={loading}>
      {billing && (
        <div className="space-y-3">
          <div>
            <CountUp value={billing.outstandingCents} format={formatMoney} className="text-2xl font-bold text-ink" />
            {oldestAge != null && (
              <p className="text-xs text-red-600 dark:text-red-400">
                oldest {oldestAge} day{oldestAge === 1 ? '' : 's'} outstanding
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span>Billed <span className="font-medium text-ink-soft">{formatMoney(billing.invoicedCents)}</span></span>
            <span>Paid <span className="font-medium text-ink-soft">{formatMoney(billing.paidCents)}</span></span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <AgingTile label="Current" value={billing.aging.current} tone="emerald" />
            <AgingTile label="31-60 days" value={billing.aging.days31to60} tone="amber" />
            <AgingTile label="61+ days" value={billing.aging.days61plus} tone="red" />
          </div>
        </div>
      )}
    </CardShell>
  );
};

// ── cu-projects ──────────────────────────────────────────────────────────
const ProjectsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [overview, setOverview] = useState<CustomerOverview | null>(null);
  const { customerId, isAdmin } = ctx;

  const load = () => {
    if (!customerId) return;
    getCustomerOverview(customerId).then(setOverview).catch(() => setOverview(null));
  };
  useLiveQuery(load, { types: OVERVIEW_TYPES });

  if (!customerId) return null;

  const loading = overview === null;
  const projects = overview?.projects ?? [];

  return (
    <CardShell
      title="Their projects" icon={<FolderKanban size={13} />} loading={loading}
      empty={!loading && projects.length === 0} emptyTitle="No projects yet." flush
      emptyIllustration="checklist"
    >
      <ul className="divide-y divide-edge">
        {projects.map(p => (
          <li key={p.id}>
            <Link
              to={`/project/${p.id}`}
              className={`flex items-center gap-3 px-4 py-2 transition-colors hover:bg-hover ${p.archived ? 'opacity-60' : ''}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink" title={p.name}>{p.name}</span>
                {isAdmin && p.outstandingCents !== undefined && p.outstandingCents > 0 && (
                  <span className="block truncate text-xs text-ink-faint">{formatMoney(p.outstandingCents)} outstanding</span>
                )}
              </span>
              {p.lostBid ? <LostBadge className="shrink-0" /> : <ProjectStatusPill status={p.status} className="shrink-0" />}
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  );
};

// ── cu-correspondence ────────────────────────────────────────────────────
const CorrespondenceCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [rows, setRows] = useState<ProjectThreadRow[] | null>(null);
  const { customerId } = ctx;

  const load = () => {
    if (!customerId) return;
    getCustomerThreads(customerId).then(setRows).catch(() => setRows([]));
  };
  useLiveQuery(load, { types: ['mailThread'] });

  if (!customerId) return null;

  const loading = rows === null;
  const visible = [...(rows ?? [])]
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, 5);

  return (
    <CardShell
      title="Correspondence" icon={<Mail size={13} />} loading={loading}
      actions={<Link to="/mail" className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
      empty={!loading && visible.length === 0} emptyTitle="No email threads linked to this customer." flush
      emptyIllustration="inbox"
    >
      <ul className="divide-y divide-edge">
        {visible.map(row => (
          <li key={row.threadKey}>
            <Link to="/mail" className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{row.subjectSnapshot || '(no subject)'}</span>
                <span className="block truncate text-xs text-ink-faint">{timeAgo(new Date(row.lastActivity).getTime())}</span>
              </span>
              {threadNeedsReply(row) && <ReplyFlagChip data-testid={`cu-mail-reply-${row.threadKey}`} />}
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  );
};

// ── cu-attention ─────────────────────────────────────────────────────────
// Verbatim from the deleted CustomerOverviewTab.tsx (fmtDate/attentionHref/
// AttentionRow) — see that history for the original rationale comments.
const fmtDate = (v: number | string | null | undefined): string | null => {
  if (v == null) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString();
};

function attentionHref(item: CustomerAttentionItem, customerId: string): string {
  switch (item.type) {
    case 'overdue_task': return `/tasks?customerId=${customerId}`;
    case 'bid_due': return `/project/${item.projectId}`;
    case 'outstanding_invoice': return `/project/${item.projectId}/billing`;
  }
}

const AttentionRow: React.FC<{ item: CustomerAttentionItem; customerId: string }> = ({ item, customerId }) => {
  const isOverdue = item.type === 'overdue_task' || (item.type === 'bid_due' && !!item.overdue);
  const Icon = item.type === 'overdue_task' ? CheckSquare : item.type === 'bid_due' ? Calendar : DollarSign;
  const iconTone = isOverdue ? 'text-red-600 dark:text-red-400' : item.type === 'outstanding_invoice' ? 'text-amber-600 dark:text-amber-400' : 'text-ink-faint';
  // An invoice or pay app date is the day it was picked (utils/billingDates).
  const invoiceDay = item.type === 'outstanding_invoice' ? billingDay(item.date) : null;
  const dateLabel = invoiceDay ? formatDay(invoiceDay) : fmtDate(item.date);

  return (
    <li>
      <Link
        to={attentionHref(item, customerId)}
        data-testid="customer-attention-row"
        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
      >
        <Icon size={14} className={`shrink-0 ${iconTone}`} />
        <span className="min-w-0 flex-1 truncate text-sm text-ink" title={item.label}>{item.label}</span>
        {item.type === 'outstanding_invoice' && (
          <span className="shrink-0 text-sm font-semibold text-ink">{formatMoney(item.balanceCents)}</span>
        )}
        {dateLabel && (
          <span className={`shrink-0 text-xs font-medium ${isOverdue ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
            {dateLabel}{isOverdue ? ' · overdue' : ''}
          </span>
        )}
      </Link>
    </li>
  );
};

const AttentionCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [overview, setOverview] = useState<CustomerOverview | null>(null);
  const { customerId } = ctx;

  const load = () => {
    if (!customerId) return;
    getCustomerOverview(customerId).then(setOverview).catch(() => setOverview(null));
  };
  useLiveQuery(load, { types: OVERVIEW_TYPES });

  if (!customerId) return null;

  const loading = overview === null;
  const attention = overview?.attention ?? [];

  return (
    <CardShell
      title="Needs attention" icon={<AlertTriangle size={13} />} loading={loading}
      empty={!loading && attention.length === 0} emptyTitle="Nothing needs attention" flush
      emptyIllustration="clear"
    >
      <ul className="divide-y divide-edge">
        {attention.map((item, i) => (
          <AttentionRow key={`${item.type}-${i}`} item={item} customerId={customerId} />
        ))}
      </ul>
    </CardShell>
  );
};

registerCards([
  {
    id: 'cu-rollup', title: 'Financials', icon: DollarSign, page: 'customer',
    widths: [2, 3], defaultWidth: 3, adminOnly: true, Component: RollupCard,
  },
  {
    id: 'cu-projects', title: 'Their projects', icon: FolderKanban, page: 'customer',
    widths: [1, 2, 3], defaultWidth: 2, Component: ProjectsCard,
  },
  {
    id: 'cu-correspondence', title: 'Correspondence', icon: Mail, page: 'customer',
    widths: [1, 2], defaultWidth: 1, Component: CorrespondenceCard,
  },
  {
    id: 'cu-attention', title: 'Needs attention', icon: AlertTriangle, page: 'customer',
    widths: [1, 2], defaultWidth: 1, Component: AttentionCard,
  },
]);
