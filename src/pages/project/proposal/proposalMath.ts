// src/pages/project/proposal/proposalMath.ts — pure helpers for proposal lines.
import { calculateTakeoffTotalCost, roundUpTo100, UNIT_LABELS } from '../../../utils/math';
import type { TakeoffTotals } from './proposalGenerator';
import type { ProposalLine, ProposalLineInput, PaymentScheduleRow } from '../../../utils/store';

export const toCents = (dollars: number): number => Math.round(dollars * 100);

export const isOverridden = (l: Pick<ProposalLine, 'kind' | 'amountCents' | 'derivedAmountCents'>): boolean =>
  l.kind === 'takeoff' && l.derivedAmountCents !== null && l.amountCents !== l.derivedAmountCents;

const unitLabel = (t: TakeoffTotals) =>
  UNIT_LABELS[t.unit || ''] || t.unit || (t.type === 'area' ? 'sq ft' : t.type === 'length' ? 'ft' : 'ea');

export const measurementSummary = (t: TakeoffTotals): string =>
  `${t.totalRealValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unitLabel(t)}`;

export const derivedCents = (t: TakeoffTotals): number =>
  toCents(roundUpTo100(calculateTakeoffTotalCost(t, t.totalRealValue)));

export function lineFromTakeoff(t: TakeoffTotals): ProposalLineInput {
  const d = derivedCents(t);
  return { kind: 'takeoff', takeoffId: t.id, description: t.name, amountCents: d, derivedAmountCents: d, measurementSummary: measurementSummary(t), isAlternate: false };
}

export function rederiveLines(lines: ProposalLine[], totals: TakeoffTotals[]): { lines: ProposalLine[]; missingTakeoffIds: string[] } {
  const byId = new Map(totals.map(t => [t.id, t]));
  const missing: string[] = [];
  const out = lines.map(l => {
    if (l.kind !== 'takeoff' || !l.takeoffId) return l;
    const t = byId.get(l.takeoffId);
    if (!t) { missing.push(l.takeoffId); return l; }
    const d = derivedCents(t);
    const overridden = isOverridden(l);
    return { ...l, derivedAmountCents: d, measurementSummary: measurementSummary(t), amountCents: overridden ? l.amountCents : d };
  });
  return { lines: out, missingTakeoffIds: missing };
}

export function proposalTotals(lines: ProposalLine[]) {
  const base = lines.filter(l => !l.isAlternate);
  const alt = lines.filter(l => l.isAlternate);
  const sum = (xs: ProposalLine[]) => xs.reduce((s, l) => s + l.amountCents, 0);
  return {
    totalCents: sum(base), alternateCents: sum(alt),
    takeoffLines: base.filter(l => l.kind === 'takeoff'), manualLines: base.filter(l => l.kind === 'manual'),
    altTakeoff: alt.filter(l => l.kind === 'takeoff'), altManual: alt.filter(l => l.kind === 'manual'),
  };
}

export const scheduleAmountCents = (row: PaymentScheduleRow, totalCents: number): number =>
  row.percent != null ? Math.round(totalCents * row.percent / 100) : (row.amountCents ?? 0);
