// src/pages/project/proposal/proposalGenerator.layout.test.ts
// Layout contract for the snapshot renderer: which sections exist, what order
// they come in, and which page each one STARTS on. Placement is asserted
// through the generator's `sections` map (1-based page index per section) plus
// the final page count; `textByPage` below adds the drawn strings for the
// assertions (section dividers/bands, and ordering WITHIN a page) that a page
// index alone can't express.
//
// Two rules drive nearly every number here:
//   • the grand total leads on the cover, ahead of the itemised pricing;
//   • sections flow on from wherever the previous one ended, separated by an
//     inline divider — but a section is measured first, and one that would be
//     cut by a break takes the next page whole (plain band, no divider) rather
//     than straddling the two. Only a section taller than a sheet splits.
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { generateProposalPdf, proposalFileName } from './proposalGenerator';
import type { ProposalRenderInput } from './proposalGenerator';
import type { Proposal } from '../../../utils/store';
import type { Project } from '../../../types';

const project = { id: 'p', name: 'Dunmore Heights', createdAt: 0, pages: [], takeoffs: [], address: '1 Main St' } as unknown as Project;

const line = (o: Partial<Proposal['lines'][number]>) => ({
  id: 'l', sortOrder: 0, kind: 'manual', takeoffId: null, description: 'x',
  amountCents: 100, derivedAmountCents: null, measurementSummary: null, isAlternate: false, ...o,
}) as Proposal['lines'][number];

const base = (o: Partial<Proposal> = {}): Proposal => ({
  id: 'pr', projectId: 'p', number: 7, revisedFromId: null, revisedFromNumber: null, status: 'draft', legacy: false,
  title: null, validUntil: null, fontFamily: 'helvetica', coverNotes: '', terms: '', inclusions: [], exclusions: [], paymentSchedule: null,
  showGrandTotal: true, includeCostDetail: false, includeSignature: false, highlightQuality: 'best',
  fileId: null, signedFileId: null, sentAt: null, sentTo: null, acceptedAt: null, declinedAt: null,
  version: 1, createdBy: null, createdAt: 0, updatedAt: 0,
  totalCents: 0, alternateCount: 0, hasOverride: false, photoCount: 0, attachmentCount: 0,
  lines: [], photos: [], attachments: [], ...o,
});

const input = (proposal: Proposal, extra: Partial<ProposalRenderInput> = {}): ProposalRenderInput => ({
  proposal, project, takeoffTotals: [], currentPageIds: new Set(),
  letterhead: { brandRgb: [153, 203, 56], company: { name: 'Birchwood' } },
  photos: [], attachments: [], includeHighlights: false, ...extra,
});

// jsPDF writes uncompressed content streams and pdf-lib copies them verbatim
// into the merged file, so the drawn strings survive in the output bytes. The
// "Page N of M" stamp is written last on every body page, which makes it a
// reliable delimiter: everything before it belongs to that page.
const textByPage = (bytes: ArrayBuffer): Map<number, string[]> => {
  const raw = Buffer.from(bytes).toString('latin1');
  const texts = [...raw.matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)]
    .map(m => m[1].replace(/\\([()\\])/g, '$1'));
  const byPage = new Map<number, string[]>();
  let current: string[] = [];
  for (const t of texts) {
    const stamp = /^Page (\d+) of \d+$/.exec(t);
    if (stamp) { byPage.set(Number(stamp[1]), current); current = []; }
    else current.push(t);
  }
  return byPage;
};

const BAND = /^(Pricing|Payment Schedule|Inclusions & Exclusions|Notes|Alternates|Cost Detail|Terms & Conditions|Photos)( \(cont\.\))?$/;
/** The section band printed at the top of a given 1-based page, if any. */
const bandOnPage = (bytes: ArrayBuffer, page: number): string | undefined =>
  textByPage(bytes).get(page)?.find(t => BAND.test(t));

/** Inline dividers print the section title in upper case, so they are trivially
 *  distinguishable from the title-case band a page break draws. */
const dividerOnPage = (bytes: ArrayBuffer, page: number, title: string): boolean =>
  !!textByPage(bytes).get(page)?.includes(title.toUpperCase());

/** Index of a drawn string within a page, for asserting order on one sheet. */
const indexOnPage = (bytes: ArrayBuffer, page: number, text: string): number =>
  textByPage(bytes).get(page)?.indexOf(text) ?? -1;

const pages = async (bytes: ArrayBuffer) => (await PDFDocument.load(bytes)).getPageCount();
const makePdf = async (n: number) => {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) d.addPage();
  const b = await d.save();
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

// A 1x1 JPEG — jsPDF needs a real decodable image to embed.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

describe('proposal layout', () => {
  it('names the file from project + date, never the number', () => {
    expect(proposalFileName(project, new Date(2026, 7, 28, 12, 0, 0))).toBe('Proposal – Dunmore Heights – 2026-08-28');
  });

  it('a bare proposal is a single cover/pricing page', async () => {
    const { pdfBytes, suggestedName, sections } = await generateProposalPdf(input(base({ lines: [line({})] })));
    expect(await pages(pdfBytes)).toBe(1);
    expect(suggestedName).toMatch(/^Proposal – Dunmore Heights – \d{4}-\d{2}-\d{2}$/);
    expect(suggestedName).not.toContain('#7');
    expect(sections.grandTotal).toBe(1);
  });

  // The cover lays out address / "Prepared …" / the 84pt total box from
  // titleLines.length, so an unbounded title would walk the box down into the
  // footer (~11 wrapped lines clears pageBottom). The title is clamped to 3
  // lines so the geometry below it is genuinely fixed.
  it('clamps a runaway title to 3 lines and keeps the total box on page 1', async () => {
    const { pdfBytes, sections } = await generateProposalPdf(input(base({
      title: 'Comprehensive exterior envelope restoration '.repeat(13).slice(0, 600),
      lines: [line({})],
    })));

    expect(await pages(pdfBytes)).toBe(1);
    expect(sections.grandTotal).toBe(1);

    const page1 = textByPage(pdfBytes).get(1) ?? [];
    // The clamp truncated the third line. ASCII '...' rather than '…' —
    // jsPDF's standard-font encoding drops U+2026 outright.
    expect(page1.some(t => t.endsWith('...'))).toBe(true);
    // ...and the box still landed on the cover, below the title.
    expect(page1).toContain('TOTAL PROPOSAL VALUE');
    // Exactly 3 title lines: every drawn string before the total label that
    // came from the title itself.
    const totalAt = page1.indexOf('TOTAL PROPOSAL VALUE');
    const titleLines = page1.slice(0, totalAt).filter(t => t.includes('Comprehensive'));
    expect(titleLines).toHaveLength(3);
  });

  it('leads the cover with the grand total, ahead of the itemised pricing', async () => {
    const { pdfBytes, sections } = await generateProposalPdf(input(base({
      validUntil: '2026-12-31',
      lines: [
        line({ id: 'a', kind: 'takeoff', takeoffId: 't1', description: 'Stucco', measurementSummary: '100.00 sq ft', amountCents: 40000 }),
        line({ id: 'b', description: 'Mobilization', amountCents: 25000 }),
      ],
    })));
    expect(sections.grandTotal).toBe(1);

    // Cover order: prepared-on line → total box → validity → pricing tables.
    const at = (t: string) => indexOnPage(pdfBytes, 1, t);
    expect(at('TOTAL PROPOSAL VALUE')).toBeGreaterThan(-1);
    expect(at('TOTAL PROPOSAL VALUE')).toBeGreaterThan(at('Prepared ' + new Date().toLocaleDateString()));
    expect(at('$650.00')).toBe(at('TOTAL PROPOSAL VALUE') + 1);
    expect(at('This proposal is valid until 12/31/2026.')).toBeGreaterThan(at('$650.00'));
    expect(at('TAKEOFF PRICING')).toBeGreaterThan(at('This proposal is valid until 12/31/2026.'));
    expect(at('ADDITIONAL PRICING')).toBeGreaterThan(at('TAKEOFF PRICING'));
    // …and the pricing itself is introduced by its own inline divider.
    expect(at('PRICING')).toBeGreaterThan(at('$650.00'));
    expect(at('PRICING')).toBeLessThan(at('TAKEOFF PRICING'));
  });

  it('omits the grand total box when showGrandTotal is false', async () => {
    const { sections } = await generateProposalPdf(input(base({ lines: [line({})], showGrandTotal: false })));
    expect(sections.grandTotal).toBeUndefined();
  });

  it('alternates flow on under a divider, not onto a page of their own', async () => {
    const p = base({ lines: [line({ id: 'a' }), line({ id: 'b', isAlternate: true })] });
    const plain = await generateProposalPdf(input(p));
    expect(await pages(plain.pdfBytes)).toBe(1);
    expect(plain.sections.alternates).toBe(1);
    expect(dividerOnPage(plain.pdfBytes, 1, 'Alternates')).toBe(true);
    expect(bandOnPage(plain.pdfBytes, 1)).toBeUndefined(); // no forced break, so no band

    const withAtt = await generateProposalPdf(input(p, { attachments: [await makePdf(3), await makePdf(2)] }));
    expect(await pages(withAtt.pdfBytes)).toBe(6);
    expect(withAtt.sections.attachmentsStart).toBe(2);
  });

  it('skips an unreadable attachment instead of failing the whole render', async () => {
    const p = base({ lines: [line({})] });
    const junk = new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer;
    const { pdfBytes } = await generateProposalPdf(input(p, { attachments: [junk, await makePdf(2)] }));
    expect(await pages(pdfBytes)).toBe(3); // cover/pricing + the 2 readable pages
  });

  it('long notes flow onto extra pages after the grand total (grand total stays on page 1)', async () => {
    const notes = Array.from({ length: 400 }, (_, i) => `Note line ${i} lorem ipsum dolor sit amet`).join('\n');
    const p = base({ lines: [line({})], coverNotes: notes });
    const { pdfBytes, sections } = await generateProposalPdf(input(p));
    expect(await pages(pdfBytes)).toBeGreaterThan(2);
    // The total is the reader's headline: it must precede the notes, on page 1.
    expect(sections.grandTotal).toBe(1);
    expect(sections.notes).toBe(1);
  });

  it('a section pushed onto a fresh page by its opening divider is banded plainly, not "(cont.)"', async () => {
    // 60 price lines and 30 inclusions run well past one sheet, so several
    // sections do get pushed over. Wherever a section STARTS it must carry its
    // plain title band — only genuine continuations may say "(cont.)".
    const long = (inclusions: number) => base({
      lines: Array.from({ length: 60 }, (_, i) => line({ id: `l${i}`, description: `Item number ${i}` })),
      inclusions: Array.from({ length: inclusions }, (_, i) => `Inclusion ${i}`),
      exclusions: ['Paint'],
      coverNotes: 'Hello there.',
    });

    // 28 inclusions leave no room for the Notes divider, so Notes opens on a
    // fresh page — that page is where it STARTS and must be banded plainly.
    const a = await generateProposalPdf(input(long(28)));
    expect(a.sections.notes).toBeGreaterThan(a.sections.inclusions);
    expect(bandOnPage(a.pdfBytes, a.sections.notes)).toBe('Notes');
    // Pricing really did continue from the cover — that band stays a "(cont.)".
    expect(bandOnPage(a.pdfBytes, 2)).toBe('Pricing (cont.)');

    // 30 inclusions overrun their own section instead, so the next page is a
    // genuine continuation of Inclusions.
    const b = await generateProposalPdf(input(long(30)));
    expect(bandOnPage(b.pdfBytes, b.sections.inclusions + 1)).toBe('Inclusions & Exclusions (cont.)');
  });

  it('inclusions/exclusions sit between the pricing and the notes', async () => {
    const p = base({ lines: [line({})], inclusions: ['Stucco', 'Lath'], exclusions: ['Paint'], coverNotes: 'Hello.' });
    const { sections } = await generateProposalPdf(input(p));
    expect(sections.inclusions).toBe(1); // flows on from the pricing, same sheet
    expect(sections.inclusions).toBeLessThanOrEqual(sections.notes);
  });

  it('terms share the cover page; only the photo grid needs a second sheet', async () => {
    const p = base({ lines: [line({})], terms: 'Pay on time.' });
    const { pdfBytes, sections } = await generateProposalPdf(input(p, {
      photos: [{ dataUrl: JPEG, caption: 'North' }, { dataUrl: JPEG, caption: null }, { dataUrl: JPEG, caption: 'x' }],
    }));
    // Cover + pricing + terms all fit on one sheet; a photo row does not.
    expect(await pages(pdfBytes)).toBe(2);
    expect(sections.terms).toBe(1);
    expect(dividerOnPage(pdfBytes, 1, 'Terms & Conditions')).toBe(true);
    expect(sections.photos).toBe(2);
    expect(bandOnPage(pdfBytes, 2)).toBe('Photos');
  });

  it('alternates, terms and a small photo set stay within two sheets', async () => {
    const p = base({
      lines: [line({ id: 'a' }), line({ id: 'b', isAlternate: true })],
      terms: 'Net 30.',
    });
    const { pdfBytes, sections } = await generateProposalPdf(input(p, {
      photos: [{ dataUrl: JPEG, caption: 'North' }, { dataUrl: JPEG, caption: 'South' }],
    }));
    // Four sections that each used to claim a sheet now occupy two.
    expect(await pages(pdfBytes)).toBeLessThanOrEqual(2);
    // Alternates flows on under a divider on the pricing's own sheet…
    expect(sections.alternates).toBe(1);
    expect(dividerOnPage(pdfBytes, 1, 'Alternates')).toBe(true);
    // …and Photos shares the sheet Terms opens, again under a divider.
    expect(sections.photos).toBe(sections.terms);
    expect(dividerOnPage(pdfBytes, sections.photos, 'Photos')).toBe(true);
  });

  it('a signature-only proposal keeps the terms block on the cover page', async () => {
    const p = base({ lines: [line({})], terms: '', includeSignature: true });
    const { pdfBytes, sections } = await generateProposalPdf(input(p));
    expect(await pages(pdfBytes)).toBe(1);
    expect(sections.terms).toBe(1);
  });

  it('cost detail flows inline and only covers takeoff lines', async () => {
    const takeoff = {
      id: 't1', name: 'Stucco', color: '#000', type: 'area', unit: 'sq ft',
      costPerUnit: 4, totalRealValue: 100, pageBreakdown: [],
    } as unknown as ProposalRenderInput['takeoffTotals'][number];
    const p = base({
      includeCostDetail: true,
      lines: [line({ id: 'a', kind: 'takeoff', takeoffId: 't1', description: 'Stucco', measurementSummary: '100.00 sq ft' })],
    });
    const withDetail = await generateProposalPdf(input(p, { takeoffTotals: [takeoff] }));
    expect(withDetail.sections.costDetail).toBe(1);
    expect(dividerOnPage(withDetail.pdfBytes, 1, 'Cost Detail')).toBe(true);

    // Manual-only proposals have nothing to detail — no page.
    const manualOnly = await generateProposalPdf(input(base({ includeCostDetail: true, lines: [line({})] })));
    expect(manualOnly.sections.costDetail).toBeUndefined();
  });

  it('a payment schedule prints under the grand total, percent rows resolved against it', async () => {
    const p = base({
      lines: [line({ amountCents: 100000 })],
      paymentSchedule: [
        { description: 'Deposit', percent: 50, amountCents: null },
        { description: 'On completion', percent: null, amountCents: 50000 },
      ],
    });
    const { pdfBytes, sections } = await generateProposalPdf(input(p));
    expect(await pages(pdfBytes)).toBe(1);
    expect(sections.paymentSchedule).toBe(1);
    // The total is on the cover above; the schedule stays with the pricing that
    // breaks it down, under its own divider.
    expect(indexOnPage(pdfBytes, 1, 'PAYMENT SCHEDULE'))
      .toBeGreaterThan(indexOnPage(pdfBytes, 1, 'TOTAL PROPOSAL VALUE'));
    expect(indexOnPage(pdfBytes, 1, 'PAYMENT SCHEDULE'))
      .toBeGreaterThan(indexOnPage(pdfBytes, 1, 'ADDITIONAL PRICING'));
  });
  it('a section too long for one sheet still breaks with a "(cont.)" band', async () => {
    // Flowing inline is a default, not a promise to cram: content that genuinely
    // overruns still paginates, and the overflow pages say so.
    const terms = Array.from({ length: 120 }, (_, i) => `Clause ${i}: the contractor shall do the thing.`).join('\n');
    const p = base({ lines: [line({})], terms });
    const { pdfBytes, sections } = await generateProposalPdf(input(p));
    expect(await pages(pdfBytes)).toBeGreaterThan(2);
    expect(sections.terms).toBe(1);                     // starts inline on the cover
    expect(dividerOnPage(pdfBytes, 1, 'Terms & Conditions')).toBe(true);
    expect(bandOnPage(pdfBytes, 2)).toBe('Terms & Conditions (cont.)');
  });

  // ── Keep-together ──────────────────────────────────────────────────────────
  // A section is measured before it is drawn: one that would be cut by a page
  // break but fits a sheet on its own is moved whole to the next page, so the
  // reader never gets a heading here and its last line over the fold. The
  // fixtures below share one shape — three price lines, which land the cursor
  // near the foot of the cover — and vary ONLY the size of the terms section.
  const pricingThenTerms = (termLines: number) => base({
    lines: Array.from({ length: 3 }, (_, i) => line({ id: `l${i}`, description: `Item ${i}` })),
    terms: Array.from({ length: termLines }, (_, i) => `Term ${i}`).join('\n'),
  });

  it('moves a section that would be cut onto the next page, whole', async () => {
    // ~128pt of terms against ~80pt of room: it would have straddled the break.
    const { pdfBytes, sections } = await generateProposalPdf(input(pricingThenTerms(8)));

    expect(sections.terms).toBe(2);
    // The fresh page introduces it with its plain band…
    expect(bandOnPage(pdfBytes, 2)).toBe('Terms & Conditions');
    // …and page 1 was left alone: no inline divider opening a section it never
    // got to carry (a divider AND a band would introduce it twice).
    expect(dividerOnPage(pdfBytes, 1, 'Terms & Conditions')).toBe(false);
    // Whole means whole — nothing continued past the page it started on.
    expect(await pages(pdfBytes)).toBe(2);
    expect(bandOnPage(pdfBytes, 2)).not.toContain('cont.');
  });

  it('leaves a section that does fit exactly where it is', async () => {
    // Same cursor, a section small enough to sit under the divider: it stays.
    const { pdfBytes, sections } = await generateProposalPdf(input(pricingThenTerms(2)));
    expect(await pages(pdfBytes)).toBe(1);
    expect(sections.terms).toBe(1);
    expect(dividerOnPage(pdfBytes, 1, 'Terms & Conditions')).toBe(true);
    expect(bandOnPage(pdfBytes, 1)).toBeUndefined(); // never broke, so no band
  });

  it('starts an over-long section on a fresh page when only a scrap would fit here', async () => {
    // 120 clauses can't fit any sheet, so this one HAS to split — but with four
    // price lines the cover has room for barely a line of it. Opening there
    // would strand that line under the divider, so it opens on page 2 instead
    // and paginates from there.
    const terms = Array.from({ length: 120 }, (_, i) => `Clause ${i}: the contractor shall do the thing.`).join('\n');
    const p = base({
      lines: Array.from({ length: 4 }, (_, i) => line({ id: `l${i}`, description: `Item ${i}` })),
      terms,
    });
    const { pdfBytes, sections } = await generateProposalPdf(input(p));

    expect(sections.terms).toBe(2);
    expect(dividerOnPage(pdfBytes, 1, 'Terms & Conditions')).toBe(false);
    expect(bandOnPage(pdfBytes, 2)).toBe('Terms & Conditions');
    expect(bandOnPage(pdfBytes, 3)).toBe('Terms & Conditions (cont.)');
  });

  // The rule this whole mechanism exists to enforce, checked across a sweep
  // rather than at one hand-picked size: wherever a section opens inline, real
  // content follows it on that same sheet. A divider alone at the foot of a
  // page is precisely the "heading here, body overleaf" split being prevented,
  // and it is also what a mis-measured section would produce — ensure() breaks
  // on the RESERVE a row asks for, which can exceed what the row then draws.
  it('never strands an inline divider at the foot of a page', async () => {
    const DIVIDERS = /^(PRICING|PAYMENT SCHEDULE|INCLUSIONS & EXCLUSIONS|NOTES|ALTERNICKS|COST DETAIL|TERMS & CONDITIONS|PHOTOS)$/;
    const stranded: string[] = [];

    for (const priceLines of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const termLines of [0, 2, 5, 13]) {
        for (const inclusions of [0, 9]) {
          const { pdfBytes } = await generateProposalPdf(input(base({
            lines: Array.from({ length: priceLines }, (_, i) => line({ id: `l${i}`, description: `Item ${i}` })),
            terms: Array.from({ length: termLines }, (_, i) => `Term ${i}`).join('\n'),
            inclusions: Array.from({ length: inclusions }, (_, i) => `Inclusion ${i}`),
            exclusions: inclusions ? ['Paint'] : [],
          })));
          for (const [page, texts] of textByPage(pdfBytes)) {
            texts.forEach((t, i) => {
              if (DIVIDERS.test(t) && i === texts.length - 1) {
                stranded.push(`${priceLines}/${termLines}/${inclusions} p${page}: ${t}`);
              }
            });
          }
        }
      }
    }
    expect(stranded).toEqual([]);
  }, 30000);

  it('renders every section, in spec order, on non-decreasing pages', async () => {
    const takeoff = {
      id: 't1', name: 'Stucco', color: '#000', type: 'area', unit: 'sq ft',
      costPerUnit: 4, totalRealValue: 100, pageBreakdown: [],
    } as unknown as ProposalRenderInput['takeoffTotals'][number];
    const p = base({
      title: 'Full Job', validUntil: '2026-12-31', includeCostDetail: true, includeSignature: true,
      inclusions: ['Stucco', 'Lath'], exclusions: ['Paint', 'Permits'],
      coverNotes: 'Some context for the client.', terms: 'Net 30.',
      paymentSchedule: [{ description: 'Deposit', percent: 50, amountCents: null }],
      lines: [
        line({ id: 'a', kind: 'takeoff', takeoffId: 't1', description: 'Stucco', measurementSummary: '100.00 sq ft', amountCents: 40000 }),
        line({ id: 'b', description: 'Mobilization', amountCents: 25000 }),
        line({ id: 'c', kind: 'takeoff', takeoffId: 't1', description: 'Extra coat', isAlternate: true, amountCents: 5000 }),
        line({ id: 'd', description: 'Optional railing', isAlternate: true, amountCents: 1500 }),
      ],
    });
    const { sections } = await generateProposalPdf(input(p, {
      takeoffTotals: [takeoff],
      photos: [{ dataUrl: JPEG, caption: 'West wall' }],
      attachments: [await makePdf(1)],
    }));

    const order = ['grandTotal', 'paymentSchedule', 'inclusions', 'notes', 'alternates', 'costDetail', 'terms', 'photos', 'attachmentsStart'];
    const starts = order.map(k => sections[k]);
    expect(starts.filter(v => typeof v !== 'number')).toEqual([]); // every section rendered
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);     // and never out of order
  });
});
