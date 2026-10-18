// src/pages/documents/MultiSelectDropdown.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MultiSelectDropdown } from './MultiSelectDropdown';

const OPTIONS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
];

describe('MultiSelectDropdown', () => {
  it('shows the empty-selection summary and opens the checkbox list on click', () => {
    render(<MultiSelectDropdown label="Type" options={OPTIONS} selected={[]} onChange={() => {}} emptyLabel="All types" />);
    expect(screen.getByText('All types')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('summarizes a single selection by its label, and multiple as a count', () => {
    const { rerender } = render(
      <MultiSelectDropdown label="Type" options={OPTIONS} selected={['a']} onChange={() => {}} />
    );
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    rerender(<MultiSelectDropdown label="Type" options={OPTIONS} selected={['a', 'b']} onChange={() => {}} />);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('toggles an option on and off via onChange', () => {
    const onChange = vi.fn();
    render(<MultiSelectDropdown label="Type" options={OPTIONS} selected={['a']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Type/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith(['a', 'b']);

    onChange.mockClear();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alpha' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('applies the given testId to the trigger button', () => {
    render(<MultiSelectDropdown label="Type" options={OPTIONS} selected={[]} onChange={() => {}} testId="doc-filter-type" />);
    expect(screen.getByTestId('doc-filter-type')).toBeInTheDocument();
  });
});
