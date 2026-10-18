// src/pages/project/daily/DailyReportsCalendar.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { DailyReportsCalendar, monthGrid } from './DailyReportsCalendar';
import { DailyReportListItem } from '../../../utils/store';

const report = (over: Partial<DailyReportListItem> = {}): DailyReportListItem => ({
  id: 'r1', projectId: 'p1', crewId: 'c1', crewName: 'Crew 1', reportDate: '2026-09-05', jobName: 'Job', contractorName: 'GC', startTime: null,
  weatherSummary: '', temperature: '', manCounts: [], createdBy: null,
  createdAt: 1, updatedAt: 1, version: 1, photoCount: 0,
  ...over,
});

describe('monthGrid', () => {
  it('starts on Sunday and covers whole weeks (length is a multiple of 7)', () => {
    const g = monthGrid(2026, 8); // September 2026 (0-based month)
    expect(g.length % 7).toBe(0);
  });

  it('September 2026 grid starts Sunday 2026-08-30 and covers through 2026-09-30', () => {
    const g = monthGrid(2026, 8);
    expect(g[0]).toEqual({ dateStr: '2026-08-30', inMonth: false });
    const inMonthDates = g.filter(c => c.inMonth).map(c => c.dateStr);
    expect(inMonthDates[0]).toBe('2026-09-01');
    expect(inMonthDates[inMonthDates.length - 1]).toBe('2026-09-30');
  });
});

describe('DailyReportsCalendar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 5)); // Sept 5, 2026 local
  });
  afterEach(() => { vi.useRealTimers(); });

  it('fills a day that has a report with the accent color', () => {
    render(<DailyReportsCalendar reports={[report({ reportDate: '2026-09-10' })]} onOpen={vi.fn()} onCreate={vi.fn()} />);
    const cell = screen.getByTestId('daily-calendar-day-2026-09-10');
    expect(cell.dataset.report).toBe('true');
    expect(cell.className).toContain('bg-accent-500');
    expect(cell.className).toContain('text-white');
    // Empty days stay plain raised cells.
    const empty = screen.getByTestId('daily-calendar-day-2026-09-11');
    expect(empty.dataset.report).toBeUndefined();
    expect(empty.className).toContain('text-ink');
  });

  it('calls onOpen with the report id when a report day is clicked', () => {
    const onOpen = vi.fn();
    render(<DailyReportsCalendar reports={[report({ id: 'rep-42', reportDate: '2026-09-10' })]} onOpen={onOpen} onCreate={vi.fn()} />);
    fireEvent.click(screen.getByTestId('daily-calendar-day-2026-09-10'));
    expect(onOpen).toHaveBeenCalledWith('rep-42');
  });

  it('calls onCreate with the dateStr when an empty day is clicked', () => {
    const onCreate = vi.fn();
    render(<DailyReportsCalendar reports={[]} onOpen={vi.fn()} onCreate={onCreate} />);
    fireEvent.click(screen.getByTestId('daily-calendar-day-2026-09-15'));
    expect(onCreate).toHaveBeenCalledWith('2026-09-15');
  });

  it('navigates months with prev/next and Today returns to the current month', () => {
    render(<DailyReportsCalendar reports={[]} onOpen={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByText('September 2026')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Next month'));
    expect(screen.getByText('October 2026')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Previous month'));
    fireEvent.click(screen.getByLabelText('Previous month'));
    expect(screen.getByText('August 2026')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Today'));
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });
});

// The All crews tab (spec docs/superpowers/specs/2026-10-06-daily-report-crews-design.md):
// every crew's reports on one calendar, for viewing — no onCreate.
describe('DailyReportsCalendar — All crews (read-only)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 5));
  });
  afterEach(() => { vi.useRealTimers(); });

  const reports = [
    report({ id: 'ours', crewName: 'Crew 1', reportDate: '2026-09-10', manCounts: [{ type: 'Plasterer', count: 4 }] }),
    report({ id: 'theirs', crewId: 'c2', crewName: 'Smith Drywall', reportDate: '2026-09-10', manCounts: [] }),
    report({ id: 'later', crewId: 'c2', crewName: 'Smith Drywall', reportDate: '2026-09-12', manCounts: [{ type: 'Hanger', count: 2 }] }),
  ];

  it('lists each crew\'s report on its day with the crew name and man count', () => {
    render(<DailyReportsCalendar reports={reports} onOpen={vi.fn()} />);
    const day = screen.getByTestId('daily-calendar-day-2026-09-10');
    expect(day.dataset.report).toBe('true');
    expect(screen.getByTestId('daily-calendar-entry-ours')).toHaveTextContent('Crew 1 · 4 men');
    expect(screen.getByTestId('daily-calendar-entry-theirs')).toHaveTextContent(/^Smith Drywall$/); // no men counted
    expect(screen.getByTestId('daily-calendar-entry-later')).toHaveTextContent('Smith Drywall · 2 men');
    expect(day.querySelectorAll('button')).toHaveLength(2);
  });

  it('opens the clicked crew\'s report', () => {
    const onOpen = vi.fn();
    render(<DailyReportsCalendar reports={reports} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: "Open Smith Drywall's daily report for 2026-09-10" }));
    expect(onOpen).toHaveBeenCalledWith('theirs');
  });

  it('starts nothing from an empty day', () => {
    render(<DailyReportsCalendar reports={reports} onOpen={vi.fn()} />);
    const empty = screen.getByTestId('daily-calendar-day-2026-09-11');
    expect(empty.dataset.report).toBeUndefined();
    expect(empty.tagName).toBe('DIV');
    expect(empty.querySelector('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Create daily report/ })).toBeNull();
  });
});
