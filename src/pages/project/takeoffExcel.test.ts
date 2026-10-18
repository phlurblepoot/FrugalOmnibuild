// src/pages/project/takeoffExcel.test.ts
// The Takeoffs tab's Excel rows. Every Qty is what the row counts for; a
// multiplied measurement's row also carries its Measured Qty and Multiplier
// (two extra columns, only when some exported measurement has a multiplier).
import { describe, it, expect } from 'vitest';
import { buildTakeoffExcelRows } from './takeoffExcel';
import { computeTakeoffTotals } from './proposal/proposalGenerator';
import type { Measurement, Project } from '../../types';

// 1 px = 1 ft: a 100 px line is 100 ft. $2 / ft.
const line = (id: string, name: string, len: number, multiplier?: number): Measurement => ({
  id, type: 'length', name, color: '#000', takeoffId: 't1', multiplier,
  points: [{ x: 0, y: 0 }, { x: len, y: 0 }],
});
const project = (measurements: Measurement[]): Project => ({
  id: 'pr', name: 'Job', createdAt: 0, planSets: [],
  takeoffs: [{ id: 't1', name: 'Base', color: '#000', type: 'length', unit: 'ft', costPerUnit: 2 }],
  pages: [{
    id: 'p1', name: 'A-1', imageId: '', imageWidth: 0, imageHeight: 0,
    scaleConfig: { pixelDistance: 1, realWorldDistance: 1, unit: 'ft' },
    measurements,
  }],
} as unknown as Project);
const rowsFor = (measurements: Measurement[]) =>
  buildTakeoffExcelRows(computeTakeoffTotals(project(measurements), new Set(['p1'])));

describe('buildTakeoffExcelRows', () => {
  it('without a multiplier: the five columns, takeoff → page → measurement rows', () => {
    const { rows, cols } = rowsFor([line('m1', 'North', 100), line('m2', 'South', 50)]);
    expect(rows).toEqual([
      ['Takeoff Name', 'Type', 'Qty', 'Unit Cost', 'Total Cost'],
      ['Base', 'length', '150.00 ft', '$2.00', '$300'],
      ['  └ A-1', '', '150.00 ft', '$2.00', '$300'],
      ['      • North', '', '100.00 ft', '$2.00', '$200'],
      ['      • South', '', '50.00 ft', '$2.00', '$100'],
    ]);
    expect(cols).toHaveLength(5);
  });

  it('a multiplied measurement: Qty is what it counts for, with its Measured Qty and Multiplier beside', () => {
    const { rows, cols } = rowsFor([line('m1', 'North', 100, 4), line('m2', 'South', 50)]);
    expect(rows).toEqual([
      ['Takeoff Name', 'Type', 'Qty', 'Unit Cost', 'Total Cost', 'Measured Qty', 'Multiplier'],
      ['Base', 'length', '450.00 ft', '$2.00', '$900'],
      ['  └ A-1', '', '450.00 ft', '$2.00', '$900'],
      ['      • North', '', '400.00 ft', '$2.00', '$800', '100.00 ft', 4],
      ['      • South', '', '50.00 ft', '$2.00', '$100'],
    ]);
    expect(cols).toHaveLength(7);
  });
});
