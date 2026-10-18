import { describe, it, expect } from 'vitest';
import { isOverridden, rederiveLines, proposalTotals, scheduleAmountCents, lineFromTakeoff, measurementSummary, derivedCents, toCents } from './proposalMath';
import type { TakeoffTotals } from './proposalGenerator';
import type { ProposalLine } from '../../../utils/store';

const t = (id: string, name: string, cost: number, val = 100, unit = 'sqft'): TakeoffTotals =>
  ({ id, name, type: 'area', color: '#fff', unit, costPerUnit: cost, totalRealValue: val, pageBreakdown: [] } as any);
const line = (o: Partial<ProposalLine>): ProposalLine =>
  ({ id: 'l', sortOrder: 0, kind: 'manual', takeoffId: null, description: '', amountCents: 0, derivedAmountCents: null, measurementSummary: null, isAlternate: false, ...o });

describe('proposalMath', () => {
  it('detects overrides only on takeoff lines with a derived amount', () => {
    expect(isOverridden(line({ kind: 'takeoff', amountCents: 100, derivedAmountCents: 90 }))).toBe(true);
    expect(isOverridden(line({ kind: 'takeoff', amountCents: 90, derivedAmountCents: 90 }))).toBe(false);
    expect(isOverridden(line({ kind: 'takeoff', amountCents: 90, derivedAmountCents: null }))).toBe(false);
    expect(isOverridden(line({ kind: 'manual', amountCents: 5, derivedAmountCents: 1 }))).toBe(false);
  });

  it('derives cents from takeoff cost rounded up to $100 and builds a summary', () => {
    const tk = t('t1', 'Stucco', 10.15, 41.7); // 423.255 → roundUpTo100 → 500
    expect(derivedCents(tk)).toBe(50000);
    expect(measurementSummary(tk)).toBe('41.70 sq ft');
    expect(lineFromTakeoff(tk)).toEqual({ kind: 'takeoff', takeoffId: 't1', description: 'Stucco', amountCents: 50000, derivedAmountCents: 50000, measurementSummary: '41.70 sq ft', isAlternate: false });
  });

  it('rederives non-overridden lines, keeps overrides, reports missing takeoffs', () => {
    const lines = [
      line({ id: 'a', kind: 'takeoff', takeoffId: 't1', amountCents: 10000, derivedAmountCents: 10000 }),
      line({ id: 'b', kind: 'takeoff', takeoffId: 't2', amountCents: 99900, derivedAmountCents: 10000 }),
      line({ id: 'c', kind: 'takeoff', takeoffId: 'gone', amountCents: 5, derivedAmountCents: 5 }),
      line({ id: 'd', kind: 'manual', amountCents: 7 }),
    ];
    const r = rederiveLines(lines, [t('t1', 'A', 2, 100), t('t2', 'B', 2, 100)]); // 200 → 200
    expect(r.lines.find(l => l.id === 'a')).toMatchObject({ amountCents: 20000, derivedAmountCents: 20000, measurementSummary: '100.00 sq ft' });
    expect(r.lines.find(l => l.id === 'b')).toMatchObject({ amountCents: 99900, derivedAmountCents: 20000 });
    expect(r.lines.find(l => l.id === 'c')).toMatchObject({ amountCents: 5 });
    expect(r.lines.find(l => l.id === 'd')).toMatchObject({ amountCents: 7 });
    expect(r.missingTakeoffIds).toEqual(['gone']);
  });

  it('totals exclude alternates and split groups', () => {
    const r = proposalTotals([
      line({ kind: 'takeoff', takeoffId: 't', amountCents: 100 }),
      line({ kind: 'manual', amountCents: 20 }),
      line({ kind: 'manual', amountCents: 5, isAlternate: true }),
      line({ kind: 'takeoff', takeoffId: 'u', amountCents: 7, isAlternate: true }),
    ]);
    expect(r.totalCents).toBe(120);
    expect(r.alternateCents).toBe(12);
    expect([r.takeoffLines.length, r.manualLines.length, r.altTakeoff.length, r.altManual.length]).toEqual([1, 1, 1, 1]);
  });

  it('schedule rows resolve percent or fixed cents', () => {
    expect(scheduleAmountCents({ description: '', percent: 50, amountCents: null }, 12345)).toBe(6173);
    expect(scheduleAmountCents({ description: '', percent: null, amountCents: 700 }, 12345)).toBe(700);
    expect(toCents(19.999)).toBe(2000);
  });
});
