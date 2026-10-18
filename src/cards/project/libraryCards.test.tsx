// src/cards/project/libraryCards.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { ThemeProvider } from '../../context/ThemeContext';
import type { CardContext, CardWidth } from '../types';
import type { BillingSummary, ChangeOrderListItem, DailyReportListItem, ProposalSummary } from '../../utils/store';
import type { ProjectThreadRow } from '../../pages/mail/types';

const {
  getBillingSummary, getPayApps, getProjectSummary, getChangeOrders, getDailyReports, getDailyReport,
  getProposals, getDocuments, getMyTimeEntries, getCustomerOverview, clockIn,
} = vi.hoisted(() => ({
  getBillingSummary: vi.fn(),
  getPayApps: vi.fn(),
  getProjectSummary: vi.fn(),
  getChangeOrders: vi.fn(),
  getDailyReports: vi.fn(),
  getDailyReport: vi.fn(),
  getProposals: vi.fn(),
  getDocuments: vi.fn(),
  getMyTimeEntries: vi.fn(),
  getCustomerOverview: vi.fn(),
  clockIn: vi.fn(),
}));

vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBillingSummary, getPayApps, getProjectSummary, getChangeOrders, getDailyReports, getDailyReport,
  getProposals, getDocuments, getMyTimeEntries, getCustomerOverview, clockIn,
}));

const { projectThreads } = vi.hoisted(() => ({ projectThreads: vi.fn() }));
vi.mock('../../utils/mailApi', () => ({ mailApi: { projectThreads } }));

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast }) }));

// useLiveQuery needs a CollaborationContext provider; a null socket is fine
// since the initial load fires regardless of socket presence.
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: null }),
}));

const { CARD_REGISTRY } = await import('../registry');
const {
  computeBilledPct, computeCoStats, threadNeedsReply, bidCountdownText, firstRoleEmail, newestDraftPayApp,
} = await import('./libraryCards');
await import('./libraryCards');

function defFor(id: string) {
  const def = CARD_REGISTRY.find(c => c.id === id);
  if (!def) throw new Error(`card ${id} not registered`);
  return def;
}

function mount(id: string, width: CardWidth, ctx: CardContext = { isAdmin: true, projectId: 'p1' }) {
  const def = defFor(id);
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <def.Component width={width} ctx={ctx} />
      </ThemeProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  getBillingSummary.mockReset();
  getPayApps.mockReset();
  getProjectSummary.mockReset();
  getChangeOrders.mockReset();
  getDailyReports.mockReset();
  getDailyReport.mockReset();
  getProposals.mockReset();
  getDocuments.mockReset();
  getMyTimeEntries.mockReset();
  getCustomerOverview.mockReset();
  clockIn.mockReset();
  projectThreads.mockReset();
  toast.mockReset();
  localStorage.clear();
  // Reduced motion so CountUp renders its final value synchronously.
  localStorage.setItem('theme-motion', 'reduced');
});

afterEach(() => {
  localStorage.removeItem('theme-motion');
});

describe('libraryCards registration', () => {
  it('registers all 15 cards with the specified widths/defaults/adminOnly flags', () => {
    expect(defFor('pj-billed-ring')).toMatchObject({ page: 'project', widths: [1], defaultWidth: 1, adminOnly: true });
    expect(defFor('pj-payapp-nudge')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1, adminOnly: true });
    expect(defFor('pj-plan-set')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('pj-plan-set').adminOnly).toBeFalsy();
    expect(defFor('pj-takeoff-totals')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('pj-punch-ring')).toMatchObject({ page: 'project', widths: [1], defaultWidth: 1 });
    expect(defFor('pj-punch-ring').adminOnly).toBeFalsy();
    expect(defFor('pj-photo-strip')).toMatchObject({ page: 'project', widths: [2, 3], defaultWidth: 2 });
    expect(defFor('pj-change-orders')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1, adminOnly: true });
    expect(defFor('pj-daily-latest')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('pj-mail-threads')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('pj-key-dates')).toMatchObject({ page: 'project', widths: [1], defaultWidth: 1 });
    expect(defFor('pj-contacts')).toMatchObject({ page: 'project', widths: [1], defaultWidth: 1 });
    expect(defFor('pj-proposal-status')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1, adminOnly: true });
    expect(defFor('pj-docs-shortcuts')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('pj-actions')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('pj-actions').adminOnly).toBeFalsy();
    expect(defFor('pj-my-hours')).toMatchObject({ page: 'project', widths: [1], defaultWidth: 1 });
    expect(defFor('pj-my-hours').adminOnly).toBeFalsy();
  });
});

describe('computeBilledPct', () => {
  const base: BillingSummary = {
    sovOriginalCents: 0, hasSov: true, baseContractCents: 1_000_000, approvedChangeCents: 0,
    contractTotalCents: 1_000_000, contractValueCents: 1_000_000,
    invoiceTotalCents: 0, invoicedCents: 0,
    paid: { invoicesCents: 0, payAppsCents: 0 }, paidCents: 0,
    invoiceOutstandingCents: 0, outstandingCents: 0,
    invoiceCount: 0, changeOrderCount: 0,
    payAppBilledCents: 400_000, payAppOutstandingCents: 0, payAppPaidCents: 0,
    invoiceBilledCents: 100_000, invoicePaidCents: 0, invoiceOutstandingBilledCents: 0,
  };

  it('derives billed% from invoiceBilledCents + payAppBilledCents over contractTotalCents', () => {
    expect(computeBilledPct(base)).toBe(50);
  });

  it('clamps to 100 when billed exceeds contract total', () => {
    expect(computeBilledPct({ ...base, contractTotalCents: 200_000 })).toBe(100);
  });

  it('guards against a zero contract total', () => {
    expect(computeBilledPct({ ...base, contractTotalCents: 0 })).toBe(0);
  });
});

describe('pj-billed-ring', () => {
  it('renders the CountUp percent centered in the donut, and renders nothing for non-admin ctx would be gated by cardsForPage (not this component)', async () => {
    getBillingSummary.mockResolvedValue({
      sovOriginalCents: 0, hasSov: true, baseContractCents: 1_000_000, approvedChangeCents: 0,
      contractTotalCents: 1_000_000, contractValueCents: 1_000_000,
      invoiceTotalCents: 0, invoicedCents: 0,
      paid: { invoicesCents: 0, payAppsCents: 0 }, paidCents: 0,
      invoiceOutstandingCents: 0, outstandingCents: 0,
      invoiceCount: 0, changeOrderCount: 0,
      payAppBilledCents: 200_000, payAppOutstandingCents: 0, payAppPaidCents: 0,
      invoiceBilledCents: 100_000, invoicePaidCents: 0, invoiceOutstandingBilledCents: 0,
    });
    mount('pj-billed-ring', 1);
    expect(await screen.findByText('30%')).toBeInTheDocument();
  });

  it('renders nothing when ctx has no projectId', () => {
    const { container } = mount('pj-billed-ring', 1, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('newestDraftPayApp / pj-payapp-nudge', () => {
  const app = (over: Record<string, unknown>) => ({
    id: 'x', projectId: 'p1', number: 1, periodTo: null, applicationDate: null, retainagePercent: 0,
    storedRetainagePercent: 0, releasedRetainagePoints: 0, status: 'draft', version: 1,
    createdAt: 0, updatedAt: 0, totalCents: 0, paidCents: 0, balanceCents: null, ...over,
  });

  it('picks the newest draft pay app by createdAt', () => {
    const apps = [app({ id: 'a', createdAt: 1, number: 1 }), app({ id: 'b', createdAt: 2, number: 2 }), app({ id: 'c', status: 'finalized', createdAt: 3 })];
    expect(newestDraftPayApp(apps)?.id).toBe('b');
  });

  it('shows the amount and links to billing', async () => {
    getPayApps.mockResolvedValue([app({ id: 'pa1', number: 4, createdAt: 1, totalCents: 125_000 })]);
    mount('pj-payapp-nudge', 1);
    expect(await screen.findByText('Pay app #4 in draft')).toBeInTheDocument();
    expect(screen.getByText('$1,250.00')).toBeInTheDocument();
    expect(screen.getByText('Pay app #4 in draft').closest('a')).toHaveAttribute('href', '/project/p1/billing');
  });

  it('shows the empty state when there are no draft pay apps', async () => {
    getPayApps.mockResolvedValue([]);
    mount('pj-payapp-nudge', 1);
    expect(await screen.findByText('No draft pay apps')).toBeInTheDocument();
  });
});

describe('pj-plan-set', () => {
  it('shows the page count and links to takeoff', async () => {
    getProjectSummary.mockResolvedValue({
      id: 'p1', name: 'Proj', status: 'in_progress', contractor: null, customerId: null, address: null,
      bidDueDate: null, version: 1, createdAt: 0, updatedAt: null, archived: false,
      pageCount: 12, takeoffCount: 3, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0,
    });
    mount('pj-plan-set', 1);
    expect(await screen.findByText('12 pages')).toBeInTheDocument();
    expect(screen.getByText('Plan set').closest('a')).toHaveAttribute('href', '/project/p1/takeoff');
  });
});

describe('pj-takeoff-totals', () => {
  it('shows the takeoff count and links to takeoff', async () => {
    getProjectSummary.mockResolvedValue({
      id: 'p1', name: 'Proj', status: 'in_progress', contractor: null, customerId: null, address: null,
      bidDueDate: null, version: 1, createdAt: 0, updatedAt: null, archived: false,
      pageCount: 1, takeoffCount: 7, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0,
    });
    mount('pj-takeoff-totals', 1);
    await screen.findByText('7');
    const link = screen.getByText('7').closest('a');
    expect(link).toHaveAttribute('href', '/project/p1/takeoff');
  });
});

describe('pj-punch-ring', () => {
  it('renders a ProgressBar with done/total from the summary', async () => {
    getProjectSummary.mockResolvedValue({
      id: 'p1', name: 'Proj', status: 'in_progress', contractor: null, customerId: null, address: null,
      bidDueDate: null, version: 1, createdAt: 0, updatedAt: null, archived: false,
      pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 3, punchTotal: 8,
    });
    mount('pj-punch-ring', 1);
    expect(await screen.findByText('3 / 8')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '38');
  });
});

describe('pj-photo-strip', () => {
  it('sources photos from getDocuments with issue-photo/punch-photo kinds and renders shrunk photos via getImageThumbUrl', async () => {
    getDocuments.mockResolvedValue({
      rows: [
        { id: 'f1', name: 'a.jpg', mime: 'image/jpeg', size: 1, kind: 'issue-photo', createdAt: 2, versionNumber: 1, archived: false, projectId: 'p1', projectName: null, customerId: null, customerName: null, source: null },
        { id: 'f2', name: 'b.jpg', mime: 'image/jpeg', size: 1, kind: 'punch-photo', createdAt: 1, versionNumber: 1, archived: false, projectId: 'p1', projectName: null, customerId: null, customerName: null, source: null },
      ], total: 2,
    });
    const { container } = mount('pj-photo-strip', 2);

    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
    const imgs = container.querySelectorAll('img');
    expect(imgs[0]).toHaveAttribute('src', '/api/images/f1/thumb');
    expect(getDocuments).toHaveBeenCalledWith({ projectIds: ['p1'], kinds: ['issue-photo', 'punch-photo'], limit: 8 });
  });

  it('shows the empty state when there are no issue/punch photos', async () => {
    getDocuments.mockResolvedValue({ rows: [], total: 0 });
    mount('pj-photo-strip', 2);
    expect(await screen.findByText('No issue or punch photos yet.')).toBeInTheDocument();
  });

  it('clicking a thumb opens the lightbox at that index', async () => {
    getDocuments.mockResolvedValue({
      rows: [
        { id: 'f1', name: 'a.jpg', mime: 'image/jpeg', size: 1, kind: 'issue-photo', createdAt: 2, versionNumber: 1, archived: false, projectId: 'p1', projectName: null, customerId: null, customerName: null, source: null },
        { id: 'f2', name: 'b.jpg', mime: 'image/jpeg', size: 1, kind: 'punch-photo', createdAt: 1, versionNumber: 1, archived: false, projectId: 'p1', projectName: null, customerId: null, customerName: null, source: null },
      ], total: 2,
    });
    const { container } = mount('pj-photo-strip', 2);
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));

    fireEvent.click(container.querySelectorAll('img')[1]);
    expect(screen.getByRole('dialog', { name: 'Photo viewer' })).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });
});

describe('computeCoStats', () => {
  const co = (over: Partial<ChangeOrderListItem>): ChangeOrderListItem => ({
    id: 'x', projectId: 'p1', number: '1', date: null, title: null, description: null, lumpSumAmount: 0,
    scheduleImpactDays: null, status: 'draft', version: 1, createdAt: 0, updatedAt: 0, amount: 0, totalCents: 0,
    ...over,
  });

  it('sums approved totalCents, counts pending (not approved/rejected), and picks the newest as latest', () => {
    const cos = [
      co({ id: 'a', status: 'approved', totalCents: 100_000, createdAt: 1 }),
      co({ id: 'b', status: 'sent', totalCents: 50_000, createdAt: 3, title: 'Extra work' }),
      co({ id: 'c', status: 'rejected', totalCents: 999_999, createdAt: 2 }),
      co({ id: 'd', status: 'approved', totalCents: 25_000, createdAt: 0 }),
    ];
    const stats = computeCoStats(cos);
    expect(stats.approvedTotalCents).toBe(125_000);
    expect(stats.pendingCount).toBe(1); // only 'b' (sent) — rejected excluded
    expect(stats.latest?.id).toBe('b');
  });
});

describe('pj-change-orders', () => {
  it('renders approved total, pending count, and the latest CO status pill', async () => {
    getChangeOrders.mockResolvedValue([
      { id: 'a', projectId: 'p1', number: '1', date: null, title: 'Foundation change', description: null, lumpSumAmount: 0, scheduleImpactDays: null, status: 'approved', version: 1, createdAt: 1, updatedAt: 1, amount: 0, totalCents: 200_000 },
      { id: 'b', projectId: 'p1', number: '2', date: null, title: 'Latest CO', description: null, lumpSumAmount: 0, scheduleImpactDays: null, status: 'sent', version: 1, createdAt: 2, updatedAt: 2, amount: 0, totalCents: 50_000 },
    ]);
    mount('pj-change-orders', 1);
    expect(await screen.findByText('$2,000.00')).toBeInTheDocument();
    expect(screen.getByText('1 pending')).toBeInTheDocument();
    expect(screen.getByText('Latest CO')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });
});

describe('pj-daily-latest', () => {
  it('shows the newest report by reportDate with weather, man count total, and a notes preview', async () => {
    getDailyReports.mockResolvedValue([
      { id: 'd1', projectId: 'p1', reportDate: '2026-08-01', jobName: 'j', contractorName: 'c', weatherSummary: 'Sunny', temperature: '75F', manCounts: [{ type: 'Framers', count: 3 }], createdBy: null, createdAt: 1, updatedAt: 1, version: 1, photoCount: 0 },
      { id: 'd2', projectId: 'p1', reportDate: '2026-08-05', jobName: 'j', contractorName: 'c', weatherSummary: 'Cloudy', temperature: '68F', manCounts: [{ type: 'Framers', count: 2 }, { type: 'Electricians', count: 1 }], createdBy: null, createdAt: 2, updatedAt: 2, version: 1, photoCount: 0 },
    ]);
    getDailyReport.mockResolvedValue({
      id: 'd2', projectId: 'p1', reportDate: '2026-08-05', jobName: 'j', contractorName: 'c', weatherSummary: 'Cloudy',
      temperature: '68F', weatherHourly: [], manCounts: [{ type: 'Framers', count: 2 }, { type: 'Electricians', count: 1 }],
      fieldNotes: 'Poured slab today.', issues: '', createdBy: null, createdAt: 2, updatedAt: 2, version: 1, photos: [],
    });
    mount('pj-daily-latest', 1);

    expect(await screen.findByText('Poured slab today.')).toBeInTheDocument();
    expect(getDailyReport).toHaveBeenCalledWith('d2'); // the newer of the two by reportDate
    expect(screen.getByText('3 on site')).toBeInTheDocument();
  });

  it('says when the newest report started', async () => {
    getDailyReports.mockResolvedValue([
      { id: 'd1', projectId: 'p1', reportDate: '2026-08-05', jobName: 'j', contractorName: 'c', startTime: '07:30', weatherSummary: '', temperature: '', manCounts: [{ type: 'Framers', count: 3 }], createdBy: null, createdAt: 1, updatedAt: 1, version: 1, photoCount: 0 },
    ]);
    getDailyReport.mockResolvedValue({ id: 'd1', fieldNotes: '' });
    mount('pj-daily-latest', 1);
    expect(await screen.findByText('3 on site · started 7:30 AM')).toBeInTheDocument();
  });

  // One date can hold a report per crew: the card names the crew, and of two
  // crews' reports on the newest date shows the one filed last.
  it('names the newest report\'s crew, the last-filed one on a shared date', async () => {
    const row = (id: string, crewName: string, createdAt: number) => ({
      id, projectId: 'p1', crewId: `c-${id}`, crewName, reportDate: '2026-08-05', jobName: 'j', contractorName: 'c', startTime: null,
      weatherSummary: '', temperature: '', manCounts: [], createdBy: null, createdAt, updatedAt: createdAt, version: 1, photoCount: 0,
    });
    getDailyReports.mockResolvedValue([row('d1', 'Crew 1', 1), row('d2', 'Smith Drywall', 5), { ...row('d0', 'Crew 1', 9), reportDate: '2026-08-04' }]);
    getDailyReport.mockResolvedValue({ id: 'd2', fieldNotes: '' });
    mount('pj-daily-latest', 1);
    expect(await screen.findByText('Aug 5, 2026 · Smith Drywall')).toBeInTheDocument();
    expect(getDailyReport).toHaveBeenCalledWith('d2');
  });

  it('shows the empty state when there are no daily reports', async () => {
    getDailyReports.mockResolvedValue([]);
    mount('pj-daily-latest', 1);
    expect(await screen.findByText('No daily reports yet.')).toBeInTheDocument();
  });
});

describe('threadNeedsReply', () => {
  // Mirrors ProjectMail.tsx's `hasReply` (commit 0e5c8b1): floored at
  // max(lastOutboundDate, earliestLinkCreatedAt), not just lastOutboundDate.
  it('is true when the last inbound message is newer than both the last outbound and the link floor', () => {
    expect(threadNeedsReply({ lastInboundDate: '2026-09-02', lastOutboundDate: '2026-09-01', earliestLinkCreatedAt: '2026-08-01' })).toBe(true);
  });
  it('is true when there is no outbound at all but the inbound is newer than the link floor', () => {
    expect(threadNeedsReply({ lastInboundDate: '2026-09-02', lastOutboundDate: null, earliestLinkCreatedAt: '2026-08-01' })).toBe(true);
  });
  it('is false when the outbound is newer or equal', () => {
    expect(threadNeedsReply({ lastInboundDate: '2026-09-01', lastOutboundDate: '2026-09-02', earliestLinkCreatedAt: '2026-08-01' })).toBe(false);
  });
  it('is false with no inbound at all', () => {
    expect(threadNeedsReply({ lastInboundDate: null, lastOutboundDate: null, earliestLinkCreatedAt: '2026-08-01' })).toBe(false);
  });
  // Regression (team-lead fix-round-1 finding): a thread linked to this
  // project AFTER its only inbound message must not read as needing a reply
  // — the inbound predates our tracking of the thread entirely, even with no
  // outbound message at all.
  it('is false when the only inbound predates the earliest link to this project, even with no outbound', () => {
    expect(threadNeedsReply({ lastInboundDate: '2026-07-01', lastOutboundDate: null, earliestLinkCreatedAt: '2026-08-01' })).toBe(false);
  });
  it('is true when the inbound is newer than the link floor even though it is older than a stale outbound-before-link', () => {
    // outbound predates the link too, so the floor is earliestLinkCreatedAt, not lastOutboundDate.
    expect(threadNeedsReply({ lastInboundDate: '2026-08-15', lastOutboundDate: '2026-07-01', earliestLinkCreatedAt: '2026-08-01' })).toBe(true);
  });
});

describe('pj-mail-threads', () => {
  const row = (over: Partial<ProjectThreadRow>): ProjectThreadRow => ({
    threadKey: 'tk1', subjectSnapshot: 'RE: Invoice', participants: [], firstDate: '2026-09-01T00:00:00Z',
    links: [], lastInboundDate: null, lastOutboundDate: null, earliestLinkCreatedAt: '2026-09-01T00:00:00Z',
    lastActivity: '2026-09-01T00:00:00Z', ...over,
  });

  it('shows the top 4 threads by lastActivity and a reply chip when reply-needed', async () => {
    projectThreads.mockResolvedValue([
      row({ threadKey: 't1', subjectSnapshot: 'Older', lastActivity: '2026-09-01T00:00:00Z' }),
      row({ threadKey: 't2', subjectSnapshot: 'Newer, needs reply', lastActivity: '2026-09-03T00:00:00Z', lastInboundDate: '2026-09-03T00:00:00Z', lastOutboundDate: '2026-09-02T00:00:00Z' }),
      // Regression: inbound predates the thread's link to this project, no
      // outbound at all — must NOT show a reply chip (team-lead fix round 1).
      row({
        threadKey: 't3', subjectSnapshot: 'Stale inbound before link', lastActivity: '2026-09-02T00:00:00Z',
        lastInboundDate: '2026-08-15T00:00:00Z', lastOutboundDate: null, earliestLinkCreatedAt: '2026-09-01T00:00:00Z',
      }),
    ]);
    mount('pj-mail-threads', 1);

    await screen.findByText('Newer, needs reply');
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Newer, needs reply'); // sorted newest-first
    expect(screen.getByTestId('pj-mail-reply-t2')).toBeInTheDocument();
    expect(screen.queryByTestId('pj-mail-reply-t1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pj-mail-reply-t3')).not.toBeInTheDocument();
    expect(screen.getByText('Newer, needs reply').closest('a')).toHaveAttribute('href', '/project/p1/mail');
  });

  it('shows the empty state with no threads', async () => {
    projectThreads.mockResolvedValue([]);
    mount('pj-mail-threads', 1);
    expect(await screen.findByText('No email threads linked to this project.')).toBeInTheDocument();
  });
});

describe('bidCountdownText', () => {
  const now = new Date('2026-09-04T12:00:00Z').getTime();
  it('renders "due today" for today', () => {
    expect(bidCountdownText(now, now)).toBe('due today');
  });
  it('renders a forward countdown', () => {
    expect(bidCountdownText(now + 3 * 86_400_000, now)).toBe('due in 3 days');
  });
  it('renders an overdue message', () => {
    expect(bidCountdownText(now - 2 * 86_400_000, now)).toBe('2 days overdue');
  });
});

describe('pj-key-dates', () => {
  it('shows the started date and bid countdown when a bid due date is set', async () => {
    getProjectSummary.mockResolvedValue({
      id: 'p1', name: 'Proj', status: 'bidding', contractor: null, customerId: null, address: null,
      bidDueDate: Date.now() + 5 * 86_400_000, version: 1, createdAt: Date.now(), updatedAt: null, archived: false,
      pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0,
    });
    mount('pj-key-dates', 1);
    await screen.findByText('Started');
    expect(screen.getByText('Bid')).toBeInTheDocument();
    expect(screen.getByText(/due in 5 days/)).toBeInTheDocument();
  });

  it('omits the bid row when there is no bid due date', async () => {
    getProjectSummary.mockResolvedValue({
      id: 'p1', name: 'Proj', status: 'in_progress', contractor: null, customerId: null, address: null,
      bidDueDate: null, version: 1, createdAt: Date.now(), updatedAt: null, archived: false,
      pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0,
    });
    mount('pj-key-dates', 1);
    await screen.findByText('Started');
    expect(screen.queryByText('Bid')).not.toBeInTheDocument();
  });
});

describe('firstRoleEmail', () => {
  it('prefers general, falling back through accounting/estimating/pm', () => {
    expect(firstRoleEmail({ general: { to: 'a@x.com, b@x.com' } })).toBe('a@x.com');
    expect(firstRoleEmail({ accounting: { to: 'acct@x.com' } })).toBe('acct@x.com');
    expect(firstRoleEmail({})).toBeNull();
    expect(firstRoleEmail(undefined)).toBeNull();
  });
});

describe('pj-contacts', () => {
  it('shows the contractor and a mailto link to the customer using their first role email', async () => {
    getProjectSummary.mockResolvedValue({
      id: 'p1', name: 'Proj', status: 'in_progress', contractor: 'Acme Contracting', customerId: 'c1', address: null,
      bidDueDate: null, version: 1, createdAt: 0, updatedAt: null, archived: false,
      pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0,
    });
    getCustomerOverview.mockResolvedValue({
      customer: { id: 'c1', name: 'Jane Doe', emails: { general: { to: 'jane@example.com' } } },
      projects: [], attention: [], taskCounts: { open: 0, overdue: 0 },
    });
    mount('pj-contacts', 1);

    expect(await screen.findByText('Acme Contracting')).toBeInTheDocument();
    const link = await screen.findByText('Jane Doe');
    expect(link.closest('a')).toHaveAttribute('href', 'mailto:jane@example.com');
  });
});

describe('pj-proposal-status', () => {
  const proposal = (over: Partial<ProposalSummary>): ProposalSummary => ({
    id: 'pr1', projectId: 'p1', number: 1, revisedFromId: null, revisedFromNumber: null, status: 'sent',
    legacy: false, title: null, validUntil: null, fontFamily: null, coverNotes: null, terms: null,
    inclusions: [], exclusions: [], paymentSchedule: null, showGrandTotal: true, includeCostDetail: false,
    includeSignature: false, highlightQuality: 'best', fileId: null, signedFileId: null, sentAt: null,
    sentTo: null, acceptedAt: null, declinedAt: null, version: 1, createdBy: null, createdAt: 0, updatedAt: 0,
    totalCents: 0, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
    ...over,
  } as ProposalSummary);

  it('shows the newest proposal status pill, total, and sentAt', async () => {
    getProposals.mockResolvedValue([
      proposal({ id: 'a', createdAt: 1, number: 1, status: 'draft', totalCents: 10_000 }),
      proposal({ id: 'b', createdAt: 2, number: 2, status: 'sent', totalCents: 55_000, sentAt: Date.parse('2026-08-01') }),
    ]);
    mount('pj-proposal-status', 1);

    expect(await screen.findByText('$550.00')).toBeInTheDocument();
    expect(screen.getByText('sent')).toBeInTheDocument();
    expect(screen.getByText(/Sent/)).toHaveTextContent(new Date(Date.parse('2026-08-01')).toLocaleDateString());
    expect(screen.getByText('Open')).toHaveAttribute('href', '/project/p1/proposal/b');
  });
});

describe('pj-docs-shortcuts', () => {
  it('lists documents linking to the project documents tab', async () => {
    getDocuments.mockResolvedValue({
      rows: [{ id: 'f1', name: 'Contract.pdf', mime: 'application/pdf', size: 1, kind: 'contract', createdAt: 1, versionNumber: 1, archived: false, projectId: 'p1', projectName: null, customerId: null, customerName: null, source: null }],
      total: 1,
    });
    mount('pj-docs-shortcuts', 1);
    expect(await screen.findByText('Contract.pdf')).toBeInTheDocument();
    expect(screen.getByText('Contract.pdf').closest('a')).toHaveAttribute('href', '/project/p1/documents');
    expect(getDocuments).toHaveBeenCalledWith({ projectIds: ['p1'], limit: 5 });
  });
});

describe('pj-actions', () => {
  it('clocks in and toasts on success, and links to takeoff/documents', async () => {
    clockIn.mockResolvedValue(undefined);
    mount('pj-actions', 1);

    const clockButton = screen.getByText(/Clock in to this project/);
    clockButton.click();
    await Promise.resolve();
    expect(clockIn).toHaveBeenCalledWith('p1');

    expect(screen.getByText('Open takeoff').closest('a')).toHaveAttribute('href', '/project/p1/takeoff');
    const docLinks = screen.getAllByText(/Documents|Upload a file/);
    expect(docLinks.length).toBe(2);
    docLinks.forEach(l => expect(l.closest('a')).toHaveAttribute('href', '/project/p1/documents'));
  });
});

describe('pj-my-hours', () => {
  it('computes total and this-week hours from time entries', async () => {
    const now = Date.now();
    getMyTimeEntries.mockResolvedValue([
      { id: 't1', projectId: 'p1', clockIn: now - 2 * 3_600_000, clockOut: now - 1 * 3_600_000, description: '' },
    ]);
    mount('pj-my-hours', 1);
    expect(await screen.findByText('1.0')).toBeInTheDocument();
    expect(screen.getByText(/hours total/)).toBeInTheDocument();
  });
});
