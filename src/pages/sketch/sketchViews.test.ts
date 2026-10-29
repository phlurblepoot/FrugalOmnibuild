// src/pages/sketch/sketchViews.test.ts
import { describe, it, expect } from 'vitest';
import { emptySketch, planSolids, rectanglePath, MM_PER_INCH } from './sketchModel';
import { SHEET_VIEWS, boxOf, layoutSheet, looseShapeLines, toView, viewLabels } from './sketchViews';
import { buildSketchPdf } from './sketchPdf';

const inch = (n: number) => n * MM_PER_INCH;

describe('sheet views', () => {
  it('look the way the 3D view buttons do: x right, y up', () => {
    expect(toView(SHEET_VIEWS.front, [10, -5, 20])).toEqual({ x: 10, y: 20 });
    const top = toView(SHEET_VIEWS.top, [10, -5, 20]);
    expect(top.x).toBeCloseTo(10);
    expect(top.y).toBeCloseTo(-5);
    // The right side looks back along −x: the front of the model (−y) is on its left.
    expect(toView(SHEET_VIEWS.side, [10, -5, 20])).toEqual({ x: -5, y: 20 });
  });

  const box = (w: number, h: number) => ({ minX: 0, minY: 0, maxX: w, maxY: h });
  const letter = { x: 34, y: 34, w: 704, h: 470 };

  it('picks the largest standard scale that fits, and lines the views up', () => {
    // A cornice block 2' long, 6" deep, 4" high.
    const front = box(inch(24), inch(4)), top = box(inch(24), inch(6)), side = box(inch(6), inch(4)), iso = box(500, 300);
    const l = layoutSheet({ front, top, side, iso }, letter, 'imperial');
    expect(l.scaleLabel).toBe('3" = 1\'-0"');
    expect(l.views.front!.scaleLabel).toBe('3" = 1\'-0"');
    expect(l.views.front!.left).toBeCloseTo(l.views.top!.left); // Top over Front
    expect(l.views.front!.bottom).toBeCloseTo(l.views.side!.bottom); // Side beside Front
    expect(l.views.top!.bottom).toBeLessThan(l.views.front!.bottom); // Top is above (y runs down the sheet)
    expect(l.views.side!.left).toBeGreaterThan(l.views.front!.left + inch(24) * l.views.front!.k);
    // The 3D view sits above the side view, right of the top view, inside the area.
    const iso3 = l.views.iso!;
    expect(iso3.left).toBeGreaterThan(l.views.top!.left);
    expect(iso3.left + 500 * iso3.k).toBeLessThanOrEqual(letter.x + letter.w + 0.01);
    // A chosen scale is used as is; metric picks from metric scales.
    expect(layoutSheet({ front }, letter, 'imperial', { label: '1" = 1\'-0"', ratio: 1 / 12 }).scaleLabel).toBe('1" = 1\'-0"');
    expect(layoutSheet({ front: box(600, 100) }, letter, 'metric').scaleLabel).toBe('1:5'); // 1:2 would be 850 pt wide
  });

  it('keeps the 3D view to the size asked for, without shrinking the flat views for it', () => {
    const boxes = { front: box(inch(24), inch(4)), top: box(inch(24), inch(6)), side: box(inch(6), inch(4)), iso: box(500, 300) };
    const small = layoutSheet(boxes, letter, 'imperial', undefined, 'small');
    const large = layoutSheet(boxes, letter, 'imperial', undefined, 'large');
    expect(500 * small.views.iso!.k).toBeLessThanOrEqual(0.3 * letter.w);
    expect(large.views.iso!.k).toBeGreaterThan(small.views.iso!.k);
    expect(large.views.front!.k).toBeCloseTo(small.views.front!.k);
  });

  it('falls back to an exact fitted scale when nothing standard fits', () => {
    const l = layoutSheet({ front: box(200_000, 100_000) }, letter, 'metric');
    expect(l.scaleLabel).toMatch(/^1:\d+ \(fitted\)$/);
    expect(200_000 * l.views.front!.k).toBeLessThanOrEqual(letter.w);
  });

  it('gives each view its own scale when one scale would make the profile too small to read', () => {
    // A 3" × 3" profile run 2' long: at one scale the profile would be under an inch and a quarter.
    const l = layoutSheet({ front: box(inch(3), inch(3)), top: box(inch(3), inch(24)), side: box(inch(24), inch(3)), iso: box(400, 200) }, letter, 'imperial');
    expect(l.scaleLabel).toBe('As noted');
    expect(l.views.front!.scaleLabel).toBe('6" = 1\'-0"');
    expect(l.views.side!.scaleLabel).toBe('1 1/2" = 1\'-0"');
    expect(inch(3) * l.views.front!.k).toBeGreaterThan(90);
    // A chosen scale keeps them lined up all the same.
    const fixed = layoutSheet({ front: box(inch(3), inch(3)), side: box(inch(24), inch(3)) }, letter, 'imperial', { label: '1" = 1\'-0"', ratio: 1 / 12 });
    expect(fixed.views.front!.bottom).toBeCloseTo(fixed.views.side!.bottom);
  });

  it('labels the lengths of the shapes a view looks straight at', () => {
    const doc = emptySketch('imperial');
    doc.shapes.push(rectanglePath('r', 'front', { x: 0, y: 0 }, { x: inch(6), y: inch(4) }));
    doc.features.push({ id: 'p', type: 'pull', shapeId: 'r', distance: inch(12) });
    const plan = planSolids(doc);
    const front = viewLabels(doc, plan, SHEET_VIEWS.front).map(l => l.text);
    expect(front).toEqual(['6"', '4"', '6"', '4"']);
    expect(viewLabels(doc, plan, SHEET_VIEWS.top)).toEqual([]); // edge-on from the top
    // Loose shapes are drawn in every view.
    doc.shapes.push(rectanglePath('loose', 'ground', { x: 0, y: 0 }, { x: 10, y: 10 }));
    expect(looseShapeLines(doc, SHEET_VIEWS.top)).toHaveLength(1);
    expect(boxOf(looseShapeLines(doc, SHEET_VIEWS.top))).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  });

  it('builds a one-page sheet with the title block', () => {
    const pdf = buildSketchPdf({
      title: 'Cornice C-3', projectName: 'Halcyon Hotel', company: { name: 'Big Bear Plaster' }, notes: 'Run in place.',
      units: 'imperial', paper: 'letter', showDims: true, date: new Date(2026, 9, 29),
      views: [
        { name: 'front', label: 'FRONT', projected: { name: 'front', visible: [[0, 0, inch(6), 0, inch(6), inch(4), 0, inch(4), 0, 0]], hidden: [] }, loose: [], labels: [{ at: { x: inch(3), y: 0 }, text: '6"' }] },
        { name: 'iso', label: '3D VIEW', projected: { name: 'iso', visible: [[0, 0, 100, 50]], hidden: [] }, loose: [], labels: [] },
      ],
    });
    expect(pdf.getNumberOfPages()).toBe(1);
    const text = pdf.output();
    for (const s of ['Cornice C-3', 'Halcyon Hotel', 'Big Bear Plaster', 'Run in place.', 'FRONT', '3D VIEW', 'Feet and inches']) expect(text).toContain(s);
  });
});
