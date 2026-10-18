// src/pages/customers/CustomerBillingTab.tsx
// Admin-only rollup + ledger across every project this customer owns. The
// Billing tab itself is hidden for non-admins by CustomerPane (the tab bar
// entry isn't rendered), so `billing` is expected to always be present here —
// the fallback below only guards against a stale/edge-case render.
import React from 'react';
import { Link } from 'react-router-dom';
import { DollarSign } from 'lucide-react';
import { CustomerBilling, CustomerBillingLedgerEntry } from '../../utils/store';
import { formatMoney } from '../../utils/money';
import { formatBillingDate } from '../../utils/billingDates';
import { INVOICE_STATUS_META } from '../../components/ui/BillingPills';
import { Card, CardBody, CardHeader, EmptyState, StatusPill, Table, TBody, TD, TH, THead, TR } from '../../components/ui';
import type { PillTone } from '../../components/ui';

// Pay apps only ever carry `draft`/`finalized` (no `sent` state) — see
// AiaPayApplications.tsx's STATUS_META, mirrored here for the mixed ledger.
const PAYAPP_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  draft: { label: 'Draft', tone: 'slate' },
  finalized: { label: 'Finalized', tone: 'emerald' },
};

const KIND_LABEL: Record<CustomerBillingLedgerEntry['kind'], string> = {
  invoice: 'Invoice',
  payapp: 'Pay Application',
};

const LedgerStatusPill: React.FC<{ entry: CustomerBillingLedgerEntry }> = ({ entry }) => {
  const meta = entry.kind === 'invoice' ? INVOICE_STATUS_META : PAYAPP_STATUS_META;
  const m = meta[entry.status] ?? { label: entry.status, tone: 'slate' as PillTone };
  return <StatusPill tone={m.tone}>{m.label}</StatusPill>;
};

export const CustomerBillingTab: React.FC<{ billing?: CustomerBilling }> = ({ billing }) => {
  if (!billing) {
    return <EmptyState icon={<DollarSign size={22} />} title="Billing unavailable"
      description="Reload the page — this data should have loaded with the overview." />;
  }

  // Newest first; entries without a date sort to the bottom.
  const ledger = [...billing.ledger].sort((a, b) => {
    const at = a.date != null ? new Date(a.date).getTime() : -Infinity;
    const bt = b.date != null ? new Date(b.date).getTime() : -Infinity;
    return bt - at;
  });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Summary" actions={<DollarSign size={15} className="text-ink-faint" />} />
        <CardBody>
          <div className="space-y-4">
            <div data-testid="billing-summary-contract">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Contract</div>
              <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                {([
                  ['Contract total', billing.contractTotalCents],
                  ['Billed', billing.contract.billedCents],
                  ['Outstanding', billing.contract.outstandingCents],
                  ['Paid', billing.contract.paidCents],
                ] as const).map(([label, cents]) => (
                  <div key={label}>
                    <div className="text-ink-faint">{label}</div>
                    <div className="text-lg font-bold text-ink">{formatMoney(cents)}</div>
                  </div>
                ))}
              </div>
            </div>
            <div data-testid="billing-summary-invoices">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Invoices</div>
              {/* Same 4-column grid as the Contract row above, with the middle
                  two cells left empty so "Paid" lands in the same column as
                  the Contract row's "Paid" — they align when scanning. */}
              <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div>
                  <div className="text-ink-faint">Invoiced</div>
                  <div className="text-lg font-bold text-ink">{formatMoney(billing.invoices.invoicedCents)}</div>
                </div>
                <div className="hidden sm:block" aria-hidden="true" />
                <div className="hidden sm:block" aria-hidden="true" />
                <div>
                  <div className="text-ink-faint">Paid</div>
                  <div className="text-lg font-bold text-ink">{formatMoney(billing.invoices.paidCents)}</div>
                </div>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Ledger" />
        <CardBody className={ledger.length === 0 ? undefined : 'p-0'}>
          {ledger.length === 0 ? (
            <EmptyState title="No invoices or pay applications yet"
              description="Invoices and AIA pay applications across this customer's projects show up here." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Project</TH><TH>Kind</TH><TH>Number</TH><TH>Date</TH><TH>Status</TH>
                  <TH>Total</TH><TH>Paid</TH><TH>Balance</TH>
                </TR>
              </THead>
              <TBody>
                {ledger.map((e, i) => (
                  <TR key={`${e.kind}-${e.projectId}-${e.number}-${i}`}>
                    <TD className="font-medium text-ink">
                      <Link to={`/project/${e.projectId}/billing`} className="hover:underline">{e.projectName}</Link>
                    </TD>
                    <TD className="text-ink-soft">{KIND_LABEL[e.kind]}</TD>
                    <TD className="text-ink-soft">{e.number}</TD>
                    <TD className="text-ink-soft">{formatBillingDate(e.date)}</TD>
                    <TD><LedgerStatusPill entry={e} /></TD>
                    <TD className="text-ink-soft">{formatMoney(e.totalCents)}</TD>
                    <TD className="text-ink-soft">{formatMoney(e.paidCents)}</TD>
                    <TD className={e.balanceCents > 0 ? 'font-semibold text-ink' : 'text-ink-soft'}>{formatMoney(e.balanceCents)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardBody>
      </Card>
    </div>
  );
};
