// src/pages/sketch/geometryTypes.ts
// Messages between the sketch editor and its geometry worker.
import type { SketchDoc } from './sketchModel';

/** One solid, as planned by planSolids. */
export interface SolidMesh {
  /** The id of the step that made it. */
  solidId: string;
  /** Every step that went into it, in order. */
  featureIds: string[];
  /** The pulls whose outline is still where it was drawn (for telling which one a click landed on). */
  pullIds: string[];
  /** xyz per vertex, world mm (z up). */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Each face of the solid as a run of `indices`: start, count, start, count, … */
  faceRuns: Uint32Array;
  /** The solid's true edges as line segments: xyz xyz per segment. */
  edges: Float32Array;
}

export interface BuildRequest { requestId: number; doc: SketchDoc }

export interface BuildResponse {
  requestId: number;
  solids: SolidMesh[];
  /** Steps that could not be built (the rest still show). */
  errors: { featureId: string; message: string }[];
  /** The engine itself failed to load or run. */
  fatal?: string;
}
