// src/cards/dashboard/libraryCards.tsx — the 9 optional Dashboard cards
// (Wave 2 Task 7): dash-project-health, dash-mail-peek, dash-proposals,
// dash-my-hours, dash-payments, dash-aging, dash-quick-actions,
// dash-recent-docs, dash-bid-deadlines. Not part of DEFAULT_LAYOUTS (that's
// Task 6's four core cards) — users add these from the card library.
// Registers itself with the card registry as a side effect on import — see
// src/cards/index.ts's header comment for why that import lives there and
// not in registry.tsx.
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  HeartPulse, Mail, FileSignature, Clock, Wallet, Hourglass, Zap, FileStack,
  CalendarClock, Plus, ListChecks,
} from 'lucide-react';
import {
  ProjectSummary, OutstandingProposal, TimeEntryLite, DashboardMoney,
  DocumentRow,
  getProjectsSummary, getOutstandingProposals, getMyTimeEntries, getDashboardMoney,
  getDocuments, clockIn,
} from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { formatBillingDate } from '../../utils/billingDates';
import { formatCurrency } from '../../pages/project/proposal/proposalGenerator';
import { expiryText } from '../../pages/project/proposal/proposalPresentation';
import { normalizeProjectStatus, ProjectStatusPill, Button } from '../../components/ui';
import { GROUP_DEFS } from '../../pages/ProjectsPage';
import { useMailUnread } from '../../pages/mail/useMailUnread';
import { useToast } from '../../components/Toast';
import { CountUp } from '../../components/motion/CountUp';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { CardShell } from '../CardShell';
import { registerCards } from '../registry';
import type { CardContext, CardWidth } from '../types';
import { hoursThisWeek } from '../../utils/time';

// Derived from the pipeline groups so cards can never drift from the Projects
// board on which statuses count as bidding/active. Same derivation coreCards
// uses for BIDDING — importing GROUP_DEFS from ProjectsPage is safe because
// ProjectsPage does not import anything from src/cards.
const BIDDING = GROUP_DEFS.find(g => g.id === 'bidding')!.statuses;
const ACTIVE = GROUP_DEFS.find(g => g.id === 'active')!.statuses;

// ── dash-project-health ──────────────────────────────────────────────────
const ProjectHealthCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width, ctx }) => {
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);

  const load = () => { getProjectsSummary().then(setSummaries).catch(() => setSummaries([])); };
  useLiveQuery(load, { types: ['project', 'issue', 'punch', 'invoice', 'payment', 'aiaPayApp', 'changeOrder'] });

  const loading = summaries === null;
  const active = (summaries ?? [])
    .filter(s => !s.archived && ACTIVE.includes(normalizeProjectStatus(s.status)))
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, width === 3 ? 8 : 5);

  return (
    <CardShell
      title="Project health"
      icon={<HeartPulse size={13} />}
      loading={loading}
      empty={!loading && active.length === 0}
      emptyTitle="No active projects."
      emptyIllustration="checklist"
      flush
    >
      <ul className="divide-y divide-edge">
        {active.map(p => {
          const openItems = p.openIssueCount + (p.punchTotal - p.punchDone);
          const showOutstanding = ctx.isAdmin && p.outstandingCents !== undefined && p.contractValueCents !== undefined
            && p.contractValueCents > 0 && p.outstandingCents > 0;
          return (
            <li key={p.id}>
              <Link to={`/project/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                  <span className="flex items-center gap-2">
                    <ProjectStatusPill status={p.status} />
                    {showOutstanding && <span className="text-xs text-ink-faint">{formatMoney(p.outstandingCents!)} outstanding</span>}
                  </span>
                </span>
                {openItems > 0 && (
                  <span className="shrink-0 rounded-full bg-sunken px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft">
                    {openItems} open
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

// ── dash-mail-peek ────────────────────────────────────────────────────────
const MailPeekCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const unread = useMailUnread();

  return (
    <CardShell title="Mail" icon={<Mail size={13} />}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <CountUp value={unread} className="text-2xl font-bold text-ink" />
          <span className="text-sm text-ink-soft">unread</span>
        </div>
        <Link to="/mail" className="shrink-0 text-xs font-medium text-accent-600 hover:underline">Open Mail</Link>
      </div>
    </CardShell>
  );
};

// ── dash-proposals ────────────────────────────────────────────────────────
const ProposalsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width }) => {
  const [proposals, setProposals] = useState<OutstandingProposal[] | null>(null);

  const load = () => { getOutstandingProposals().then(setProposals).catch(() => setProposals([])); };
  useLiveQuery(load, { types: ['proposal', 'project'] });

  const loading = proposals === null;
  const visible = (proposals ?? []).slice(0, width === 1 ? 4 : 6);

  return (
    <CardShell
      title="Outstanding proposals"
      icon={<FileSignature size={13} />}
      actions={<Link to="/documents?kinds=proposal" className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
      loading={loading}
      empty={!loading && visible.length === 0}
      emptyTitle="No proposals awaiting a response."
      emptyIllustration="blueprint"
      flush
    >
      <ul className="divide-y divide-edge">
        {visible.map(p => {
          const expiry = expiryText(p);
          const expired = expiry?.startsWith('expired') ?? false;
          return (
            <li key={p.id}>
              <Link to={`/project/${p.projectId}/proposal/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">
                    {p.projectName ?? '—'} · #{p.number}{p.title ? ` — ${p.title}` : ''}
                  </span>
                  {expiry && (
                    <span className={`block truncate text-xs ${expired ? 'text-red-600 dark:text-red-400' : 'text-ink-faint'}`}>
                      {expiry}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-xs font-medium text-ink-soft">{formatCurrency(p.totalCents / 100)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

// ── dash-my-hours ─────────────────────────────────────────────────────────
const MyHoursCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const [hours, setHours] = useState<number | null>(null);

  const load = () => { getMyTimeEntries().then(e => setHours(hoursThisWeek(e))).catch(() => setHours(0)); };
  useLiveQuery(load, { types: ['timeEntry'] });

  const loading = hours === null;

  return (
    <CardShell
      title="My hours this week"
      icon={<Clock size={13} />}
      actions={<Link to="/time" className="text-xs font-medium text-accent-600 hover:underline">Time tracking</Link>}
      loading={loading}
    >
      {!loading && (
        <div className="flex items-baseline gap-2">
          <CountUp value={hours!} format={v => v.toFixed(1)} className="text-2xl font-bold text-ink" />
          <span className="text-sm text-ink-soft">hours since Sunday</span>
        </div>
      )}
    </CardShell>
  );
};

// ── dash-payments ─────────────────────────────────────────────────────────
const PaymentsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width }) => {
  const [payments, setPayments] = useState<DashboardMoney['recentPayments'] | null>(null);

  const load = () => { getDashboardMoney().then(d => setPayments(d.recentPayments)).catch(() => setPayments([])); };
  useLiveQuery(load, { types: ['payment', 'invoice', 'aiaPayApp'] });

  const loading = payments === null;
  const visible = (payments ?? []).slice(0, width === 1 ? 4 : 6);

  return (
    <CardShell
      title="Recent payments"
      icon={<Wallet size={13} />}
      loading={loading}
      empty={!loading && visible.length === 0}
      emptyTitle="No recent payments."
      emptyIllustration="money"
      flush
    >
      <ul className="divide-y divide-edge">
        {visible.map(p => (
          <li key={p.id}>
            <Link to={`/project/${p.projectId}/billing`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">{p.projectName}</span>
                <span className="block truncate text-xs text-ink-faint">
                  {formatBillingDate(p.date)}{p.method ? ` · ${p.method}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-xs font-medium text-ink-soft">{formatMoney(p.amount)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  );
};

// ── dash-aging ────────────────────────────────────────────────────────────
// Buckets come straight from the server's dashboardMoney().aging — computed
// over EVERY outstanding billed document across non-archived projects, not
// derived from the attention feed's aging_receivable items (which only exist
// at >=14 days old and are capped at 20 red-first, so receivables could
// silently vanish from these sums). See server/dashboardStore.ts.
const AgingCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const [aging, setAging] = useState<DashboardMoney['aging'] | null>(null);

  const load = () => { getDashboardMoney().then(d => setAging(d.aging)).catch(() => setAging(null)); };
  useLiveQuery(load, { types: ['invoice', 'payment', 'aiaPayApp', 'project'] });

  const loading = aging === null;
  const total = aging ? aging.current + aging.days31to60 + aging.days61plus : 0;

  const TILES: { key: keyof NonNullable<typeof aging>; testId: string; label: string; tone: string }[] = [
    { key: 'current', testId: 'd0_30', label: '0–30 days', tone: 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-400/10 dark:border-emerald-400/20 dark:text-emerald-300' },
    { key: 'days31to60', testId: 'd31_60', label: '31–60 days', tone: 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-400/10 dark:border-amber-400/20 dark:text-amber-300' },
    { key: 'days61plus', testId: 'd61', label: '61+ days', tone: 'bg-red-50 border-red-200 text-red-700 dark:bg-red-400/10 dark:border-red-400/20 dark:text-red-300' },
  ];

  return (
    <CardShell
      title="Aging receivables"
      icon={<Hourglass size={13} />}
      loading={loading}
      empty={!loading && total === 0}
      emptyTitle="Nothing aging."
      emptyIllustration="money"
    >
      <div className="grid grid-cols-3 gap-2">
        {TILES.map(t => (
          <div key={t.key} data-testid={`aging-bucket-${t.testId}`} className={`rounded-lg border p-2.5 ${t.tone}`}>
            <p className="text-[11px] font-medium">{t.label}</p>
            <p className="text-sm font-bold text-ink">{formatMoney(aging?.[t.key] ?? 0)}</p>
          </div>
        ))}
      </div>
    </CardShell>
  );
};

// ── dash-quick-actions ────────────────────────────────────────────────────
const QuickActionsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [clockingIn, setClockingIn] = useState(false);

  const handleClockIn = async () => {
    setClockingIn(true);
    try {
      await clockIn();
      toast('Clocked in.', { type: 'success' });
    } catch {
      toast('Could not clock in.', { type: 'error' });
    } finally {
      setClockingIn(false);
    }
  };

  return (
    <CardShell title="Quick actions" icon={<Zap size={13} />}>
      <div className="flex flex-col gap-2">
        <Button variant="secondary" size="sm" className="justify-start" onClick={() => navigate('/new')}>
          <Plus size={14} />New Project
        </Button>
        <Button variant="secondary" size="sm" className="justify-start" onClick={() => navigate('/tasks?new=1')}>
          <ListChecks size={14} />New Task
        </Button>
        <Button variant="secondary" size="sm" className="justify-start" onClick={handleClockIn} disabled={clockingIn}>
          <Clock size={14} />Clock in
        </Button>
      </div>
    </CardShell>
  );
};

// ── dash-recent-docs ──────────────────────────────────────────────────────
const RecentDocsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ width }) => {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);

  const load = () => { getDocuments({ limit: 6 }).then(r => setDocs(r.rows)).catch(() => setDocs([])); };
  useLiveQuery(load, { types: ['file'] });

  const loading = docs === null;
  const visible = (docs ?? []).slice(0, width === 1 ? 4 : 6);

  return (
    <CardShell
      title="Recent documents"
      icon={<FileStack size={13} />}
      actions={<Link to="/documents" className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
      loading={loading}
      empty={!loading && visible.length === 0}
      emptyTitle="No documents yet."
      emptyIllustration="blueprint"
      flush
    >
      <ul className="divide-y divide-edge">
        {visible.map(d => {
          const context = d.projectName ?? d.customerName;
          return (
            <li key={d.id}>
              <Link to="/documents" className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{d.name ?? '(untitled)'}</span>
                  <span className="block truncate text-xs text-ink-faint">{context ?? d.kind}</span>
                </span>
                <span className="shrink-0 text-xs text-ink-faint">{new Date(d.createdAt).toLocaleDateString()}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

// ── dash-bid-deadlines ────────────────────────────────────────────────────
const BidDeadlinesCard: React.FC<{ width: CardWidth; ctx: CardContext }> = () => {
  const [summaries, setSummaries] = useState<ProjectSummary[] | null>(null);

  const load = () => { getProjectsSummary().then(setSummaries).catch(() => setSummaries([])); };
  useLiveQuery(load, { types: ['project'] });

  const loading = summaries === null;
  const upcoming = (summaries ?? [])
    .filter(s => !s.archived && BIDDING.includes(normalizeProjectStatus(s.status)) && s.bidDueDate !== null)
    .sort((a, b) => a.bidDueDate! - b.bidDueDate!)
    .slice(0, 5);

  return (
    <CardShell
      title="Upcoming bid deadlines"
      icon={<CalendarClock size={13} />}
      loading={loading}
      empty={!loading && upcoming.length === 0}
      emptyTitle="No upcoming deadlines."
      emptyIllustration="checklist"
      flush
    >
      <ul className="divide-y divide-edge">
        {upcoming.map(p => {
          const overdue = p.bidDueDate! < Date.now();
          return (
            <li key={p.id}>
              <Link to={`/project/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                  {p.contractor && <span className="block truncate text-xs text-ink-faint">{p.contractor}</span>}
                </span>
                <span className={`shrink-0 text-xs font-medium ${overdue ? 'text-red-600 dark:text-red-400' : 'text-ink-soft'}`}>
                  {new Date(p.bidDueDate!).toLocaleDateString()}{overdue ? ' · overdue' : ''}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
};

registerCards([
  {
    id: 'dash-project-health', title: 'Project health', icon: HeartPulse, page: 'dashboard',
    widths: [2, 3], defaultWidth: 2, Component: ProjectHealthCard,
  },
  {
    id: 'dash-mail-peek', title: 'Mail', icon: Mail, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, Component: MailPeekCard,
  },
  {
    id: 'dash-proposals', title: 'Outstanding proposals', icon: FileSignature, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: ProposalsCard,
  },
  {
    id: 'dash-my-hours', title: 'My hours this week', icon: Clock, page: 'dashboard',
    widths: [1], defaultWidth: 1, Component: MyHoursCard,
  },
  {
    id: 'dash-payments', title: 'Recent payments', icon: Wallet, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: PaymentsCard,
  },
  {
    id: 'dash-aging', title: 'Aging receivables', icon: Hourglass, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: AgingCard,
  },
  {
    id: 'dash-quick-actions', title: 'Quick actions', icon: Zap, page: 'dashboard',
    widths: [1], defaultWidth: 1, Component: QuickActionsCard,
  },
  {
    id: 'dash-recent-docs', title: 'Recent documents', icon: FileStack, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, Component: RecentDocsCard,
  },
  {
    id: 'dash-bid-deadlines', title: 'Upcoming bid deadlines', icon: CalendarClock, page: 'dashboard',
    widths: [1, 2], defaultWidth: 1, Component: BidDeadlinesCard,
  },
]);
