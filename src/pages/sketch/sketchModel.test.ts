// src/pages/sketch/sketchModel.test.ts
import { describe, it, expect } from 'vitest';
import {
  emptySketch, parseSketch, serializeSketch, formatLength, parseLength, circleThrough, arcPoints,
  rectanglePath, canPull, toWorld, shapeSnapPoints, MM_PER_INCH,
} from './sketchModel';
import { gridStep, snapPoint, pointAt, angleDeg, parseAngle } from './sketchSnap';

const inch = (n: number) => n * MM_PER_INCH;

describe('sketch file', () => {
  it('round-trips through JSON and refuses other files', () => {
    const doc = emptySketch('metric');
    doc.shapes.push(rectanglePath('r', 'ground', { x: 0, y: 0 }, { x: 10, y: 5 }));
    expect(parseSketch(serializeSketch(doc))).toEqual(doc);
    expect(() => parseSketch('{"hello":1}')).toThrow(/not a sketch/);
    expect(() => parseSketch(JSON.stringify({ ...doc, version: 2 }))).toThrow(/newer version/);
  });
});

describe('lengths', () => {
  it('shows imperial lengths in feet and inches to 1/32" and metric in millimetres', () => {
    expect(formatLength(inch(16.25), 'imperial')).toBe(`1' - 4 1/4"`);
    expect(formatLength(inch(3.5), 'imperial')).toBe(`3 1/2"`);
    expect(formatLength(inch(3 + 3 / 32), 'imperial')).toBe(`3 3/32"`);
    expect(formatLength(-inch(2), 'imperial')).toBe(`−2"`);
    expect(formatLength(412.75, 'metric')).toBe('412.8 mm');
  });

  it('reads typed imperial lengths as inches unless feet are marked', () => {
    expect(parseLength('3 1/2', 'imperial')).toBeCloseTo(inch(3.5));
    expect(parseLength(`1' 4 1/4"`, 'imperial')).toBeCloseTo(inch(16.25));
    expect(parseLength(`2'`, 'imperial')).toBeCloseTo(inch(24));
    expect(parseLength('-6', 'imperial')).toBeCloseTo(-inch(6));
    expect(parseLength('abc', 'imperial')).toBeNull();
  });

  it('reads typed metric lengths as millimetres, with cm and m', () => {
    expect(parseLength('250', 'metric')).toBe(250);
    expect(parseLength('2.5 cm', 'metric')).toBe(25);
    expect(parseLength('1.2m', 'metric')).toBe(1200);
    expect(parseLength('5 ft', 'metric')).toBeNull();
  });
});

describe('geometry', () => {
  it('finds the circle through three points', () => {
    const c = circleThrough({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 })!;
    expect(c.center.x).toBeCloseTo(0);
    expect(c.center.y).toBeCloseTo(0);
    expect(c.radius).toBeCloseTo(1);
    expect(circleThrough({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 })).toBeNull();
  });

  it('an arc runs the way its through point says', () => {
    // From (1,0) to (-1,0): through (0,1) goes over the top, through (0,-1) under.
    const over = arcPoints({ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, 8);
    const under = arcPoints({ x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }, 8);
    expect(over[3].y).toBeGreaterThan(0.9);
    expect(under[3].y).toBeLessThan(-0.9);
    expect(over[over.length - 1]).toEqual({ x: -1, y: 0 });
  });

  it('a rectangle is a closed, pullable path', () => {
    const r = rectanglePath('r', 'front', { x: 0, y: 0 }, { x: 4, y: 2 });
    expect(r.closed).toBe(true);
    expect(r.segments.at(-1)!.to).toEqual({ x: 0, y: 0 });
    expect(canPull(r)).toBe(true);
    expect(shapeSnapPoints(r)).toContainEqual({ x: 2, y: 0 }); // a midpoint
  });

  it('places plane points in the world the way OpenCascade does (z up)', () => {
    expect(toWorld('ground', { x: 1, y: 2 })).toEqual([1, 2, 0]);
    expect(toWorld('front', { x: 1, y: 2 })).toEqual([1, 0, 2]);
    expect(toWorld('side', { x: 1, y: 2 })).toEqual([0, 1, 2]);
  });
});

describe('snapping', () => {
  it('picks the finest grid that stays readable on screen', () => {
    // 1 px per mm: 1/2" (12.7 mm) is too tight at 14 px, 1" (25.4 px) is fine.
    expect(gridStep('imperial', 1)).toBeCloseTo(inch(1));
    expect(gridStep('metric', 1)).toBe(20);
    // 10 px per mm: 1/32" is 8 px, 1/16" is 16 px.
    expect(gridStep('imperial', 10)).toBeCloseTo(inch(1 / 16));
  });

  it('prefers a nearby point, then a 45/90 degree line, then the grid', () => {
    const base = { pxPerMm: 1, step: 10, targets: [{ x: 33, y: 47 }] };
    expect(snapPoint({ ...base, raw: { x: 35, y: 50 } })).toEqual({ p: { x: 33, y: 47 }, kind: 'point' });
    // Nearly horizontal from (0,0): locked to 0°, length rounded to the grid.
    const a = snapPoint({ ...base, raw: { x: 96, y: 4 }, from: { x: 0, y: 0 } });
    expect(a.kind).toBe('angle');
    expect(a.p.x).toBeCloseTo(100);
    expect(a.p.y).toBeCloseTo(0);
    expect(snapPoint({ ...base, raw: { x: 96, y: 24 }, from: { x: 0, y: 0 } })).toEqual({ p: { x: 100, y: 20 }, kind: 'grid' });
    expect(snapPoint({ ...base, raw: { x: 96.3, y: 24.2 }, free: true }).kind).toBe('free');
  });

  it('places typed lengths and angles exactly', () => {
    expect(pointAt({ x: 0, y: 0 }, 10, 90)).toEqual({ x: 0, y: 10 });
    expect(angleDeg({ x: 0, y: 0 }, { x: 0, y: -5 })).toBe(270);
    expect(parseAngle('45°')).toBe(45);
    expect(parseAngle('north')).toBeNull();
  });
});
