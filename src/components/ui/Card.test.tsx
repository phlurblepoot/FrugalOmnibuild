// src/components/ui/Card.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardHeader, CardBody } from './Card';

describe('Card', () => {
  it('renders a flat raised surface with children', () => {
    render(
      <Card data-testid="card">
        <CardHeader title="Invoices" actions={<button>New</button>} />
        <CardBody>rows</CardBody>
      </Card>
    );
    const card = screen.getByTestId('card');
    expect(card.className).toContain('bg-raised');
    expect(card.className).not.toContain('glass'); // data surfaces stay flat
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
    expect(screen.getByText('rows')).toBeInTheDocument();
  });
});
