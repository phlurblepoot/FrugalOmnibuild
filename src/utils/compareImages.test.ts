import { it, expect, vi, describe } from 'vitest';

vi.mock('./pdfDocCache', () => ({ getCachedPdfDocument: vi.fn() }));

import { bestShift, changeMap, diffPixels, dilate, inkFromRgba, measurementSamples, touchesChange, DIFF_COLORS, type InkMap } from './compareImages';
import type { Measurement } from '../types';

/** A blank ink map with ink drawn where `draw` says so. */
const map = (w: number, h: number, draw: (x: number, y: number) => boolean): InkMap => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (draw(x, y)) data[y * w + x] = 255;
  return { w, h, data };
};

// A rectangle outline plus a cross: enough structure for a unique best shift.
const sheet = (ox: number, oy: number) => (x: number, y: number) => {
  const X = x - ox, Y = y - oy;
  const rect = (X === 10 || X === 50 || Y === 10 || Y === 40) && X >= 10 && X <= 50 && Y >= 10 && Y <= 40;
  const cross = (X === 25 && Y > 15 && Y < 35) || (Y === 22 && X > 15 && X < 45);
  return rect || cross;
};

describe('inkFromRgba', () => {
  it('maps white to no ink and black to full ink', () => {
    const rgba = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]);
    expect(Array.from(inkFromRgba(rgba, 2, 1).data)).toEqual([0, 255]);
  });
});

describe('dilate', () => {
  it('spreads a single pixel to a square of radius r', () => {
    const d = dilate(map(5, 5, (x, y) => x === 2 && y === 2), 1);
    const on = Array.from(d.data).filter(v => v > 0).length;
    expect(on).toBe(9);
    expect(d.data[0]).toBe(0);
  });
});

describe('bestShift', () => {
  it('finds how far the newer sheet moved', () => {
    const a = map(80, 60, sheet(0, 0));
    const b = map(80, 60, sheet(-6, 4)); // drawn 6 left and 4 down
    const r = bestShift(a, b, 10);
    expect(r).toMatchObject({ sx: 6, sy: -4 });
    expect(r.score).toBeGreaterThan(0.99);
  });

  it('leaves identical sheets where they are', () => {
    const a = map(80, 60, sheet(0, 0));
    expect(bestShift(a, a, 5)).toMatchObject({ sx: 0, sy: 0 });
  });
});

describe('changeMap', () => {
  it('marks lines only on the older sheet as removed and only on the newer as added', () => {
    const older = map(40, 20, (x, y) => y === 5 || (y === 15 && x < 10));
    const newer = map(40, 20, (x, y) => y === 5 || (y === 15 && x >= 30));
    const c = changeMap(older, newer, 1);
    expect(c.kind[15 * 40 + 2]).toBe(1);
    expect(c.kind[15 * 40 + 35]).toBe(2);
    expect(c.kind[5 * 40 + 20]).toBe(0);
    expect(c.removed).toBe(10);
    expect(c.added).toBe(10);
  });

  it('ignores a line that moved less than the tolerance', () => {
    const older = map(30, 20, (_x, y) => y === 8);
    const newer = map(30, 20, (_x, y) => y === 9);
    const c = changeMap(older, newer, 2);
    expect(c.removed + c.added).toBe(0);
  });

  it('colours removed red and added blue', () => {
    const older = map(3, 1, x => x === 0);
    const newer = map(3, 1, x => x === 2);
    const c = changeMap(older, newer, 0);
    const px = diffPixels(older, newer, c);
    expect(Array.from(px.slice(0, 3))).toEqual([...DIFF_COLORS.removed]);
    expect(Array.from(px.slice(8, 11))).toEqual([...DIFF_COLORS.added]);
    expect(px[4]).toBe(255); // unchanged paper stays white
  });
});

describe('takeoffs on changes', () => {
  const line = (pts: [number, number][]): Measurement =>
    ({ id: 'm', type: 'length', name: '', color: '', points: pts.map(([x, y]) => ({ x, y })) }) as Measurement;

  it('samples along every segment of a line', () => {
    const s = measurementSamples(line([[0, 0], [10, 0]]), 2);
    expect(s[0]).toEqual({ x: 0, y: 0 });
    expect(s[s.length - 1]).toEqual({ x: 10, y: 0 });
    expect(s.length).toBe(6);
  });

  it('flags a takeoff that runs over a change and not one that does not', () => {
    const older = map(100, 100, () => false);
    const newer = map(100, 100, (x, y) => x === 50 && y > 40 && y < 60);
    const c = changeMap(older, newer, 0);
    const id = (p: { x: number; y: number }) => p;
    expect(touchesChange(line([[20, 50], [80, 50]]), c, 1, id, 2)).toBe(true);
    expect(touchesChange(line([[20, 10], [80, 10]]), c, 1, id, 2)).toBe(false);
    // Mapped from a sheet drawn at half size: (40,25)->(80,50) crosses it.
    expect(touchesChange(line([[10, 25], [40, 25]]), c, 1, p => ({ x: p.x * 2, y: p.y * 2 }), 2)).toBe(true);
  });
});
