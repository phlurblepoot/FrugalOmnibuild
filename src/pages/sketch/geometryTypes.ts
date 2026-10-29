// src/pages/sketch/geometryTypes.ts
// Messages between the sketch editor and its geometry worker.
import type { SketchDoc } from './sketchModel';

export interface SolidMesh {
  featureId: string;
  /** xyz per vertex, world mm (z up). */
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
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
