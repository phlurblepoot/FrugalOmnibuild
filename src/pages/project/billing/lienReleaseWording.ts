// src/pages/project/billing/lienReleaseWording.ts
//
// Every word of a Florida release of lien lives here, so the PDF
// (lienReleasePdf.ts) and the editor's live preview print the same thing, and
// a change in the law is a one-file change. Spec:
// docs/superpowers/specs/2026-10-15-florida-lien-release-design.md (§4, §5.5).
//
// The statutory sentences are the 2026 text of Fla. Stat. 713.20(4) (progress
// payment) and 713.20(5) (final payment), verbatim. Do not paraphrase them:
// lienRelease.test.ts pins them word for word. The conditional paragraphs and
// the optional exceptions paragraph are our own drafting (spec §4.3, §4.4),
// approved by the owner as written.
//
// Pure functions only: no DOM, no jsPDF, no Date in local time.

export type LienPaymentType = 'progress' | 'final';
export type LienConditionKind = 'check' | 'funds';
export type LienReleaseStatus = 'draft' | 'sent' | 'void';

export type LienEntityType = 'llc' | 'corporation' | 'partnership' | 'sole_proprietor' | 'other';

/** Settings and editor labels. */
export const LIEN_ENTITY_LABELS: Record<LienEntityType, string> = {
  llc: 'LLC', corporation: 'Corporation', partnership: 'Partnership', sole_proprietor: 'Sole proprietor', other: 'Other',
};

/** The words printed after "a <state>" in the notary sentence; 'other' has none, so it keeps the blank. */
const ENTITY_PHRASE: Record<LienEntityType, string> = {
  llc: 'limited liability company', corporation: 'corporation', partnership: 'partnership',
  sole_proprietor: 'sole proprietorship', other: '',
};

/** One lien release as the server stores and returns it (server/lienReleaseStore.ts). */
export interface LienRelease {
  id: string;
  projectId: string;
  /** Per-project counter, printed `LR-{number}`. */
  number: string | null;
  paymentType: LienPaymentType;
  conditional: boolean;
  sourceType: 'payapp' | 'invoice' | null;
  sourceId: string | null;
  supersedesId: string | null;
  lienorName: string;
  /** Printed in the notary sentence; null leaves the statute's blank. */
  lienorEntityType?: LienEntityType | null;
  lienorState?: string | null;
  customerName: string;
  ownerName: string;
  propertyDescription: string;
  amountCents: number;
  /** 'YYYY-MM-DD'; progress releases only. */
  throughDate: string | null;
  /** 'YYYY-MM-DD'. */
  releaseDate: string;
  signerName: string;
  signerTitle: string | null;
  conditionKind: LienConditionKind | null;
  checkNumber: string | null;
  checkMaker: string | null;
  checkBank: string | null;
  exceptions: string | null;
  signatureFileId: string | null;
  status: LienReleaseStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** A run of text; `fill` marks a value filled in from the record (underlined). */
export interface Seg { text: string; fill?: boolean; bold?: boolean }

export type ParaKind = 'body' | 'property' | 'retention' | 'condition' | 'check' | 'exceptions' | 'dated';
export interface Para { kind: ParaKind; segs: Seg[] }

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** '2026-10-15' -> 'October 15, 2026'. Built from the parts, never through a
 *  Date, so no time zone can move the day (see src/utils/billingDates.ts). */
export function formatLongDate(day: string | null | undefined): string {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!m) return day ?? '';
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : day ?? '';
}

/** 1234567 -> '12,345.67' (the `$` is part of the surrounding text). */
export function formatAmount(cents: number): string {
  const n = Math.round(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

// ── Statutory sentences (Fla. Stat. 713.20(4) and (5), 2026) ────────────────
export const PROGRESS_HEADING = 'UPON PROGRESS PAYMENT';
export const FINAL_HEADING = 'UPON FINAL PAYMENT';
export const RELEASE_TITLE = 'WAIVER AND RELEASE OF LIEN';
export const CONDITIONAL_RELEASE_TITLE = 'CONDITIONAL WAIVER AND RELEASE OF LIEN';

/** 713.20(4): the fixed closing sentence of the progress form. */
export const PROGRESS_RETENTION_SENTENCE =
  'This waiver and release does not cover any retention or labor, services, or materials furnished after the date specified.';

// ── Our own drafting (spec §4.3, §4.4) ──────────────────────────────────────
export const CONDITION_CHECK_TEXT =
  'CONDITION: This waiver and release is conditioned on payment of the check described below, as permitted by section 713.20(7), Florida Statutes. It takes effect only when that check has been paid by the bank on which it is drawn. If the check is not paid, this waiver and release is void.';
export const CONDITION_FUNDS_TEXT =
  "CONDITION: This waiver and release is conditioned on the undersigned's receipt of the sum stated above in good and collected funds. It takes effect only upon that receipt. If the payment is not received, or is returned, reversed or charged back, this waiver and release is void.";
export const EXCEPTIONS_LEAD = 'EXCEPTIONS: This waiver and release does not cover the following:';

const clean = (s: string | null | undefined): string => (s ?? '').trim();

/** The title lines: ['WAIVER AND RELEASE OF LIEN', 'UPON PROGRESS PAYMENT'], with CONDITIONAL in front when conditional. */
export function lienReleaseTitle(r: Pick<LienRelease, 'paymentType' | 'conditional'>): string[] {
  return [
    r.conditional ? CONDITIONAL_RELEASE_TITLE : RELEASE_TITLE,
    r.paymentType === 'final' ? FINAL_HEADING : PROGRESS_HEADING,
  ];
}

/** The body of the release, in print order, up to and including the DATED line. */
export function lienReleaseParagraphs(r: LienRelease): Para[] {
  const paras: Para[] = [];
  const amount = formatAmount(r.amountCents);

  if (r.paymentType === 'final') {
    paras.push({
      kind: 'body',
      segs: [
        { text: 'The undersigned lienor, in consideration of the final payment in the amount of $' },
        { text: amount, fill: true },
        { text: ', hereby waives and releases its lien and right to claim a lien for labor, services, or materials furnished to ' },
        { text: r.customerName, fill: true },
        { text: ' on the job of ' },
        { text: r.ownerName, fill: true },
        { text: ' to the following described property:' },
      ],
    });
    paras.push({ kind: 'property', segs: [{ text: r.propertyDescription, fill: true }] });
  } else {
    paras.push({
      kind: 'body',
      segs: [
        { text: 'The undersigned lienor, in consideration of the sum of $' },
        { text: amount, fill: true },
        { text: ', hereby waives and releases its lien and right to claim a lien for labor, services, or materials furnished through ' },
        { text: formatLongDate(r.throughDate), fill: true },
        { text: ' to ' },
        { text: r.customerName, fill: true },
        { text: ' on the job of ' },
        { text: r.ownerName, fill: true },
        { text: ' to the following property:' },
      ],
    });
    paras.push({ kind: 'property', segs: [{ text: r.propertyDescription, fill: true }] });
    paras.push({ kind: 'retention', segs: [{ text: PROGRESS_RETENTION_SENTENCE }] });
  }

  if (r.conditional) {
    if (r.conditionKind === 'check') {
      paras.push({ kind: 'condition', segs: [{ text: CONDITION_CHECK_TEXT, bold: true }] });
      const bank = clean(r.checkBank);
      paras.push({
        kind: 'check',
        segs: [
          { text: 'Check No. ' },
          { text: clean(r.checkNumber), fill: true },
          { text: ', drawn by ' },
          { text: clean(r.checkMaker), fill: true },
          ...(bank ? [{ text: ' on ' }, { text: bank, fill: true }] : []),
          { text: ', in the amount of $' },
          { text: amount, fill: true },
          { text: '.' },
        ],
      });
    } else {
      paras.push({ kind: 'condition', segs: [{ text: CONDITION_FUNDS_TEXT, bold: true }] });
    }
  }

  const exceptions = clean(r.exceptions);
  if (exceptions) {
    paras.push({
      kind: 'exceptions',
      segs: [{ text: EXCEPTIONS_LEAD }, { text: '\n' }, { text: exceptions, fill: true }],
    });
  }

  paras.push({
    kind: 'dated',
    segs: [{ text: 'DATED on ' }, { text: formatLongDate(r.releaseDate), fill: true }, { text: '.' }],
  });
  return paras;
}

/** The lines under the signature line: company, then "By:", then name and title. */
export function lienReleaseSignatureLines(r: LienRelease): { company: string; by: string; signer: string } {
  const title = clean(r.signerTitle);
  return {
    company: r.lienorName,
    by: 'By:',
    signer: title ? `${r.signerName}, ${title}` : r.signerName,
  };
}

// ── Notary acknowledgment (owner's T22 decision: printed on EVERY release) ───
//
// Florida's Statutory Short Form of Acknowledgment, Fla. Stat. 695.25 (2026),
// for a person signing on behalf of a company (forms (2) corporation and (3)
// limited liability company). The company's entity type and state come
// from the release (copied from Settings); a value that is empty keeps the
// statute's blank for the notary to complete. The signer's name and title and the company name are filled in;
// the notary's fields (state, county, date, identification, signature, name,
// title or rank, serial number) stay blank. The statute's check boxes are the
// ballot-box character; helvetica has no glyph for it, so lienReleasePdf.ts
// draws it as "[  ]".
export const NOTARY_BOX = '☐';
export const NOTARY_BLANK = '______________________';

export interface NotaryBlock {
  /** "STATE OF ____" and "COUNTY OF ____". */
  venue: string[];
  /** The acknowledgment sentence(s), with the filled-in values marked. */
  text: Seg[];
  /** Captions under the notary's blank signature lines, in order. */
  captions: string[];
}

export function lienReleaseNotary(
  r: Pick<LienRelease, 'signerName' | 'signerTitle' | 'lienorName'> & Partial<Pick<LienRelease, 'lienorEntityType' | 'lienorState'>>,
): NotaryBlock {
  const title = clean(r.signerTitle);
  const state = clean(r.lienorState);
  const entity = r.lienorEntityType ? ENTITY_PHRASE[r.lienorEntityType] ?? '' : '';
  return {
    venue: [`STATE OF ${NOTARY_BLANK}`, `COUNTY OF ${NOTARY_BLANK}`],
    text: [
      { text: `The foregoing instrument was acknowledged before me by means of ${NOTARY_BOX} physical presence or ${NOTARY_BOX} online notarization, this ${NOTARY_BLANK} (date) by ` },
      { text: title ? `${r.signerName}, ${title}` : r.signerName, fill: true },
      { text: ', of ' },
      { text: r.lienorName, fill: true },
      { text: ', a ' },
      state ? { text: state, fill: true } : { text: `${NOTARY_BLANK} (state or place of formation)` },
      { text: ' ' },
      entity ? { text: entity, fill: true } : { text: `${NOTARY_BLANK} (corporation or limited liability company)` },
      { text: `, on behalf of the company, who is personally known to me or has produced ${NOTARY_BLANK} (type of identification) as identification.` },
    ],
    captions: [
      '(Signature of person taking acknowledgment)',
      '(Name typed, printed or stamped)',
      '(Title or rank)',
      '(Serial number, if any)',
    ],
  };
}

/** Plain text of a run list, for tests and the editor preview. */
export const segsText = (segs: Seg[]): string => segs.map(s => s.text).join('');

// ── Names and labels ─────────────────────────────────────────────────────────
export function lienReleaseFileName(r: Pick<LienRelease, 'number' | 'paymentType' | 'conditional'>): string {
  const n = clean(r.number) || 'release';
  return `LR-${n} ${r.conditional ? 'Conditional' : 'Unconditional'} ${r.paymentType === 'final' ? 'Final' : 'Progress'} Release.pdf`;
}

/** The grey reference line under the letterhead: "Release LR-3 · Job · Pay App #2". */
export function lienReleaseReference(r: Pick<LienRelease, 'number'>, projectName: string, sourceLabel?: string | null): string {
  return ['Release LR-' + (clean(r.number) || '?'), projectName, sourceLabel].filter(Boolean).join(' · ');
}

/** Default subject and body for the send composer (mirrors the server's send route). */
export function lienReleaseEmailDefaults(
  r: Pick<LienRelease, 'paymentType' | 'conditional'>,
  projectName: string,
): { subject: string; body: string } {
  const cond = r.conditional ? 'Conditional ' : '';
  const type = r.paymentType === 'final' ? 'Final' : 'Progress';
  return {
    subject: `${cond}Waiver and Release of Lien upon ${type} Payment — ${projectName}`,
    body: `Please find attached our ${r.conditional ? 'conditional ' : ''}waiver and release of lien for ${projectName}.`,
  };
}
