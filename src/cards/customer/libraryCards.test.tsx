// src/cards/customer/libraryCards.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { ThemeProvider } from '../../context/ThemeContext';
import type { CardContext, CardWidth } from '../types';
import type { CustomerOverview, ProjectSummary, TaskListItem } from '../../utils/store';
import { useTimeZone } from '../../test/timeZone';

const { getCustomerOverview, getProjectsSummary, getTasks } = vi.hoisted(() => ({
  getCustomerOverview: vi.fn(),
  getProjectsSummary: vi.fn(),
  getTasks: vi.fn(),
}));

vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCustomerOverview, getProjectsSummary, getTasks,
}));

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
  getProjectsSummary.mockReset();
  getTasks.mockReset();
  localStorage.clear();
  localStorage.setItem('theme-motion', 'reduced');
});

afterEach(() => {
  localStorage.removeItem('theme-motion');
});

describe('customer libraryCards registration', () => {
  it('registers all four library cards with the specified widths/defaults/adminOnly', () => {
    expect(defFor('cu-payments')).toMatchObject({ page: 'customer', widths: [1, 2], defaultWidth: 1, adminOnly: true });
    expect(defFor('cu-open-items')).toMatchObject({ page: 'customer', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('cu-open-items').adminOnly).toBeFalsy();
    expect(defFor('cu-open-tasks')).toMatchObject({ page: 'customer', widths: [1], defaultWidth: 1 });
    expect(defFor('cu-open-tasks').adminOnly).toBeFalsy();
    expect(defFor('cu-tasks')).toMatchObject({ page: 'customer', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('cu-tasks').adminOnly).toBeFalsy();
    expect(defFor('cu-notes')).toMatchObject({ page: 'customer', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('cu-notes').adminOnly).toBeFalsy();
  });
});

describe('cu-payments', () => {
  const overview: CustomerOverview = {
    customer: baseCustomer,
    projects: [],
    billing: {
      contractTotalCents: 0, invoicedCents: 0, paidCents: 0, outstandingCents: 0,
      aging: { current: 0, days31to60: 0, days61plus: 0 },
      contract: { billedCents: 0, paidCents: 0, outstandingCents: 0 },
      invoices: { invoicedCents: 0, paidCents: 0, outstandingCents: 0 },
      ledger: [
        { projectId: 'p1', projectName: 'Kitchen remodel', kind: 'invoice', number: 1, date: Date.UTC(2026, 0, 1), status: 'paid', totalCents: 50_000, paidCents: 50_000, balanceCents: 0 },
        { projectId: 'p1', projectName: 'Kitchen remodel', kind: 'invoice', number: 2, date: Date.UTC(2026, 0, 15), status: 'draft', totalCents: 20_000, paidCents: 0, balanceCents: 20_000 },
        { projectId: 'p2', projectName: 'Roof job', kind: 'payapp', number: 3, date: '2026-02-01', status: 'sent', totalCents: 100_000, paidCents: 60_000, balanceCents: 40_000 },
        { projectId: 'p2', projectName: 'Roof job', kind: 'payapp', number: 4, date: '2026-03-01', status: 'sent', totalCents: 70_000, paidCents: 70_000, balanceCents: 0 },
        { projectId: 'p2', projectName: 'Roof job', kind: 'invoice', number: 5, date: Date.UTC(2026, 3, 1), status: 'paid', totalCents: 10_000, paidCents: 10_000, balanceCents: 0 },
        { projectId: 'p2', projectName: 'Roof job', kind: 'invoice', number: 6, date: Date.UTC(2026, 4, 1), status: 'paid', totalCents: 15_000, paidCents: 15_000, balanceCents: 0 },
        { projectId: 'p2', projectName: 'Roof job', kind: 'invoice', number: 7, date: Date.UTC(2026, 5, 1), status: 'paid', totalCents: 25_000, paidCents: 25_000, balanceCents: 0 },
      ],
    },
    attention: [],
    taskCounts: { open: 0, overdue: 0 },
  };

  it('shows only ledger entries with paidCents > 0, newest 5, with money and project context', async () => {
    getCustomerOverview.mockResolvedValue(overview);
    mount('cu-payments', 1);

    // Newest is #7 (June); the zero-paid #2 (Jan 15, draft) must never appear.
    await screen.findByText(/#7/);
    expect(screen.queryByText(/#2\b/)).not.toBeInTheDocument();

    const rows = screen.getAllByText(/^Invoice #|^Pay App #/);
    expect(rows).toHaveLength(5); // capped at 5, and #1 (oldest paid one) dropped
    expect(rows.map(r => r.textContent)).toEqual(['Invoice #7', 'Invoice #6', 'Invoice #5', 'Pay App #4', 'Pay App #3']);

    expect(screen.getByText('$250.00')).toBeInTheDocument(); // #7 paidCents
    expect(screen.getAllByText(/Roof job/).length).toBeGreaterThan(0); // project context shown on rows
  });

  describe('west of UTC', () => {
    useTimeZone('America/Los_Angeles');

    it('dates each row with the day it was picked, invoice or pay app', async () => {
      getCustomerOverview.mockResolvedValue(overview);
      mount('cu-payments', 1);
      await screen.findByText(/#7/);
      expect(screen.getByText(`Roof job · ${new Date(2026, 5, 1).toLocaleDateString()}`)).toBeInTheDocument();
      expect(screen.getByText(`Roof job · ${new Date(2026, 1, 1).toLocaleDateString()}`)).toBeInTheDocument();
    });
  });

  it('renders empty state when billing is absent (non-admin payload, belt-and-suspenders)', async () => {
    getCustomerOverview.mockResolvedValue({ customer: baseCustomer, projects: [], attention: [], taskCounts: { open: 0, overdue: 0 } });
    mount('cu-payments', 1, { isAdmin: false, customerId: 'c1' });
    expect(await screen.findByText(/no payments/i)).toBeInTheDocument();
  });

  it('renders nothing when ctx has no customerId', () => {
    const { container } = mount('cu-payments', 1, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('cu-open-items', () => {
  const summaries: ProjectSummary[] = [
    {
      id: 'p1', name: 'Kitchen', status: 'in_progress', contractor: null, customerId: 'c1', address: null,
      bidDueDate: null, version: 1, createdAt: 0, updatedAt: null, archived: false,
      pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 3, punchDone: 2, punchTotal: 5,
    },
    {
      id: 'p2', name: 'Roof', status: 'complete', contractor: null, customerId: 'c1', address: null,
      bidDueDate: null, version: 1, createdAt: 0, updatedAt: null, archived: false,
      pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 1, punchDone: 4, punchTotal: 4,
    },
    // Different customer — must be excluded.
    {
      id: 'p3', name: 'Other customer job', status: 'in_progress', contractor: null, customerId: 'other', address: null,
      bidDueDate: null, version: 1, createdAt: 0, updatedAt: null, archived: false,
      pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 99, punchDone: 0, punchTotal: 99,
    },
    // Archived project for this customer — must be excluded.
    {
      id: 'p4', name: 'Old job', status: 'complete', contractor: null, customerId: 'c1', address: null,
      bidDueDate: null, version: 1, createdAt: 0, updatedAt: null, archived: true,
      pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 50, punchDone: 0, punchTotal: 50,
    },
  ];

  it('sums open issues and punch-left across the customer\'s non-archived projects only', async () => {
    getProjectsSummary.mockResolvedValue(summaries);
    mount('cu-open-items', 1);

    // openIssueCount: 3 + 1 = 4 (99 and 50 from excluded projects must not count)
    expect(await screen.findByText('4')).toBeInTheDocument();
    // punch left: (5-2) + (4-4) = 3
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders nothing when ctx has no customerId', () => {
    const { container } = mount('cu-open-items', 1, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('cu-open-tasks', () => {
  it('renders the open/overdue task-count tiles from overview.taskCounts', async () => {
    getCustomerOverview.mockResolvedValue({
      customer: baseCustomer, projects: [], attention: [], taskCounts: { open: 5, overdue: 2 },
    });
    mount('cu-open-tasks', 1);

    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('renders zero tiles (not the empty state) when nothing is open or overdue', async () => {
    getCustomerOverview.mockResolvedValue({
      customer: baseCustomer, projects: [], attention: [], taskCounts: { open: 0, overdue: 0 },
    });
    mount('cu-open-tasks', 1);

    await screen.findByText('Open');
    expect(screen.getAllByText('0')).toHaveLength(2);
  });

  it('renders nothing when ctx has no customerId', () => {
    const { container } = mount('cu-open-tasks', 1, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('cu-tasks', () => {
  const task = (overrides: Partial<TaskListItem>): TaskListItem => ({
    id: 't1', category: 'general', title: 'Follow up', notes: '',
    assigneeUserId: null, assigneeUsername: null, status: 'open', dueDate: '2026-06-01', sortOrder: 0,
    projectId: null, customerId: 'c1', projectName: null, customerName: 'Acme Co',
    version: 1, createdAt: 0, createdBy: null, photoCount: 0,
    ...overrides,
  });

  it('renders upcoming (dated, not-done) tasks soonest-first via upcomingTaskItems, with project context and a link scoped to this customer', async () => {
    getTasks.mockResolvedValue([
      task({ id: 't1', title: 'Later task', dueDate: '2026-06-10' }),
      task({ id: 't2', title: 'Sooner task', dueDate: '2026-06-02', projectName: 'Kitchen remodel' }),
      task({ id: 't3', title: 'Done task', dueDate: '2026-06-01', status: 'done' }),
      task({ id: 't4', title: 'No due date', dueDate: null }),
    ]);
    mount('cu-tasks', 1);

    expect(getTasks).toHaveBeenCalledWith({ customerId: 'c1' });

    const titles = await screen.findAllByText(/Later task|Sooner task/);
    expect(titles.map(t => t.textContent)).toEqual(['Sooner task', 'Later task']); // soonest first
    expect(screen.queryByText('Done task')).not.toBeInTheDocument();
    expect(screen.queryByText('No due date')).not.toBeInTheDocument();
    expect(screen.getByText('Kitchen remodel')).toBeInTheDocument();

    const link = screen.getByText('Sooner task').closest('a')!;
    expect(link).toHaveAttribute('href', '/tasks?customerId=c1');
  });

  it('shows the empty state when there are no upcoming tasks', async () => {
    getTasks.mockResolvedValue([]);
    mount('cu-tasks', 1);
    expect(await screen.findByText(/no upcoming tasks/i)).toBeInTheDocument();
  });

  it('renders nothing when ctx has no customerId', () => {
    const { container } = mount('cu-tasks', 1, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('cu-notes', () => {
  it('renders the customer notes read-only, plus a link to the settings tab', async () => {
    getCustomerOverview.mockResolvedValue({
      customer: { ...baseCustomer, notes: 'Prefers email over phone.' },
      projects: [], attention: [], taskCounts: { open: 0, overdue: 0 },
    });
    mount('cu-notes', 1);

    expect(await screen.findByText('Prefers email over phone.')).toBeInTheDocument();
    const editLink = screen.getByRole('link');
    expect(editLink).toHaveAttribute('href', '/customers/c1?tab=settings');
  });

  it('shows an empty state when there are no notes', async () => {
    getCustomerOverview.mockResolvedValue({ customer: baseCustomer, projects: [], attention: [], taskCounts: { open: 0, overdue: 0 } });
    mount('cu-notes', 1);
    expect(await screen.findByText(/no notes/i)).toBeInTheDocument();
  });

  it('renders nothing when ctx has no customerId', () => {
    const { container } = mount('cu-notes', 1, { isAdmin: true });
    expect(container).toBeEmptyDOMElement();
  });
});
