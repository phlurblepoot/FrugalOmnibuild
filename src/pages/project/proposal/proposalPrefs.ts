// src/pages/project/proposal/proposalPrefs.ts
// Per-user proposal memory: which server user-preference keys hold it, and the
// pure parse/push helpers around the manual-line library. Everything here is
// side-effect free — the editor does the getUserPreferences/saveUserPreferences
// round-trip itself.
import type { ProposalSaveInput } from '../../../utils/store';
import { normalizeHighlightQuality } from './proposalGenerator';
import { parseHistory } from './proposalTextHistory';

export const PREF_KEYS = {
  notes: 'proposal-coverNotes-history',
  terms: 'proposal-terms-history',
  inclusions: 'proposal-inclusions-history',
  exclusions: 'proposal-exclusions-history',
  lines: 'proposal-manualLine-history',
  font: 'proposal-fontFamily',
  quality: 'proposal-highlightQuality',
  costDetail: 'proposal-includeCostDetail',
  signature: 'proposal-includeSignature',
  grandTotal: 'proposal-showGrandTotal',
} as const;

// One remembered manual line. Amounts stay in integer cents, like every other
// money value in the proposal pipeline.
export interface ManualLineMemory { description: string; amountCents: number }

// The manual-line library is longer than the free-text histories (5): an
// estimator re-uses far more distinct add-on lines than cover-note blocks.
export const LINE_LIBRARY_MAX = 10;

// Parse a prefs JSON value into a safe ManualLineMemory[]. Bad JSON, a
// non-array result, and malformed entries all degrade to [] / are filtered
// out rather than throwing.
export function parseLineLibrary(raw: string | undefined): ManualLineMemory[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is ManualLineMemory =>
        !!x && typeof x === 'object' &&
        typeof (x as ManualLineMemory).description === 'string' &&
        typeof (x as ManualLineMemory).amountCents === 'number' &&
        Number.isFinite((x as ManualLineMemory).amountCents))
      .map(x => ({ description: x.description.trim(), amountCents: Math.round(x.amountCents) }))
      .filter(x => !!x.description);
  } catch {
    return [];
  }
}

// Push `entry` onto the library (newest first), deduped by description
// case-insensitively so "Scaffolding" typed with a different capitalisation
// updates the remembered price instead of piling up a near-duplicate. Returns
// `lib` unchanged (same reference) when there is nothing to record — an empty
// description, or an identical entry already at the front — so the caller can
// skip the preference write with a reference check.
export function pushLineLibrary(lib: ManualLineMemory[], entry: ManualLineMemory): ManualLineMemory[] {
  const description = entry.description.trim();
  if (!description) return lib;
  const amountCents = Math.round(entry.amountCents);
  const front = lib[0];
  if (front && front.description.toLowerCase() === description.toLowerCase() && front.amountCents === amountCents) return lib;
  const key = description.toLowerCase();
  const deduped = lib.filter(m => m.description.toLowerCase() !== key);
  return [{ description, amountCents }, ...deduped].slice(0, LINE_LIBRARY_MAX);
}

const bool = (raw: string | undefined): boolean | undefined =>
  raw === 'true' ? true : raw === 'false' ? false : undefined;

// Option defaults for a NEW proposal, taken from whatever this user last
// saved. Keys the user has never touched are left out entirely so the server's
// own column defaults win instead of being overwritten with guesses.
export function optionDefaultsFromPrefs(prefs: Record<string, string>): Partial<ProposalSaveInput> {
  const out: Partial<ProposalSaveInput> = {};
  const font = prefs[PREF_KEYS.font];
  if (font === 'helvetica' || font === 'times' || font === 'courier') out.fontFamily = font;
  if (prefs[PREF_KEYS.quality] != null) out.highlightQuality = normalizeHighlightQuality(prefs[PREF_KEYS.quality]);
  const costDetail = bool(prefs[PREF_KEYS.costDetail]);
  if (costDetail !== undefined) out.includeCostDetail = costDetail;
  const signature = bool(prefs[PREF_KEYS.signature]);
  if (signature !== undefined) out.includeSignature = signature;
  const grandTotal = bool(prefs[PREF_KEYS.grandTotal]);
  if (grandTotal !== undefined) out.showGrandTotal = grandTotal;
  // The most recent cover notes / terms this user wrote seed the new proposal
  // too — the same "don't retype the boilerplate" promise the option defaults
  // make, and what the retired single-proposal page did. Only the newest entry
  // is used; the rest of the history stays available from the editor's
  // history menu.
  const notes = parseHistory(prefs[PREF_KEYS.notes])[0];
  if (notes) out.coverNotes = notes;
  const terms = parseHistory(prefs[PREF_KEYS.terms])[0];
  if (terms) out.terms = terms;
  return out;
}
