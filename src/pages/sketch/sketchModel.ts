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

/** Where a shape is drawn: one of the three main planes, or the plane of a
 *  solid's flat face (its frame, with the normal pointing out of the solid). */
export type SketchPlane = PlaneId | PlaneFrame;

export const frameOf = (plane: SketchPlane): PlaneFrame => (typeof plane === 'string' ? PLANES[plane] : plane);

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Unit length, with float noise cleaned off (so a face facing straight up is exactly 0,0,1). */
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return v.map(c => { const r = Math.round((c / l) * 1e9) / 1e9; return r === 0 ? 0 : r; }) as Vec3;
};

/** The frame of a flat face through `point` facing `normal` (out of the solid).
 *  Like the main planes, sketch y runs up the face on an upright face, and on
 *  a level one x runs along world x; the origin sits where world (0,0,0)
 *  projects onto the face, so its grid lines up with the main planes'. */
export const faceFrame = (point: Vec3, normal: Vec3): PlaneFrame => {
  const n = unit(normal);
  const level = Math.abs(n[2]) > 0.999999;
  const xDir = level ? [1, 0, 0] as Vec3 : unit(cross([0, 0, 1], n));
  const yDir = unit(cross(n, xDir));
  const offset = Math.round(dot(point, n) * 1e6) / 1e6;
  const origin = n.map(c => { const r = c * offset; return r === 0 ? 0 : r; }) as Vec3;
  return { origin, xDir, yDir, normal: n };
};

/** Whether two planes are the same flat surface (facing either way). */
export const samePlaneSurface = (a: SketchPlane, b: SketchPlane, tol = 1e-3): boolean => {
  if (a === b) return true;
  const fa = frameOf(a), fb = frameOf(b);
  if (Math.abs(Math.abs(dot(fa.normal, fb.normal)) - 1) > 1e-6) return false;
  const d: Vec3 = [fb.origin[0] - fa.origin[0], fb.origin[1] - fa.origin[1], fb.origin[2] - fa.origin[2]];
  return Math.abs(dot(d, fa.normal)) <= tol;
};

/** Whether two planes are the same plane facing the same way (so their sketch coordinates agree). */
export const samePlane = (a: SketchPlane, b: SketchPlane): boolean => {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  const close = (u: Vec3, v: Vec3) => Math.abs(u[0] - v[0]) + Math.abs(u[1] - v[1]) + Math.abs(u[2] - v[2]) < 1e-6;
  return close(a.origin, b.origin) && close(a.xDir, b.xDir) && close(a.normal, b.normal);
};

/** A world point in a plane's sketch coordinates (x, y) and its height off the plane (w). */
export const toPlane = (plane: SketchPlane, p: Vec3): { x: number; y: number; w: number } => {
  const f = frameOf(plane);
  const d: Vec3 = [p[0] - f.origin[0], p[1] - f.origin[1], p[2] - f.origin[2]];
  return { x: dot(d, f.xDir), y: dot(d, f.yDir), w: dot(d, f.normal) };
};

/** One step of a path, from the previous point: a straight line, or an arc through `through`. */
export type PathSegment =
  | { kind: 'line'; to: Vec2 }
  | { kind: 'arc'; to: Vec2; through: Vec2 };

export interface PathShape {
  id: string;
  type: 'path';
  plane: SketchPlane;
  /** Drawn on a face of this pull's solid: pulling it out joins that solid, pulling it in cuts it. */
  onFeatureId?: string;
  start: Vec2;
  segments: PathSegment[];
  /** A closed path returns to its start (its last segment ends there). Only closed shapes can be pulled. */
  closed: boolean;
}

export interface CircleShape {
  id: string;
  type: 'circle';
  plane: SketchPlane;
  onFeatureId?: string;
  center: Vec2;
  radius: number;
}

export type SketchShape = PathShape | CircleShape;

/** Pull a closed shape along its plane's normal into a solid (negative pulls the other way).
 *  A shape drawn on a solid's face joins that solid when pulled out (positive)
 *  and cuts into it when pulled in (negative). */
export interface PullFeature {
  id: string;
  type: 'pull';
  shapeId: string;
  distance: number;
}

/** Spin a closed shape around a line in its plane (a column, a rosette, a curved moulding). */
export interface SpinFeature {
  id: string;
  type: 'spin';
  shapeId: string;
  /** Two points on the axis, in the shape's plane. */
  axis: [Vec2, Vec2];
  /** Degrees, counter-clockwise looking down the axis from its second point; 360 is all the way round. */
  angle: number;
}

/** Run a closed profile along a path (a cornice round a room), mitred at the corners.
 *  The profile is used where it is drawn, moved along its plane's normal to the path's start. */
export interface RunFeature {
  id: string;
  type: 'run';
  shapeId: string;
  pathId: string;
}

export type SketchFeature = PullFeature | SpinFeature | RunFeature;

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
export const rectanglePath = (id: string, plane: SketchPlane, a: Vec2, b: Vec2): PathShape => ({
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
export const toWorld = (plane: SketchPlane, p: Vec2): Vec3 => {
  const f = frameOf(plane);
  return [
    f.origin[0] + f.xDir[0] * p.x + f.yDir[0] * p.y,
    f.origin[1] + f.xDir[1] * p.x + f.yDir[1] * p.y,
    f.origin[2] + f.xDir[2] * p.x + f.yDir[2] * p.y,
  ];
};

/** The shapes a pull has turned into solids (they are shown as solids, not lines). */
/** The shapes steps have turned into solids (shown as solids, not lines): profiles, and the paths runs follow. */
export const usedShapeIds = (doc: SketchDoc): Set<string> =>
  new Set(doc.features.flatMap(f => (f.type === 'run' ? [f.shapeId, f.pathId] : [f.shapeId])));

export const canPull = (s: SketchShape): boolean => s.type === 'circle' || (s.closed && s.segments.length >= 2);

// ── Solids built from several steps ─────────────────────────────────────────

/** How to build one solid with OpenCascade, worked out from the steps (no
 *  geometry is made here, so it is quick and testable). The geometry worker
 *  builds each recipe, and reuses the mesh of any recipe it has built before. */
export type Recipe =
  | { op: 'pull'; fid: string; shape: SketchShape; distance: number }
  | { op: 'spin'; fid: string; shape: SketchShape; origin: Vec3; direction: Vec3; angle: number }
  | { op: 'run'; fid: string; shape: SketchShape; path: SketchShape }
  | { op: 'join' | 'cut'; fid: string; a: Recipe; b: Recipe };

export interface PlannedSolid {
  /** The id of the step that made it. */
  id: string;
  recipe: Recipe;
  /** Every step that went into it, in order. */
  featureIds: string[];
  /** The pulls whose outline is still where it was drawn (for telling which one a click landed on). */
  pullIds: string[];
}

export interface SolidPlan {
  solids: PlannedSolid[];
  /** Steps that could not be applied, and why. */
  skipped: Map<string, string>;
}

/** Points along a shape as its first move leaves its start: the start, and a point a little way along. */
const startAndHeading = (s: SketchShape): [Vec3, Vec3] => {
  if (s.type === 'circle') {
    const a = { x: s.center.x + s.radius, y: s.center.y };
    return [toWorld(s.plane, a), toWorld(s.plane, { x: a.x, y: a.y + 1 })];
  }
  const first = s.segments[0];
  const next = !first ? s.start : first.kind === 'line' ? first.to : arcPoints(s.start, first.through, first.to, 48)[0];
  return [toWorld(s.plane, s.start), toWorld(s.plane, next)];
};

/** Whether a spin axis (in the shape's plane) leaves the whole shape on one side; it may run along an edge. */
export const axisClearOfShape = (shape: SketchShape, axis: [Vec2, Vec2]): boolean => {
  const [a, b] = axis;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  let min = Infinity, max = -Infinity;
  for (const p of shapeOutline(shape, 48)) {
    const d = (dx * (p.y - a.y) - dy * (p.x - a.x)) / len;
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  const tol = 1e-3;
  return min >= -tol || max <= tol;
};

/** Works out the solids the steps make, in order. */
export const planSolids = (doc: SketchDoc): SolidPlan => {
  const live = new Map<string, PlannedSolid>();
  // Any step's id (or a solid's) → the solid it now belongs to.
  const owner = new Map<string, string>();
  const skipped = new Map<string, string>();
  const resolve = (id: string | undefined) => {
    const s = id && owner.get(id);
    return s && live.has(s) ? s : undefined;
  };
  const shapeOf = (id: string) => doc.shapes.find(s => s.id === id);

  for (const f of doc.features) {
    const shape = shapeOf(f.shapeId);
    if (!shape) { skipped.set(f.id, 'Its shape was deleted.'); continue; }
    let piece: Recipe;
    if (f.type === 'pull') {
      piece = { op: 'pull', fid: f.id, shape, distance: f.distance };
    } else if (f.type === 'spin') {
      if (!axisClearOfShape(shape, f.axis)) { skipped.set(f.id, 'The axis runs through the shape. Put it to one side (it may run along an edge).'); continue; }
      const o = toWorld(shape.plane, f.axis[0]), e = toWorld(shape.plane, f.axis[1]);
      piece = { op: 'spin', fid: f.id, shape, origin: o, direction: [e[0] - o[0], e[1] - o[1], e[2] - o[2]], angle: f.angle };
    } else {
      const path = shapeOf(f.pathId);
      if (!path) { skipped.set(f.id, 'Its path was deleted.'); continue; }
      if (path.id === shape.id) { skipped.set(f.id, 'The profile and the path must be different shapes.'); continue; }
      const [start, ahead] = startAndHeading(path);
      const frame = frameOf(shape.plane);
      const t: Vec3 = [ahead[0] - start[0], ahead[1] - start[1], ahead[2] - start[2]];
      const tl = Math.hypot(...t) || 1;
      if (Math.abs(dot(t, frame.normal)) / tl < 0.2) { skipped.set(f.id, 'The profile lies along the path. Draw it on a plane across the path’s start.'); continue; }
      // Slide the profile along its plane's normal so it stands at the path's start.
      const w = toPlane(shape.plane, start).w;
      const moved: PlaneFrame = { ...frame, origin: [frame.origin[0] + frame.normal[0] * w, frame.origin[1] + frame.normal[1] * w, frame.origin[2] + frame.normal[2] * w] };
      piece = { op: 'run', fid: f.id, shape: { ...shape, plane: moved }, path };
    }
    // A pull of a shape drawn on a solid's face joins or cuts that solid.
    const target = f.type === 'pull' ? resolve(shape.onFeatureId) : undefined;
    if (target) {
      const solid = live.get(target)!;
      solid.recipe = { op: (piece as { distance: number }).distance < 0 ? 'cut' : 'join', fid: f.id, a: solid.recipe, b: piece };
      solid.featureIds.push(f.id);
      solid.pullIds.push(f.id);
      owner.set(f.id, target);
      continue;
    }
    live.set(f.id, { id: f.id, recipe: piece, featureIds: [f.id], pullIds: f.type === 'pull' ? [f.id] : [] });
    owner.set(f.id, f.id);
  }
  return { solids: [...live.values()], skipped };
};

/** Inside a closed outline, or within `tol` of its edge. */
const insideOrOn = (outline: Vec2[], p: Vec2, tol: number): boolean => {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i], b = outline[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    if (Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) <= tol) return true;
  }
  return inside;
};

/** Which of a solid's pulls made the surface at a world point: the latest
 *  whose pulled outline holds the point (a cut's walls and floor, a joined
 *  block's sides), or null when none does. */
export const pullAtPoint = (doc: SketchDoc, pullIds: string[], p: Vec3, tol = 0.3): string | null => {
  for (const id of [...pullIds].reverse()) {
    const f = doc.features.find((ff): ff is PullFeature => ff.id === id && ff.type === 'pull');
    const shape = f && doc.shapes.find(s => s.id === f.shapeId);
    if (!f || !shape) continue;
    const q = toPlane(shape.plane, p);
    if (q.w < Math.min(0, f.distance) - tol || q.w > Math.max(0, f.distance) + tol) continue;
    if (insideOrOn(shapeOutline(shape, 48), q, tol)) return id;
  }
  return null;
};

/** The given shapes plus every shape drawn, directly or further on, on the solids pulled from them. */
const withDependents = (doc: SketchDoc, shapeIds: Iterable<string>): Set<string> => {
  const out = new Set(shapeIds);
  for (let grew = true; grew;) {
    grew = false;
    const pulls = new Set(doc.features.filter(f => out.has(f.shapeId) || (f.type === 'run' && out.has(f.pathId))).map(f => f.id));
    for (const s of doc.shapes) {
      if (s.onFeatureId && pulls.has(s.onFeatureId) && !out.has(s.id)) { out.add(s.id); grew = true; }
    }
  }
  return out;
};

/** Removes a shape, the steps made from it (a run along it too), and whatever was drawn on their faces. */
export const removeShape = (doc: SketchDoc, shapeId: string): SketchDoc => {
  const gone = withDependents(doc, [shapeId]);
  return {
    ...doc,
    shapes: doc.shapes.filter(s => !gone.has(s.id)),
    features: doc.features.filter(f => !gone.has(f.shapeId) && !(f.type === 'run' && gone.has(f.pathId))),
  };
};

/** Removes one step, leaving its shape (as an outline again), and whatever was drawn on its faces. */
export const removeFeature = (doc: SketchDoc, featureId: string): SketchDoc => {
  let next: SketchDoc = { ...doc, features: doc.features.filter(f => f.id !== featureId) };
  for (const s of doc.shapes) if (s.onFeatureId === featureId && next.shapes.some(x => x.id === s.id)) next = removeShape(next, s.id);
  return next;
};

/** Changes how far a pull goes. Shapes drawn on the end it moves, and
 *  anything built on them, move with that end. */
export const setPullDistance = (doc: SketchDoc, featureId: string, distance: number): SketchDoc => {
  const f = doc.features.find((ff): ff is PullFeature => ff.id === featureId && ff.type === 'pull');
  const shape = f && doc.shapes.find(s => s.id === f.shapeId);
  if (!f || !shape) return doc;
  const features = doc.features.map(ff => (ff.id === featureId ? { ...f, distance } : ff));
  const base = frameOf(shape.plane);
  const onEnd = doc.shapes.filter(s => {
    if (s.onFeatureId !== featureId || typeof s.plane === 'string') return false;
    if (Math.abs(Math.abs(dot(s.plane.normal, base.normal)) - 1) > 1e-6) return false;
    return Math.abs(toPlane(shape.plane, s.plane.origin).w - f.distance) <= 1e-3;
  });
  const moving = withDependents(doc, onEnd.map(s => s.id));
  const delta = distance - f.distance;
  const shift = (o: Vec3): Vec3 => [o[0] + base.normal[0] * delta, o[1] + base.normal[1] * delta, o[2] + base.normal[2] * delta];
  const shapes = doc.shapes.map(s =>
    moving.has(s.id) && typeof s.plane !== 'string' ? { ...s, plane: { ...s.plane, origin: shift(s.plane.origin) } } : s);
  return { ...doc, shapes, features };
};

/** The steps that made pieces of a solid (pulls, spins and runs), in order, as built (a run's profile where it was moved to). */
export type RecipePiece = Exclude<Recipe, { op: 'join' | 'cut' }>;
export const recipePieces = (r: Recipe): RecipePiece[] =>
  'a' in r ? [...recipePieces(r.a), ...recipePieces(r.b)] : [r];

/** A shape in a few words, for the step list: "Rectangle 6" × 4"", "Circle Ø 3"", "Shape, 7 sides". */
export const describeShape = (s: SketchShape, units: SketchUnits): string => {
  if (s.type === 'circle') return `Circle Ø ${formatLength(s.radius * 2, units)}`;
  const pts = [s.start, ...s.segments.map(g => g.to)];
  const square = s.closed && s.segments.length === 4 && s.segments.every(g => g.kind === 'line')
    && s.segments.every((g, i) => { const p = pts[i]; return Math.abs(g.to.x - p.x) < 1e-6 || Math.abs(g.to.y - p.y) < 1e-6; });
  if (square) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return `Rectangle ${formatLength(Math.max(...xs) - Math.min(...xs), units)} × ${formatLength(Math.max(...ys) - Math.min(...ys), units)}`;
  }
  const n = s.segments.length;
  return s.closed ? `Shape, ${n} sides` : `Path, ${n} ${n === 1 ? 'piece' : 'pieces'}`;
};
