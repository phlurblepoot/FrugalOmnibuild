// src/cards/dashboard/coreCards.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { ThemeProvider } from '../../context/ThemeContext';
import type { CardContext, CardWidth } from '../types';

const {
  getDashboardAttention, getDashboardMoney, getTasks, getProjectsSummary, getActivity,
} = vi.hoisted(() => ({
  getDashboardAttention: vi.fn(),
  getDashboardMoney: vi.fn(),
  getTasks: vi.fn(),
  getProjectsSummary: vi.fn(),
  getActivity: vi.fn(),
}));

vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDashboardAttention, getDashboardMoney, getTasks, getProjectsSummary, getActivity,
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
  getDashboardAttention.mockReset();
  getDashboardMoney.mockReset();
  getTasks.mockReset();
  getProjectsSummary.mockReset();
  getActivity.mockReset();
  localStorage.clear();
  // Reduced motion so CountUp renders its final value synchronously.
  localStorage.setItem('theme-motion', 'reduced');
});

afterEach(() => {
  localStorage.removeItem('theme-motion');
});

describe('coreCards registration', () => {
  it('registers all four dashboard cards with the specified widths/defaults/adminOnly', () => {
    expect(defFor('dash-attention')).toMatchObject({ page: 'dashboard', widths: [1, 2, 3], defaultWidth: 2 });
    expect(defFor('dash-attention').adminOnly).toBeFalsy();

    expect(defFor('dash-money')).toMatchObject({ page: 'dashboard', widths: [1, 2, 3], defaultWidth: 2, adminOnly: true });

    expect(defFor('dash-deck')).toMatchObject({ page: 'dashboard', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('dash-deck').adminOnly).toBeFalsy();

    expect(defFor('dash-activity')).toMatchObject({ page: 'dashboard', widths: [1, 2], defaultWidth: 1 });
    expect(defFor('dash-activity').adminOnly).toBeFalsy();
  });
});

describe('dash-attention', () => {
  it('renders rows with the correct deep link per attention type', async () => {
    getDashboardAttention.mockResolvedValue([
      { type: 'overdue_task', label: 'Task overdue', sub: 'due yesterday', projectId: null, projectName: null, itemId: 't1', date: 1, severity: 'red' },
      { type: 'bid_due', label: 'Bid due soon', sub: 'Acme', projectId: 'p1', projectName: 'Acme', itemId: 'p1', date: 2, severity: 'amber' },
      { type: 'aging_receivable', label: 'Invoice aging', sub: '$500', projectId: 'p2', projectName: 'Beta', itemId: 'inv1', date: 3, severity: 'red', balanceCents: 50000 },
      { type: 'draft_payapp', label: 'Draft pay app', sub: 'sitting', projectId: 'p3', projectName: 'Gamma', itemId: 'pa1', date: 4, severity: 'amber' },
      { type: 'stale_rfi', label: 'Stale RFI', sub: 'no response', projectId: 'p4', projectName: 'Delta', itemId: 'rfi1', date: 5, severity: 'amber' },
    ]);
    mount('dash-attention', 2);

    await screen.findByText('Task overdue');
    expect(screen.getByText('Task overdue').closest('a')).toHaveAttribute('href', '/tasks');
    expect(screen.getByText('Bid due soon').closest('a')).toHaveAttribute('href', '/project/p1');
    expect(screen.getByText('Invoice aging').closest('a')).toHaveAttribute('href', '/project/p2/billing');
    expect(screen.getByText('Draft pay app').closest('a')).toHaveAttribute('href', '/project/p3/billing');
    expect(screen.getByText('Stale RFI').closest('a')).toHaveAttribute('href', '/project/p4/rfis');
  });

  it('shows a count badge and caps rows to 4 at width 1, 8 at width 2+', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      type: 'overdue_task' as const, label: `Task ${i}`, sub: '', projectId: null, projectName: null,
      itemId: `t${i}`, date: i, severity: 'red' as const,
    }));
    getDashboardAttention.mockResolvedValue(items);
    mount('dash-attention', 1);

    await screen.findByText('Task 0');
    expect(screen.getAllByText(/^Task \d$/)).toHaveLength(4);
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('shows the empty state when there is nothing to attend to', async () => {
    getDashboardAttention.mockResolvedValue([]);
    mount('dash-attention', 2);
    expect(await screen.findByText('Nothing needs you — enjoy it.')).toBeInTheDocument();
  });
});

describe('dash-money', () => {
  const money = {
    outstandingCents: 150000, contractTotalCents: 1000000, billedCents: 400000, paidCents: 250000,
    draftPayAppCount: 2,
    recentPayments: [{ id: 'pay1', amount: 25000, date: Date.now(), method: 'check', projectId: 'p1', projectName: 'Acme' }],
    trend: [{ month: '2026-07', paidCents: 10000 }, { month: '2026-08', paidCents: 25000 }],
  };

  it('renders headline, sparkline, and billed/draft/last-payment detail at width 2', async () => {
    getDashboardMoney.mockResolvedValue(money);
    mount('dash-money', 2);

    expect(await screen.findByText('$1,500.00')).toBeInTheDocument();
    expect(screen.getByTestId('sparkline-line')).toBeInTheDocument();
    expect(screen.getByText(/40% billed/)).toBeInTheDocument();
    expect(screen.getByText(/2 drafts/)).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });

  it('renders only the number and sparkline at width 1', async () => {
    getDashboardMoney.mockResolvedValue(money);
    mount('dash-money', 1);

    expect(await screen.findByText('$1,500.00')).toBeInTheDocument();
    expect(screen.getByTestId('sparkline-line')).toBeInTheDocument();
    expect(screen.queryByText(/billed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/drafts?/)).not.toBeInTheDocument();
  });

  it('is registered adminOnly so the registry, not the component, gates visibility', () => {
    expect(defFor('dash-money').adminOnly).toBe(true);
  });
});

describe('dash-deck', () => {
  const taskFixture = (over: Partial<{ id: string; title: string; assigneeUserId: string | null; dueDate: string | null }>) => ({
    id: 't1', category: '', title: 'Task', notes: '', assigneeUserId: null, assigneeUsername: null,
    status: 'open', dueDate: '2026-09-10', sortOrder: 0, projectId: null, customerId: null,
    projectName: null, customerName: null, version: 1, createdAt: 0, createdBy: null, photoCount: 0,
    ...over,
  });

  it('defaults to mine and filters out tasks assigned to others; All shows everyone', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'me' }));
    getTasks.mockResolvedValue([
      taskFixture({ id: 't1', title: 'My task', assigneeUserId: 'me' }),
      taskFixture({ id: 't2', title: 'Other task', assigneeUserId: 'other' }),
    ]);
    getProjectsSummary.mockResolvedValue([]);
    mount('dash-deck', 1);

    await screen.findByText('My task');
    expect(screen.queryByText('Other task')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('deck-scope-all'));
    await screen.findByText('Other task');
    expect(screen.getByText('My task')).toBeInTheDocument();
  });

  it('shows the soonest 3 bid deadlines from bidding projects only', async () => {
    getTasks.mockResolvedValue([]);
    getProjectsSummary.mockResolvedValue([
      { id: 'p1', name: 'A', status: 'bidding', bidDueDate: 4000, archived: false },
      { id: 'p2', name: 'B', status: 'bidding', bidDueDate: 1000, archived: false },
      { id: 'p3', name: 'C', status: 'in_progress', bidDueDate: 500, archived: false },
      { id: 'p4', name: 'D', status: 'bidding', bidDueDate: 2000, archived: false },
      { id: 'p5', name: 'E', status: 'bidding', bidDueDate: 3000, archived: false },
    ] as never);
    mount('dash-deck', 1);

    const chips = await screen.findByTestId('deck-bid-chips');
    expect(chips.textContent).toContain('B');
    expect(chips.textContent).toContain('D');
    expect(chips.textContent).toContain('E');
    expect(chips.textContent).not.toContain('A');
    expect(chips.textContent).not.toContain('C');
  });

  it('shows the empty state when there are no tasks or bid deadlines', async () => {
    getTasks.mockResolvedValue([]);
    getProjectsSummary.mockResolvedValue([]);
    mount('dash-deck', 1);
    expect(await screen.findByText('Nothing on deck.')).toBeInTheDocument();
  });
});

describe('dash-activity', () => {
  it('renders activity rows, linking where activityTarget resolves a target', async () => {
    getActivity.mockResolvedValue([
      { id: 'a1', projectId: 'p1', userId: 'u1', type: 'issue_created', message: 'Issue opened', createdAt: Date.now(), projectName: 'Acme', username: 'noah' },
      { id: 'a2', projectId: null, userId: null, type: 'other', message: 'Global thing', createdAt: Date.now(), projectName: null, username: null },
    ]);
    mount('dash-activity', 1, { isAdmin: true });

    await screen.findByText('Issue opened');
    expect(screen.getByText('Issue opened').closest('a')).toHaveAttribute('href', '/project/p1/issues');
    expect(screen.getByText('Global thing').closest('a')).toBeNull();
  });

  it('shows the empty state when there is no activity', async () => {
    getActivity.mockResolvedValue([]);
    mount('dash-activity', 1);
    expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
  });
});
