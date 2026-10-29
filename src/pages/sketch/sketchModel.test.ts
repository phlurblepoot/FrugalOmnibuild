// src/pages/sketch/sketchModel.test.ts
import { describe, it, expect } from 'vitest';
import {
  emptySketch, parseSketch, serializeSketch, formatLength, parseLength, circleThrough, arcPoints,
  rectanglePath, canPull, toWorld, shapeSnapPoints, faceFrame, samePlane, samePlaneSurface, toPlane, solidOfPull,
  pullAtPoint, removeShape, setPullDistance, MM_PER_INCH, type SketchDoc, type Vec2,
} from './sketchModel';
import {
  gridStep, snapPoint, pointAt, angleDeg, parseAngle, levelAngleToward, angleFromLevel, type SnapTargets,
} from './sketchSnap';

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

  const targets = (t: Partial<SnapTargets> = {}): SnapTargets => ({ ends: [], extras: [], segments: [], ...t });

  it('without keys held: a nearby end point, else the grid (no angle lock)', () => {
    const base = { pxPerMm: 1, step: 10, targets: targets({ ends: [{ x: 33, y: 47 }], extras: [{ x: 70, y: 70 }] }) };
    expect(snapPoint({ ...base, raw: { x: 35, y: 50 } })).toEqual({ p: { x: 33, y: 47 }, kind: 'point' });
    // Nearly level from (0,0) is not pulled level any more: it stays on the grid.
    expect(snapPoint({ ...base, raw: { x: 96, y: 4 }, from: { x: 0, y: 0 } })).toEqual({ p: { x: 100, y: 0 }, kind: 'grid' });
    expect(snapPoint({ ...base, raw: { x: 96, y: 24 }, from: { x: 0, y: 0 } })).toEqual({ p: { x: 100, y: 20 }, kind: 'grid' });
    // Midpoints wait for Shift.
    expect(snapPoint({ ...base, raw: { x: 72, y: 68 } }).kind).toBe('grid');
    expect(snapPoint({ ...base, raw: { x: 96.3, y: 24.2 }, free: true }).kind).toBe('free');
  });

  it('Ctrl locks a line to every 15 degrees from the previous point', () => {
    const base = { pxPerMm: 1, step: 10, targets: targets(), angleStep: 15 };
    const level = snapPoint({ ...base, raw: { x: 96, y: 6 }, from: { x: 0, y: 0 } });
    expect(level.kind).toBe('angle');
    expect(level.p.x).toBeCloseTo(100);
    expect(level.p.y).toBeCloseTo(0);
    // 31.5° rounds to 30°, the length to the grid.
    const r = (31.5 * Math.PI) / 180;
    const thirty = snapPoint({ ...base, raw: { x: 101 * Math.cos(r), y: 101 * Math.sin(r) }, from: { x: 0, y: 0 } });
    expect(angleDeg({ x: 0, y: 0 }, thirty.p)).toBeCloseTo(30);
    expect(Math.hypot(thirty.p.x, thirty.p.y)).toBeCloseTo(100);
  });

  it('Shift lines up with what is drawn: midpoints, crossings, outlines and level or plumb guides', () => {
    const square: [Vec2, Vec2][] = [[{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 100, y: 0 }, { x: 100, y: 100 }]];
    const base = {
      pxPerMm: 1, step: 10, shapes: true,
      targets: targets({ ends: [{ x: 0, y: 0 }, { x: 100, y: 100 }], extras: [{ x: 50, y: 0 }], segments: square }),
    };
    expect(snapPoint({ ...base, raw: { x: 53, y: 4 } })).toEqual({ p: { x: 50, y: 0 }, kind: 'point' });
    // On an outline, between grid lines.
    expect(snapPoint({ ...base, raw: { x: 103, y: 33 } })).toEqual({ p: { x: 100, y: 33 }, kind: 'line' });
    // Level with (100,100), on the grid along it.
    expect(snapPoint({ ...base, raw: { x: 243, y: 104 } })).toEqual({ p: { x: 240, y: 100 }, kind: 'guide', guides: [{ x: 100, y: 100 }] });
    // Plumb under (50,0)'s midpoint and level with (100,100): their crossing.
    expect(snapPoint({ ...base, raw: { x: 46, y: 97 } })).toEqual({ p: { x: 50, y: 100 }, kind: 'cross', guides: [{ x: 50, y: 0 }, { x: 100, y: 100 }] });
    // Where two outlines meet.
    expect(snapPoint({ ...base, raw: { x: 104, y: 3 } })).toMatchObject({ p: { x: 100, y: 0 }, kind: 'cross' });
    // With Ctrl too, the locked line stops on a guide: 45° from (0,0) to level with (100,100).
    const g = snapPoint({ ...base, angleStep: 15, raw: { x: 96, y: 103 }, from: { x: 0, y: 0 } });
    expect(g.kind).toBe('angle');
    expect(g.p.x).toBeCloseTo(100);
    expect(g.p.y).toBeCloseTo(100);
  });

  it('measures a typed angle from level, toward the side the pointer is on', () => {
    expect(levelAngleToward(45, { x: 1, y: 1 })).toBeCloseTo(45);
    expect(levelAngleToward(45, { x: -1, y: 1 })).toBeCloseTo(135);
    expect(levelAngleToward(45, { x: -1, y: -1 })).toBeCloseTo(225);
    expect(levelAngleToward(45, { x: 1, y: -1 })).toBeCloseTo(315);
    expect(levelAngleToward(90, { x: -3, y: -1 })).toBeCloseTo(270);
    expect(levelAngleToward(0, { x: -3, y: 5 })).toBeCloseTo(180);
    expect(angleFromLevel({ x: 0, y: 0 }, { x: -10, y: 10 })).toBeCloseTo(45);
    expect(angleFromLevel({ x: 0, y: 0 }, { x: 0, y: -4 })).toBeCloseTo(90);
  });

  it('places typed lengths and angles exactly', () => {
    expect(pointAt({ x: 0, y: 0 }, 10, 90)).toEqual({ x: 0, y: 10 });
    expect(angleDeg({ x: 0, y: 0 }, { x: 0, y: -5 })).toBe(270);
    expect(parseAngle('45°')).toBe(45);
    expect(parseAngle('north')).toBeNull();
  });
});

describe('drawing on faces', () => {
  it('gives a face the same frame as the main plane it faces like, offset to the face', () => {
    // The far end of a block pulled from Front: faces -y, 200 mm out.
    expect(faceFrame([30, -200, 12], [0, -1, 0])).toEqual({ origin: [0, -200, 0], xDir: [1, 0, 0], yDir: [0, 0, 1], normal: [0, -1, 0] });
    // A top face 60 mm up: like Ground.
    expect(faceFrame([5, 5, 60], [0, 0, 1])).toEqual({ origin: [0, 0, 60], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] });
    // The back of it (facing +y): x runs the other way, so it reads left to right from behind.
    const back = faceFrame([0, 0, 0], [0, 1, 0]);
    expect(back.xDir).toEqual([-1, 0, 0]);
    expect(back.yDir).toEqual([0, 0, 1]);
    // A sloped face: y still runs up the slope.
    const slope = faceFrame([0, 0, 0], [0, -Math.SQRT1_2, Math.SQRT1_2]);
    expect(slope.xDir).toEqual([1, 0, 0]);
    expect(slope.yDir[2]).toBeGreaterThan(0);
    expect(toWorld(faceFrame([0, -200, 0], [0, -1, 0]), { x: 10, y: 20 })).toEqual([10, -200, 20]);
  });

  it('tells planes that are the same surface apart from ones that also agree on direction', () => {
    const front = faceFrame([0, 0, 0], [0, -1, 0]);
    const back = faceFrame([0, 0, 0], [0, 1, 0]);
    expect(samePlane(front, faceFrame([9, 0, 4], [0, -1, 0]))).toBe(true);
    expect(samePlane(front, back)).toBe(false);
    expect(samePlaneSurface(front, back)).toBe(true);
    expect(samePlaneSurface('front', back)).toBe(true);
    expect(samePlaneSurface('front', faceFrame([0, -5, 0], [0, -1, 0]))).toBe(false);
    expect(toPlane(faceFrame([0, -200, 0], [0, -1, 0]), [10, -230, 20])).toEqual({ x: 10, y: 20, w: 30 });
  });

  const block = (): SketchDoc => {
    const doc = emptySketch('metric');
    // A 100 × 60 block pulled 200 out from Front; a 20 mm square drawn on its far
    // end pulled out 30 (joined); a slot on that end pulled in 50 (cut).
    const end = faceFrame([0, -200, 0], [0, -1, 0]);
    doc.shapes.push(
      rectanglePath('base', 'front', { x: 0, y: 0 }, { x: 100, y: 60 }),
      { ...rectanglePath('boss', end, { x: 20, y: 20 }, { x: 40, y: 40 }), onFeatureId: 'p1' },
      { ...rectanglePath('slot', end, { x: 60, y: 10 }, { x: 90, y: 50 }), onFeatureId: 'p1' },
      rectanglePath('other', 'ground', { x: 500, y: 0 }, { x: 600, y: 50 }),
    );
    doc.features.push(
      { id: 'p1', type: 'pull', shapeId: 'base', distance: 200 },
      { id: 'p2', type: 'pull', shapeId: 'boss', distance: 30 },
      { id: 'p3', type: 'pull', shapeId: 'slot', distance: -50 },
      { id: 'p4', type: 'pull', shapeId: 'other', distance: 10 },
    );
    return doc;
  };

  it('groups the pulls drawn on a solid with it', () => {
    expect([...solidOfPull(block()).entries()]).toEqual([['p1', 'p1'], ['p2', 'p1'], ['p3', 'p1'], ['p4', 'p4']]);
  });

  it('finds which pull made the surface under the pointer', () => {
    const doc = block();
    const ids = ['p1', 'p2', 'p3'];
    expect(pullAtPoint(doc, ids, [50, -100, 60])).toBe('p1'); // the block's top
    expect(pullAtPoint(doc, ids, [30, -230, 30])).toBe('p2'); // the end of the joined square
    expect(pullAtPoint(doc, ids, [75, -175, 10])).toBe('p3'); // the floor of the slot
    expect(pullAtPoint(doc, ids, [95, -200, 55])).toBe('p1'); // the block's end, beside the slot
    expect(pullAtPoint(doc, ids, [300, 0, 0])).toBeNull();
  });

  it('deleting a solid takes what was drawn on it too', () => {
    const doc = removeShape(block(), 'base');
    expect(doc.shapes.map(s => s.id)).toEqual(['other']);
    expect(doc.features.map(f => f.id)).toEqual(['p4']);
    expect(removeShape(block(), 'slot').shapes.map(s => s.id)).toEqual(['base', 'boss', 'other']);
  });

  it('pulling the block further moves what is drawn on its end along with it', () => {
    const doc = setPullDistance(block(), 'p1', 250);
    expect(doc.features.find(f => f.id === 'p1')!.distance).toBe(250);
    const boss = doc.shapes.find(s => s.id === 'boss')!;
    expect(typeof boss.plane !== 'string' && boss.plane.origin).toEqual([0, -250, 0]);
    expect(doc.shapes.find(s => s.id === 'other')!.plane).toBe('ground');
    // The joined square is the same length; it just starts further out.
    expect(doc.features.find(f => f.id === 'p2')!.distance).toBe(30);
  });
});
