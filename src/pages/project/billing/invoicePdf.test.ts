import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { invoiceRows, invoiceTotalsBlock, buildInvoicePdf } from './invoicePdf';
import { useTimeZone } from '../../../test/timeZone';

describe('invoice pdf data shaping', () => {
  it('invoiceRows maps lines to [desc, qty, unit, amount] display strings', () => {
    const rows = invoiceRows([{ description: 'Drywall', qty: 2, unitPrice: 50 } as any]);
    expect(rows[0]).toEqual(['Drywall', '2', '$50.00', '$100.00']);
  });
  it('invoiceTotalsBlock formats total/paid/balance from cents', () => {
    expect(invoiceTotalsBlock(12550, 5000)).toEqual([
      ['Total', '$125.50'], ['Paid', '$50.00'], ['Balance Due', '$75.50'],
    ]);
  });
});

// A 1x1 JPEG — jsPDF needs a real decodable image to embed.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const baseInvoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv1', projectId: 'p1', number: 'INV-1', date: null, status: 'draft', terms: null, notes: null,
  version: 1, createdAt: 0, updatedAt: 0, lines: [], payments: [], photos: [], attachments: [],
  totalCents: 0, paidCents: 0, balanceCents: 0, ...overrides,
}) as any;

const letterhead = { brandRgb: [153, 203, 56] as [number, number, number], company: { name: 'Birchwood' } };

describe('buildInvoicePdf — photo pages', () => {
  it('appends no extra page when there are no photos', async () => {
    const bytes = buildInvoicePdf({ invoice: baseInvoice(), projectName: 'Job', letterhead });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it('appends a photos page (page count grows) when photoDataUrls is non-empty', async () => {
    const withoutPhotos = await PDFDocument.load(buildInvoicePdf({ invoice: baseInvoice(), projectName: 'Job', letterhead }));
    const withPhotos = await PDFDocument.load(
      buildInvoicePdf({ invoice: baseInvoice(), projectName: 'Job', letterhead, photoDataUrls: [JPEG, JPEG, JPEG] }),
    );
    expect(withPhotos.getPageCount()).toBeGreaterThan(withoutPhotos.getPageCount());
  });
});

// The strings jsPDF drew (its content streams are uncompressed).
const pdfText = (bytes: Uint8Array): string[] =>
  [...Buffer.from(bytes).toString('latin1').matchAll(/\(((?:\\.|[^()\\])*)\)\s*Tj/g)].map(m => m[1]);

describe('buildInvoicePdf — date, west of UTC', () => {
  useTimeZone('America/Los_Angeles');

  it('prints the day that was picked, not the day before', () => {
    const bytes = buildInvoicePdf({ invoice: baseInvoice({ date: new Date('2026-10-01').getTime() }), projectName: 'Job', letterhead });
    expect(pdfText(bytes)).toContain(`Date: ${new Date(2026, 9, 1).toLocaleDateString()}`);
  });
});
