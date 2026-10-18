// src/pages/customers/CustomerBillingTab.test.tsx — the customer's billing
// ledger shows invoice and pay app dates as the days they were picked, in a US
// time zone too (where an invoice date's UTC midnight is the evening before).
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CustomerBilling, CustomerBillingLedgerEntry } from '../../utils/store';
import { useTimeZone } from '../../test/timeZone';
import { CustomerBillingTab } from './CustomerBillingTab';

useTimeZone('America/Los_Angeles');

const entry = (over: Partial<CustomerBillingLedgerEntry>): CustomerBillingLedgerEntry => ({
  projectId: 'p1', projectName: 'Kitchen remodel', kind: 'invoice', number: 1, date: null,
  status: 'sent', totalCents: 50_000, paidCents: 0, balanceCents: 50_000,
  ...over,
});

const billing = (ledger: CustomerBillingLedgerEntry[]): CustomerBilling => ({
  contractTotalCents: 0, invoicedCents: 0, paidCents: 0, outstandingCents: 0, ledger,
  aging: { current: 0, days31to60: 0, days61plus: 0 },
  contract: { billedCents: 0, paidCents: 0, outstandingCents: 0 },
  invoices: { invoicedCents: 0, paidCents: 0, outstandingCents: 0 },
});

describe('CustomerBillingTab — ledger dates west of UTC', () => {
  it('shows an invoice date and a pay app date as the days they were picked', () => {
    render(
      <MemoryRouter>
        <CustomerBillingTab billing={billing([
          entry({ number: 1001, date: new Date('2026-10-01').getTime() }),
          entry({ kind: 'payapp', number: 3, date: '2026-09-01' }),
          entry({ number: 1002, date: null }),
        ])} />
      </MemoryRouter>
    );
    const rowOf = (number: string) => screen.getByText(number).closest('tr')!;
    expect(within(rowOf('1001')).getByText(new Date(2026, 9, 1).toLocaleDateString())).toBeInTheDocument();
    expect(within(rowOf('3')).getByText(new Date(2026, 8, 1).toLocaleDateString())).toBeInTheDocument();
    expect(within(rowOf('1002')).getByText('—')).toBeInTheDocument();
  });
});
