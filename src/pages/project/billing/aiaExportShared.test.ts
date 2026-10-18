import { describe, it, expect } from 'vitest';
import { buildBlankSovContext } from './aiaExportShared';
import { AiaSovLine } from '../../../utils/store';

const line = (over: Partial<AiaSovLine>): AiaSovLine => ({
  id: 'l1', projectId: 'p1', itemNo: '1', description: 'Stucco',
  scheduledValueCents: 100000, retainagePercent: null, isChangeOrder: 0,
  changeOrderId: null, sortOrder: 0, version: 1, createdAt: 1, ...over,
});

describe('buildBlankSovContext', () => {
  it('zeroes every billing column and sets balance = scheduled', () => {
    const { g703 } = buildBlankSovContext([line({})], {}, 'p1');
    expect(g703).toHaveLength(1);
    const r = g703[0];
    expect(r.previousCents).toBe(0);
    expect(r.thisPeriodCents).toBe(0);
    expect(r.storedCents).toBe(0);
    expect(r.totalToDateCents).toBe(0);
    expect(r.percentComplete).toBe(0);
    expect(r.retainageCents).toBe(0);
    expect(r.balanceToFinishCents).toBe(100000);
    expect(r.sovLineId).toBe('l1');
  });

  it('orders rows by sortOrder', () => {
    const { g703 } = buildBlankSovContext([
      line({ id: 'b', sortOrder: 2, description: 'second' }),
      line({ id: 'a', sortOrder: 1, description: 'first' }),
    ], {}, 'p1');
    expect(g703.map(r => r.description)).toEqual(['first', 'second']);
  });

  it('computes G702 contract sums and zeroes all progress lines', () => {
    const { g702 } = buildBlankSovContext([
      line({ id: 'a', scheduledValueCents: 100000 }),
      line({ id: 'b', scheduledValueCents: 25000, isChangeOrder: 1 }),
      line({ id: 'c', scheduledValueCents: -5000, isChangeOrder: 1 }),
    ], {}, 'p1');
    expect(g702.L1originalContractCents).toBe(100000);
    expect(g702.L2changeOrdersCents).toBe(20000);
    expect(g702.L3contractSumToDateCents).toBe(120000);
    expect(g702.L4totalCompletedStoredCents).toBe(0);
    expect(g702.L5aRetainageWorkCents).toBe(0);
    expect(g702.L5bRetainageStoredCents).toBe(0);
    expect(g702.L5retainageCents).toBe(0);
    expect(g702.L6earnedLessRetainageCents).toBe(0);
    expect(g702.L7lessPreviousCents).toBe(0);
    expect(g702.L8currentPaymentDueCents).toBe(0);
    expect(g702.L9balanceToFinishCents).toBe(120000);
    expect(g702.changeOrders).toEqual({ additionsCents: 25000, deductionsCents: -5000, netCents: 20000 });
  });

  it('synthetic app has number 0, blank dates, and settings retainage (default 10)', () => {
    const a = buildBlankSovContext([line({})], { retainagePercent: 5 }, 'p1').app;
    expect(a.number).toBe(0);
    expect(a.periodTo).toBeNull();
    expect(a.applicationDate).toBeNull();
    expect(a.retainagePercent).toBe(5);
    expect(buildBlankSovContext([line({})], {}, 'p1').app.retainagePercent).toBe(10);
  });

  it('synthetic g702.retainage reports the base rate with nothing released yet', () => {
    const { g702 } = buildBlankSovContext([line({})], { retainagePercent: 5 }, 'p1');
    expect(g702.retainage).toEqual({
      mode: 'uniform',
      baseWorkPercent: 5,
      cumulativeReleasedPoints: 0,
      releasedThisApp: 0,
      remainingPoints: 5,
      effectiveWorkPercent: 5,
    });
  });

  it('resolves perLine mode (and a null effectiveWorkPercent) when a SOV line carries its own rate', () => {
    const { g702 } = buildBlankSovContext([line({ retainagePercent: 12 })], {}, 'p1');
    expect(g702.retainage.mode).toBe('perLine');
    expect(g702.retainage.effectiveWorkPercent).toBeNull();
  });

  it('buildBlankSovContext carries lineType through and sums only items into L1', () => {
    const lines: AiaSovLine[] = [
      { id: 'a', projectId: 'p', itemNo: '1', description: 'Work', scheduledValueCents: 1000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 1, createdAt: 0, lineType: 'item' },
      { id: 'h', projectId: 'p', itemNo: null, description: 'Section', scheduledValueCents: 0, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 1, version: 1, createdAt: 0, lineType: 'header' },
    ];
    const blank = buildBlankSovContext(lines, {}, 'p');
    expect(blank.g703.map(r => r.lineType)).toEqual(['item', 'header']);
    expect(blank.g702.L1originalContractCents).toBe(1000);
  });
});
