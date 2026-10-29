// src/pages/sketch/geometryTypes.ts
// Messages between the sketch editor and its geometry worker.
import type { SketchDoc } from './sketchModel';

/** One solid: a pull, plus the pulls of shapes drawn on its faces joined to or cut from it. */
export interface SolidMesh {
  /** The solid's first pull. */
  featureId: string;
  /** Every pull that built it, in order (the first is `featureId`). */
  featureIds: string[];
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
  /** Pulls that could not be built (the rest still show). */
  errors: { featureId: string; message: string }[];
  /** The engine itself failed to load or run. */
  fatal?: string;
}
