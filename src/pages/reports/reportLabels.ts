// src/pages/reports/reportLabels.ts — wording shared by the on-screen reports
// and their Excel downloads, so the two always say the same thing.
import type { AgingBucket, RetainageReportRow } from '../../utils/reportsApi';

// The dashboard's Aging receivables card uses the same three labels.
export const AGING_LABELS: Record<AgingBucket | 'undated', string> = {
  current: '0–30 days',
  days31to60: '31–60 days',
  days61plus: '61+ days',
  undated: 'No date',
};

/** Line 4 over line 3, as a fraction (0.6 = 60%); null on a $0 contract. */
export const fractionComplete = (r: Pick<RetainageReportRow, 'completedStoredCents' | 'contractSumCents'>): number | null =>
  r.contractSumCents > 0 ? r.completedStoredCents / r.contractSumCents : null;

const pts = (n: number): string => String(+n.toFixed(2));

/** "10%", "10% − 4 pts released", "Per line", "Per line − 4 pts released". */
export function retainageRateLabel(r: Pick<RetainageReportRow, 'retainageMode' | 'retainagePercent' | 'releasedPoints'>): string {
  const base = r.retainageMode === 'perLine' ? 'Per line' : `${pts(r.retainagePercent)}%`;
  return r.releasedPoints > 0 ? `${base} − ${pts(r.releasedPoints)} pts released` : base;
}
