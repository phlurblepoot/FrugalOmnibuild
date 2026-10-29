// src/utils/pdfPhotos.test.ts
import { describe, it, expect, vi } from 'vitest';
import { jsPDF } from 'jspdf';
import { layoutPhotoRows, drawPhotoGrid, loadPdfPhoto, PHOTO_GAP } from './pdfPhotos';

// A 1x1 JPEG — jsPDF needs a real decodable image to embed or measure.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const landscape = { dataUrl: JPEG, width: 4000, height: 3000 };
const portrait = { dataUrl: JPEG, width: 3000, height: 4000 };

describe('layoutPhotoRows', () => {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const width = 532; // two 260pt columns and the gap
  const cellW = (width - PHOTO_GAP) / 2;

  it('keeps each photo at its own shape instead of stretching it', () => {
    const [row] = layoutPhotoRows(doc, [landscape, portrait], 40, width);
    const [l, p] = row.cells;
    expect(l.w / l.h).toBeCloseTo(4 / 3);
    expect(p.w / p.h).toBeCloseTo(3 / 4);
    // A landscape photo fills its column; a portrait one is as tall as a column is wide.
    expect(l.w).toBeCloseTo(cellW);
    expect(p.h).toBeCloseTo(cellW);
    expect(row.height).toBeCloseTo(cellW);
  });

  it('centres a photo in its column and row', () => {
    const [row] = layoutPhotoRows(doc, [landscape, portrait], 40, width);
    const [l, p] = row.cells;
    expect(l.x).toBeCloseTo(40);
    expect(l.dy).toBeCloseTo((row.height - l.h) / 2);
    expect(p.cellX).toBeCloseTo(40 + cellW + PHOTO_GAP);
    expect(p.x).toBeCloseTo(p.cellX + (cellW - p.w) / 2);
  });

  it('a row of landscape photos is only as tall as they need', () => {
    const [row] = layoutPhotoRows(doc, [landscape, landscape], 40, width);
    expect(row.height).toBeCloseTo(cellW * 3 / 4);
  });

  it('reads the size from the image itself when it is not known', () => {
    const [row] = layoutPhotoRows(doc, [{ dataUrl: JPEG, width: 0, height: 0 }], 40, width);
    expect(row.cells[0].w).toBeCloseTo(cellW); // a square 1x1 image
    expect(row.cells[0].h).toBeCloseTo(cellW);
  });

  it('leaves out a photo jsPDF cannot read, without a hole in the grid', () => {
    const rows = layoutPhotoRows(doc, [landscape, { dataUrl: 'data:image/jpeg;base64,AAAA', width: 0, height: 0 }, portrait], 40, width);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells.map(c => c.photo)).toEqual([landscape, portrait]);
  });
});

describe('drawPhotoGrid', () => {
  it('draws each photo at its fitted size and starts a new page when a row does not fit', () => {
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const addImage = vi.spyOn(doc, 'addImage');
    const newPage = vi.fn(() => 60);
    const y = drawPhotoGrid(doc, [landscape, portrait, landscape], { left: 48, width: 516, y: 600, bottom: 744, newPage });

    expect(newPage).toHaveBeenCalledTimes(1); // the first row (252pt tall) does not fit below y=600
    expect(addImage).toHaveBeenCalledTimes(3);
    const [, , , , w, h] = addImage.mock.calls[1] as unknown as [string, string, number, number, number, number];
    expect(w / h).toBeCloseTo(3 / 4); // the portrait photo is not stretched
    expect(y).toBeGreaterThan(60);
  });
});

describe('loadPdfPhoto', () => {
  it('hands the file over as it is where images cannot be decoded (size read later)', async () => {
    const blob = new Blob([Uint8Array.from(atob(JPEG.split(',')[1]), c => c.charCodeAt(0))], { type: 'image/jpeg' });
    const photo = await loadPdfPhoto(blob);
    expect(photo).toMatchObject({ width: 0, height: 0 });
    expect(photo!.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});
