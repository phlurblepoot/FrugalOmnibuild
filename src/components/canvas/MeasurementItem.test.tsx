// src/components/canvas/MeasurementItem.test.tsx
// The sidebar row of one measurement: a multiplied length/area shows what it
// counts for, its math on a line under the row, a ×N badge by its name, its
// cutouts multiplied, and a Multiplier action while selected — never for a
// count marker.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MeasurementItem } from './MeasurementItem';
import type { Measurement, MeasurementTakeoff, Point, ScaleConfig } from '../../types';

// 10 px = 1 ft, so 100 px² = 1 sq ft.
const scale: ScaleConfig = { pixelDistance: 10, realWorldDistance: 1, unit: 'ft' };
const rect = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];
const areaTakeoff: MeasurementTakeoff = { id: 't-area', name: 'Stucco', color: '#ef4444', type: 'area' };

// 200x210 px = 420 sq ft.
const floor = (o: Partial<Measurement> = {}): Measurement => ({
  id: 'm1', type: 'area', name: 'Level 2 floor', color: '#000', takeoffId: 't-area', points: rect(0, 0, 200, 210), ...o,
});

const renderItem = (measurement: Measurement, o: Partial<React.ComponentProps<typeof MeasurementItem>> = {}) =>
  render(
    <MeasurementItem
      measurement={measurement}
      scaleConfig={scale}
      takeoffType={areaTakeoff.type}
      takeoff={areaTakeoff}
      onDelete={() => {}}
      selected={false}
      onSelect={() => {}}
      onRename={() => {}}
      {...o}
    />,
  );

describe('MeasurementItem multiplier', () => {
  // A selected row scrolls itself into view; jsdom has no layout to scroll.
  beforeAll(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('without a multiplier: just the value, no math or badge', () => {
    renderItem(floor());
    expect(screen.getByTestId('measurement-value')).toHaveTextContent(/^420\.00 sq ft$/);
    expect(screen.queryByTestId('measurement-multiplier-math')).toBeNull();
    expect(screen.queryByTestId('measurement-multiplier-badge')).toBeNull();
  });

  it('a multiplied area shows what it counts for, its math, and a ×N badge', () => {
    renderItem(floor({ multiplier: 4 }));
    expect(screen.getByTestId('measurement-value')).toHaveTextContent(/^1680\.00 sq ft$/);
    expect(screen.getByTestId('measurement-multiplier-math')).toHaveTextContent(/^420\.00 sq ft × 4 = 1680\.00 sq ft$/);
    const badge = screen.getByTestId('measurement-multiplier-badge');
    expect(badge).toHaveTextContent('×4');
    expect(badge).toHaveAttribute('title', 'Counts 4 times');
  });

  it('a multiplied measurement\'s cutouts deduct that many times too', () => {
    renderItem(floor({ multiplier: 4, segments: [{ points: rect(50, 50, 50, 25), subtract: true }] }));
    // Net 420 − 12.5 = 407.5 sq ft, × 4.
    expect(screen.getByTestId('measurement-multiplier-math')).toHaveTextContent('407.50 sq ft × 4 = 1630.00 sq ft');
    expect(screen.getByTestId('cutout-value')).toHaveTextContent('−12.50 sq ft × 4 = −50.00 sq ft');
  });

  it('a length, and a length priced as wall surface area, multiply too', () => {
    const wall: Measurement = { id: 'w', type: 'length', name: 'Corridor', color: '#000', takeoffId: 't-area', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], multiplier: 3 };
    const { unmount } = renderItem(wall, { takeoffType: 'length', takeoff: undefined });
    expect(screen.getByTestId('measurement-value')).toHaveTextContent(`30' - 0"`);
    expect(screen.getByTestId('measurement-multiplier-math')).toHaveTextContent(`10' - 0" × 3 = 30' - 0"`);
    unmount();
    // 10 ft run × 10 ft high = 100 sq ft of wall.
    renderItem({ ...wall, heights: [10, 10] });
    expect(screen.getByTestId('measurement-multiplier-math')).toHaveTextContent('100.00 sq ft × 3 = 300.00 sq ft');
  });

  it('a selected length/area offers Multiplier, which opens the editor without reselecting', () => {
    const onEditMultiplier = vi.fn();
    const onSelect = vi.fn();
    renderItem(floor(), { selected: true, onEditMultiplier, onSelect });
    fireEvent.click(screen.getByTestId('btn-edit-multiplier'));
    expect(onEditMultiplier).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('only while selected', () => {
    renderItem(floor(), { onEditMultiplier: () => {} });
    expect(screen.queryByTestId('btn-edit-multiplier')).toBeNull();
  });

  it('a count marker never offers or shows a multiplier', () => {
    const marker: Measurement = { id: 'c', type: 'count', name: 'Outlet', color: '#000', takeoffId: 't-c', points: [{ x: 1, y: 1 }], multiplier: 3 };
    renderItem(marker, { takeoffType: 'count', takeoff: undefined, selected: true, onEditMultiplier: () => {} });
    expect(screen.queryByTestId('btn-edit-multiplier')).toBeNull();
    expect(screen.queryByTestId('measurement-multiplier-badge')).toBeNull();
    expect(screen.queryByTestId('measurement-multiplier-math')).toBeNull();
    expect(screen.getByTestId('measurement-value')).toHaveTextContent(/^1 each$/);
  });
});
