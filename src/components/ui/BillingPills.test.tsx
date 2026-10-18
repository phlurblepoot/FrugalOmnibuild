// src/components/ui/BillingPills.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InvoiceStatusPill, ChangeOrderStatusPill, INVOICE_STATUS_META, CO_STATUS_META } from './BillingPills';

describe('billing pills', () => {
  it('maps every invoice + change-order status', () => {
    for (const s of ['draft', 'sent', 'paid']) expect(INVOICE_STATUS_META[s], s).toBeDefined();
    for (const s of ['pending', 'approved', 'rejected']) expect(CO_STATUS_META[s], s).toBeDefined();
  });
  it('renders labels', () => {
    render(<><InvoiceStatusPill status="sent" /><ChangeOrderStatusPill status="approved" /></>);
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });
  it('falls back to slate for unknown statuses (prototype-safe)', () => {
    render(<InvoiceStatusPill status="constructor" />);
    // StatusPill's 'slate' tone NAME is unchanged; its classes were retokened
    // to bg-sunken/text-ink-soft (Wave 3 token migration), so assert on the
    // token class rather than the literal string "slate".
    expect(screen.getByText('constructor').className).toContain('bg-sunken');
  });
});
