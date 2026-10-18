// src/cards/dashboard/coreCards.tsx — the four default Dashboard cards
// (Wave 2 Task 6): dash-attention, dash-money, dash-deck, dash-activity.
// Registers itself with the card registry as a side effect on import — see
// src/cards/index.ts's header comment for why that import lives there and
// not in registry.tsx.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, DollarSign, CalendarDays, Activity as ActivityIcon } from 'lucide-react';
import {
  AttentionItem, DashboardMoney, ActivityItem, TaskListItem, ProjectSummary,
  getDashboardAttention, getDashboardMoney, getActivity, getTasks, getProjectsSummary,
} from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { activityTarget } from '../../utils/activityLink';
import { normalizeProjectStatus } from '../../components/ui';
import { GROUP_DEFS } from '../../pages/ProjectsPage';
import { upcomingTaskItems } from '../../components/tasks/UpcomingTasksCard';
import { CountUp } from '../../components/motion/CountUp';
import { Sparkline } from '../../components/charts/Sparkline';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { CardShell } from '../CardShell';
import { registerCards } from '../registry';
import type { CardContext, CardWidth } from '../types';
import { timeAgo } from '../../utils/time';

const todayISO = () => new Date().toISOString().slice(0, 10);

const BIDDING = GROUP_DEFS.find(g => g.id === 'bidding')!.statuses;

// ── dash-attention ───────────────────────────────────────────────────────
function attentionLink(item: AttentionItem): string | null {
  switch (item.type) {
    case 'overdue_task': return '/tasks';
    case 'bid_due': return item.projectId ? `/project/${item.projectId}` : null;
    case 'aging_receivable':
    case 'draft_payapp': return item.projectId ? `/project/${item.projectId}/billing` : null;
    case 'stale_rfi': return item.projectId ? `/project/${item.projectId}/rfis` : null;
    default: return null;
  }
}

const AttentionRow: React.FC<{ item: AttentionItem }> = ({ item }) => {
  const href = attentionLink(item);
  const body = (
    <>
      <span
        className={`mt-1 size-2 shrink-0 rounded-full ${item.severity === 'red' ? 'bg-red-400' : 'bg-amber-400'}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{item.label}</span>
        <span className="block truncate text-xs text-ink-faint">{item.sub}</span>
      </span>
    </>
  );
  return href ? (
    <li><Link to={href} className="flex items-start gap-2 px-4 py-2 transition-colors hover:bg-hover">{body}</Link></li>
  ) : (
    <li><div className="flex items-start gap-2 px-4 py-2">{body}</div></li>
  );
};

const AttentionCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width }) => {
  const [items, setItems] = useState<AttentionItem[] | null>(null);

  const load = () => { getDashboardAttention().then(setItems).catch(() => setItems([])); };
  useLiveQuery(load, { types: ['task', 'project', 'rfi', 'invoice', 'aiaPayApp', 'payment'] });

  const loading = items === null;
  const list = items ?? [];
  const max = width === 1 ? 4 : 8;
  const visible = list.slice(0, max);

  return (
    <CardShell
      title="⚡ Needs your attention"
      icon={<AlertTriangle size={13} />}
      actions={list.length > 0 ? (
        <span className="rounded-full bg-sunken px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft">{list.length}</span>
      ) : undefined}
      loading={loading}
      empty={!loading && list.length === 0}
      emptyTitle="Nothing needs you — enjoy it."
      emptyIllustration="clear"
      flush
    >
      <ul className="divide-y divide-edge">
        {visible.map(item => <AttentionRow key={item.itemId} item={item} />)}
      </ul>
    </CardShell>
  );
};

// ── dash-money ────────────────────────────────────────────────────────────
const MoneyCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width }) => {
  const [data, setData] = useState<DashboardMoney | null>(null);

  const load = () => { getDashboardMoney().then(setData).catch(() => setData(null)); };
  useLiveQuery(load, { types: ['invoice', 'payment', 'aiaPayApp', 'changeOrder', 'project'] });

  const loading = data === null;
  const pct = data && data.contractTotalCents > 0 ? Math.round((data.billedCents / data.contractTotalCents) * 100) : 0;
  const lastPayment = data?.recentPayments[0];

  return (
    <CardShell title="Money pulse" icon={<DollarSign size={13} />} loading={loading}>
      {data && (
        <div className="space-y-2">
          <CountUp value={data.outstandingCents} format={formatMoney} className="text-2xl font-bold text-ink" />
          <Sparkline points={data.trend.map(t => t.paidCents)} height={32} />
          {width !== 1 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
              <span>{pct}% billed of contract</span>
              {data.draftPayAppCount > 0 && (
                <span className="rounded-full bg-sunken px-1.5 py-0.5 font-medium text-ink-soft">
                  {data.draftPayAppCount} draft{data.draftPayAppCount === 1 ? '' : 's'}
                </span>
              )}
              {lastPayment && (
                <span>Last payment {formatMoney(lastPayment.amount)} · {lastPayment.projectName}</span>
              )}
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
};

// ── dash-deck ─────────────────────────────────────────────────────────────
const DeckCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width }) => {
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null);
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);

  const load = () => {
    getTasks().then(setTasks).catch(() => setTasks([]));
    getProjectsSummary().then(setSummaries).catch(() => setSummaries([]));
  };
  useLiveQuery(load, { types: ['task', 'project'] });

  const loading = tasks === null || summaries === null;
  const taskList = tasks ?? [];
  const scoped = scope === 'mine' ? taskList.filter(t => t.assigneeUserId === user.id) : taskList;
  const taskItems = upcomingTaskItems(scoped, width === 1 ? 4 : 6);

  const bidDeadlines = (summaries ?? [])
    .filter(s => !s.archived && s.bidDueDate !== null && BIDDING.includes(normalizeProjectStatus(s.status)))
    .sort((a, b) => a.bidDueDate! - b.bidDueDate!)
    .slice(0, 3);

  const empty = !loading && taskItems.length === 0 && bidDeadlines.length === 0;

  const toggle = (
    <div className="flex rounded-lg bg-sunken p-0.5 text-[11px]">
      {(['mine', 'all'] as const).map(s => (
        <button
          key={s}
          type="button"
          data-testid={`deck-scope-${s}`}
          onClick={() => setScope(s)}
          className={`rounded-md px-2 py-0.5 font-medium transition-colors ${scope === s ? 'bg-raised text-ink shadow-sm' : 'text-ink-faint hover:text-ink'}`}
        >
          {s === 'mine' ? 'Mine' : 'All'}
        </button>
      ))}
    </div>
  );

  const today = todayISO();

  return (
    <CardShell
      title="📅 On deck"
      icon={<CalendarDays size={13} />}
      actions={toggle}
      loading={loading}
      empty={empty}
      emptyTitle="Nothing on deck."
      emptyIllustration="checklist"
      flush
    >
      <div>
        {bidDeadlines.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3" data-testid="deck-bid-chips">
            {bidDeadlines.map(p => {
              const overdue = p.bidDueDate! < Date.now();
              return (
                <Link
                  key={p.id}
                  to={`/project/${p.id}`}
                  className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${overdue ? 'border-red-300 text-red-600 dark:border-red-400/30 dark:text-red-400' : 'border-edge text-ink-soft'}`}
                >
                  {p.name} · {new Date(p.bidDueDate!).toLocaleDateString()}
                </Link>
              );
            })}
          </div>
        )}
        <ul className="divide-y divide-edge">
          {taskItems.map(t => {
            const overdue = !!t.dueDate && t.dueDate < today;
            const context = t.projectName ?? t.customerName;
            return (
              <li key={t.id}>
                <Link to="/tasks" className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{t.title || '(untitled)'}</span>
                    {context && <span className="block truncate text-xs text-ink-faint">{context}</span>}
                  </span>
                  <span className={`shrink-0 text-xs font-medium tabular-nums ${overdue ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
                    {t.dueDate}{overdue ? ' · overdue' : ''}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </CardShell>
  );
};

// ── dash-activity ─────────────────────────────────────────────────────────
const ActivityCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);

  const load = () => { getActivity(10).then(setActivity).catch(() => setActivity([])); };
  useLiveQuery(load, {
    types: ['project', 'task', 'issue', 'rfi', 'punch', 'invoice', 'changeOrder', 'payment', 'timeEntry', 'customer', 'file', 'proposal'],
  });

  const loading = activity === null;
  const list = activity ?? [];

  return (
    <CardShell
      title="Team activity"
      icon={<ActivityIcon size={13} />}
      loading={loading}
      empty={!loading && list.length === 0}
      emptyTitle="No activity yet."
      emptyIllustration="clear"
      flush
    >
      <ul className="divide-y divide-edge">
        {list.map(a => {
          const target = activityTarget(a, { admin: ctx.isAdmin });
          const body = (
            <>
              <p className="text-sm text-ink">{a.message}</p>
              <p className="text-xs text-ink-faint">
                {a.projectName && <span className="font-medium text-ink-soft">{a.projectName} · </span>}
                {a.username ? `${a.username} · ` : ''}{timeAgo(a.createdAt)}
              </p>
            </>
          );
          return (
            <li key={a.id}>
              {target ? (
                <Link to={target} className="block px-4 py-2 transition-colors hover:bg-hover">{body}</Link>
              ) : (
                <div className="px-4 py-2">{body}</div>
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
    id: 'dash-attention', title: '⚡ Needs your attention', icon: AlertTriangle, page: 'dashboard',
    widths: [1, 2, 3], defaultWidth: 2, Component: AttentionCard,
  },
  {
    id: 'dash-money', title: 'Money pulse', icon: DollarSign, page: 'dashboard',
    widths: [1, 2, 3], defaultWidth: 2, adminOnly: true, Component: MoneyCard,
  },
  {
    id: 'dash-deck', title: '📅 On deck', icon: CalendarDays, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, Component: DeckCard,
  },
  {
    id: 'dash-activity', title: 'Team activity', icon: ActivityIcon, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, Component: ActivityCard,
  },
]);
