// src/pages/sketch/sketchTools.ts
// What the drawing tools do with each click, kept free of the 3D view so it
// can be tested: a click (already snapped, in sketch-plane mm) moves the draft
// on, and sometimes finishes a shape.
import {
  dist2, rectanglePath, samePoint,
  type CircleShape, type PathSegment, type PathShape, type SketchPlane, type SketchShape, type Vec2,
} from './sketchModel';
import { pointAt } from './sketchSnap';

export type ToolId = 'select' | 'line' | 'rect' | 'circle' | 'pull' | 'spin' | 'run' | 'combine' | 'move' | 'rotate' | 'mirror';

export type Draft =
  /** A chain of lines and arcs. `arcThrough` is set while an arc waits for its end. */
  | { tool: 'line'; plane: SketchPlane; start: Vec2; segments: PathSegment[]; arcThrough?: Vec2 }
  | { tool: 'rect'; plane: SketchPlane; a: Vec2 }
  | { tool: 'circle'; plane: SketchPlane; center: Vec2 }
  /** Pulling a shape (featureId set when re-pulling an existing solid). */
  | { tool: 'pull'; shapeId: string; featureId?: string; distance: number }
  /** Spinning a shape: picked, then the axis's first point (`a`), then its second. */
  | { tool: 'spin'; shapeId: string; a?: Vec2 }
  /** Running a profile along a path: the profile is picked, the path comes next. */
  | { tool: 'run'; shapeId: string }
  /** Joining or cutting: the first solid is picked, the second comes next. */
  | { tool: 'combine'; targetId: string }
  /** Moving a solid: picked, then the point it moves from. */
  | { tool: 'move'; solidId: string; from?: Vec2 }
  /** Turning a solid: picked, then the point it turns round (on the work plane, about its normal). */
  | { tool: 'rotate'; solidId: string; pivot?: Vec2 }
  /** Mirroring a solid: picked, then the mirror line's first point. */
  | { tool: 'mirror'; solidId: string; a?: Vec2 };

export interface Step { draft: Draft | null; commit?: SketchShape }

const lastPoint = (d: Extract<Draft, { tool: 'line' }>): Vec2 =>
  d.segments.length ? d.segments[d.segments.length - 1].to : d.start;

/** A click with the Line tool. In arc mode the first click sets a point the
 *  arc passes through and the second its end. Landing back on the start
 *  closes the shape. */
export const lineClick = (draft: Draft | null, p: Vec2, plane: SketchPlane, arcMode: boolean, newId: () => string): Step => {
  if (!draft || draft.tool !== 'line') return { draft: { tool: 'line', plane, start: p, segments: [] } };
  const prev = lastPoint(draft);
  if (samePoint(prev, p)) return { draft };
  let seg: PathSegment;
  if (arcMode) {
    if (!draft.arcThrough) return { draft: { ...draft, arcThrough: p } };
    if (samePoint(draft.arcThrough, p)) return { draft };
    seg = { kind: 'arc', to: p, through: draft.arcThrough };
  } else {
    seg = { kind: 'line', to: p };
  }
  const segments = [...draft.segments, seg];
  if (samePoint(p, draft.start) && (segments.length >= 2 || seg.kind === 'arc')) {
    return {
      draft: null,
      commit: { id: newId(), type: 'path', plane: draft.plane, start: draft.start, segments, closed: true },
    };
  }
  return { draft: { tool: 'line', plane: draft.plane, start: draft.start, segments } };
};

/** Enter / double-click: keep what is drawn as an open path (not pullable). */
export const lineFinish = (draft: Draft | null, newId: () => string): Step => {
  if (!draft || draft.tool !== 'line' || draft.segments.length === 0) return { draft: null };
  const shape: PathShape = { id: newId(), type: 'path', plane: draft.plane, start: draft.start, segments: draft.segments, closed: false };
  return { draft: null, commit: shape };
};

/** Backspace: undo the last click of the shape being drawn. */
export const lineBack = (draft: Draft | null): Draft | null => {
  if (!draft || draft.tool !== 'line') return draft;
  if (draft.arcThrough) return { ...draft, arcThrough: undefined };
  if (draft.segments.length === 0) return null;
  return { ...draft, segments: draft.segments.slice(0, -1) };
};

/** A typed length (and angle) for the next line of the chain. */
export const lineTyped = (draft: Draft | null, length: number, angleDeg: number, newId: () => string): Step => {
  if (!draft || draft.tool !== 'line') return { draft };
  const p = pointAt(lastPoint(draft), length, angleDeg);
  return lineClick({ ...draft, arcThrough: undefined }, p, draft.plane, false, newId);
};

export const rectClick = (draft: Draft | null, p: Vec2, plane: SketchPlane, newId: () => string): Step => {
  if (!draft || draft.tool !== 'rect') return { draft: { tool: 'rect', plane, a: p } };
  if (Math.abs(p.x - draft.a.x) < 1e-6 || Math.abs(p.y - draft.a.y) < 1e-6) return { draft };
  return { draft: null, commit: rectanglePath(newId(), draft.plane, draft.a, p) };
};

/** Typed width and height; `toward` (the pointer) picks which way from the first corner. */
export const rectTyped = (draft: Draft | null, width: number, height: number, toward: Vec2 | null, newId: () => string): Step => {
  if (!draft || draft.tool !== 'rect' || width === 0 || height === 0) return { draft };
  const sx = toward && toward.x < draft.a.x ? -1 : 1;
  const sy = toward && toward.y < draft.a.y ? -1 : 1;
  return rectClick(draft, { x: draft.a.x + sx * Math.abs(width), y: draft.a.y + sy * Math.abs(height) }, draft.plane, newId);
};

export const circleClick = (draft: Draft | null, p: Vec2, plane: SketchPlane, newId: () => string): Step => {
  if (!draft || draft.tool !== 'circle') return { draft: { tool: 'circle', plane, center: p } };
  return circleTyped(draft, dist2(draft.center, p), newId);
};

export const circleTyped = (draft: Draft | null, radius: number, newId: () => string): Step => {
  if (!draft || draft.tool !== 'circle' || !(radius > 0)) return { draft };
  const shape: CircleShape = { id: newId(), type: 'circle', plane: draft.plane, center: draft.center, radius: Math.abs(radius) };
  return { draft: null, commit: shape };
};

/** The outline to show for a draft while the pointer is at `at` (open path, plane mm). */
export const draftPreview = (draft: Draft | null, at: Vec2 | null): SketchShape | null => {
  if (!draft || (draft.tool !== 'line' && draft.tool !== 'rect' && draft.tool !== 'circle')) return null;
  if (draft.tool === 'rect') return at ? rectanglePath('preview', draft.plane, draft.a, at) : null;
  if (draft.tool === 'circle') return at ? { id: 'preview', type: 'circle', plane: draft.plane, center: draft.center, radius: dist2(draft.center, at) } : null;
  const segments = [...draft.segments];
  if (at) {
    if (draft.arcThrough) segments.push({ kind: 'arc', to: at, through: draft.arcThrough });
    else if (!samePoint(at, lastPoint(draft))) segments.push({ kind: 'line', to: at });
  }
  return { id: 'preview', type: 'path', plane: draft.plane, start: draft.start, segments, closed: false };
};

export { lastPoint as draftLastPoint };
