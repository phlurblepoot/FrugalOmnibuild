// src/pages/settings/ClaudeUsagePanel.test.tsx
//
// The usage panel: the plan's 5-hour and weekly limits (whole account) with
// what page scans used inside each, and the scans' own totals by period.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ usage: vi.fn() }));
vi.mock('../../utils/aiSheets', () => ({ claudeApi: { usage: h.usage } }));

import { ClaudeUsagePanel } from './ClaudeUsagePanel';

const totals = (pages: number, tokens: number, cost: number) =>
  ({ pages, calls: pages, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost });
const base = {
  today: totals(3, 45_600, 0.21), last7Days: totals(40, 612_000, 2.8), thisMonth: totals(55, 840_000, 3.85), allTime: totals(55, 840_000, 3.85),
  plan: null, inFiveHourWindow: null, inSevenDayWindow: null,
};
const later = (h: number) => Date.now() + h * 3600_000;

beforeEach(() => { h.usage.mockReset(); });

describe('ClaudeUsagePanel', () => {
  it('shows each limit with what page scans used in that window', async () => {
    h.usage.mockResolvedValue({
      ...base,
      plan: { at: Date.now(), status: 'allowed', fiveHour: { utilization: 0.34, resetsAt: later(2) }, sevenDay: { utilization: 0.921, resetsAt: later(72) } },
      inFiveHourWindow: totals(12, 182_000, 0.84), inSevenDayWindow: totals(40, 612_000, 2.8),
    });
    render(<ClaudeUsagePanel source="token" />);
    const five = await screen.findByTestId('claude-limit-5h');
    expect(five).toHaveTextContent('34% used · resets');
    expect(five).toHaveTextContent('Page scans in this window: 12 pages · 182k tokens');
    expect(within(five).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '34');
    const week = screen.getByTestId('claude-limit-7d');
    expect(week).toHaveTextContent('92% used');
    expect(within(week).getByRole('progressbar').className).toContain('bg-red-500');
    expect(screen.getByText(/Anthropic does not say how much of that each app used/)).toBeInTheDocument();
  });

  it('lists page-scan totals by period, valued at API prices on a subscription', async () => {
    h.usage.mockResolvedValue(base);
    render(<ClaudeUsagePanel source="token" />);
    const table = await screen.findByTestId('claude-usage-table');
    expect(within(table).getByText('At API prices')).toBeInTheDocument();
    const today = within(table).getByText('Today').closest('tr')!;
    expect(today).toHaveTextContent('Today346k$0.21');
    expect(within(table).getByText('Last 7 days').closest('tr')).toHaveTextContent('40612k$2.80');
    expect(screen.getByText(/show here after the next page scan or Test connection/)).toBeInTheDocument();
  });

  it('with an API key, shows cost and no plan limits', async () => {
    h.usage.mockResolvedValue(base);
    render(<ClaudeUsagePanel source="apiKey" />);
    expect(await screen.findByText(/no plan limits/)).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.queryByTestId('claude-limit-5h')).toBeNull();
  });

  it('refreshes on demand and when told to', async () => {
    h.usage.mockResolvedValue(base);
    const { rerender } = render(<ClaudeUsagePanel source="token" refreshKey={0} />);
    await screen.findByTestId('claude-usage-table');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    await waitFor(() => expect(h.usage).toHaveBeenCalledTimes(2));
    rerender(<ClaudeUsagePanel source="token" refreshKey={1} />);
    await waitFor(() => expect(h.usage).toHaveBeenCalledTimes(3));
  });

  it('says so when usage cannot be loaded', async () => {
    h.usage.mockRejectedValue(new Error('403'));
    render(<ClaudeUsagePanel source="token" />);
    expect(await screen.findByText('Usage could not be loaded.')).toBeInTheDocument();
  });
});
