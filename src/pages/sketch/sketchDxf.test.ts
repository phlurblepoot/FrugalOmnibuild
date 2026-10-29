// src/pages/sketch/sketchDxf.test.ts
import { describe, it, expect } from 'vitest';
import { MM_PER_INCH, emptySketch, faceFrame, rectanglePath, type PathShape } from './sketchModel';
import { planeEntities, polylineEntities, shapeEntities, writeDxf, type DxfEntity } from './sketchDxf';

type Arc = Extract<DxfEntity, { type: 'arc' }>;
/** Whether a DXF arc (counter-clockwise from start to end) passes through this angle. */
const arcHas = (a: Arc, deg: number) => ((deg - a.start + 360) % 360) <= ((a.end - a.start + 360) % 360) + 1e-9;
const arcPath = (through: { x: number; y: number }): PathShape => ({
  id: 'a', type: 'path', plane: 'front', closed: false, start: { x: 10, y: 0 },
  segments: [{ kind: 'arc', through, to: { x: -10, y: 0 } }],
});

describe('DXF export', () => {
  it('writes lines, circles and arcs exactly, arcs counter-clockwise the way DXF reads them', () => {
    expect(shapeEntities(rectanglePath('r', 'front', { x: 0, y: 0 }, { x: 20, y: 10 })).map(e => e.type)).toEqual(['line', 'line', 'line', 'line']);
    expect(shapeEntities({ id: 'c', type: 'circle', plane: 'front', center: { x: 5, y: 5 }, radius: 3 })).toEqual([{ type: 'circle', c: { x: 5, y: 5 }, r: 3, layer: 'PROFILE' }]);
    // Over the top: counter-clockwise from 0° to 180°.
    const over = shapeEntities(arcPath({ x: 0, y: 10 }))[0] as Arc;
    expect(over).toMatchObject({ type: 'arc', r: 10, start: 0, end: 180 });
    expect(arcHas(over, 90)).toBe(true);
    // Under the bottom (drawn clockwise): the same half circle from its other end.
    const under = shapeEntities(arcPath({ x: 0, y: -10 }))[0] as Arc;
    expect(under.start).toBeCloseTo(180);
    expect(arcHas(under, 270)).toBe(true);
    expect(arcHas(under, 90)).toBe(false);
  });

  it('lays a plane\'s shapes flat at true size, including ones on faces turned the other way', () => {
    const doc = emptySketch('metric');
    doc.shapes.push(rectanglePath('r', 'front', { x: 0, y: 0 }, { x: 20, y: 10 }));
    doc.shapes.push(rectanglePath('g', 'ground', { x: 0, y: 0 }, { x: 5, y: 5 })); // faces up, not the front
    // On the back face of a block (facing +y), 50 mm back: an arc bulging upward.
    const back = faceFrame([0, 50, 0], [0, 1, 0]);
    doc.shapes.push({ ...arcPath({ x: 0, y: 10 }), id: 'b', plane: back });
    const out = planeEntities(doc, 'front');
    expect(out.filter(e => e.type === 'line')).toHaveLength(4);
    const arc = out.find((e): e is Arc => e.type === 'arc')!;
    expect(arc.r).toBeCloseTo(10);
    // Seen from the front it still bulges upward (90°), whichever way the back face's own axes run.
    expect(arcHas(arc, 90)).toBe(true);
    expect(arcHas(arc, 270)).toBe(false);
    expect(planeEntities(doc, 'side')).toEqual([]);
  });

  it('turns flat-view polylines into lines and polylines', () => {
    const out = polylineEntities([[0, 0, 10, 0], [0, 0, 5, 5, 10, 0], [1, 1]], 'HIDDEN');
    expect(out.map(e => e.type)).toEqual(['line', 'polyline']);
    expect(out.every(e => e.layer === 'HIDDEN')).toBe(true);
  });

  it('writes a well-formed R12 file in inches or millimetres', () => {
    const entities: DxfEntity[] = [
      { type: 'line', a: { x: 0, y: 0 }, b: { x: MM_PER_INCH * 12, y: 0 }, layer: 'PROFILE' },
      { type: 'arc', c: { x: 0, y: 0 }, r: MM_PER_INCH, start: 0, end: 90, layer: 'PROFILE' },
      { type: 'polyline', pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }], closed: false, layer: 'HIDDEN' },
    ];
    const text = writeDxf(entities, 'imperial');
    const lines = text.split('\r\n').slice(0, -1);
    expect(lines.length % 2).toBe(0); // group code / value pairs
    for (let i = 0; i < lines.length; i += 2) expect(lines[i]).toMatch(/^-?\d+$/);
    const pairs = Array.from({ length: lines.length / 2 }, (_, i) => [lines[2 * i], lines[2 * i + 1]]);
    const after = (code: string, value: string) => pairs[pairs.findIndex(([c, v]) => c === code && v === value) + 1];
    expect(after('9', '$INSUNITS')).toEqual(['70', '1']);
    expect(pairs.at(-1)).toEqual(['0', 'EOF']);
    for (const name of ['PROFILE', 'VISIBLE', 'HIDDEN']) expect(text).toContain(`\r\n2\r\n${name}\r\n`);
    // A foot of line is 12 inches; the arc's radius an inch.
    const line = pairs.findIndex(([c, v]) => c === '0' && v === 'LINE');
    expect(pairs.slice(line, line + 9)).toContainEqual(['11', '12']);
    const arc = pairs.findIndex(([c, v]) => c === '0' && v === 'ARC');
    expect(pairs.slice(arc, arc + 9)).toContainEqual(['40', '1']);
    expect(text.match(/\r\nVERTEX\r\n/g)).toHaveLength(3);
    // Metric stays in millimetres.
    const metric = writeDxf(entities, 'metric');
    expect(metric).toContain('$INSUNITS\r\n70\r\n4\r\n');
    expect(metric).toContain('\r\n11\r\n304.8\r\n');
  });
});
