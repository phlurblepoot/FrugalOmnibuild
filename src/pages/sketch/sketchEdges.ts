// src/pages/sketch/sketchEdges.ts
// A solid's edges, as the geometry worker meshes them, for the Round tool:
// each edge's line, a point on it that finds it again when the solid is
// rebuilt (see EdgeFeature), and the edges around a face (a click on a face
// picks them all).
import type { SolidMesh } from './geometryTypes';
import type { Vec3 } from './sketchModel';

export const edgeCount = (solid: Pick<SolidMesh, 'edgeRuns'>): number => solid.edgeRuns.length / 2;

/** One edge's segments: xyz xyz per segment. */
export const edgeLine = (solid: Pick<SolidMesh, 'edges' | 'edgeRuns'>, i: number): Float32Array => {
  const start = solid.edgeRuns[2 * i], count = solid.edgeRuns[2 * i + 1];
  return solid.edges.subarray(start * 3, (start + count) * 3);
};

/** A point on an edge away from its ends (which it shares with the edges it meets): the middle of a
 *  straight one, or a point of a curved one's mesh near its middle (those lie on the curve). */
export const edgeRefPoint = (line: Float32Array): Vec3 => {
  const segments = Math.floor(line.length / 6);
  if (segments <= 1) return [(line[0] + line[3]) / 2, (line[1] + line[4]) / 2, (line[2] + line[5]) / 2];
  const k = (2 * (Math.floor(segments / 2) - 1) + 1) * 3; // the end of the segment before the middle one
  return [line[k], line[k + 1], line[k + 2]];
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The distance from a point to a triangle (Ericson, Real-Time Collision Detection 5.1.5). */
export const pointTriangleDistance = (p: Vec3, a: Vec3, b: Vec3, c: Vec3): number => {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (q: Vec3) => Math.hypot(...sub(p, q));
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return at([a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return at([a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return at([b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]);
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return at([a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
};

/** The face (its run of `indices`) that a triangle belongs to. */
export const faceOfTriangle = (solid: Pick<SolidMesh, 'faceRuns' | 'indices'>, triangle: number): { start: number; count: number } => {
  const at = triangle * 3;
  for (let r = 0; r < solid.faceRuns.length; r += 2) {
    if (at >= solid.faceRuns[r] && at < solid.faceRuns[r] + solid.faceRuns[r + 1]) return { start: solid.faceRuns[r], count: solid.faceRuns[r + 1] };
  }
  return { start: 0, count: solid.indices.length };
};

/** The edges around a face: those whose middle lies on it. */
export const edgesOfFace = (solid: SolidMesh, face: { start: number; count: number }, tol = 0.1): number[] => {
  const v = (k: number): Vec3 => [solid.positions[3 * k], solid.positions[3 * k + 1], solid.positions[3 * k + 2]];
  const tris: [Vec3, Vec3, Vec3][] = [];
  for (let i = face.start; i + 2 < face.start + face.count; i += 3) tris.push([v(solid.indices[i]), v(solid.indices[i + 1]), v(solid.indices[i + 2])]);
  const out: number[] = [];
  for (let e = 0; e < edgeCount(solid); e++) {
    const p = edgeRefPoint(edgeLine(solid, e));
    if (tris.some(([a, b, c]) => pointTriangleDistance(p, a, b, c) <= tol)) out.push(e);
  }
  return out;
};
