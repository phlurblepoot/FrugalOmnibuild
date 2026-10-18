import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../../components/Toast';

const h = vi.hoisted(() => ({ splitSovLine: vi.fn(async () => ({ header: {}, children: [] })) }));
vi.mock('../../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../../utils/store')>()),
  splitSovLine: h.splitSovLine,
}));

import { SplitSovLineModal, allocateCents } from './SplitSovLineModal';

const line: any = { id: 'l1', projectId: 'p1', itemNo: '5', description: 'Drywall', scheduledValueCents: 1000000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 3, createdAt: 0, lineType: 'item' };

const mount = (onSplit = vi.fn(), onClose = vi.fn(), payAppCount?: number) => {
  render(<ToastProvider><SplitSovLineModal line={line} onClose={onClose} onSplit={onSplit} payAppCount={payAppCount} /></ToastProvider>);
  return { onSplit, onClose };
};

beforeEach(() => vi.clearAllMocks());

describe('allocateCents', () => {
  it('rounds per part and gives the remainder to the last part', () => {
    expect(allocateCents(1000000, [60, 40])).toEqual([600000, 400000]);
    expect(allocateCents(10001, [33.34, 33.33, 33.33])).toEqual([3334, 3333, 3334]);
  });
});

describe('SplitSovLineModal', () => {
  it('starts with two 50/50 parts, previews dollars, and enables Split only at exactly 100%', async () => {
    mount();
    expect(screen.getByText('Drywall')).toBeInTheDocument();
    expect(screen.getByText('$10,000.00')).toBeInTheDocument();
    expect(screen.getAllByTestId('split-part-percent')).toHaveLength(2);
    expect(screen.getAllByText('$5,000.00')).toHaveLength(2);
    expect(screen.getByTestId('split-remaining')).toHaveTextContent('0.00%');
    const [p1] = screen.getAllByTestId('split-part-percent');
    await userEvent.clear(p1); await userEvent.type(p1, '60');
    expect(screen.getByTestId('split-remaining')).toHaveTextContent('-10.00%');
    expect(screen.getByTestId('split-submit')).toBeDisabled();
    const [, p2] = screen.getAllByTestId('split-part-percent');
    await userEvent.clear(p2); await userEvent.type(p2, '40');
    expect(screen.getByTestId('split-submit')).toBeEnabled();
  });

  it('Even split distributes to 2 dp with the last part absorbing the remainder; Add part appends a row', async () => {
    mount();
    await userEvent.click(screen.getByTestId('split-add-part'));
    await userEvent.click(screen.getByTestId('split-even'));
    const pcts = screen.getAllByTestId('split-part-percent').map(i => (i as HTMLInputElement).value);
    expect(pcts).toEqual(['33.33', '33.33', '33.34']);
    expect(screen.getByTestId('split-remaining')).toHaveTextContent('0.00%');
  });

  it('submits descriptions + percents with the line version, then calls onSplit and onClose', async () => {
    const { onSplit, onClose } = mount();
    const [d1, d2] = screen.getAllByTestId('split-part-description');
    await userEvent.clear(d1); await userEvent.type(d1, 'Level 1');
    await userEvent.clear(d2); await userEvent.type(d2, 'Level 2');
    await userEvent.click(screen.getByTestId('split-submit'));
    await waitFor(() => expect(h.splitSovLine).toHaveBeenCalledWith('l1', 3, [{ description: 'Level 1', percent: 50 }, { description: 'Level 2', percent: 50 }]));
    expect(onSplit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('blocks submit when a description is empty', async () => {
    mount();
    const [d1] = screen.getAllByTestId('split-part-description');
    await userEvent.clear(d1);
    expect(screen.getByTestId('split-submit')).toBeDisabled();
  });

  it('warns about lost billing progress only when the project has pay applications', () => {
    const warning = /new lines start with no billed progress/i;
    mount(vi.fn(), vi.fn(), 2);
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.getByText(warning)).toHaveTextContent('2 pay applications');
  });

  it('shows no warning when the project has no pay applications', () => {
    mount(vi.fn(), vi.fn(), 0);
    expect(screen.queryByText(/new lines start with no billed progress/i)).not.toBeInTheDocument();
  });
});
