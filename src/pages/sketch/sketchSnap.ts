// src/pages/sketch/sketchSnap.ts
// Where a click lands on the work plane: on an existing point when one is
// close, else along a 45°/90° line from the previous point when the pointer is
// nearly on one, else on the grid. All in sketch-plane millimetres.
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

export type SnapKind = 'point' | 'angle' | 'grid' | 'free';
export interface Snapped { p: Vec2; kind: SnapKind }

const roundTo = (v: number, step: number) => Math.round(v / step) * step;

export const snapPoint = (opts: {
  raw: Vec2;
  pxPerMm: number;
  step: number;
  /** Points on existing shapes and in the shape being drawn. */
  targets: Vec2[];
  /** The previous point of the shape being drawn, for the angle lock. */
  from?: Vec2;
  /** Hold-to-disable (Alt): the raw point, unsnapped. */
  free?: boolean;
  pointRadiusPx?: number;
  angleTolDeg?: number;
}): Snapped => {
  const { raw, pxPerMm, step, targets, from, free } = opts;
  if (free) return { p: raw, kind: 'free' };
  const reach = (opts.pointRadiusPx ?? 10) / pxPerMm;
  let best: Vec2 | null = null;
  let bestD = reach;
  for (const t of targets) {
    const d = Math.hypot(t.x - raw.x, t.y - raw.y);
    if (d <= bestD) { best = t; bestD = d; }
  }
  if (best) return { p: { ...best }, kind: 'point' };

  if (from) {
    const dx = raw.x - from.x, dy = raw.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      const ang = Math.atan2(dy, dx);
      const locked = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(ang - locked) <= ((opts.angleTolDeg ?? 4) * Math.PI) / 180) {
        const l = roundTo(len * Math.cos(ang - locked), step);
        return { p: { x: from.x + l * Math.cos(locked), y: from.y + l * Math.sin(locked) }, kind: 'angle' };
      }
    }
  }
  return { p: { x: roundTo(raw.x, step), y: roundTo(raw.y, step) }, kind: 'grid' };
};

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
