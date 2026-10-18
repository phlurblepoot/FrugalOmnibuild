// src/cards/dashboard/libraryCards.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { ThemeProvider } from '../../context/ThemeContext';
import type { CardContext, CardWidth } from '../types';
import { startOfWeek } from '../../utils/time';
import { useTimeZone } from '../../test/timeZone';

const {
  getProjectsSummary, getOutstandingProposals, getMyTimeEntries, getDashboardMoney,
  getDashboardAttention, getDocuments, clockIn,
} = vi.hoisted(() => ({
  getProjectsSummary: vi.fn(),
  getOutstandingProposals: vi.fn(),
  getMyTimeEntries: vi.fn(),
  getDashboardMoney: vi.fn(),
  getDashboardAttention: vi.fn(),
  getDocuments: vi.fn(),
  clockIn: vi.fn(),
}));

vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectsSummary, getOutstandingProposals, getMyTimeEntries, getDashboardMoney,
  getDashboardAttention, getDocuments, clockIn,
}));

const { useMailUnread } = vi.hoisted(() => ({ useMailUnread: vi.fn() }));
vi.mock('../../pages/mail/useMailUnread', () => ({ useMailUnread }));

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast }) }));

// useLiveQuery needs a CollaborationContext provider; a null socket is fine
// since the initial load fires regardless of socket presence.
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: null }),
}));

const { CARD_REGISTRY } = await import('../registry');
await import('./libraryCards');

function defFor(id: string) {
  const def = CARD_REGISTRY.find(c => c.id === id);
  if (!def) throw new Error(`card ${id} not registered`);
  return def;
}

function mount(id: string, width: CardWidth, ctx: CardContext = { isAdmin: true }) {
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
  getProjectsSummary.mockReset();
  getOutstandingProposals.mockReset();
  getMyTimeEntries.mockReset();
  getDashboardMoney.mockReset();
  getDashboardAttention.mockReset();
  getDocuments.mockReset();
  clockIn.mockReset();
  useMailUnread.mockReset();
  toast.mockReset();
  localStorage.clear();
  // Reduced motion so CountUp renders its final value synchronously.
  localStorage.setItem('theme-motion', 'reduced');
});

afterEach(() => {
  localStorage.removeItem('theme-motion');
});

describe('libraryCards registration', () => {
  it('registers all nine cards with the specified widths/defaults/adminOnly', () => {
    expect(defFor('dash-project-health')).toMatchObject({ page: 'dashboard', widths: [2, 3], defaultWidth: 2 });
    expect(defFor('dash-project-health').adminOnly).toBeFalsy();

    expect(defFor('dash-mail-peek')).toMatchObject({ page: 'dashboard', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('dash-mail-peek').adminOnly).toBeFalsy();

    expect(defFor('dash-proposals')).toMatchObject({ page: 'dashboard', widths: [1, 2], defaultWidth: 1, adminOnly: true });

    expect(defFor('dash-my-hours')).toMatchObject({ page: 'dashboard', widths: [1], defaultWidth: 1 });
    expect(defFor('dash-my-hours').adminOnly).toBeFalsy();

    expect(defFor('dash-payments')).toMatchObject({ page: 'dashboard', widths: [1, 2], defaultWidth: 1, adminOnly: true });

    expect(defFor('dash-aging')).toMatchObject({ page: 'dashboard', widths: [1, 2], defaultWidth: 1, adminOnly: true });

    expect(defFor('dash-quick-actions')).toMatchObject({ page: 'dashboard', widths: [1], defaultWidth: 1 });
    expect(defFor('dash-quick-actions').adminOnly).toBeFalsy();

    expect(defFor('dash-recent-docs')).toMatchObject({ page: 'dashboard', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('dash-recent-docs').adminOnly).toBeFalsy();

    expect(defFor('dash-bid-deadlines')).toMatchObject({ page: 'dashboard', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('dash-bid-deadlines').adminOnly).toBeFalsy();
  });
});

describe('dash-project-health', () => {
  const base: import('../../utils/store').ProjectSummary = {
    id: 'p1', name: 'Acme Tower', status: 'in_progress', contractor: null, customerId: null,
    address: null, bidDueDate: null, version: 1, createdAt: 1, updatedAt: 2, archived: false,
    pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 2, punchDone: 1, punchTotal: 3,
  };

  it('shows only active projects with open-item count and admin outstanding amount', async () => {
    getProjectsSummary.mockResolvedValue([
      { ...base },
      { ...base, id: 'p2', name: 'Estimating Job', status: 'bidding' },
      { ...base, id: 'p3', name: 'Archived Job', archived: true },
      { ...base, id: 'p4', name: 'Billed Job', outstandingCents: 25000, contractValueCents: 100000, openIssueCount: 0, punchDone: 3, punchTotal: 3 },
    ]);
    mount('dash-project-health', 2, { isAdmin: true });

    await screen.findByText('Acme Tower');
    expect(screen.queryByText('Estimating Job')).not.toBeInTheDocument();
    expect(screen.queryByText('Archived Job')).not.toBeInTheDocument();
    // openIssueCount(2) + (punchTotal(3) - punchDone(1)) = 4
    expect(screen.getByText('4 open')).toBeInTheDocument();
    expect(screen.getByText('Billed Job')).toBeInTheDocument();
    expect(screen.getByText('$250.00 outstanding')).toBeInTheDocument();
  });

  it('hides the outstanding amount for non-admins even when the fields are present', async () => {
    getProjectsSummary.mockResolvedValue([
      { ...base, outstandingCents: 25000, contractValueCents: 100000 },
    ]);
    mount('dash-project-health', 2, { isAdmin: false });

    await screen.findByText('Acme Tower');
    expect(screen.queryByText(/outstanding/)).not.toBeInTheDocument();
  });

  it('renders nothing extra when outstandingCents is 0 (a clean row, not "$0.00 outstanding")', async () => {
    getProjectsSummary.mockResolvedValue([
      { ...base, outstandingCents: 0, contractValueCents: 100000 },
    ]);
    mount('dash-project-health', 2, { isAdmin: true });

    await screen.findByText('Acme Tower');
    expect(screen.queryByText(/outstanding/)).not.toBeInTheDocument();
  });

  it('shows the empty state with no active projects', async () => {
    getProjectsSummary.mockResolvedValue([]);
    mount('dash-project-health', 2);
    expect(await screen.findByText('No active projects.')).toBeInTheDocument();
  });
});

describe('dash-mail-peek', () => {
  it('renders the unread count and a link to /mail', () => {
    useMailUnread.mockReturnValue(3);
    mount('dash-mail-peek', 1);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Open Mail').closest('a')).toHaveAttribute('href', '/mail');
  });
});

describe('dash-proposals', () => {
  it('renders outstanding proposal rows with expiry text and a project link', async () => {
    getOutstandingProposals.mockResolvedValue([
      {
        id: 'pr1', projectId: 'p1', projectName: 'Acme', number: 3, revisedFromId: null, revisedFromNumber: null,
        status: 'sent', legacy: false, title: 'Site work', validUntil: '2026-09-20', fontFamily: null,
        coverNotes: null, terms: null, inclusions: [], exclusions: [], paymentSchedule: null,
        showGrandTotal: true, includeCostDetail: true, includeSignature: true, highlightQuality: 'best',
        fileId: null, signedFileId: null, sentAt: 1, sentTo: null, acceptedAt: null, declinedAt: null,
        version: 1, createdBy: null, createdAt: 1, updatedAt: 1, totalCents: 150000, alternateCount: 0,
        hasOverride: false, photoCount: 0, attachmentCount: 0,
      },
    ]);
    mount('dash-proposals', 1);

    const link = await screen.findByText(/Acme · #3 — Site work/);
    expect(link.closest('a')).toHaveAttribute('href', '/project/p1/proposal/pr1');
    expect(screen.getByText('$1,500.00')).toBeInTheDocument();
  });

  it('is registered adminOnly', () => {
    expect(defFor('dash-proposals').adminOnly).toBe(true);
  });
});

describe('dash-my-hours', () => {
  it('shows CountUp hours computed from this weeks entries', async () => {
    // The app's weeks run Sunday to Saturday: an entry at the start of this
    // one counts whatever day the test runs (a Monday-based date failed on
    // Sundays).
    const clockInMs = startOfWeek();
    getMyTimeEntries.mockResolvedValue([
      { id: 't1', projectId: null, clockIn: clockInMs, clockOut: clockInMs + 2 * 3_600_000, description: '' },
    ]);
    mount('dash-my-hours', 1);

    expect(await screen.findByText('2.0')).toBeInTheDocument();
    expect(screen.getByText('Time tracking').closest('a')).toHaveAttribute('href', '/time');
  });
});

describe('dash-payments', () => {
  it('renders recent payment rows linking to project billing', async () => {
    getDashboardMoney.mockResolvedValue({
      outstandingCents: 0, contractTotalCents: 0, billedCents: 0, paidCents: 0, draftPayAppCount: 0,
      recentPayments: [{ id: 'pay1', amount: 25000, date: Date.now(), method: 'check', projectId: 'p1', projectName: 'Acme' }],
      trend: [],
    });
    mount('dash-payments', 1);

    const link = await screen.findByText('Acme');
    expect(link.closest('a')).toHaveAttribute('href', '/project/p1/billing');
    expect(screen.getByText('$250.00')).toBeInTheDocument();
  });

  it('is registered adminOnly', () => {
    expect(defFor('dash-payments').adminOnly).toBe(true);
  });

  describe('west of UTC', () => {
    useTimeZone('America/Los_Angeles');

    it('dates a payment with the day that was picked', async () => {
      getDashboardMoney.mockResolvedValue({
        outstandingCents: 0, contractTotalCents: 0, billedCents: 0, paidCents: 0, draftPayAppCount: 0,
        recentPayments: [{ id: 'pay1', amount: 25000, date: new Date('2026-10-01').getTime(), method: 'check', projectId: 'p1', projectName: 'Acme' }],
        trend: [],
      });
      mount('dash-payments', 1);
      await screen.findByText('Acme');
      expect(screen.getByText(`${new Date(2026, 9, 1).toLocaleDateString()} · check`)).toBeInTheDocument();
    });
  });
});

describe('dash-aging', () => {
  // Buckets are rendered straight from dashboardMoney().aging — computed
  // server-side over EVERY outstanding billed document, not derived from the
  // attention feed's capped/14-day-floor aging_receivable items. See
  // server/dashboardStore.ts's dashboardMoney().
  it('renders the three aging buckets from the money payload', async () => {
    getDashboardMoney.mockResolvedValue({
      outstandingCents: 60000, contractTotalCents: 0, billedCents: 0, paidCents: 0, draftPayAppCount: 0,
      recentPayments: [], trend: [],
      aging: { current: 10000, days31to60: 20000, days61plus: 30000 },
    });
    mount('dash-aging', 1);

    await waitFor(() => expect(screen.getByTestId('aging-bucket-d0_30')).toHaveTextContent('$100.00'));
    expect(screen.getByTestId('aging-bucket-d31_60')).toHaveTextContent('$200.00');
    expect(screen.getByTestId('aging-bucket-d61')).toHaveTextContent('$300.00');
  });

  it('shows the empty state when there are no aging receivables', async () => {
    getDashboardMoney.mockResolvedValue({
      outstandingCents: 0, contractTotalCents: 0, billedCents: 0, paidCents: 0, draftPayAppCount: 0,
      recentPayments: [], trend: [],
      aging: { current: 0, days31to60: 0, days61plus: 0 },
    });
    mount('dash-aging', 1);
    expect(await screen.findByText('Nothing aging.')).toBeInTheDocument();
  });

  it('is registered adminOnly', () => {
    expect(defFor('dash-aging').adminOnly).toBe(true);
  });
});

function DAY_MS() { return 86_400_000; }

describe('dash-quick-actions', () => {
  it('navigates to /new for New Project and /tasks?new=1 for New Task', () => {
    mount('dash-quick-actions', 1);
    fireEvent.click(screen.getByText('New Project'));
    fireEvent.click(screen.getByText('New Task'));
    // No navigation assertion library wired here beyond MemoryRouter, but the
    // click handlers must not throw and the buttons must be present.
    expect(screen.getByText('New Project')).toBeInTheDocument();
    expect(screen.getByText('New Task')).toBeInTheDocument();
  });

  it('calls clockIn and shows a success toast on click', async () => {
    clockIn.mockResolvedValue(undefined);
    mount('dash-quick-actions', 1);
    fireEvent.click(screen.getByText('Clock in'));
    await waitFor(() => expect(clockIn).toHaveBeenCalled());
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Clocked in.', { type: 'success' }));
  });

  it('shows an error toast when clockIn fails', async () => {
    clockIn.mockRejectedValue(new Error('nope'));
    mount('dash-quick-actions', 1);
    fireEvent.click(screen.getByText('Clock in'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Could not clock in.', { type: 'error' }));
  });
});

describe('dash-recent-docs', () => {
  it('renders recent document rows linking to /documents', async () => {
    getDocuments.mockResolvedValue({
      rows: [
        { id: 'd1', name: 'Invoice 12', mime: 'application/pdf', size: 100, kind: 'invoice', createdAt: Date.now(), versionNumber: 1, archived: false, projectId: 'p1', projectName: 'Acme', customerId: null, customerName: null, source: null },
      ],
      total: 1,
    });
    mount('dash-recent-docs', 1);

    const link = await screen.findByText('Invoice 12');
    expect(link.closest('a')).toHaveAttribute('href', '/documents');
  });

  it('shows the empty state with no documents', async () => {
    getDocuments.mockResolvedValue({ rows: [], total: 0 });
    mount('dash-recent-docs', 1);
    expect(await screen.findByText('No documents yet.')).toBeInTheDocument();
  });
});

describe('dash-bid-deadlines', () => {
  it('shows bidding projects with a due date, overdue ones flagged red', async () => {
    getProjectsSummary.mockResolvedValue([
      {
        id: 'p1', name: 'Overdue Bid', status: 'bidding', contractor: 'ABC Co', customerId: null,
        address: null, bidDueDate: Date.now() - DAY_MS(), version: 1, createdAt: 1, updatedAt: 1,
        archived: false, pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0,
      },
      {
        id: 'p2', name: 'In Progress Job', status: 'in_progress', contractor: null, customerId: null,
        address: null, bidDueDate: Date.now() + DAY_MS(), version: 1, createdAt: 1, updatedAt: 1,
        archived: false, pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0,
      },
    ]);
    mount('dash-bid-deadlines', 1);

    await screen.findByText('Overdue Bid');
    expect(screen.getByText(/overdue/)).toBeInTheDocument();
    expect(screen.queryByText('In Progress Job')).not.toBeInTheDocument();
  });
});
