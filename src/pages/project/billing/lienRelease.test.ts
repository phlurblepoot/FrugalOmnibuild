import { describe, it, expect } from 'vitest';
import {
  type LienRelease, lienReleaseTitle, lienReleaseParagraphs, lienReleaseNotary, lienReleaseSignatureLines,
  lienReleaseFileName, lienReleaseReference, lienReleaseEmailDefaults, formatLongDate, formatAmount, segsText,
  CONDITION_CHECK_TEXT, CONDITION_FUNDS_TEXT, NOTARY_BOX,
} from './lienReleaseWording';
import { buildLienReleasePdf } from './lienReleasePdf';
import { useTimeZone } from '../../../test/timeZone';

const release = (over: Partial<LienRelease> = {}): LienRelease => ({
  id: 'lr1', projectId: 'p1', number: '3', paymentType: 'progress', conditional: false,
  sourceType: null, sourceId: null, supersedesId: null,
  lienorName: 'Birchwood Plaster LLC', lienorEntityType: null, lienorState: null, customerName: 'Acme Builders', ownerName: 'Jane Owner',
  propertyDescription: 'Lot 4, 12 Palm Way\nTampa, FL 33601', amountCents: 1234567,
  throughDate: '2026-09-30', releaseDate: '2026-10-15', signerName: 'Noah Smith', signerTitle: 'Owner',
  conditionKind: null, checkNumber: null, checkMaker: null, checkBank: null, exceptions: null,
  signatureFileId: null, status: 'draft', version: 1, createdAt: 0, updatedAt: 0,
  ...over,
});

const bodyText = (r: LienRelease) => lienReleaseParagraphs(r).map(p => segsText(p.segs));

describe('statutory wording, Fla. Stat. 713.20 (spec §4.1, §4.2)', () => {
  it('prints the progress payment form word for word', () => {
    expect(lienReleaseTitle(release())).toEqual(['WAIVER AND RELEASE OF LIEN', 'UPON PROGRESS PAYMENT']);
    expect(bodyText(release())).toEqual([
      'The undersigned lienor, in consideration of the sum of $12,345.67, hereby waives and releases its lien and right to claim a lien for labor, services, or materials furnished through September 30, 2026 to Acme Builders on the job of Jane Owner to the following property:',
      'Lot 4, 12 Palm Way\nTampa, FL 33601',
      'This waiver and release does not cover any retention or labor, services, or materials furnished after the date specified.',
      'DATED on October 15, 2026.',
    ]);
  });

  it('prints the final payment form word for word, with no through date and no retention sentence', () => {
    const r = release({ paymentType: 'final', throughDate: null });
    expect(lienReleaseTitle(r)).toEqual(['WAIVER AND RELEASE OF LIEN', 'UPON FINAL PAYMENT']);
    expect(bodyText(r)).toEqual([
      'The undersigned lienor, in consideration of the final payment in the amount of $12,345.67, hereby waives and releases its lien and right to claim a lien for labor, services, or materials furnished to Acme Builders on the job of Jane Owner to the following described property:',
      'Lot 4, 12 Palm Way\nTampa, FL 33601',
      'DATED on October 15, 2026.',
    ]);
  });

  it('marks the filled-in values (underlined in the PDF) and nothing else', () => {
    const fills = lienReleaseParagraphs(release()).flatMap(p => p.segs.filter(s => s.fill).map(s => s.text));
    expect(fills).toEqual(['12,345.67', 'September 30, 2026', 'Acme Builders', 'Jane Owner', 'Lot 4, 12 Palm Way\nTampa, FL 33601', 'October 15, 2026']);
  });
});

describe('conditional versions (spec §4.3)', () => {
  it('puts CONDITIONAL in the title and the funds condition before the DATED line', () => {
    const r = release({ conditional: true, conditionKind: 'funds' });
    expect(lienReleaseTitle(r)[0]).toBe('CONDITIONAL WAIVER AND RELEASE OF LIEN');
    const paras = lienReleaseParagraphs(r);
    expect(paras.map(p => p.kind)).toEqual(['body', 'property', 'retention', 'condition', 'dated']);
    expect(segsText(paras[3].segs)).toBe(
      "CONDITION: This waiver and release is conditioned on the undersigned's receipt of the sum stated above in good and collected funds. It takes effect only upon that receipt. If the payment is not received, or is returned, reversed or charged back, this waiver and release is void.");
    expect(paras[3].segs.every(s => s.bold)).toBe(true);
    expect(CONDITION_FUNDS_TEXT).toBe(segsText(paras[3].segs));
  });

  it('names 713.20(7) and the check for a check condition, and drops "on {bank}" when blank', () => {
    const r = release({ conditional: true, conditionKind: 'check', checkNumber: '1042', checkMaker: 'Acme Builders', checkBank: 'First Bank' });
    const [, , , condition, check] = bodyText(r);
    expect(condition).toBe(
      'CONDITION: This waiver and release is conditioned on payment of the check described below, as permitted by section 713.20(7), Florida Statutes. It takes effect only when that check has been paid by the bank on which it is drawn. If the check is not paid, this waiver and release is void.');
    expect(condition).toBe(CONDITION_CHECK_TEXT);
    expect(check).toBe('Check No. 1042, drawn by Acme Builders on First Bank, in the amount of $12,345.67.');
    expect(bodyText({ ...r, checkBank: '  ' })[4]).toBe('Check No. 1042, drawn by Acme Builders, in the amount of $12,345.67.');
  });

  it('an unconditional release carries no condition even if stale condition fields are present', () => {
    const r = release({ conditional: false, conditionKind: 'check', checkNumber: '1' });
    expect(lienReleaseParagraphs(r).map(p => p.kind)).toEqual(['body', 'property', 'retention', 'dated']);
  });
});

describe('optional exceptions (spec §4.4)', () => {
  it('prints the exceptions before the DATED line only when there are some', () => {
    expect(lienReleaseParagraphs(release({ exceptions: '   ' })).some(p => p.kind === 'exceptions')).toBe(false);
    const paras = lienReleaseParagraphs(release({ exceptions: 'Unpaid CO 4', conditional: true, conditionKind: 'funds' }));
    expect(paras.map(p => p.kind)).toEqual(['body', 'property', 'retention', 'condition', 'exceptions', 'dated']);
    expect(segsText(paras[4].segs)).toBe('EXCEPTIONS: This waiver and release does not cover the following:\nUnpaid CO 4');
  });
});

describe('notary acknowledgment, Fla. Stat. 695.25 (owner decision: every release)', () => {
  it('fills the signer, title and company and leaves the notary fields blank', () => {
    const n = lienReleaseNotary(release());
    expect(n.venue).toEqual(['STATE OF ______________________', 'COUNTY OF ______________________']);
    const text = segsText(n.text);
    expect(text).toContain(`The foregoing instrument was acknowledged before me by means of ${NOTARY_BOX} physical presence or ${NOTARY_BOX} online notarization, this ______________________ (date) by Noah Smith, Owner, of Birchwood Plaster LLC, a ______________________ (state or place of formation)`);
    expect(text).toContain('(corporation or limited liability company), on behalf of the company, who is personally known to me or has produced ______________________ (type of identification) as identification.');
    expect(n.text.filter(s => s.fill).map(s => s.text)).toEqual(['Noah Smith, Owner', 'Birchwood Plaster LLC']);
    expect(n.captions).toEqual([
      '(Signature of person taking acknowledgment)', '(Name typed, printed or stamped)', '(Title or rank)', '(Serial number, if any)',
    ]);
  });

  it('prints "a <state> <entity type>" from the release, and keeps a blank only for an empty value', () => {
    const full = lienReleaseNotary(release({ lienorEntityType: 'llc', lienorState: 'Florida' }));
    expect(segsText(full.text)).toContain('of Birchwood Plaster LLC, a Florida limited liability company, on behalf of the company');
    expect(full.text.filter(s => s.fill).map(s => s.text)).toEqual(['Noah Smith, Owner', 'Birchwood Plaster LLC', 'Florida', 'limited liability company']);
    expect(segsText(lienReleaseNotary(release({ lienorEntityType: 'sole_proprietor', lienorState: 'Georgia' })).text)).toContain('a Georgia sole proprietorship, on');
    const noState = segsText(lienReleaseNotary(release({ lienorEntityType: 'corporation' })).text);
    expect(noState).toContain('a ______________________ (state or place of formation) corporation, on behalf');
    const noEntity = segsText(lienReleaseNotary(release({ lienorState: 'Florida' })).text);
    expect(noEntity).toContain('a Florida ______________________ (corporation or limited liability company), on behalf');
    expect(segsText(lienReleaseNotary(release({ lienorEntityType: 'other', lienorState: 'Florida' })).text)).toContain('(corporation or limited liability company)');
  });

  it('leaves the title out when the signer has none', () => {
    expect(segsText(lienReleaseNotary(release({ signerTitle: null })).text)).toContain('(date) by Noah Smith, of Birchwood');
  });
});

describe('formats and names', () => {
  it('formats amounts and long dates without a Date object', () => {
    expect(formatAmount(1234567)).toBe('12,345.67');
    expect(formatAmount(5)).toBe('0.05');
    expect(formatAmount(100000000)).toBe('1,000,000.00');
    expect(formatLongDate('2026-10-05')).toBe('October 5, 2026');
    expect(formatLongDate('2026-12-31')).toBe('December 31, 2026');
    expect(formatLongDate(null)).toBe('');
  });
  it('names the file, the reference line, the signer line and the email', () => {
    expect(lienReleaseFileName(release({ conditional: true }))).toBe('LR-3 Conditional Progress Release.pdf');
    expect(lienReleaseFileName(release({ paymentType: 'final' }))).toBe('LR-3 Unconditional Final Release.pdf');
    expect(lienReleaseReference(release(), 'Palm Way', 'Pay App #2')).toBe('Release LR-3 · Palm Way · Pay App #2');
    expect(lienReleaseReference(release(), 'Palm Way')).toBe('Release LR-3 · Palm Way');
    expect(lienReleaseSignatureLines(release())).toEqual({ company: 'Birchwood Plaster LLC', by: 'By:', signer: 'Noah Smith, Owner' });
    expect(lienReleaseEmailDefaults({ paymentType: 'final', conditional: true }, 'Job')).toEqual({
      subject: 'Conditional Waiver and Release of Lien upon Final Payment — Job',
      body: 'Please find attached our conditional waiver and release of lien for Job.',
    });
  });
});

// The strings jsPDF drew (its content streams are uncompressed).
const pdfText = (bytes: Uint8Array): string[] =>
  [...Buffer.from(bytes).toString('latin1').matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)].map(m => m[1].replace(/\\([()\\])/g, '$1'));
const pageCount = (bytes: Uint8Array): number =>
  (Buffer.from(bytes).toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;

const letterhead = { brandRgb: [153, 203, 56] as [number, number, number], company: { name: 'Birchwood Plaster' } };
const build = (over: Partial<LienRelease> = {}, extra: Record<string, unknown> = {}) =>
  buildLienReleasePdf({ release: release(over), projectName: 'Palm Way Stucco', letterhead, ...extra });

describe('buildLienReleasePdf', () => {
  it('draws a PDF with the title, the filled-in values, the signature block and the notary block', () => {
    const bytes = build();
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
    const text = pdfText(bytes);
    expect(text.join(' ')).not.toContain('Release LR-3');
    expect(text).toContain('WAIVER AND RELEASE OF LIEN');
    expect(text).toContain('UPON PROGRESS PAYMENT');
    expect(text).toContain('12,345.67');
    expect(text.join(' ')).toContain('September 30, 2026');
    expect(text.join(' ')).toContain('Jane Owner');
    expect(text.join(' ')).toContain('Lot 4, 12 Palm Way');
    expect(text.join(' ')).toContain('Tampa, FL 33601');
    expect(text.join(' ')).toContain('Birchwood Plaster LLC');
    expect(text).toContain('By:');
    expect(text.join(' ')).toContain('Noah Smith, Owner');
    expect(text.join(' ')).toContain('STATE OF ______________________');
    expect(text.join(' ')).toContain('acknowledged before me by means of [\u00a0\u00a0] physical presence');
    expect(text).toContain('(Signature of person taking acknowledgment)');
    expect(text).toContain('(Serial number, if any)');
  });

  it('prints the notary block on every variant, and the CONDITIONAL title on conditional ones', () => {
    for (const paymentType of ['progress', 'final'] as const) {
      for (const conditional of [false, true]) {
        const text = pdfText(build({ paymentType, conditional, conditionKind: conditional ? 'funds' : null, throughDate: paymentType === 'final' ? null : '2026-09-30' })).join(' ');
        expect(text).toContain('online notarization');
        expect(text).toContain(paymentType === 'final' ? 'UPON FINAL PAYMENT' : 'UPON PROGRESS PAYMENT');
        expect(text.includes('CONDITIONAL WAIVER AND RELEASE OF LIEN')).toBe(conditional);
        expect(text.includes('CONDITION:')).toBe(conditional);
        expect(text.includes('does not cover any retention')).toBe(paymentType === 'progress');
      }
    }
  });

  it('prints the check condition and the exceptions paragraph', () => {
    const text = pdfText(build({ conditional: true, conditionKind: 'check', checkNumber: '1042', checkMaker: 'Acme Builders', checkBank: 'First Bank', exceptions: 'Unpaid CO 4' })).join(' ');
    expect(text).toContain('section 713.20(7), Florida Statutes');
    expect(text).toContain('1042');
    expect(text).toContain('First Bank');
    expect(text).toContain('EXCEPTIONS:');
    expect(text).toContain('Unpaid CO 4');
  });

  it('puts the header email override on the letterhead and no reference line under it', () => {
    const text = pdfText(build({}, { sourceLabel: 'Pay App #2', headerEmail: 'billing@example.com' }));
    expect(text).toContain('billing@example.com');
    expect(text.join(' ')).not.toContain('Release LR-3');
  });

  it('fits every variant, notary block included, on one page with typical content', () => {
    const lh = { brandRgb: [153, 203, 56] as [number, number, number], company: { name: 'Birchwood Plaster', address: '100 Main St, Tampa, FL 33601', phone: '813-555-0100', email: 'office@birchwood.example', website: 'birchwood.example' } };
    for (const paymentType of ['progress', 'final'] as const) {
      for (const conditional of [false, true]) {
        for (const conditionKind of conditional ? ['funds', 'check'] as const : [null]) {
          const bytes = buildLienReleasePdf({ release: release({ paymentType, conditional, conditionKind, throughDate: paymentType === 'final' ? null : '2026-09-30', checkNumber: '1042', checkMaker: 'Acme Builders', checkBank: 'First Bank', exceptions: conditional ? 'Unpaid CO 4' : null, lienorEntityType: 'llc', lienorState: 'Florida' }), projectName: 'Palm Way Stucco', letterhead: lh });
          expect(pageCount(bytes), `${paymentType} conditional=${conditional} ${conditionKind}`).toBe(1);
        }
      }
    }
  });

  it('continues on a second page, letterhead repeated, when the property description is long', () => {
    expect(pageCount(build())).toBeGreaterThanOrEqual(1);
    const long = Array.from({ length: 40 }, (_, i) => `Parcel ${i + 1}: lot ${i + 1}, block B`).join('\n');
    const bytes = build({ propertyDescription: long, conditional: true, conditionKind: 'funds', exceptions: 'Unpaid CO 4' });
    expect(pageCount(bytes)).toBeGreaterThanOrEqual(2);
    // The notary block is never split from its heading: it lands whole on the last page.
    const text = pdfText(bytes);
    expect(text.filter(t => t === 'Birchwood Plaster').length).toBe(pageCount(bytes)); // letterhead on each page
    expect(text.join(' ')).toContain('Parcel 40: lot 40, block B');
    expect(text).toContain('(Title or rank)');
  });

  it('does not throw on a bad signature image: the line stays blank', () => {
    expect(() => build({ signatureFileId: 'sig' }, { signatureDataUrl: 'data:image/png;base64,AAAA' })).not.toThrow();
  });
});

describe('buildLienReleasePdf, dates west of UTC', () => {
  useTimeZone('America/Los_Angeles');

  it('prints the days that were picked, not the day before', () => {
    const text = pdfText(build({ throughDate: '2026-10-01', releaseDate: '2026-10-02' }));
    expect(text.join(' ')).toContain('October 1, 2026');
    expect(text.join(' ')).toContain('October 2, 2026');
  });
});
