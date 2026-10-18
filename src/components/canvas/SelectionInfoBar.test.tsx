// src/components/canvas/SelectionInfoBar.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { SelectionInfoBar } from './SelectionInfoBar';
import type { SelectionSummary } from '../../utils/segmentValue';

const wall: SelectionSummary = {
  measurementName: 'North wall',
  takeoffName: 'Stucco',
  color: '#ef4444',
  total: { quantity: '507.50 sq ft', dollars: '$1,776' },
};

describe('SelectionInfoBar', () => {
  it('renders nothing when nothing is selected', () => {
    const { container } = render(<SelectionInfoBar summary={null} multiCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it('whole measurement: name, takeoff with its swatch, and the measurement total', () => {
    render(<SelectionInfoBar summary={wall} multiCount={0} />);
    const bar = screen.getByTestId('selection-info-bar');
    expect(within(bar).getByText('North wall')).toBeInTheDocument();
    expect(within(bar).getByText('Stucco')).toBeInTheDocument();
    expect(bar.querySelector('[style]')).toHaveStyle({ backgroundColor: '#ef4444' });
    expect(screen.getByTestId('selection-info-total')).toHaveTextContent('Measurement total507.50 sq ft · $1,776');
    expect(screen.queryByTestId('selection-info-segment')).toBeNull();
  });

  it('one segment: its own value beside the measurement total', () => {
    render(<SelectionInfoBar summary={{ ...wall, segment: { label: 'Segment', value: { quantity: '420.00 sq ft', dollars: '$1,470' } } }} multiCount={0} />);
    expect(screen.getByTestId('selection-info-segment')).toHaveTextContent('Segment420.00 sq ft · $1,470');
    expect(screen.getByTestId('selection-info-total')).toHaveTextContent('Measurement total507.50 sq ft · $1,776');
  });

  it('a cutout reads as a deduction', () => {
    render(<SelectionInfoBar summary={{ ...wall, segment: { label: 'Cutout', value: { quantity: '−12.50 sq ft', dollars: '−$44' } } }} multiCount={0} />);
    expect(screen.getByTestId('selection-info-segment')).toHaveTextContent('Cutout−12.50 sq ft · −$44');
  });

  it('omits the $ when there is none, and shows a surface area\'s length', () => {
    render(<SelectionInfoBar summary={{ ...wall, takeoffName: undefined, total: { quantity: '160.00 sq ft', length: `10' - 0"` } }} multiCount={0} />);
    const total = screen.getByTestId('selection-info-total');
    expect(total).toHaveTextContent(`Measurement total160.00 sq ftLength: 10' - 0"`);
    expect(total).not.toHaveTextContent('$');
    expect(screen.getByText('Ungrouped')).toBeInTheDocument();
  });

  it('a count marker: its price and how many are on the page', () => {
    render(<SelectionInfoBar summary={{ measurementName: 'Count 3', takeoffName: 'Outlets', color: '#22c55e', total: { quantity: '1 each', dollars: '$45' }, countOnPage: 12 }} multiCount={0} />);
    expect(screen.getByTestId('selection-info-total')).toHaveTextContent('Marker1 each · $45');
    expect(screen.getByText('On this page')).toBeInTheDocument();
    expect(screen.getByText('12 each')).toBeInTheDocument();
  });

  it('a multiplied measurement shows the math on its segment and its total', () => {
    render(<SelectionInfoBar summary={{
      ...wall,
      segment: { label: 'Segment', value: { quantity: '420.00 sq ft × 4 = 1680.00 sq ft', dollars: '$5,880' } },
      total: { quantity: '507.50 sq ft × 4 = 2030.00 sq ft', dollars: '$7,105' },
    }} multiCount={0} />);
    expect(screen.getByTestId('selection-info-segment')).toHaveTextContent('Segment420.00 sq ft × 4 = 1680.00 sq ft · $5,880');
    expect(screen.getByTestId('selection-info-total')).toHaveTextContent('Measurement total507.50 sq ft × 4 = 2030.00 sq ft · $7,105');
  });

  it('several multi-selected measurements show a count instead', () => {
    render(<SelectionInfoBar summary={wall} multiCount={3} />);
    expect(screen.getByTestId('selection-info-bar')).toHaveTextContent('3 selected');
    expect(screen.queryByText('North wall')).toBeNull();
  });
});
