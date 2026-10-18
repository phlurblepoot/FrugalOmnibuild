// src/cards/customer/libraryCards.tsx — the four optional Customer cards
// (Wave 2 Task 11): cu-payments, cu-open-items, cu-tasks, cu-notes. Not part
// of DEFAULT_LAYOUTS (that's Task 10's four core cards) — users add these
// from the card library. Registers itself with the card registry as a side
// effect on import — see src/cards/index.ts's header comment for why that
// import lives there and not in registry.tsx.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Receipt, ClipboardList, CheckSquare, StickyNote, ListTodo } from 'lucide-react';
import {
  CustomerOverview, ProjectSummary, TaskListItem,
  getCustomerOverview, getProjectsSummary, getTasks,
} from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { billingDay, formatDay } from '../../utils/billingDates';
import { upcomingTaskItems } from '../../components/tasks/UpcomingTasksCard';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { CardShell } from '../CardShell';
import { registerCards } from '../registry';
import type { CardContext, CardWidth } from '../types';

const todayISO = () => new Date().toISOString().slice(0, 10);

// Same "View all"-style action link used throughout dashboard/project card
// libraries — a plain accent text link in the CardShell header.
const ViewAllLink: React.FC<{ to: string; children: React.ReactNode }> = ({ to, children }) => (
  <Link to={to} className="text-xs font-medium text-accent-600 hover:underline">{children}</Link>
);

// ── cu-payments ──────────────────────────────────────────────────────────
// billing/open-items share this type list rather than coreCards.tsx's
// OVERVIEW_TYPES (which also watches 'task', unneeded here) — duplicated per
// this module's independence rationale (see timeAgo-style copies elsewhere).
const BILLING_TYPES: import('../../hooks/useLiveQuery').EntityType[] =
  ['customer', 'project', 'invoice', 'payment', 'aiaPayApp'];

// Ledger dates are epoch ms for invoices, 'YYYY-MM-DD' strings for pay apps
// (see CustomerBillingLedgerEntry) — normalize to a comparable number for
// sorting.
function ledgerDateMs(v: string | number | null): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : new Date(v).getTime();
}

// Shown as the day it was picked (utils/billingDates), never shifted a day by
// the viewer's timezone.
function fmtLedgerDate(v: string | number | null): string | null {
  const day = billingDay(v);
  return day && formatDay(day);
}

const kindLabel = (kind: 'invoice' | 'payapp'): string => (kind === 'invoice' ? 'Invoice' : 'Pay App');

const PaymentsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [overview, setOverview] = useState<CustomerOverview | null>(null);
  const { customerId } = ctx;

  const load = () => {
    if (!customerId) return;
    getCustomerOverview(customerId).then(setOverview).catch(() => setOverview(null));
  };
  useLiveQuery(load, { types: BILLING_TYPES });

  if (!customerId) return null;

  const loading = overview === null;
  // Belt-and-suspenders: this card is adminOnly (registry gates it), but
  // guard the field's absence anyway rather than assume the payload shape.
  const ledger = overview?.billing?.ledger ?? [];
  const rows = ledger
    .filter(e => e.paidCents > 0)
    .sort((a, b) => ledgerDateMs(b.date) - ledgerDateMs(a.date))
    .slice(0, 5);

  return (
    <CardShell
      title="Payments" icon={<Receipt size={13} />} loading={loading}
      empty={!loading && rows.length === 0} emptyTitle="No payments recorded yet." flush
      emptyIllustration="money"
    >
      <ul className="divide-y divide-edge">
        {rows.map((row, i) => {
          const dateLabel = fmtLedgerDate(row.date);
          return (
            <li key={`${row.kind}-${row.number}-${i}`}>
              <Link
                to={`/project/${row.projectId}/billing`}
                className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{kindLabel(row.kind)} #{row.number}</span>
                  <span className="block truncate text-xs text-ink-faint">
                    {row.projectName}{dateLabel ? ` · ${dateLabel}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-semibold text-ink">{formatMoney(row.paidCents)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

// ── cu-open-items ────────────────────────────────────────────────────────
const OpenItemsTile: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="rounded-lg border border-edge p-3 text-center">
    <div className="text-xl font-bold text-ink">{value}</div>
    <div className="text-[11px] text-ink-faint">{label}</div>
  </div>
);

const OpenItemsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);
  const { customerId } = ctx;

  const load = () => {
    if (!customerId) return;
    getProjectsSummary().then(setSummaries).catch(() => setSummaries([]));
  };
  useLiveQuery(load, { types: BILLING_TYPES });

  if (!customerId) return null;

  const loading = summaries === null;
  const mine = (summaries ?? []).filter(s => s.customerId === customerId && !s.archived);
  const openIssues = mine.reduce((sum, s) => sum + s.openIssueCount, 0);
  const punchLeft = mine.reduce((sum, s) => sum + Math.max(0, s.punchTotal - s.punchDone), 0);

  return (
    <CardShell title="Open items" icon={<ClipboardList size={13} />} loading={loading}>
      <div className="grid grid-cols-2 gap-3">
        <OpenItemsTile label="Open issues" value={openIssues} />
        <OpenItemsTile label="Punch left" value={punchLeft} />
      </div>
    </CardShell>
  );
};

// ── cu-open-tasks ────────────────────────────────────────────────────────
// Restores the task-count tile the old (pre-card-system) Overview tab had —
// a product note carried over from Wave 2 (the owner noticed the count was
// gone). Reads overview.taskCounts, which the server already computes
// (customerStore.ts) — no new endpoint needed.
const OpenTasksTile: React.FC<{ label: string; value: number; alert?: boolean }> = ({ label, value, alert }) => (
  <div className="rounded-lg border border-edge p-3 text-center">
    <div className={`text-xl font-bold ${alert && value > 0 ? 'text-red-600 dark:text-red-400' : 'text-ink'}`}>{value}</div>
    <div className="text-[11px] text-ink-faint">{label}</div>
  </div>
);

const OpenTasksCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [overview, setOverview] = useState<CustomerOverview | null>(null);
  const { customerId } = ctx;

  const load = () => {
    if (!customerId) return;
    getCustomerOverview(customerId).then(setOverview).catch(() => setOverview(null));
  };
  useLiveQuery(load, { types: ['task'] });

  if (!customerId) return null;

  const loading = overview === null;
  const counts = overview?.taskCounts ?? { open: 0, overdue: 0 };

  return (
    <CardShell title="Open tasks" icon={<ListTodo size={13} />} loading={loading}>
      <div className="grid grid-cols-2 gap-3">
        <OpenTasksTile label="Open" value={counts.open} />
        <OpenTasksTile label="Overdue" value={counts.overdue} alert />
      </div>
    </CardShell>
  );
};

// ── cu-tasks ─────────────────────────────────────────────────────────────
const TasksCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width, ctx }) => {
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const { customerId } = ctx;

  const load = () => {
    if (!customerId) return;
    getTasks({ customerId }).then(setTasks).catch(() => setTasks([]));
  };
  useLiveQuery(load, { types: ['task'] });

  if (!customerId) return null;

  const loading = tasks === null;
  const items = upcomingTaskItems(tasks ?? [], width === 1 ? 4 : 6);
  const today = todayISO();

  return (
    <CardShell
      title="Tasks" icon={<CheckSquare size={13} />} loading={loading}
      actions={<ViewAllLink to={`/tasks?customerId=${customerId}`}>View all</ViewAllLink>}
      empty={!loading && items.length === 0} emptyTitle="No upcoming tasks." flush
      emptyIllustration="checklist"
    >
      <ul className="divide-y divide-edge">
        {items.map(t => {
          const overdue = !!t.dueDate && t.dueDate < today;
          return (
            <li key={t.id}>
              <Link
                to={`/tasks?customerId=${customerId}`}
                className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{t.title || '(untitled)'}</span>
                  {t.projectName && <span className="block truncate text-xs text-ink-faint">{t.projectName}</span>}
                </span>
                <span className={`shrink-0 text-xs font-medium tabular-nums ${overdue ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
                  {t.dueDate}{overdue ? ' · overdue' : ''}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

// ── cu-notes ─────────────────────────────────────────────────────────────
const NotesCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [overview, setOverview] = useState<CustomerOverview | null>(null);
  const { customerId } = ctx;

  const load = () => {
    if (!customerId) return;
    getCustomerOverview(customerId).then(setOverview).catch(() => setOverview(null));
  };
  useLiveQuery(load, { types: ['customer'] });

  if (!customerId) return null;

  const loading = overview === null;
  const notes = overview?.customer.notes?.trim();

  return (
    <CardShell
      title="Notes" icon={<StickyNote size={13} />} loading={loading}
      actions={<ViewAllLink to={`/customers/${customerId}?tab=settings`}>Edit</ViewAllLink>}
      empty={!loading && !notes} emptyTitle="No notes yet."
      emptyIllustration="checklist"
    >
      {notes && <p className="whitespace-pre-wrap text-sm text-ink">{notes}</p>}
    </CardShell>
  );
};

registerCards([
  {
    id: 'cu-payments', title: 'Payments', icon: Receipt, page: 'customer',
    widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: PaymentsCard,
  },
  {
    id: 'cu-open-items', title: 'Open items', icon: ClipboardList, page: 'customer',
    widths: [1, 2], defaultWidth: 1, Component: OpenItemsCard,
  },
  {
    id: 'cu-open-tasks', title: 'Open tasks', icon: ListTodo, page: 'customer',
    widths: [1], defaultWidth: 1, Component: OpenTasksCard,
  },
  {
    id: 'cu-tasks', title: 'Tasks', icon: CheckSquare, page: 'customer',
    widths: [1, 2], defaultWidth: 1, Component: TasksCard,
  },
  {
    id: 'cu-notes', title: 'Notes', icon: StickyNote, page: 'customer',
    widths: [1, 2], defaultWidth: 1, Component: NotesCard,
  },
]);
