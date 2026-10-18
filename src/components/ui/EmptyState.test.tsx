// src/components/ui/EmptyState.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders title, description, and action', () => {
    render(
      <EmptyState
        title="No invoices yet"
        description="Create your first invoice to get started."
        action={<button>New invoice</button>}
      />
    );
    expect(screen.getByRole('heading', { name: 'No invoices yet' })).toBeInTheDocument();
    expect(screen.getByText(/first invoice/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New invoice' })).toBeInTheDocument();
  });

  it('renders without optional parts', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
  });
});
