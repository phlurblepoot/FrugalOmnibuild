// src/cards/project/libraryCards.tsx — the 15 optional Project cards (Wave 2
// Task 9), not part of DEFAULT_LAYOUTS (that's Task 8's three core cards).
// Users add these from the card library. Registers itself with the card
// registry as a side effect on import — see src/cards/index.ts's header
// comment for why that import lives there and not in registry.tsx.
//
// pj-photo-strip note: the brief called for building this from getIssues +
// getPunchItems, but those list fetchers only carry photoCount (a number),
// not the photos themselves with fileIds — Issue/PunchItem (the single-entity
// detail types) carry the photos array, but the list endpoints don't. Rather
// than N+1 a getIssue/getPunchItem call per row, this reuses the unified
// documents system (Wave "Unified documents", migration 23) which already
// relabels issue/punch photo file rows with kind 'issue-photo'/'punch-photo'
// and is queryable via getDocuments({ projectIds, kinds }) — one cheap call,
// still sourced from issue + punch photos only, per the controller ruling.
// DocumentRow.id is the underlying file id, same id getImageUrl expects (see
// DocumentViewerModal.tsx's `/api/images/${row.id}/raw` and
// PhotoDropCard.tsx's `getImageUrl(p.fileId)` — same id space).
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PieChart, Wallet, Layers, Ruler, ClipboardCheck, Image as ImageIcon, FileSignature,
  CloudSun, Mail, CalendarClock, Users, FolderOpen, Zap, Clock, Upload,
} from 'lucide-react';
import {
  BillingSummary, AiaPayAppListItem, ProjectSummary, ChangeOrderListItem, DailyReportListItem,
  ProposalSummary, ProposalStatus, DocumentRow, TimeEntryLite, CustomerOverview,
  getBillingSummary, getPayApps, getProjectSummary, getChangeOrders, getDailyReports,
  getDailyReport, getProposals, getDocuments, getMyTimeEntries, getCustomerOverview,
  getImageUrl, getImageThumbUrl, clockIn,
} from '../../utils/store';
import type { CustomerRoleEmails } from '../../types';
import type { ProjectThreadRow } from '../../pages/mail/types';
import { mailApi } from '../../utils/mailApi';
import { formatMoney } from '../../utils/money';
import { manCountTotal, weatherLine, formatReportDate, formatStartTime } from '../../pages/project/daily/dailyReportForm';
import { formatMailDate } from '../../pages/mail/mailFormat';
import { ReplyFlagChip } from '../../components/documents/ReplyFlagChip';
import { Lightbox } from '../../components/Lightbox';
import { ChangeOrderStatusPill } from '../../components/ui/BillingPills';
import { Button, ProgressBar, StatusPill, PillTone } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { CountUp } from '../../components/motion/CountUp';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { CardShell } from '../CardShell';
import { registerCards } from '../registry';
import type { CardContext, CardWidth } from '../types';
import { DAY, hoursThisWeek } from '../../utils/time';

// ── pj-billed-ring ───────────────────────────────────────────────────────
// Ledger-family math only, per controller ruling: billed = invoiceBilledCents
// + payAppBilledCents over contractTotalCents — the same "billed" figure the
// pj-financial-band awaiting+paid segments already sum to. Never derive this
// from outstanding.
export function computeBilledPct(b: BillingSummary): number {
  if (b.contractTotalCents <= 0) return 0;
  const billed = b.invoiceBilledCents + b.payAppBilledCents;
  return Math.max(0, Math.min(100, (billed / b.contractTotalCents) * 100));
}

const RING_R = 40;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

const BilledRingCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getBillingSummary(projectId).then(setBilling).catch(() => setBilling(null));
  };
  useLiveQuery(load, { types: ['invoice', 'payment', 'aiaPayApp', 'changeOrder', 'project'], projectId });

  if (!projectId) return null;

  const loading = billing === null;
  const pct = billing ? computeBilledPct(billing) : 0;
  const offset = RING_CIRCUMFERENCE * (1 - pct / 100);

  return (
    <CardShell title="Billed" icon={<PieChart size={13} />} loading={loading}>
      {billing && (
        <div className="flex flex-col items-center justify-center gap-1 py-1">
          <div className="relative flex size-24 items-center justify-center">
            <svg viewBox="0 0 100 100" className="size-24 -rotate-90" role="img" aria-label="Percent of contract billed">
              <circle cx="50" cy="50" r={RING_R} fill="none" stroke="var(--edge)" strokeWidth="10" />
              <circle
                cx="50" cy="50" r={RING_R} fill="none"
                stroke="oklch(0.62 0.18 var(--accent-h))" strokeWidth="10" strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={offset}
              />
            </svg>
            <CountUp value={Math.round(pct)} format={v => `${v}%`} className="absolute text-xl font-bold text-ink" />
          </div>
          <span className="text-xs text-ink-faint">of {formatMoney(billing.contractTotalCents)} contract</span>
        </div>
      )}
    </CardShell>
  );
};

// ── pj-payapp-nudge ──────────────────────────────────────────────────────
export function newestDraftPayApp(apps: AiaPayAppListItem[]): AiaPayAppListItem | null {
  return apps.filter(p => p.status === 'draft').sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

const PayAppNudgeCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [payApps, setPayApps] = useState<AiaPayAppListItem[] | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getPayApps(projectId).then(setPayApps).catch(() => setPayApps([]));
  };
  useLiveQuery(load, { types: ['aiaPayApp'], projectId });

  if (!projectId) return null;

  const loading = payApps === null;
  const draft = newestDraftPayApp(payApps ?? []);

  return (
    <CardShell
      title="Pay app nudge" icon={<Wallet size={13} />} loading={loading}
      empty={!loading && !draft} emptyTitle="No draft pay apps" emptyIllustration="money"
    >
      {draft && (
        <Link
          to={`/project/${projectId}/billing`}
          className="block rounded-lg border border-amber-300 bg-amber-50 p-3 transition-colors hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-900/20 dark:hover:bg-amber-900/30"
        >
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Pay app #{draft.number} in draft</p>
          <p className="text-lg font-bold text-ink">{formatMoney(draft.totalCents)}</p>
        </Link>
      )}
    </CardShell>
  );
};

// ── pj-plan-set ──────────────────────────────────────────────────────────
const PlanSetCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(setSummary).catch(() => setSummary(null));
  };
  useLiveQuery(load, { types: ['project', 'file'], projectId });

  if (!projectId) return null;

  const loading = summary === null;

  return (
    <CardShell title="Current plan set" icon={<Layers size={13} />} loading={loading}>
      {summary && (
        <Link to={`/project/${projectId}/takeoff`} className="flex items-center justify-between gap-2 rounded-lg border border-edge p-3 transition-colors hover:bg-hover">
          <span className="text-sm text-ink">Plan set</span>
          <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-semibold text-ink-soft">
            {summary.pageCount} page{summary.pageCount === 1 ? '' : 's'}
          </span>
        </Link>
      )}
    </CardShell>
  );
};

// ── pj-takeoff-totals ────────────────────────────────────────────────────
const TakeoffTotalsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(setSummary).catch(() => setSummary(null));
  };
  useLiveQuery(load, { types: ['project'], projectId });

  if (!projectId) return null;

  const loading = summary === null;

  return (
    <CardShell title="Takeoffs" icon={<Ruler size={13} />} loading={loading}>
      {summary && (
        <Link to={`/project/${projectId}/takeoff`} className="flex items-center justify-between gap-2 rounded-lg border border-edge p-3 transition-colors hover:bg-hover">
          <span className="text-sm text-ink">Takeoffs</span>
          <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-semibold text-ink-soft">{summary.takeoffCount}</span>
        </Link>
      )}
    </CardShell>
  );
};

// ── pj-punch-ring ────────────────────────────────────────────────────────
// Named for the spec row's id, but width [1] only and ProgressBar (an actual
// glow-legitimate progress bar) reads better at that size than a small donut
// — see task-9-brief.md's own note settling on ProgressBar here.
const PunchRingCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(setSummary).catch(() => setSummary(null));
  };
  useLiveQuery(load, { types: ['project', 'punch'], projectId });

  if (!projectId) return null;

  const loading = summary === null;

  return (
    <CardShell title="Punch progress" icon={<ClipboardCheck size={13} />} loading={loading}>
      {summary && <ProgressBar done={summary.punchDone} total={summary.punchTotal} />}
    </CardShell>
  );
};

// ── pj-photo-strip ───────────────────────────────────────────────────────
const PhotoStripCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getDocuments({ projectIds: [projectId], kinds: ['issue-photo', 'punch-photo'], limit: 8 })
      .then(r => setDocs(r.rows)).catch(() => setDocs([]));
  };
  useLiveQuery(load, { types: ['issue', 'punch', 'file'], projectId });

  if (!projectId) return null;

  const loading = docs === null;
  const photos = docs ?? [];

  return (
    <CardShell
      title="Recent photos" icon={<ImageIcon size={13} />} loading={loading}
      empty={!loading && photos.length === 0} emptyTitle="No issue or punch photos yet." emptyIllustration="photos"
      actions={<Link to={`/project/${projectId}/documents`} className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
    >
      <div className="grid grid-cols-4 gap-2">
        {photos.map((p, i) => (
          <img
            key={p.id}
            src={getImageThumbUrl(p.id)}
            alt=""
            onClick={() => setLightboxIndex(i)}
            className="aspect-square w-full cursor-pointer rounded-lg border border-edge object-cover"
          />
        ))}
      </div>
      {lightboxIndex !== null && (
        <Lightbox
          items={photos.map(p => ({ src: getImageUrl(p.id) }))}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </CardShell>
  );
};

// ── pj-change-orders ─────────────────────────────────────────────────────
export interface CoStats { approvedTotalCents: number; pendingCount: number; latest: ChangeOrderListItem | null }
export function computeCoStats(cos: ChangeOrderListItem[]): CoStats {
  const approvedTotalCents = cos.filter(c => c.status === 'approved').reduce((s, c) => s + c.totalCents, 0);
  const pendingCount = cos.filter(c => c.status !== 'approved' && c.status !== 'rejected').length;
  const latest = [...cos].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  return { approvedTotalCents, pendingCount, latest };
}

const ChangeOrdersCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [cos, setCos] = useState<ChangeOrderListItem[] | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getChangeOrders(projectId).then(setCos).catch(() => setCos([]));
  };
  useLiveQuery(load, { types: ['changeOrder'], projectId });

  if (!projectId) return null;

  const loading = cos === null;
  const stats = computeCoStats(cos ?? []);

  return (
    <CardShell
      title="Change orders" icon={<FileSignature size={13} />} loading={loading}
      empty={!loading && (cos ?? []).length === 0} emptyTitle="No change orders yet." emptyIllustration="money"
      actions={<Link to={`/project/${projectId}/billing`} className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
    >
      {cos && cos.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="text-lg font-bold text-ink">{formatMoney(stats.approvedTotalCents)}</span>
            <span className="text-xs text-ink-faint">approved</span>
            {stats.pendingCount > 0 && (
              <span className="text-xs text-ink-soft">{stats.pendingCount} pending</span>
            )}
          </div>
          {stats.latest && (
            <div className="flex items-center justify-between gap-2 text-xs text-ink-soft">
              <span className="min-w-0 truncate">{stats.latest.title || `CO ${stats.latest.number ?? ''}`}</span>
              <ChangeOrderStatusPill status={stats.latest.status} />
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
};

// ── pj-daily-latest ──────────────────────────────────────────────────────
// The newest-dated report across every crew; on a date several crews filed,
// the one filed last.
function newestDailyReport(rows: DailyReportListItem[]): DailyReportListItem | null {
  return [...rows].sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.createdAt - a.createdAt)[0] ?? null;
}

const DailyLatestCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [rows, setRows] = useState<DailyReportListItem[] | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getDailyReports(projectId).then(list => {
      setRows(list);
      const latest = newestDailyReport(list);
      if (latest) {
        getDailyReport(latest.id).then(r => setNotes(r.fieldNotes || null)).catch(() => setNotes(null));
      } else {
        setNotes(null);
      }
    }).catch(() => { setRows([]); setNotes(null); });
  };
  // dailyReportCrew too: a renamed crew renames the card's report.
  useLiveQuery(load, { types: ['dailyReport', 'dailyReportCrew'], projectId });

  if (!projectId) return null;

  const loading = rows === null;
  const latest = newestDailyReport(rows ?? []);

  return (
    <CardShell
      title="Latest daily report" icon={<CloudSun size={13} />} loading={loading}
      empty={!loading && !latest} emptyTitle="No daily reports yet." emptyIllustration="blueprint"
      actions={<Link to={`/project/${projectId}/daily-reports`} className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
    >
      {latest && (
        <div className="space-y-1.5">
          {/* One date can hold a report per crew, so the crew names it too. */}
          <p className="text-sm font-semibold text-ink">{formatReportDate(latest.reportDate)}{latest.crewName ? ` · ${latest.crewName}` : ''}</p>
          {(latest.weatherSummary || latest.temperature) && (
            <p className="text-xs text-ink-soft">{weatherLine(latest.weatherSummary, latest.temperature)}</p>
          )}
          <p className="text-xs text-ink-faint">
            {manCountTotal(latest.manCounts)} on site{latest.startTime ? ` · started ${formatStartTime(latest.startTime)}` : ''}
          </p>
          {notes && <p className="line-clamp-2 text-xs text-ink-faint">{notes}</p>}
        </div>
      )}
    </CardShell>
  );
};

// ── pj-mail-threads ──────────────────────────────────────────────────────
// Mirrors ProjectMail.tsx's `hasReply` exactly (commit 0e5c8b1, spec Goal 4):
// floored at max(lastOutboundDate, earliestLinkCreatedAt), not just
// lastOutboundDate — otherwise a thread whose only inbound predates its link
// to this project would false-positive as an unanswered reply.
export function threadNeedsReply(
  row: Pick<ProjectThreadRow, 'lastInboundDate' | 'lastOutboundDate' | 'earliestLinkCreatedAt'>
): boolean {
  const floor = row.lastOutboundDate && row.lastOutboundDate > row.earliestLinkCreatedAt
    ? row.lastOutboundDate : row.earliestLinkCreatedAt;
  return !!row.lastInboundDate && row.lastInboundDate > floor;
}

const MailThreadsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [rows, setRows] = useState<ProjectThreadRow[] | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    mailApi.projectThreads(projectId).then(setRows).catch(() => setRows([]));
  };
  useLiveQuery(load, { types: ['mailThread'], projectId });

  if (!projectId) return null;

  const loading = rows === null;
  const visible = [...(rows ?? [])]
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, 4);

  return (
    <CardShell
      title="Mail" icon={<Mail size={13} />} loading={loading}
      empty={!loading && visible.length === 0} emptyTitle="No email threads linked to this project." emptyIllustration="inbox"
      actions={<Link to={`/project/${projectId}/mail`} className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
      flush
    >
      <ul className="divide-y divide-edge">
        {visible.map(row => (
          <li key={row.threadKey}>
            <Link to={`/project/${projectId}/mail`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{row.subjectSnapshot || '(no subject)'}</span>
                <span className="block truncate text-xs text-ink-faint">{formatMailDate(row.lastActivity)}</span>
              </span>
              {threadNeedsReply(row) && <ReplyFlagChip data-testid={`pj-mail-reply-${row.threadKey}`} />}
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  );
};

// ── pj-key-dates ─────────────────────────────────────────────────────────
export function bidCountdownText(dueMs: number, now: number = Date.now()): string {
  const days = Math.round((dueMs - now) / DAY);
  if (days === 0) return 'due today';
  if (days > 0) return `due in ${days} day${days === 1 ? '' : 's'}`;
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
}

const KeyDatesCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(setSummary).catch(() => setSummary(null));
  };
  useLiveQuery(load, { types: ['project'], projectId });

  if (!projectId) return null;

  const loading = summary === null;

  return (
    <CardShell title="Key dates" icon={<CalendarClock size={13} />} loading={loading}>
      {summary && (
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-ink-faint">Started</dt>
            <dd className="text-ink">{new Date(summary.createdAt).toLocaleDateString()}</dd>
          </div>
          {summary.bidDueDate !== null && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-faint">Bid</dt>
              <dd className="text-ink">{bidCountdownText(summary.bidDueDate)}</dd>
            </div>
          )}
        </dl>
      )}
    </CardShell>
  );
};

// ── pj-contacts ──────────────────────────────────────────────────────────
export function firstRoleEmail(emails: CustomerRoleEmails | undefined): string | null {
  if (!emails) return null;
  for (const role of ['general', 'accounting', 'estimating', 'pm'] as const) {
    const to = emails[role]?.to;
    if (to && to.trim()) return to.split(',')[0].trim();
  }
  return null;
}

const ContactsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [summary, setSummary] = useState<ProjectSummary | null>(null);
  const [customer, setCustomer] = useState<CustomerOverview | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(s => {
      setSummary(s);
      if (s.customerId) {
        getCustomerOverview(s.customerId).then(setCustomer).catch(() => setCustomer(null));
      } else {
        setCustomer(null);
      }
    }).catch(() => setSummary(null));
  };
  useLiveQuery(load, { types: ['project', 'customer'], projectId });

  if (!projectId) return null;

  const loading = summary === null;
  const customerEmail = customer ? firstRoleEmail(customer.customer.emails) : null;

  return (
    <CardShell title="Contacts" icon={<Users size={13} />} loading={loading}>
      {summary && (
        <dl className="space-y-1.5 text-sm">
          {summary.contractor && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-faint">Contractor</dt>
              <dd className="min-w-0 truncate text-ink">{summary.contractor}</dd>
            </div>
          )}
          {customer && (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-faint">Customer</dt>
              <dd className="min-w-0 truncate text-ink">
                {customerEmail ? <a href={`mailto:${customerEmail}`} className="text-accent-600 hover:underline">{customer.customer.name}</a> : customer.customer.name}
              </dd>
            </div>
          )}
          {!summary.contractor && !customer && (
            <p className="text-xs text-ink-faint">No contacts on file.</p>
          )}
        </dl>
      )}
    </CardShell>
  );
};

// ── pj-proposal-status ───────────────────────────────────────────────────
const PROPOSAL_STATUS_TONE: Record<ProposalStatus, PillTone> = {
  draft: 'slate', sent: 'blue', accepted: 'green', declined: 'red',
};

const ProposalStatusCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getProposals(projectId).then(setProposals).catch(() => setProposals([]));
  };
  useLiveQuery(load, { types: ['proposal'], projectId });

  if (!projectId) return null;

  const loading = proposals === null;
  const latest = [...(proposals ?? [])].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

  return (
    <CardShell
      title="Proposal" icon={<FileSignature size={13} />} loading={loading}
      empty={!loading && !latest} emptyTitle="No proposals yet." emptyIllustration="blueprint"
      actions={latest ? <Link to={`/project/${projectId}/proposal/${latest.id}`} className="text-xs font-medium text-accent-600 hover:underline">Open</Link> : undefined}
    >
      {latest && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-ink">#{latest.number}{latest.title ? ` — ${latest.title}` : ''}</span>
            <StatusPill tone={PROPOSAL_STATUS_TONE[latest.status] ?? 'slate'}>{latest.status}</StatusPill>
          </div>
          <p className="text-lg font-bold text-ink">{formatMoney(latest.totalCents)}</p>
          {latest.sentAt !== null && (
            <p className="text-xs text-ink-faint">Sent {new Date(latest.sentAt).toLocaleDateString()}</p>
          )}
        </div>
      )}
    </CardShell>
  );
};

// ── pj-docs-shortcuts ────────────────────────────────────────────────────
const DocsShortcutsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [docs, setDocs] = useState<DocumentRow[] | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getDocuments({ projectIds: [projectId], limit: 5 }).then(r => setDocs(r.rows)).catch(() => setDocs([]));
  };
  useLiveQuery(load, { types: ['file'], projectId });

  if (!projectId) return null;

  const loading = docs === null;
  const visible = docs ?? [];

  return (
    <CardShell
      title="Documents" icon={<FolderOpen size={13} />} loading={loading}
      empty={!loading && visible.length === 0} emptyTitle="No documents yet." emptyIllustration="blueprint"
      actions={<Link to={`/project/${projectId}/documents`} className="text-xs font-medium text-accent-600 hover:underline">View all</Link>}
      flush
    >
      <ul className="divide-y divide-edge">
        {visible.map(d => (
          <li key={d.id}>
            <Link to={`/project/${projectId}/documents`} className="flex items-center justify-between gap-3 px-4 py-2 transition-colors hover:bg-hover">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{d.name ?? '(untitled)'}</span>
                <span className="block truncate text-xs text-ink-faint">{d.kind}</span>
              </span>
              <span className="shrink-0 text-xs text-ink-faint">{new Date(d.createdAt).toLocaleDateString()}</span>
            </Link>
          </li>
        ))}
      </ul>
    </CardShell>
  );
};

// ── pj-actions ───────────────────────────────────────────────────────────
// Ported verbatim (content, not layout) from ProjectOverview's pre-rewrite
// Actions card — git show 888d332~1:src/pages/project/ProjectOverview.tsx.
const ActionsCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const { toast } = useToast();
  const { projectId } = ctx;

  if (!projectId) return null;

  const handleClockIn = async () => {
    try {
      await clockIn(projectId);
      toast('Clocked in to this project', { type: 'success' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Clock-in failed', { type: 'error' });
    }
  };

  return (
    <CardShell title="Actions" icon={<Zap size={13} />}>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={handleClockIn}>
          <Clock size={14} />Clock in to this project
        </Button>
        <Link to={`/project/${projectId}/takeoff`}><Button variant="secondary" size="sm"><Ruler size={14} />Open takeoff</Button></Link>
        <Link to={`/project/${projectId}/documents`}><Button variant="secondary" size="sm"><FolderOpen size={14} />Documents</Button></Link>
        <Link to={`/project/${projectId}/documents`}><Button variant="secondary" size="sm"><Upload size={14} />Upload a file</Button></Link>
      </div>
    </CardShell>
  );
};

// ── pj-my-hours ──────────────────────────────────────────────────────────
const MyHoursCard: React.FC<{ width: CardWidth; ctx: CardContext }> = ({ ctx }) => {
  const [entries, setEntries] = useState<TimeEntryLite[] | null>(null);
  const { projectId } = ctx;

  const load = () => {
    if (!projectId) return;
    getMyTimeEntries(projectId).then(setEntries).catch(() => setEntries([]));
  };
  useLiveQuery(load, { types: ['timeEntry'], projectId });

  if (!projectId) return null;

  const loading = entries === null;
  const totalHours = entries
    ? entries.reduce((ms, e) => ms + ((e.clockOut ?? Date.now()) - e.clockIn), 0) / 3_600_000
    : 0;
  const weekHours = entries ? hoursThisWeek(entries) : 0;

  return (
    <CardShell
      title="My hours on this project" icon={<Clock size={13} />} loading={loading}
      actions={<Link to={`/project/${projectId}/time`} className="text-xs font-medium text-accent-600 hover:underline">Project time</Link>}
    >
      {!loading && (
        <div className="flex items-baseline gap-2">
          <CountUp value={totalHours} format={v => v.toFixed(1)} className="text-2xl font-bold text-ink" />
          <span className="text-sm text-ink-soft">hours total · {weekHours.toFixed(1)} this week</span>
        </div>
      )}
    </CardShell>
  );
};

registerCards([
  { id: 'pj-billed-ring', title: 'Billed', icon: PieChart, page: 'project', widths: [1], defaultWidth: 1, adminOnly: true, Component: BilledRingCard },
  { id: 'pj-payapp-nudge', title: 'Pay app nudge', icon: Wallet, page: 'project', widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: PayAppNudgeCard },
  { id: 'pj-plan-set', title: 'Current plan set', icon: Layers, page: 'project', widths: [1, 2], defaultWidth: 1, Component: PlanSetCard },
  { id: 'pj-takeoff-totals', title: 'Takeoffs', icon: Ruler, page: 'project', widths: [1, 2], defaultWidth: 1, Component: TakeoffTotalsCard },
  { id: 'pj-punch-ring', title: 'Punch progress', icon: ClipboardCheck, page: 'project', widths: [1], defaultWidth: 1, Component: PunchRingCard },
  { id: 'pj-photo-strip', title: 'Recent photos', icon: ImageIcon, page: 'project', widths: [2, 3], defaultWidth: 2, Component: PhotoStripCard },
  { id: 'pj-change-orders', title: 'Change orders', icon: FileSignature, page: 'project', widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: ChangeOrdersCard },
  { id: 'pj-daily-latest', title: 'Latest daily report', icon: CloudSun, page: 'project', widths: [1, 2], defaultWidth: 1, Component: DailyLatestCard },
  { id: 'pj-mail-threads', title: 'Mail', icon: Mail, page: 'project', widths: [1, 2], defaultWidth: 1, Component: MailThreadsCard },
  { id: 'pj-key-dates', title: 'Key dates', icon: CalendarClock, page: 'project', widths: [1], defaultWidth: 1, Component: KeyDatesCard },
  { id: 'pj-contacts', title: 'Contacts', icon: Users, page: 'project', widths: [1], defaultWidth: 1, Component: ContactsCard },
  { id: 'pj-proposal-status', title: 'Proposal', icon: FileSignature, page: 'project', widths: [1, 2], defaultWidth: 1, adminOnly: true, Component: ProposalStatusCard },
  { id: 'pj-docs-shortcuts', title: 'Documents', icon: FolderOpen, page: 'project', widths: [1, 2], defaultWidth: 1, Component: DocsShortcutsCard },
  { id: 'pj-actions', title: 'Actions', icon: Zap, page: 'project', widths: [1, 2], defaultWidth: 1, Component: ActionsCard },
  { id: 'pj-my-hours', title: 'My hours on this project', icon: Clock, page: 'project', widths: [1], defaultWidth: 1, Component: MyHoursCard },
]);
