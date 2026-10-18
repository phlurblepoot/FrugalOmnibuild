// src/pages/Dashboard.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor as rtlWaitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import React from 'react';
import { hoursThisWeek, startOfWeek, timeAgo } from './Dashboard';

const {
  fakeSocket, getDashboardAttention, getDashboardMoney, getTasks, getProjectsSummary, getActivity,
} = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return {
    fakeSocket,
    getDashboardAttention: vi.fn(),
    getDashboardMoney: vi.fn(),
    getTasks: vi.fn(),
    getProjectsSummary: vi.fn(),
    getActivity: vi.fn(),
  };
});
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'sock-1' }),
}));
vi.mock('../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getDashboardAttention, getDashboardMoney, getTasks, getProjectsSummary, getActivity,
}));

// Imported after the mocks above so Dashboard (and the cards it renders via
// CardGrid) pick up the mocked store/collaboration context.
import { Dashboard } from './Dashboard';

function mount() {
  return render(<MemoryRouter><Dashboard /></MemoryRouter>);
}

describe('startOfWeek', () => {
  it('returns the preceding Sunday at 00:00', () => {
    // Wed 2026-06-10 15:30 local → Sun 2026-06-07 00:00 local
    const wed = new Date(2026, 5, 10, 15, 30);
    const start = new Date(startOfWeek(wed));
    expect(start.getDay()).toBe(0); // Sunday
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
    expect(start.getDate()).toBe(7);
  });
});

describe('hoursThisWeek', () => {
  it('sums only entries clocked in this week, counting open entries to now', () => {
    const now = new Date(2026, 5, 10, 12, 0).getTime(); // Wed noon
    const weekStart = startOfWeek(new Date(now));
    const entries = [
      { id: '1', projectId: null, clockIn: weekStart + 3_600_000, clockOut: weekStart + 3 * 3_600_000, description: '' }, // 2h
      { id: '2', projectId: null, clockIn: now - 1_800_000, clockOut: null, description: '' },                      // 0.5h open
      { id: '3', projectId: null, clockIn: weekStart - 24 * 3_600_000, clockOut: weekStart - 20 * 3_600_000, description: '' }, // last week
    ];
    expect(hoursThisWeek(entries, now)).toBeCloseTo(2.5, 5);
  });
});

describe('timeAgo', () => {
  it('formats rough relative times', () => {
    const now = Date.now();
    expect(timeAgo(now - 30_000)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000)).toBe('2d ago');
  });
});

describe('Dashboard page', () => {
  beforeEach(() => {
    getDashboardAttention.mockReset().mockResolvedValue([]);
    getDashboardMoney.mockReset().mockResolvedValue({
      outstandingCents: 0, contractTotalCents: 0, billedCents: 0, paidCents: 0,
      draftPayAppCount: 0, recentPayments: [], trend: [],
    });
    getTasks.mockReset().mockResolvedValue([]);
    getProjectsSummary.mockReset().mockResolvedValue([]);
    getActivity.mockReset().mockResolvedValue([]);
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });
  afterEach(() => localStorage.removeItem('user'));

  it('renders the greeting and the card grid with the default card titles, for an admin', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', username: 'noah', role: 'admin' }));
    mount();

    expect(screen.getByText(/Welcome back, noah/)).toBeInTheDocument();
    expect(await screen.findByTestId('card-grid')).toBeInTheDocument();

    expect(await screen.findByText('⚡ Needs your attention')).toBeInTheDocument();
    expect(screen.getByText('Money pulse')).toBeInTheDocument();
    expect(screen.getByText('📅 On deck')).toBeInTheDocument();
    expect(screen.getByText('Team activity')).toBeInTheDocument();
  });

  it('hides the Money pulse card for a non-admin', async () => {
    localStorage.setItem('user', JSON.stringify({ id: 'u1', username: 'noah', role: 'user' }));
    mount();

    await screen.findByTestId('card-grid');
    await rtlWaitFor(() => expect(screen.getByText('⚡ Needs your attention')).toBeInTheDocument());
    expect(screen.queryByText('Money pulse')).not.toBeInTheDocument();
  });
});
