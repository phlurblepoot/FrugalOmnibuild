// src/pages/sketch/sketchDxf.ts
// DXF files for CAD and CNC: a plane's shapes at true size (lines, arcs and
// circles exactly, for cutting a profile), or a flat view of the model (its
// edges as polylines, hidden ones on their own dashed layer). Written as plain
// R12 DXF, which every CAD program and most CNC software reads, in inches for
// feet-and-inches sketches and millimetres for metric ones.
import {
  MM_PER_INCH, circleThrough, frameOf, toPlane, toWorld,
  type PlaneId, type SketchDoc, type SketchShape, type SketchUnits, type Vec2,
} from './sketchModel';

export type DxfLayer = 'PROFILE' | 'VISIBLE' | 'HIDDEN';

export type DxfEntity =
  | { type: 'line'; a: Vec2; b: Vec2; layer: DxfLayer }
  /** Counter-clockwise from `start` to `end`, in degrees. */
  | { type: 'arc'; c: Vec2; r: number; start: number; end: number; layer: DxfLayer }
  | { type: 'circle'; c: Vec2; r: number; layer: DxfLayer }
  | { type: 'polyline'; pts: Vec2[]; closed: boolean; layer: DxfLayer };

const deg = (a: number) => ((a * 180) / Math.PI + 360) % 360;

/** A shape's outline as exact DXF lines, arcs and circles, in its plane's coordinates (mm). */
export const shapeEntities = (s: SketchShape, layer: DxfLayer = 'PROFILE'): DxfEntity[] => {
  if (s.type === 'circle') return [{ type: 'circle', c: s.center, r: s.radius, layer }];
  const out: DxfEntity[] = [];
  let prev = s.start;
  for (const seg of s.segments) {
    if (seg.kind === 'line') {
      if (Math.hypot(seg.to.x - prev.x, seg.to.y - prev.y) > 1e-9) out.push({ type: 'line', a: prev, b: seg.to, layer });
    } else {
      const c = circleThrough(prev, seg.through, seg.to);
      if (!c) out.push({ type: 'line', a: prev, b: seg.to, layer });
      else {
        const a0 = Math.atan2(prev.y - c.center.y, prev.x - c.center.x);
        const am = Math.atan2(seg.through.y - c.center.y, seg.through.x - c.center.x);
        const a1 = Math.atan2(seg.to.y - c.center.y, seg.to.x - c.center.x);
        const tau = 2 * Math.PI, ccwSpan = (from: number, to: number) => ((to - from) % tau + tau) % tau;
        // DXF arcs run counter-clockwise; a clockwise one is the same arc from its other end.
        const ccw = ccwSpan(a0, am) < ccwSpan(a0, a1);
        out.push({ type: 'arc', c: c.center, r: c.radius, start: deg(ccw ? a0 : a1), end: deg(ccw ? a1 : a0), layer });
      }
    }
    prev = seg.to;
  }
  return out;
};

/**
 * The shapes drawn facing a main plane (on it, or on a solid's face parallel to
 * it), laid flat in that plane's coordinates at true size.
 */
export const planeEntities = (doc: SketchDoc, plane: PlaneId): DxfEntity[] => {
  const n = frameOf(plane).normal;
  const flat = (s: SketchShape, p: Vec2): Vec2 => { const q = toPlane(plane, toWorld(s.plane, p)); return { x: q.x, y: q.y }; };
  return doc.shapes
    .filter(s => { const m = frameOf(s.plane).normal; return Math.abs(Math.abs(m[0] * n[0] + m[1] * n[1] + m[2] * n[2]) - 1) < 1e-6; })
    .flatMap(s => shapeEntities(s.type === 'circle'
      ? { ...s, center: flat(s, s.center) }
      // Arcs are mapped by their three points, so a face turned the other way round keeps them right.
      : { ...s, start: flat(s, s.start), segments: s.segments.map(g => (g.kind === 'line' ? { ...g, to: flat(s, g.to) } : { ...g, to: flat(s, g.to), through: flat(s, g.through) })) }));
};

/** Flat-view polylines (x, y pairs in mm) as DXF polylines. */
export const polylineEntities = (polylines: number[][], layer: DxfLayer): DxfEntity[] =>
  polylines.filter(pl => pl.length >= 4).map(pl => {
    const pts: Vec2[] = [];
    for (let i = 0; i + 1 < pl.length; i += 2) pts.push({ x: pl[i], y: pl[i + 1] });
    return pts.length === 2 ? { type: 'line', a: pts[0], b: pts[1], layer } : { type: 'polyline', pts, closed: false, layer };
  });

const num = (n: number) => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

/** The DXF text for these entities (millimetres in, converted to the sketch's units). */
export const writeDxf = (entities: DxfEntity[], units: SketchUnits): string => {
  const k = units === 'metric' ? 1 : 1 / MM_PER_INCH;
  const out: (string | number)[] = [];
  const pair = (code: number, value: string | number) => out.push(code, value);
  const pt = (base: number, p: Vec2) => { pair(base, num(p.x * k)); pair(base + 10, num(p.y * k)); pair(base + 20, 0); };

  pair(0, 'SECTION'); pair(2, 'HEADER');
  pair(9, '$ACADVER'); pair(1, 'AC1009');
  // 1 = inches, 4 = millimetres; MEASUREMENT 0 = imperial, 1 = metric.
  pair(9, '$INSUNITS'); pair(70, units === 'metric' ? 4 : 1);
  pair(9, '$MEASUREMENT'); pair(70, units === 'metric' ? 1 : 0);
  pair(0, 'ENDSEC');

  pair(0, 'SECTION'); pair(2, 'TABLES');
  pair(0, 'TABLE'); pair(2, 'LTYPE'); pair(70, 2);
  pair(0, 'LTYPE'); pair(2, 'CONTINUOUS'); pair(70, 0); pair(3, 'Solid line'); pair(72, 65); pair(73, 0); pair(40, 0);
  const dash = units === 'metric' ? 3 : 0.125;
  pair(0, 'LTYPE'); pair(2, 'DASHED'); pair(70, 0); pair(3, '__ __ __'); pair(72, 65); pair(73, 2); pair(40, num(dash * 1.5));
  pair(49, num(dash)); pair(49, num(-dash / 2));
  pair(0, 'ENDTAB');
  const layers: [DxfLayer, number, string][] = [['PROFILE', 7, 'CONTINUOUS'], ['VISIBLE', 7, 'CONTINUOUS'], ['HIDDEN', 8, 'DASHED']];
  pair(0, 'TABLE'); pair(2, 'LAYER'); pair(70, layers.length);
  for (const [name, color, lt] of layers) { pair(0, 'LAYER'); pair(2, name); pair(70, 0); pair(62, color); pair(6, lt); }
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');

  pair(0, 'SECTION'); pair(2, 'ENTITIES');
  for (const e of entities) {
    if (e.type === 'line') {
      pair(0, 'LINE'); pair(8, e.layer); pt(10, e.a); pt(11, e.b);
    } else if (e.type === 'circle') {
      pair(0, 'CIRCLE'); pair(8, e.layer); pt(10, e.c); pair(40, num(e.r * k));
    } else if (e.type === 'arc') {
      pair(0, 'ARC'); pair(8, e.layer); pt(10, e.c); pair(40, num(e.r * k)); pair(50, num(e.start)); pair(51, num(e.end));
    } else {
      pair(0, 'POLYLINE'); pair(8, e.layer); pair(66, 1); pair(10, 0); pair(20, 0); pair(30, 0); pair(70, e.closed ? 1 : 0);
      for (const p of e.pts) { pair(0, 'VERTEX'); pair(8, e.layer); pt(10, p); }
      pair(0, 'SEQEND'); pair(8, e.layer);
    }
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  return out.join('\r\n') + '\r\n';
};
