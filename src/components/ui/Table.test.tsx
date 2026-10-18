// src/components/ui/Table.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Table, THead, TBody, TR, TH, TD } from './Table';

describe('Table', () => {
  it('renders a semantic table with header and rows', () => {
    render(
      <Table>
        <THead>
          <TR><TH>Name</TH><TH>Amount</TH></TR>
        </THead>
        <TBody>
          <TR><TD>Drywall</TD><TD>$1,200</TD></TR>
        </TBody>
      </Table>
    );
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '$1,200' })).toBeInTheDocument();
  });

  it('interactive rows get the hover wash class', () => {
    render(
      <Table>
        <TBody>
          <TR interactive data-testid="row"><TD>x</TD></TR>
        </TBody>
      </Table>
    );
    expect(screen.getByTestId('row').className).toContain('hover:bg-hover');
  });
});
