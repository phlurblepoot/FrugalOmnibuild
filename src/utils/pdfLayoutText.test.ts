// layoutTextOf: the page's large text with where it sits and which way it is
// turned, read by pdf.js from a real PDF (made here with pdf-lib).
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { layoutTextOf } from './pdf';

// pdf.ts points pdf.js at Vite's URL for its worker; under vitest use the file.
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

async function onePagePdf(draw: (page: import('pdf-lib').PDFPage, font: import('pdf-lib').PDFFont) => void, rotate = 0) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([1000, 500]);
  if (rotate) page.setRotation(degrees(rotate));
  draw(page, font);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await doc.save()), useWorkerFetch: false, isEvalSupported: false }).promise;
  return pdf.getPage(1);
}

describe('layoutTextOf', () => {
  it('lists large text with its place and turn, biggest kept, small print dropped', async () => {
    const page = await onePagePdf((p, font) => {
      // A sheet number turned to read bottom-to-top, in a right-hand strip.
      p.drawText('A-201', { x: 960, y: 40, size: 30, font, rotate: degrees(90) });
      p.drawText('FRONT ELEVATION', { x: 100, y: 450, size: 18, font });
      for (let i = 0; i < 100; i++) p.drawText(`note ${i}`, { x: 100 + (i % 10) * 70, y: 50 + Math.floor(i / 10) * 30, size: 6, font });
    });
    const text = await layoutTextOf(page);
    const lines = text.split('\n');
    expect(lines).toHaveLength(80);
    expect(text).toContain('FRONT ELEVATION');
    const number = lines.find(l => l.endsWith('A-201'))!;
    expect(number).toMatch(/^\[x 96%, y 92%, turned 90°, size 30\] A-201$/);
    // Top to bottom: the elevation label (near the top) comes before the notes.
    expect(lines[0]).toMatch(/FRONT ELEVATION$/);
  });

  it('keeps two labels of the same size apart', async () => {
    const page = await onePagePdf((p, font) => {
      p.drawText('FRONT ELEVATION', { x: 50, y: 250, size: 20, font });
      p.drawText('LEFT ELEVATION', { x: 600, y: 250, size: 20, font });
    });
    const lines = (await layoutTextOf(page)).split('\n');
    expect(lines).toEqual([
      expect.stringMatching(/^\[x 5%, y 50%, size 20\] FRONT ELEVATION$/),
      expect.stringMatching(/^\[x 60%, y 50%, size 20\] LEFT ELEVATION$/),
    ]);
  });

  it('accounts for a page stored rotated', async () => {
    const page = await onePagePdf((p, font) => { p.drawText('S-101', { x: 50, y: 50, size: 24, font }); }, 90);
    expect(await layoutTextOf(page)).toMatch(/turned 270°, size 24\] S-101$/);
  });

  it('is empty for a page with no text', async () => {
    expect(await layoutTextOf(await onePagePdf(() => {}))).toBe('');
  });
});
