// src/pages/sketch/sketchModel.ts
// The Sketch document: flat shapes drawn on a work plane, and pulls that turn
// a closed shape into a solid. Saved as JSON in Documents (kind 'sketch').
// Every length is stored in millimetres; `units` only changes how lengths are
// typed and shown (feet-inches to 1/32", or millimetres).
import { formatFeetAndInches, parseFeetAndInches } from '../../utils/math';

export const SKETCH_FORMAT = 'frugal-sketch';
export const SKETCH_MIME = 'application/vnd.frugalomnibuild.sketch+json';
export const SKETCH_EXTENSION = '.sketch.json';

export type SketchUnits = 'imperial' | 'metric';

/** Ground lies flat (z up); Front stands facing you; Side stands at right angles to Front. */
export type PlaneId = 'ground' | 'front' | 'side';

export interface Vec2 { x: number; y: number }
export type Vec3 = [number, number, number];

/** A work plane in world space (z up): sketch x runs along xDir, sketch y along yDir. */
export interface PlaneFrame { origin: Vec3; xDir: Vec3; yDir: Vec3; normal: Vec3 }

// The same frames replicad uses for 'XY', 'XZ' and 'YZ', so a shape drawn here
// is built in OpenCascade exactly where it is shown.
export const PLANES: Record<PlaneId, PlaneFrame> = {
  ground: { origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
  front: { origin: [0, 0, 0], xDir: [1, 0, 0], yDir: [0, 0, 1], normal: [0, -1, 0] },
  side: { origin: [0, 0, 0], xDir: [0, 1, 0], yDir: [0, 0, 1], normal: [1, 0, 0] },
};

export const PLANE_LABELS: Record<PlaneId, string> = { ground: 'Ground', front: 'Front', side: 'Side' };

/** One step of a path, from the previous point: a straight line, or an arc through `through`. */
export type PathSegment =
  | { kind: 'line'; to: Vec2 }
  | { kind: 'arc'; to: Vec2; through: Vec2 };

export interface PathShape {
  id: string;
  type: 'path';
  plane: PlaneId;
  start: Vec2;
  segments: PathSegment[];
  /** A closed path returns to its start (its last segment ends there). Only closed shapes can be pulled. */
  closed: boolean;
}

export interface CircleShape {
  id: string;
  type: 'circle';
  plane: PlaneId;
  center: Vec2;
  radius: number;
}

export type SketchShape = PathShape | CircleShape;

/** Pull a closed shape along its plane's normal into a solid (negative pulls the other way). */
export interface PullFeature {
  id: string;
  type: 'pull';
  shapeId: string;
  distance: number;
}

export type SketchFeature = PullFeature;

export interface SketchDoc {
  format: typeof SKETCH_FORMAT;
  version: 1;
  units: SketchUnits;
  shapes: SketchShape[];
  features: SketchFeature[];
}

export const emptySketch = (units: SketchUnits): SketchDoc => ({
  format: SKETCH_FORMAT, version: 1, units, shapes: [], features: [],
});

/** Reads a saved sketch, or throws when the file is not one. */
export const parseSketch = (text: string): SketchDoc => {
  const raw = JSON.parse(text);
  if (!raw || raw.format !== SKETCH_FORMAT) throw new Error('This file is not a sketch.');
  if (raw.version !== 1) throw new Error('This sketch was saved by a newer version of the app.');
  return {
    format: SKETCH_FORMAT,
    version: 1,
    units: raw.units === 'metric' ? 'metric' : 'imperial',
    shapes: Array.isArray(raw.shapes) ? raw.shapes : [],
    features: Array.isArray(raw.features) ? raw.features : [],
  };
};

export const serializeSketch = (doc: SketchDoc): string => JSON.stringify(doc);

// ── Units ───────────────────────────────────────────────────────────────────

export const MM_PER_INCH = 25.4;

/** A length as the sketch shows it: `1' - 4 1/4"` (to 1/32") or `412.8 mm`. */
export const formatLength = (mm: number, units: SketchUnits): string => {
  const sign = mm < 0 ? '−' : '';
  const abs = Math.abs(mm);
  if (units === 'metric') return `${sign}${Number(abs.toFixed(1))} mm`;
  return `${sign}${formatFeetAndInches(abs / (12 * MM_PER_INCH), 32)}`;
};

/** A typed length in millimetres, or null when it does not read as one.
 *  Imperial: a bare number is inches (`3 1/2`, `1' 4 1/4"`, `1'-4"` all work).
 *  Metric: millimetres, or with a `cm` / `m` suffix. */
export const parseLength = (input: string, units: SketchUnits): number | null => {
  const t = input.trim();
  if (!t) return null;
  const negative = /^[-−]/.test(t);
  const body = t.replace(/^[-−]\s*/, '');
  let mm: number | null;
  if (units === 'metric') {
    const m = body.match(/^(\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|m)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = (m[2] || 'mm').toLowerCase();
    mm = unit === 'm' ? n * 1000 : unit === 'cm' ? n * 10 : n;
  } else {
    const ft = parseFeetAndInches(body, 'in');
    mm = ft === null ? null : ft * 12 * MM_PER_INCH;
  }
  if (mm === null || !Number.isFinite(mm)) return null;
  return negative ? -mm : mm;
};

// ── Geometry helpers (sketch plane, mm) ─────────────────────────────────────

export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);
export const samePoint = (a: Vec2, b: Vec2, tol = 1e-6): boolean => dist2(a, b) <= tol;

/** Centre and radius of the circle through three points, or null when they are in a line. */
export const circleThrough = (a: Vec2, b: Vec2, c: Vec2): { center: Vec2; radius: number } | null => {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const center = {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
  return { center, radius: dist2(center, a) };
};

/** Points along an arc from `from` through `through` to `to` (end included, start not). */
export const arcPoints = (from: Vec2, through: Vec2, to: Vec2, steps = 24): Vec2[] => {
  const c = circleThrough(from, through, to);
  if (!c) return [to];
  const ang = (p: Vec2) => Math.atan2(p.y - c.center.y, p.x - c.center.x);
  const a0 = ang(from), am = ang(through), a1 = ang(to);
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // Sweep counter-clockwise if `through` lies on the CCW way from `from` to `to`.
  const ccw = norm(am - a0) < norm(a1 - a0);
  const sweep = ccw ? norm(a1 - a0) : -norm(a0 - a1);
  const pts: Vec2[] = [];
  for (let i = 1; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    pts.push({ x: c.center.x + c.radius * Math.cos(a), y: c.center.y + c.radius * Math.sin(a) });
  }
  pts[pts.length - 1] = to;
  return pts;
};

/** The outline of a shape as points (arcs and circles approximated), in sketch-plane mm. */
export const shapeOutline = (s: SketchShape, arcSteps = 24): Vec2[] => {
  if (s.type === 'circle') {
    const n = Math.max(32, arcSteps * 3);
    return Array.from({ length: n + 1 }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      return { x: s.center.x + s.radius * Math.cos(a), y: s.center.y + s.radius * Math.sin(a) };
    });
  }
  const pts: Vec2[] = [s.start];
  let prev = s.start;
  for (const seg of s.segments) {
    if (seg.kind === 'line') pts.push(seg.to);
    else pts.push(...arcPoints(prev, seg.through, seg.to, arcSteps));
    prev = seg.to;
  }
  return pts;
};

/** Every point a new point can snap to on a shape: vertices, segment midpoints, centres. */
export const shapeSnapPoints = (s: SketchShape): Vec2[] => {
  if (s.type === 'circle') {
    const { center: c, radius: r } = s;
    return [c, { x: c.x + r, y: c.y }, { x: c.x - r, y: c.y }, { x: c.x, y: c.y + r }, { x: c.x, y: c.y - r }];
  }
  const pts: Vec2[] = [s.start];
  let prev = s.start;
  for (const seg of s.segments) {
    pts.push(seg.to);
    pts.push(seg.kind === 'line' ? { x: (prev.x + seg.to.x) / 2, y: (prev.y + seg.to.y) / 2 } : seg.through);
    if (seg.kind === 'arc') {
      const c = circleThrough(prev, seg.through, seg.to);
      if (c) pts.push(c.center);
    }
    prev = seg.to;
  }
  return pts;
};

/** A closed rectangle path from two opposite corners. */
export const rectanglePath = (id: string, plane: PlaneId, a: Vec2, b: Vec2): PathShape => ({
  id, type: 'path', plane, closed: true,
  start: a,
  segments: [
    { kind: 'line', to: { x: b.x, y: a.y } },
    { kind: 'line', to: b },
    { kind: 'line', to: { x: a.x, y: b.y } },
    { kind: 'line', to: a },
  ],
});

/** Sketch-plane point → world point (z up). */
export const toWorld = (plane: PlaneId, p: Vec2): Vec3 => {
  const f = PLANES[plane];
  return [
    f.origin[0] + f.xDir[0] * p.x + f.yDir[0] * p.y,
    f.origin[1] + f.xDir[1] * p.x + f.yDir[1] * p.y,
    f.origin[2] + f.xDir[2] * p.x + f.yDir[2] * p.y,
  ];
};

/** The shapes a pull has turned into solids (they are shown as solids, not lines). */
export const pulledShapeIds = (doc: SketchDoc): Set<string> =>
  new Set(doc.features.filter(f => f.type === 'pull').map(f => f.shapeId));

export const canPull = (s: SketchShape): boolean => s.type === 'circle' || (s.closed && s.segments.length >= 2);
