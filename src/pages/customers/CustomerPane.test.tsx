// src/pages/customers/CustomerPane.test.tsx
// Overview-tab card-grid wiring: the old CustomerOverviewTab is gone (Wave 2
// Task 10) — the Overview tab renders the shared CardGrid instead. Full tab
// behavior (Projects/Tasks/Billing/Settings) and header rendering are
// exercised by the customers e2e suite; this covers just the swap.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CardContext, CardPage } from '../../cards';
import type { CustomerOverview } from '../../utils/store';

const { getCustomerOverview } = vi.hoisted(() => ({ getCustomerOverview: vi.fn() }));

vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCustomerOverview,
}));

vi.mock('../../cards', () => ({
  CardGrid: ({ page, ctx }: { page: CardPage; ctx: CardContext }) => (
    <div data-testid="card-grid" data-page={page} data-customer-id={ctx.customerId} data-is-admin={String(ctx.isAdmin)} />
  ),
}));

import { CustomerPane } from './CustomerPane';

const overview: CustomerOverview = {
  customer: {
    id: 'c1', name: 'Acme Co', emails: {}, contactName: undefined, phone: undefined,
  } as CustomerOverview['customer'],
  projects: [],
  attention: [],
  taskCounts: { open: 0, overdue: 0 },
};

function mount() {
  return render(
    <MemoryRouter>
      <CustomerPane customerId="c1" onBack={vi.fn()} onDeleted={vi.fn()} onMerged={vi.fn()} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  getCustomerOverview.mockReset();
  getCustomerOverview.mockResolvedValue(overview);
  localStorage.clear();
});

describe('CustomerPane overview tab', () => {
  it('renders the customer card-grid (not the deleted CustomerOverviewTab) by default', async () => {
    localStorage.setItem('user', JSON.stringify({ role: 'admin' }));
    mount();

    const grid = await screen.findByTestId('card-grid');
    expect(grid).toHaveAttribute('data-page', 'customer');
    expect(grid).toHaveAttribute('data-customer-id', 'c1');
    expect(grid).toHaveAttribute('data-is-admin', 'true');
  });

  it('passes isAdmin=false for a non-admin user', async () => {
    localStorage.setItem('user', JSON.stringify({ role: 'user' }));
    mount();

    expect(await screen.findByTestId('card-grid')).toHaveAttribute('data-is-admin', 'false');
  });
});
