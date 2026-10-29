// src/pages/sketch/sketchModel.test.ts
import { describe, it, expect } from 'vitest';
import {
  emptySketch, parseSketch, serializeSketch, formatLength, parseLength, circleThrough, arcPoints,
  rectanglePath, canPull, toWorld, shapeSnapPoints, faceFrame, samePlane, samePlaneSurface, toPlane, planSolids,
  pullAtPoint, removeShape, removeFeature, setPullDistance, axisClearOfShape, describeShape, usedShapeIds, recipePieces,
  applyTransform, stepOfSolid, scaleReference, referenceCorners, MM_PER_INCH, type PullFeature, type SketchDoc, type Vec2,
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

  it('joins and cuts the pulls drawn on a solid into it', () => {
    const plan = planSolids(block());
    expect(plan.solids.map(s => [s.id, s.featureIds])).toEqual([['p1', ['p1', 'p2', 'p3']], ['p4', ['p4']]]);
    const r = plan.solids[0].recipe;
    expect(r.op).toBe('cut');
    expect(r.op === 'cut' && r.a.op).toBe('join');
    expect(recipePieces(r).map(p => p.fid)).toEqual(['p1', 'p2', 'p3']);
    expect(plan.skipped.size).toBe(0);
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
    expect((doc.features.find(f => f.id === 'p1') as PullFeature).distance).toBe(250);
    const boss = doc.shapes.find(s => s.id === 'boss')!;
    expect(typeof boss.plane !== 'string' && boss.plane.origin).toEqual([0, -250, 0]);
    expect(doc.shapes.find(s => s.id === 'other')!.plane).toBe('ground');
    // The joined square is the same length; it just starts further out.
    expect((doc.features.find(f => f.id === 'p2') as PullFeature).distance).toBe(30);
  });
});

describe('spin and run', () => {
  const inchRect = (id: string, plane: Parameters<typeof rectanglePath>[1], x0: number, y0: number, x1: number, y1: number) =>
    rectanglePath(id, plane, { x: inch(x0), y: inch(y0) }, { x: inch(x1), y: inch(y1) });

  it('spins round an axis to one side of the shape (or along its edge), not through it', () => {
    const r = inchRect('r', 'front', 2, 0, 3, 6);
    expect(axisClearOfShape(r, [{ x: 0, y: 0 }, { x: 0, y: 10 }])).toBe(true);
    expect(axisClearOfShape(r, [{ x: inch(2), y: 0 }, { x: inch(2), y: 10 }])).toBe(true); // along its edge
    expect(axisClearOfShape(r, [{ x: inch(2.5), y: 0 }, { x: inch(2.5), y: 10 }])).toBe(false);
    expect(axisClearOfShape(r, [{ x: 0, y: 0 }, { x: 0, y: 0 }])).toBe(false);

    const doc = emptySketch('imperial');
    doc.shapes.push(r);
    doc.features.push({ id: 's1', type: 'spin', shapeId: 'r', axis: [{ x: 0, y: 0 }, { x: 0, y: 10 }], angle: 360 });
    const plan = planSolids(doc);
    expect(plan.solids[0].recipe).toMatchObject({ op: 'spin', origin: [0, 0, 0], direction: [0, 0, 10], angle: 360 });
    doc.features[0] = { ...doc.features[0], axis: [{ x: inch(2.5), y: 0 }, { x: inch(2.5), y: 10 }] } as typeof doc.features[0];
    expect(planSolids(doc).skipped.get('s1')).toMatch(/runs through the shape/);
  });

  it('runs a profile along a path, moving it along its normal to the path start', () => {
    const doc = emptySketch('imperial');
    // A room's wall line on the ground, starting 12" back and running back (+y);
    // the cornice profile drawn on Front (y = 0) gets slid back to y = 12".
    doc.shapes.push(
      inchRect('prof', 'front', 0, 0, 2, 3),
      { id: 'path', type: 'path', plane: 'ground', start: { x: 0, y: inch(12) }, closed: false,
        segments: [{ kind: 'line', to: { x: 0, y: inch(60) } }, { kind: 'line', to: { x: inch(48), y: inch(60) } }] },
    );
    doc.features.push({ id: 'run1', type: 'run', shapeId: 'prof', pathId: 'path' });
    const plan = planSolids(doc);
    const r = plan.solids[0].recipe;
    expect(r.op).toBe('run');
    if (r.op === 'run') {
      expect(typeof r.shape.plane !== 'string' && r.shape.plane.origin[1]).toBeCloseTo(inch(12));
      expect(r.path.id).toBe('path');
    }
    expect(usedShapeIds(doc)).toEqual(new Set(['prof', 'path']));
    // A path running along the profile's own plane cannot be followed.
    doc.shapes[1] = { ...doc.shapes[1], segments: [{ kind: 'line', to: { x: inch(60), y: inch(12) } }] } as typeof doc.shapes[1];
    expect(planSolids(doc).skipped.get('run1')).toMatch(/lies along the path/);
    // Deleting the path deletes the run, and the profile comes back as an outline.
    const gone = removeShape(doc, 'path');
    expect(gone.features).toEqual([]);
    expect(gone.shapes.map(s => s.id)).toEqual(['prof']);
  });

  it('a deleted step leaves its shape, and takes what was drawn on its faces', () => {
    const doc = emptySketch('metric');
    const end = faceFrame([0, -100, 0], [0, -1, 0]);
    doc.shapes.push(
      rectanglePath('base', 'front', { x: 0, y: 0 }, { x: 50, y: 50 }),
      { ...rectanglePath('boss', end, { x: 10, y: 10 }, { x: 20, y: 20 }), onFeatureId: 'p1' },
    );
    doc.features.push({ id: 'p1', type: 'pull', shapeId: 'base', distance: 100 }, { id: 'p2', type: 'pull', shapeId: 'boss', distance: 5 });
    const after = removeFeature(doc, 'p1');
    expect(after.shapes.map(s => s.id)).toEqual(['base']);
    expect(after.features).toEqual([]);
  });

  it('describes shapes for the step list', () => {
    expect(describeShape(inchRect('r', 'front', 0, 0, 6, 4), 'imperial')).toBe('Rectangle 6" × 4"');
    expect(describeShape({ id: 'c', type: 'circle', plane: 'front', center: { x: 0, y: 0 }, radius: inch(1.5) }, 'imperial')).toBe('Circle Ø 3"');
    expect(describeShape({ id: 'p', type: 'path', plane: 'front', start: { x: 0, y: 0 }, closed: false, segments: [{ kind: 'line', to: { x: 1, y: 0 } }] }, 'metric')).toBe('Path, 1 piece');
  });
});

describe('joining, cutting, moving and copying solids', () => {
  const twoBlocks = (): SketchDoc => {
    const doc = emptySketch('metric');
    doc.shapes.push(
      rectanglePath('a', 'ground', { x: 0, y: 0 }, { x: 100, y: 50 }),
      rectanglePath('b', 'ground', { x: 80, y: 0 }, { x: 200, y: 50 }),
    );
    doc.features.push({ id: 'pa', type: 'pull', shapeId: 'a', distance: 30 }, { id: 'pb', type: 'pull', shapeId: 'b', distance: 60 });
    return doc;
  };

  it('a join or cut uses up the second solid', () => {
    const doc = twoBlocks();
    doc.features.push({ id: 'c1', type: 'combine', mode: 'cut', targetId: 'pa', toolId: 'pb' });
    const plan = planSolids(doc);
    expect(plan.solids.map(s => s.id)).toEqual(['pa']);
    expect(plan.solids[0].featureIds).toEqual(['pa', 'pb', 'c1']);
    expect(plan.solids[0].recipe).toMatchObject({ op: 'cut', fid: 'c1', a: { op: 'pull', fid: 'pa' }, b: { op: 'pull', fid: 'pb' } });
    // A later step that names the used-up solid works on the one it went into.
    doc.features.push({ id: 'm1', type: 'move', targetId: 'pb', transform: { kind: 'move', by: [0, 0, 10] }, copies: 0 });
    const after = planSolids(doc);
    expect(after.solids[0].featureIds).toContain('m1');
    expect(after.solids[0].recipe.op).toBe('transform');
    expect(after.solids[0].pullIds).toEqual([]); // moved: no outline is where it was drawn any more
  });

  it('copies are new solids, each one step further on; the original stays', () => {
    const doc = twoBlocks();
    doc.features.push({ id: 'm1', type: 'move', targetId: 'pa', transform: { kind: 'move', by: [0, 300, 0] }, copies: 2 });
    const plan = planSolids(doc);
    expect(plan.solids.map(s => s.id)).toEqual(['pa', 'pb', 'm1:1', 'm1:2']);
    expect(plan.solids[3].recipe).toMatchObject({ op: 'transform', times: 2, of: { op: 'pull', fid: 'pa' } });
    expect(stepOfSolid('m1:2')).toBe('m1');
    expect(stepOfSolid('pa')).toBe('pa');
    // A mirror with "keep the original" makes one copy, however many were asked for.
    doc.features.push({ id: 'mi', type: 'move', targetId: 'pb', transform: { kind: 'mirror', origin: [0, 0, 0], normal: [1, 0, 0] }, copies: 5 });
    expect(planSolids(doc).solids.map(s => s.id)).toEqual(['pa', 'pb', 'm1:1', 'm1:2', 'mi:1']);
  });

  it('deleting a solid tidies away the joins, moves and copies that needed it', () => {
    const doc = twoBlocks();
    doc.features.push(
      { id: 'm1', type: 'move', targetId: 'pa', transform: { kind: 'move', by: [0, 300, 0] }, copies: 1 },
      { id: 'c1', type: 'combine', mode: 'join', targetId: 'pb', toolId: 'm1:1' },
    );
    const after = removeShape(doc, 'a');
    expect(after.features.map(f => f.id)).toEqual(['pb']);
    // Deleting just the copy step takes the join that used the copy.
    expect(removeFeature(doc, 'm1').features.map(f => f.id)).toEqual(['pa', 'pb']);
  });

  it('moves, turns and mirrors points as the solids will be', () => {
    const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
    near(applyTransform({ kind: 'move', by: [10, 0, -5] }, [1, 2, 3], 2), [21, 2, -7]);
    near(applyTransform({ kind: 'rotate', origin: [0, 0, 0], axis: [0, 0, 1], angle: 90 }, [100, 0, 7]), [0, 100, 7]);
    near(applyTransform({ kind: 'rotate', origin: [50, 50, 0], axis: [0, 0, 2], angle: 90 }, [100, 50, 0], 2), [0, 50, 0]);
    near(applyTransform({ kind: 'mirror', origin: [300, 0, 0], normal: [1, 0, 0] }, [100, 4, 5]), [500, 4, 5]);
    near(applyTransform({ kind: 'mirror', origin: [0, 0, 0], normal: [0, 3, 0] }, [1, 2, 3]), [1, -2, 3]);
  });
});

describe('rounding and bevelling edges', () => {
  const block = (): SketchDoc => {
    const doc = emptySketch('metric');
    doc.shapes.push(rectanglePath('a', 'ground', { x: 0, y: 0 }, { x: 100, y: 50 }));
    doc.features.push({ id: 'pa', type: 'pull', shapeId: 'a', distance: 30 });
    return doc;
  };

  it('rounds the solid where it is, keeping its id, pieces and pulls', () => {
    const doc = block();
    doc.features.push({ id: 'r1', type: 'edges', mode: 'round', targetId: 'pa', points: [[50, 0, 30]], size: 5 });
    const plan = planSolids(doc);
    expect(plan.solids.map(s => s.id)).toEqual(['pa']);
    expect(plan.solids[0].featureIds).toEqual(['pa', 'r1']);
    expect(plan.solids[0].pullIds).toEqual(['pa']); // its faces are still where the pull made them
    expect(plan.solids[0].recipe).toMatchObject({ op: 'edges', fid: 'r1', mode: 'round', size: 5, of: { op: 'pull', fid: 'pa' } });
    expect(recipePieces(plan.solids[0].recipe).map(p => p.fid)).toEqual(['pa']);
    // A move after it moves the rounded solid; a copy of it is rounded too.
    doc.features.push({ id: 'm1', type: 'move', targetId: 'pa', transform: { kind: 'move', by: [0, 300, 0] }, copies: 1 });
    expect(planSolids(doc).solids[1].recipe).toMatchObject({ op: 'transform', of: { op: 'edges', fid: 'r1' } });
  });

  it('skips a rounding with nothing to round, and tidies one away with its solid', () => {
    const doc = block();
    doc.features.push({ id: 'r0', type: 'edges', mode: 'bevel', targetId: 'pa', points: [], size: 5 });
    expect(planSolids(doc).skipped.get('r0')).toMatch(/No edges/);
    doc.features.push({ id: 'r1', type: 'edges', mode: 'bevel', targetId: 'pa', points: [[0, 25, 30]], size: 5 });
    expect(removeShape(doc, 'a').features).toEqual([]);
  });
});

describe('reference photos', () => {
  const photo = { id: 'r', fileId: 'f', name: 'detail.jpg', plane: 'front' as const, center: { x: 100, y: 50 }, width: 200, aspect: 0.5, rotation: 0, opacity: 0.6 };

  it('older sketches open with none', () => {
    const doc = parseSketch(JSON.stringify({ format: 'frugal-sketch', version: 1, units: 'imperial', shapes: [], features: [] }));
    expect(doc.refs).toEqual([]);
  });

  it('scales a photo so a measured length comes out true, keeping the first point still', () => {
    // On the photo, (0,50) to (100,50) is 100 mm now; it is really 300 mm.
    const scaled = scaleReference(photo, { x: 0, y: 50 }, { x: 100, y: 50 }, 300);
    expect(scaled.width).toBeCloseTo(600);
    expect(scaled.center).toEqual({ x: 300, y: 50 });
    expect(scaled.aspect).toBe(0.5);
    // Nothing measured, nothing changes.
    expect(scaleReference(photo, { x: 1, y: 1 }, { x: 1, y: 1 }, 300)).toBe(photo);
  });

  it('knows where its corners are when turned', () => {
    const c = referenceCorners({ ...photo, rotation: 90 });
    expect(c[0].x).toBeCloseTo(150); // bottom-left (−100, −50) turned a quarter: (50, −100) from the middle
    expect(c[0].y).toBeCloseTo(-50);
  });
});
