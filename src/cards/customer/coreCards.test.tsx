// src/cards/customer/coreCards.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { ThemeProvider } from '../../context/ThemeContext';
import type { CardContext, CardWidth } from '../types';
import type { CustomerOverview } from '../../utils/store';
import type { ProjectThreadRow } from '../../pages/mail/types';
import { useTimeZone } from '../../test/timeZone';

const { getCustomerOverview, getCustomerThreads } = vi.hoisted(() => ({
  getCustomerOverview: vi.fn(),
  getCustomerThreads: vi.fn(),
}));

vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCustomerOverview, getCustomerThreads,
}));

// useLiveQuery needs a CollaborationContext provider; a null socket is fine
// since the initial load fires regardless of socket presence.
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: null }),
}));

const { CARD_REGISTRY } = await import('../registry');
await import('./coreCards');

function defFor(id: string) {
  const def = CARD_REGISTRY.find(c => c.id === id);
  if (!def) throw new Error(`card ${id} not registered`);
  return def;
}

function mount(id: string, width: CardWidth, ctx: CardContext = { isAdmin: true, customerId: 'c1' }) {
  const def = defFor(id);
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <def.Component width={width} ctx={ctx} />
      </ThemeProvider>
    </MemoryRouter>
  );
}

const baseCustomer: CustomerOverview['customer'] = {
  id: 'c1', name: 'Acme Co', emails: {},
};

beforeEach(() => {
  getCustomerOverview.mockReset();
  getCustomerThreads.mockReset();
  localStorage.clear();
  // Reduced motion so CountUp renders its final value synchronously.
  localStorage.setItem('theme-motion', 'reduced');
});

afterEach(() => {
  localStorage.removeItem('theme-motion');
});

describe('customer coreCards registration', () => {
  it('registers all four customer cards with the specified widths/defaults/adminOnly', () => {
    expect(defFor('cu-rollup')).toMatchObject({ page: 'customer', widths: [2, 3], defaultWidth: 3, adminOnly: true });
    expect(defFor('cu-projects')).toMatchObject({ page: 'customer', widths: [1, 2, 3], defaultWidth: 2 });
    expect(defFor('cu-projects').adminOnly).toBeFalsy();
    expect(defFor('cu-correspondence')).toMatchObject({ page: 'customer', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('cu-correspondence').adminOnly).toBeFalsy();
    expect(defFor('cu-attention')).toMatchObject({ page: 'customer', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('cu-attention').adminOnly).toBeFalsy();
  });
});

describe('cu-rollup', () => {
  const overview: CustomerOverview = {
    customer: baseCustomer,
    projects: [],
    billing: {
      contractTotalCents: 1_000_000,
      invoicedCents: 600_000,
      paidCents: 400_000,
      outstandingCents: 200_000,
      ledger: [],
      aging: { current: 50_000, days31to60: 100_000, days61plus: 25_000 },
      contract: { billedCents: 0, paidCents: 0, outstandingCents: 0 },
      invoices: { invoicedCents: 0, paidCents: 0, outstandingCents: 0 },
    },
    attention: [
      { type: 'outstanding_invoice', label: 'Invoice #1', projectId: 'p1', balanceCents: 50_000, ageDays: 12 },
      { type: 'outstanding_invoice', label: 'Invoice #2', projectId: 'p2', balanceCents: 150_000, ageDays: 65 },
    ],
    taskCounts: { open: 0, overdue: 0 },
  };

  it('renders outstanding CountUp, oldest-age note, lifetime billed/paid, and the three aging tiles', async () => {
    getCustomerOverview.mockResolvedValue(overview);
    mount('cu-rollup', 3);

    expect(await screen.findByText('$2,000.00')).toBeInTheDocument(); // outstanding
    expect(screen.getByText(/65 days/)).toBeInTheDocument(); // oldest age
    expect(screen.getByText('$6,000.00')).toBeInTheDocument(); // billed (invoicedCents)
    expect(screen.getByText('$4,000.00')).toBeInTheDocument(); // paid
    expect(screen.getByText('$500.00')).toBeInTheDocument(); // aging current
    expect(screen.getByText('$1,000.00')).toBeInTheDocument(); // aging 31-60
    expect(screen.getByText('$250.00')).toBeInTheDocument(); // aging 61+
    expect(screen.getByText('61+ days')).toBeInTheDocument();
    expect(screen.getByText('31-60 days')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('omits the oldest-age note when no outstanding_invoice attention item carries an age', async () => {
    getCustomerOverview.mockResolvedValue({ ...overview, attention: [] });
    mount('cu-rollup', 3);

    await screen.findByText('$2,000.00');
    expect(screen.queryByText(/days outstanding/)).not.toBeInTheDocument();
  });

  it('renders nothing when ctx has no customerId', () => {
    const { container } = mount('cu-rollup', 3, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('cu-projects', () => {
  const overview: CustomerOverview = {
    customer: baseCustomer,
    projects: [
      { id: 'p1', name: 'Kitchen remodel', status: 'in_progress', archived: false, lostBid: false, bidDueDate: null, updatedAt: null, outstandingCents: 25_000 },
      { id: 'p2', name: 'Old deck', status: 'complete', archived: true, lostBid: false, bidDueDate: null, updatedAt: null },
    ],
    attention: [],
    taskCounts: { open: 0, overdue: 0 },
  };

  it('renders project rows with status pill, admin outstanding line, archived dimming, and project links', async () => {
    getCustomerOverview.mockResolvedValue(overview);
    mount('cu-projects', 2, { isAdmin: true, customerId: 'c1' });

    const kitchenLink = (await screen.findByText('Kitchen remodel')).closest('a')!;
    expect(kitchenLink).toHaveAttribute('href', '/project/p1');
    expect(screen.getByText('$250.00 outstanding')).toBeInTheDocument();

    const deckLink = screen.getByText('Old deck').closest('a')!;
    expect(deckLink).toHaveAttribute('href', '/project/p2');
    expect(deckLink.className).toMatch(/opacity/);
  });

  it('hides the outstanding line for non-admins (field absent)', async () => {
    getCustomerOverview.mockResolvedValue({
      ...overview,
      projects: overview.projects.map(({ outstandingCents: _drop, ...p }) => p),
    });
    mount('cu-projects', 2, { isAdmin: false, customerId: 'c1' });

    await screen.findByText('Kitchen remodel');
    expect(screen.queryByText(/outstanding/)).not.toBeInTheDocument();
  });

  it('renders nothing when ctx has no customerId', () => {
    const { container } = mount('cu-projects', 2, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('cu-correspondence', () => {
  const row = (overrides: Partial<ProjectThreadRow>): ProjectThreadRow => ({
    threadKey: 'tk1',
    subjectSnapshot: 'Re: Change order',
    participants: [],
    firstDate: '2026-01-01T00:00:00.000Z',
    links: [],
    lastInboundDate: null,
    lastOutboundDate: null,
    earliestLinkCreatedAt: '2026-01-01T00:00:00.000Z',
    lastActivity: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('renders up to 5 threads sorted by lastActivity with a reply chip when inbound beats the link-date floor', async () => {
    getCustomerThreads.mockResolvedValue([
      row({ threadKey: 't1', subjectSnapshot: 'Oldest', lastActivity: '2026-01-01T00:00:00.000Z' }),
      row({
        threadKey: 't2', subjectSnapshot: 'Needs reply', lastActivity: '2026-01-05T00:00:00.000Z',
        earliestLinkCreatedAt: '2026-01-01T00:00:00.000Z', lastOutboundDate: '2026-01-02T00:00:00.000Z',
        lastInboundDate: '2026-01-04T00:00:00.000Z',
      }),
      row({ threadKey: 't3', subjectSnapshot: 'Newest', lastActivity: '2026-01-06T00:00:00.000Z' }),
    ]);
    mount('cu-correspondence', 1);

    await screen.findByText('Newest');
    const items = screen.getAllByText(/Oldest|Needs reply|Newest/).map(el => el.textContent);
    expect(items).toEqual(['Newest', 'Needs reply', 'Oldest']); // sorted desc by lastActivity

    expect(screen.getByTestId('cu-mail-reply-t2')).toBeInTheDocument();
    expect(screen.queryByTestId('cu-mail-reply-t1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cu-mail-reply-t3')).not.toBeInTheDocument();

    // Wave 3 Task 13: rows and the header's "View all" link fall back to the
    // global /mail page — there's no per-customer thread route.
    expect(screen.getByText('Newest').closest('a')).toHaveAttribute('href', '/mail');
    expect(screen.getByRole('link', { name: 'View all' })).toHaveAttribute('href', '/mail');
  });

  it('does NOT flag a reply when inbound predates the earliest link (link-date floor, not bare lastInbound>lastOutbound)', async () => {
    getCustomerThreads.mockResolvedValue([
      row({
        threadKey: 't1', lastOutboundDate: null,
        earliestLinkCreatedAt: '2026-01-10T00:00:00.000Z',
        lastInboundDate: '2026-01-05T00:00:00.000Z', // before the link was even created
        lastActivity: '2026-01-10T00:00:00.000Z',
      }),
    ]);
    mount('cu-correspondence', 1);

    await screen.findByText('Re: Change order');
    expect(screen.queryByTestId('cu-mail-reply-t1')).not.toBeInTheDocument();
  });

  it('renders nothing when ctx has no customerId', () => {
    const { container } = mount('cu-correspondence', 1, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('cu-attention', () => {
  it('renders attention rows preserving the customer-attention-row testid and per-type hrefs', async () => {
    const overview: CustomerOverview = {
      customer: baseCustomer,
      projects: [],
      attention: [
        { type: 'overdue_task', label: 'Follow up call', taskId: 't1', date: '2026-01-01' },
        { type: 'bid_due', label: 'Bid: Roof job', projectId: 'p1', date: Date.now(), overdue: true },
        { type: 'outstanding_invoice', label: 'Invoice #4', projectId: 'p2', balanceCents: 12_000 },
      ],
      taskCounts: { open: 1, overdue: 1 },
    };
    getCustomerOverview.mockResolvedValue(overview);
    mount('cu-attention', 1, { isAdmin: true, customerId: 'c1' });

    const rows = await screen.findAllByTestId('customer-attention-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('href', '/tasks?customerId=c1');
    expect(rows[1]).toHaveAttribute('href', '/project/p1');
    expect(rows[2]).toHaveAttribute('href', '/project/p2/billing');
  });

  it('shows the empty state when nothing needs attention', async () => {
    getCustomerOverview.mockResolvedValue({
      customer: baseCustomer, projects: [], attention: [], taskCounts: { open: 0, overdue: 0 },
    });
    mount('cu-attention', 1, { isAdmin: true, customerId: 'c1' });
    expect(await screen.findByText(/nothing needs attention/i)).toBeInTheDocument();
  });

  it('renders nothing when ctx has no customerId', () => {
    const { container } = mount('cu-attention', 1, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });

  describe('west of UTC', () => {
    useTimeZone('America/Los_Angeles');

    it('dates an outstanding invoice or pay app with the day that was picked', async () => {
      getCustomerOverview.mockResolvedValue({
        customer: baseCustomer, projects: [], taskCounts: { open: 0, overdue: 0 },
        attention: [
          { type: 'outstanding_invoice', label: 'Invoice #4', projectId: 'p2', balanceCents: 12_000, date: new Date('2026-10-01').getTime() },
          { type: 'outstanding_invoice', label: 'Pay App #2', projectId: 'p2', balanceCents: 8_000, date: '2026-09-01' },
        ],
      } satisfies CustomerOverview);
      mount('cu-attention', 1, { isAdmin: true, customerId: 'c1' });
      const rows = await screen.findAllByTestId('customer-attention-row');
      expect(rows[0]).toHaveTextContent(new Date(2026, 9, 1).toLocaleDateString());
      expect(rows[1]).toHaveTextContent(new Date(2026, 8, 1).toLocaleDateString());
    });
  });
});
