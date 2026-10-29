// src/pages/sketch/sketchSnap.ts
// Where a click lands on the work plane (see snapPoint), the grid spacing for
// the zoom, and the angle helpers for typed lines. All in sketch-plane millimetres.
import { MM_PER_INCH, type SketchUnits, type Vec2 } from './sketchModel';

const IMPERIAL_STEPS_IN = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 6, 12, 24, 60, 120, 240, 600];
const METRIC_STEPS_MM = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

/** The grid spacing for this zoom: the finest step still at least `minPx` apart on screen. */
export const gridStep = (units: SketchUnits, pxPerMm: number, minPx = 14): number => {
  const steps = units === 'metric' ? METRIC_STEPS_MM : IMPERIAL_STEPS_IN.map(i => i * MM_PER_INCH);
  return steps.find(s => s * pxPerMm >= minPx) ?? steps[steps.length - 1];
};

/** Every how many grid lines a darker one is drawn: each inch on a fine grid,
 *  each foot on an inch grid, every 10 steps otherwise. */
export const majorEvery = (units: SketchUnits, step: number): number => {
  if (units === 'metric') return 10;
  const inches = step / MM_PER_INCH;
  if (inches < 1) return Math.round(1 / inches);
  if (inches < 12) return Math.round(12 / inches);
  return 10;
};

export type SnapKind = 'point' | 'cross' | 'line' | 'guide' | 'angle' | 'grid' | 'free';
export interface Snapped {
  p: Vec2;
  kind: SnapKind;
  /** Points a dashed level or plumb guide runs from, to `p`. */
  guides?: Vec2[];
}

/** What a point can snap to on the work plane. */
export interface SnapTargets {
  /** Shape corners and ends, the plane's origin and the shape being drawn: always snapped to. */
  ends: Vec2[];
  /** Midpoints and centres: snapped to with Shift. */
  extras: Vec2[];
  /** The straight pieces of every outline: with Shift, a point lands on them or where they cross. */
  segments: [Vec2, Vec2][];
}

const roundTo = (v: number, step: number) => Math.round(v / step) * step;
const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);

const closestOnSegment = (p: Vec2, [a, b]: [Vec2, Vec2]): Vec2 => {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
};

/** Where line a1→a2 meets line b1→b2 (both taken as endless lines), or null when parallel. */
const lineCross = (a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null => {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y, d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
};

const onSegment = (p: Vec2, [a, b]: [Vec2, Vec2], tol: number) => {
  const q = closestOnSegment(p, [a, b]);
  return Math.hypot(q.x - p.x, q.y - p.y) <= tol;
};

/**
 * Where a click lands on the work plane, in order:
 * - Alt (`free`): exactly where the pointer is.
 * - Ctrl (`angleStep`): along the nearest of every `angleStep` degrees from the
 *   previous point, at a grid length (or, with Shift too, where that line
 *   meets a guide or an outline).
 * - an end point close to the pointer;
 * - with Shift (`shapes`): a midpoint or centre; where outlines and level or
 *   plumb guides through existing points cross; a point on an outline; a guide.
 * - else the grid.
 */
export const snapPoint = (opts: {
  raw: Vec2;
  pxPerMm: number;
  step: number;
  targets: SnapTargets;
  /** The previous point of the shape being drawn, for the angle lock. */
  from?: Vec2;
  shapes?: boolean;
  angleStep?: number | null;
  free?: boolean;
  reachPx?: number;
}): Snapped => {
  const { raw, pxPerMm, step, targets, from, shapes, angleStep, free } = opts;
  if (free) return { p: raw, kind: 'free' };
  const reach = (opts.reachPx ?? 10) / pxPerMm;
  const guideFrom = shapes ? [...targets.ends, ...targets.extras] : [];

  if (angleStep && from) {
    const dx = raw.x - from.x, dy = raw.y - from.y;
    if (Math.hypot(dx, dy) > 0) {
      const stepRad = (angleStep * Math.PI) / 180;
      const locked = Math.round(Math.atan2(dy, dx) / stepRad) * stepRad;
      const u = { x: clean(Math.cos(locked)), y: clean(Math.sin(locked)) };
      const t0 = dx * u.x + dy * u.y;
      const along = (t: number) => ({ x: from.x + t * u.x, y: from.y + t * u.y });
      if (shapes) {
        let best: { t: number; guide?: Vec2 } | null = null;
        let bestD = reach;
        const consider = (t: number, guide?: Vec2) => {
          if (t > 1e-9 && Math.abs(t - t0) <= bestD) { best = { t, guide }; bestD = Math.abs(t - t0); }
        };
        for (const g of guideFrom) {
          if (Math.abs(u.x) > 1e-9) consider((g.x - from.x) / u.x, g);
          if (Math.abs(u.y) > 1e-9) consider((g.y - from.y) / u.y, g);
        }
        const far = along(1);
        for (const seg of targets.segments) {
          const c = lineCross(from, far, seg[0], seg[1]);
          if (c && onSegment(c, seg, 1e-6)) consider((c.x - from.x) * u.x + (c.y - from.y) * u.y);
        }
        if (best) {
          const b = best as { t: number; guide?: Vec2 };
          return { p: along(b.t), kind: 'angle', guides: b.guide ? [b.guide] : undefined };
        }
      }
      return { p: along(Math.max(step, roundTo(t0, step))), kind: 'angle' };
    }
  }

  const nearest = (pts: Vec2[]) => {
    let best: Vec2 | null = null;
    let bestD = reach;
    for (const t of pts) {
      const d = Math.hypot(t.x - raw.x, t.y - raw.y);
      if (d <= bestD) { best = t; bestD = d; }
    }
    return best as Vec2 | null;
  };
  const point = nearest(shapes ? guideFrom : targets.ends);
  if (point) return { p: { ...point }, kind: 'point' };

  if (shapes) {
    const near = targets.segments.filter(seg => onSegment(raw, seg, reach));
    let gx: Vec2 | null = null, gy: Vec2 | null = null;
    for (const g of guideFrom) {
      if (Math.abs(g.x - raw.x) <= reach && (!gx || Math.abs(g.x - raw.x) < Math.abs(gx.x - raw.x))) gx = g;
      if (Math.abs(g.y - raw.y) <= reach && (!gy || Math.abs(g.y - raw.y) < Math.abs(gy.y - raw.y))) gy = g;
    }
    // Crossings: two outlines, an outline and a guide, or two guides.
    let cross: Snapped | null = null;
    let crossD = reach * Math.SQRT2;
    const take = (c: Vec2 | null, guides?: Vec2[]) => {
      if (!c) return;
      const d = Math.hypot(c.x - raw.x, c.y - raw.y);
      if (d <= crossD) { cross = { p: c, kind: 'cross', guides }; crossD = d; }
    };
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const c = lineCross(near[i][0], near[i][1], near[j][0], near[j][1]);
        if (c && onSegment(c, near[i], 1e-6) && onSegment(c, near[j], 1e-6)) take(c);
      }
      if (gx) { const c = lineCross(near[i][0], near[i][1], gx, { x: gx.x, y: gx.y + 1 }); if (c && onSegment(c, near[i], 1e-6)) take(c, [gx]); }
      if (gy) { const c = lineCross(near[i][0], near[i][1], gy, { x: gy.x + 1, y: gy.y }); if (c && onSegment(c, near[i], 1e-6)) take(c, [gy]); }
    }
    if (gx && gy) take({ x: gx.x, y: gy.y }, [gx, gy]);
    if (cross) return cross;
    if (near.length) {
      let best = closestOnSegment(raw, near[0]);
      for (const seg of near.slice(1)) {
        const q = closestOnSegment(raw, seg);
        if (Math.hypot(q.x - raw.x, q.y - raw.y) < Math.hypot(best.x - raw.x, best.y - raw.y)) best = q;
      }
      return { p: best, kind: 'line' };
    }
    if (gx) return { p: { x: gx.x, y: roundTo(raw.y, step) }, kind: 'guide', guides: [gx] };
    if (gy) return { p: { x: roundTo(raw.x, step), y: gy.y }, kind: 'guide', guides: [gy] };
  }
  return { p: { x: roundTo(raw.x, step), y: roundTo(raw.y, step) }, kind: 'grid' };
};

/** The direction (degrees counter-clockwise from the plane's x) of an angle
 *  typed as "measured from level": it opens toward the side `toward` points
 *  to, so 45 with the pointer up and to the left goes up-left. */
export const levelAngleToward = (deg: number, toward: Vec2): number => {
  const r = (deg * Math.PI) / 180;
  const sx = toward.x < 0 ? -1 : 1, sy = toward.y < 0 ? -1 : 1;
  const d = (Math.atan2(sy * Math.sin(r), sx * Math.cos(r)) * 180) / Math.PI;
  const n = Math.round((d < 0 ? d + 360 : d) * 1e9) / 1e9;
  return n === 360 ? 0 : n;
};

/** How far the line a→b is from level, 0° to 90°. */
export const angleFromLevel = (a: Vec2, b: Vec2): number =>
  (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;

/** Angle in degrees (0 = along the plane's x, counter-clockwise) from a to b. */
export const angleDeg = (a: Vec2, b: Vec2): number => {
  const d = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
};

/** The point `length` mm from `from` at `deg` degrees. */
export const pointAt = (from: Vec2, length: number, deg: number): Vec2 => {
  const r = (deg * Math.PI) / 180;
  // Clean up float noise at the right angles, so 90° is exactly straight up.
  const c = Math.abs(Math.cos(r)) < 1e-12 ? 0 : Math.cos(r);
  const s = Math.abs(Math.sin(r)) < 1e-12 ? 0 : Math.sin(r);
  return { x: from.x + length * c, y: from.y + length * s };
};

/** Parses a typed angle in degrees ("45", "45°", "-30"); null when it is not one. */
export const parseAngle = (input: string): number | null => {
  const m = input.trim().replace(/°$/, '').match(/^[-−]?\d+(?:\.\d+)?$/);
  if (!m) return null;
  return parseFloat(m[0].replace('−', '-'));
};
