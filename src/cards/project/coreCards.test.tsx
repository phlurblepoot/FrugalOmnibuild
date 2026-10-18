// src/cards/project/coreCards.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { ThemeProvider } from '../../context/ThemeContext';
import type { CardContext, CardWidth } from '../types';
import type { BillingSummary } from '../../utils/store';

const {
  getBillingSummary, getPayApps, getProjectSummary, getRfis, getTasks, getProjectHappenings,
} = vi.hoisted(() => ({
  getBillingSummary: vi.fn(),
  getPayApps: vi.fn(),
  getProjectSummary: vi.fn(),
  getRfis: vi.fn(),
  getTasks: vi.fn(),
  getProjectHappenings: vi.fn(),
}));

vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBillingSummary, getPayApps, getProjectSummary, getRfis, getTasks, getProjectHappenings,
}));

// useLiveQuery needs a CollaborationContext provider; a null socket is fine
// since the initial load fires regardless of socket presence.
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: null }),
}));

const { CARD_REGISTRY } = await import('../registry');
const { computeFinancialBand, iconForHappening } = await import('./coreCards');
await import('./coreCards');

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
  getRfis.mockReset();
  getTasks.mockReset();
  getProjectHappenings.mockReset();
  localStorage.clear();
  // Reduced motion so CountUp renders its final value synchronously.
  localStorage.setItem('theme-motion', 'reduced');
});

afterEach(() => {
  localStorage.removeItem('theme-motion');
});

describe('coreCards registration', () => {
  it('registers all three project cards with the specified widths/defaults/adminOnly', () => {
    expect(defFor('pj-financial-band')).toMatchObject({ page: 'project', widths: [2, 3], defaultWidth: 3, adminOnly: true });
    expect(defFor('pj-open-items')).toMatchObject({ page: 'project', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('pj-open-items').adminOnly).toBeFalsy();
    expect(defFor('pj-happenings')).toMatchObject({ page: 'project', widths: [1, 2, 3], defaultWidth: 2 });
    expect(defFor('pj-happenings').adminOnly).toBeFalsy();
  });
});

describe('computeFinancialBand', () => {
  const base: BillingSummary = {
    sovOriginalCents: 0, hasSov: true, baseContractCents: 1_000_000, approvedChangeCents: 0,
    contractTotalCents: 1_000_000, contractValueCents: 1_000_000,
    invoiceTotalCents: 0, invoicedCents: 0,
    paid: { invoicesCents: 100_000, payAppsCents: 0 }, paidCents: 200_000,
    invoiceOutstandingCents: 0, outstandingCents: 0,
    invoiceCount: 0, changeOrderCount: 0,
    payAppBilledCents: 400_000, payAppOutstandingCents: 200_000, payAppPaidCents: 200_000,
    invoiceBilledCents: 100_000, invoicePaidCents: 100_000, invoiceOutstandingBilledCents: 0,
  };

  it('derives paid/awaiting/remaining from the ledger fields and percentages of contract total', () => {
    // paid = 100,000 (invoices) + 200,000 (pay apps) = 300,000 -> 30%
    // awaiting = 0 (invoice outstanding) + 200,000 (pay app outstanding) = 200,000 -> 20%
    // billed = 100,000 + 400,000 = 500,000; remaining = max(0, 1,000,000 - 500,000) = 500,000 -> 50%
    const band = computeFinancialBand(base);
    expect(band).toEqual({
      paid: 300_000, awaiting: 200_000, remaining: 500_000,
      paidPct: 30, awaitingPct: 20, remainingPct: 50,
    });
  });

  it('never reports negative remaining when billed exceeds the contract total', () => {
    const band = computeFinancialBand({ ...base, contractTotalCents: 400_000 });
    expect(band.remaining).toBe(0);
    expect(band.remainingPct).toBe(0);
  });

  it('guards against a zero contract total (no NaN/Infinity percentages)', () => {
    const band = computeFinancialBand({ ...base, contractTotalCents: 0 });
    expect(band).toMatchObject({ paidPct: 0, awaitingPct: 0, remainingPct: 0 });
  });
});

describe('pj-financial-band', () => {
  const billing: BillingSummary = {
    sovOriginalCents: 0, hasSov: true, baseContractCents: 1_000_000, approvedChangeCents: 0,
    contractTotalCents: 1_000_000, contractValueCents: 1_000_000,
    invoiceTotalCents: 0, invoicedCents: 0,
    paid: { invoicesCents: 100_000, payAppsCents: 0 }, paidCents: 200_000,
    invoiceOutstandingCents: 0, outstandingCents: 0,
    invoiceCount: 0, changeOrderCount: 0,
    payAppBilledCents: 400_000, payAppOutstandingCents: 200_000, payAppPaidCents: 200_000,
    invoiceBilledCents: 100_000, invoicePaidCents: 100_000, invoiceOutstandingBilledCents: 0,
  };

  it('renders segment widths as style percentages, the contract total, and legend at width 3', async () => {
    getBillingSummary.mockResolvedValue(billing);
    getPayApps.mockResolvedValue([]);
    mount('pj-financial-band', 3);

    expect(await screen.findByText('$10,000.00')).toBeInTheDocument();
    expect(screen.getByTestId('pj-band-paid')).toHaveStyle({ width: '30%' });
    expect(screen.getByTestId('pj-band-awaiting')).toHaveStyle({ width: '20%' });
    expect(screen.getByTestId('pj-band-remaining')).toHaveStyle({ width: '50%' });
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Awaiting')).toBeInTheDocument();
    expect(screen.getByText('Remaining')).toBeInTheDocument();
  });

  it('hides the legend at width 2', async () => {
    getBillingSummary.mockResolvedValue(billing);
    getPayApps.mockResolvedValue([]);
    mount('pj-financial-band', 2);

    await screen.findByTestId('pj-band-bar');
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
  });

  it('shows a "Next: Pay app in draft" callout from the newest draft pay app', async () => {
    getBillingSummary.mockResolvedValue(billing);
    getPayApps.mockResolvedValue([
      { id: 'pa1', projectId: 'p1', number: 2, periodTo: null, applicationDate: null, retainagePercent: 0, storedRetainagePercent: 0, releasedRetainagePoints: 0, status: 'finalized', version: 1, createdAt: 1, updatedAt: 1, totalCents: 50_000, paidCents: 50_000, balanceCents: 0 },
      { id: 'pa2', projectId: 'p1', number: 3, periodTo: null, applicationDate: null, retainagePercent: 0, storedRetainagePercent: 0, releasedRetainagePoints: 0, status: 'draft', version: 1, createdAt: 2, updatedAt: 2, totalCents: 125_000, paidCents: 0, balanceCents: null },
    ]);
    mount('pj-financial-band', 3);

    expect(await screen.findByText(/Next: Pay app #3 in draft/)).toBeInTheDocument();
    expect(screen.getByText(/\$1,250\.00/)).toBeInTheDocument();
  });

  it('renders nothing when ctx has no projectId', () => {
    const { container } = mount('pj-financial-band', 3, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('pj-open-items', () => {
  const summary = {
    id: 'p1', name: 'Proj', status: 'in_progress', contractor: null, customerId: null, address: null,
    bidDueDate: null, version: 1, createdAt: 0, updatedAt: null, archived: false,
    pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 3, punchDone: 4, punchTotal: 10,
  };

  it('renders open issues / punch left / open RFIs / overdue task counts', async () => {
    getProjectSummary.mockResolvedValue(summary);
    getRfis.mockResolvedValue([
      { id: 'r1', projectId: 'p1', number: 1, title: null, question: null, specRef: null, drawingRef: null, attention: null, responseNeededBy: null, responseText: null, responseFileId: null, status: 'open', version: 1, sentAt: null, answeredAt: null, createdAt: 0, updatedAt: 0, photoCount: 0 },
      { id: 'r2', projectId: 'p1', number: 2, title: null, question: null, specRef: null, drawingRef: null, attention: null, responseNeededBy: null, responseText: null, responseFileId: null, status: 'answered', version: 1, sentAt: null, answeredAt: null, createdAt: 0, updatedAt: 0, photoCount: 0 },
      { id: 'r3', projectId: 'p1', number: 3, title: null, question: null, specRef: null, drawingRef: null, attention: null, responseNeededBy: null, responseText: null, responseFileId: null, status: 'closed', version: 1, sentAt: null, answeredAt: null, createdAt: 0, updatedAt: 0, photoCount: 0 },
    ]);
    getTasks.mockResolvedValue([
      { id: 't1', category: 'general', title: 'Overdue one', notes: '', assigneeUserId: null, assigneeUsername: null, status: 'todo', dueDate: '2000-01-01', sortOrder: 0, projectId: 'p1', customerId: null, projectName: null, customerName: null, version: 1, createdAt: 0, createdBy: null, photoCount: 0 },
      { id: 't2', category: 'general', title: 'Overdue but done', notes: '', assigneeUserId: null, assigneeUsername: null, status: 'done', dueDate: '2000-01-01', sortOrder: 0, projectId: 'p1', customerId: null, projectName: null, customerName: null, version: 1, createdAt: 0, createdBy: null, photoCount: 0 },
      { id: 't3', category: 'general', title: 'Future', notes: '', assigneeUserId: null, assigneeUsername: null, status: 'todo', dueDate: '2999-01-01', sortOrder: 0, projectId: 'p1', customerId: null, projectName: null, customerName: null, version: 1, createdAt: 0, createdBy: null, photoCount: 0 },
    ]);
    mount('pj-open-items', 1);
    await screen.findByText('Open issues');

    const tile = (label: string) => screen.getByText(label).closest('a')!;
    expect(tile('Open issues')).toHaveTextContent('3'); // openIssueCount
    expect(tile('Open issues')).toHaveAttribute('href', '/project/p1/issues');
    expect(tile('Punch left')).toHaveTextContent('6'); // 10 - 4
    expect(tile('Punch left')).toHaveAttribute('href', '/project/p1/punch');
    expect(tile('Open RFIs')).toHaveTextContent('1'); // only r1 is open
    expect(tile('Open RFIs')).toHaveAttribute('href', '/project/p1/rfis');
    expect(tile('Overdue tasks')).toHaveTextContent('1'); // only t1 (t2 is done, t3 is future)
    expect(tile('Overdue tasks')).toHaveAttribute('href', '/tasks?projectId=p1');
  });

  it('lays out 2x2 at width 1 and 4-across at width 2', async () => {
    getProjectSummary.mockResolvedValue(summary);
    getRfis.mockResolvedValue([]);
    getTasks.mockResolvedValue([]);

    const { container: c1 } = mount('pj-open-items', 1);
    await screen.findByText('Open issues');
    expect(c1.querySelector('.grid')).toHaveClass('grid-cols-2');

    const { container: c2 } = mount('pj-open-items', 2);
    await screen.findAllByText('Open issues');
    expect(c2.querySelector('.grid')).toHaveClass('grid-cols-4');
  });
});

describe('pj-happenings', () => {
  it('renders rows with kind/type-based icons, time-ago stamps, and activityTarget links', async () => {
    getProjectHappenings.mockResolvedValue([
      { kind: 'mail', id: 'th1', message: 'Reply on "Invoice 12"', createdAt: Date.now() - 60_000 },
      { kind: 'activity', id: 'a1', type: 'invoice_sent', message: 'Invoice sent', username: 'noah', createdAt: Date.now() - 3_600_000 },
      { kind: 'activity', id: 'a2', type: 'punch_added', message: 'Punch item added', username: 'noah', createdAt: Date.now() - 7_200_000 },
      { kind: 'activity', id: 'a3', type: 'note', message: 'Some note', username: null, createdAt: Date.now() - 90_000_000 },
    ]);
    mount('pj-happenings', 2);

    await screen.findByText('Reply on "Invoice 12"');
    expect(screen.getByText('Reply on "Invoice 12"').closest('a')).toHaveAttribute('href', '/project/p1/mail');
    expect(screen.getByText('Invoice sent').closest('a')).toHaveAttribute('href', '/project/p1/billing');
    expect(screen.getByText('Punch item added').closest('a')).toHaveAttribute('href', '/project/p1/punch');
    expect(screen.getAllByText(/noah ·/).length).toBe(2); // a1 and a2 both attributed to noah
    expect(screen.getByText('Some note').nextElementSibling).toHaveTextContent(/ago$/);
  });

  it('shows the empty state when nothing has happened', async () => {
    getProjectHappenings.mockResolvedValue([]);
    mount('pj-happenings', 2);
    expect(await screen.findByText('Nothing happening yet.')).toBeInTheDocument();
  });

  it('renders nothing when ctx has no projectId', () => {
    const { container } = mount('pj-happenings', 2, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('iconForHappening', () => {
  const activity = (type: string): import('../../utils/store').HappeningItem =>
    ({ kind: 'activity', id: 'x', type, message: 'm', createdAt: 0 });

  it('maps kind/type to the documented lucide icons', () => {
    expect(iconForHappening({ kind: 'mail', id: 'x', message: 'm', createdAt: 0 }).displayName).toBe('Mail');
    expect(iconForHappening(activity('invoice_sent')).displayName).toBe('DollarSign');
    expect(iconForHappening(activity('payment_recorded')).displayName).toBe('DollarSign');
    expect(iconForHappening(activity('change_order_sent')).displayName).toBe('DollarSign');
    expect(iconForHappening(activity('punch_added')).displayName).toBe('ClipboardCheck');
    expect(iconForHappening(activity('daily_report_created')).displayName).toBe('CalendarDays');
    expect(iconForHappening(activity('note')).displayName).toBe('FileText');
  });
});
