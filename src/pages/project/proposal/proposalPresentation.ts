// src/pages/project/proposal/proposalPresentation.ts
// Pure presentation helpers for the proposals list. Kept free of React so the
// number/expiry rules can be characterised by plain unit tests.
import type { PillTone } from '../../../components/ui';
import type { ProposalStatus, ProposalSummary } from '../../../utils/store';

// Proposal numbers are INTERNAL (spec §2): they label rows in the app, never
// the generated PDF. A revision carries its parent's number so the lineage of
// "#3 (rev. of #1)" reads at a glance.
export const proposalLabel = (p: Pick<ProposalSummary, 'number' | 'revisedFromNumber'>): string =>
  p.revisedFromNumber ? `#${p.number} (rev. of #${p.revisedFromNumber})` : `#${p.number}`;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/**
 * Human countdown for a sent proposal's `validUntil`, or null when there is
 * nothing to say: a draft has not been offered yet, and an accepted/declined
 * one is settled — its expiry stopped mattering the moment it was answered.
 *
 * `validUntil` is a bare YYYY-MM-DD, so it is parsed at LOCAL midnight and
 * compared against the local start of `today`: whole calendar days apart, not
 * elapsed hours, and rounding absorbs the 23/25-hour DST days in between.
 */
export const expiryText = (
  p: Pick<ProposalSummary, 'status' | 'validUntil'>,
  today: Date = new Date(),
): string | null => {
  if (p.status !== 'sent' || !p.validUntil) return null;
  const due = Date.parse(`${p.validUntil}T00:00:00`);
  if (Number.isNaN(due)) return null;
  const delta = Math.round((due - startOfDay(today)) / 86_400_000);
  if (delta === 0) return 'expires today';
  return delta > 0 ? `expires in ${days(delta)}` : `expired ${days(-delta)} ago`;
};

export const STATUS_TONE: Record<ProposalStatus, PillTone> = {
  draft: 'slate',
  sent: 'blue',
  accepted: 'emerald',
  declined: 'red',
};
