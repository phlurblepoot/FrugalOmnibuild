// src/pages/sketch/sketchEdges.test.ts
import { describe, it, expect } from 'vitest';
import type { SolidMesh } from './geometryTypes';
import { edgeCount, edgeLine, edgeRefPoint, edgesOfFace, faceOfTriangle, pointTriangleDistance } from './sketchEdges';
import { toggleEdge, toggleFaceEdges, type PickedEdge } from './sketchTools';

/** A 100 × 50 × 30 block as the geometry worker meshes it: the top face (two triangles), and three of its edges. */
const block = (): SolidMesh => ({
  solidId: 'pa', featureIds: ['pa'], pullIds: ['pa'],
  positions: new Float32Array([0, 0, 30, 100, 0, 30, 100, 50, 30, 0, 50, 30, 0, 0, 0, 100, 0, 0]),
  normals: new Float32Array(18),
  // Top (z = 30), then the front (y = 0).
  indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 1, 4, 1, 0]),
  faceRuns: new Uint32Array([0, 6, 6, 6]),
  edges: new Float32Array([
    0, 0, 30, 100, 0, 30, // front top edge
    100, 0, 30, 100, 50, 30, // right top edge
    0, 0, 0, 100, 0, 0, // front bottom edge
    // A quarter circle (centre 0,0,0, radius 10) in three pieces, as a curve comes.
    10, 0, 0, 7.071, 7.071, 0, 7.071, 7.071, 0, 0, 10, 0, 0, 10, 0, -7.071, 7.071, 0,
  ]),
  edgeRuns: new Uint32Array([0, 2, 2, 2, 4, 2, 6, 6]),
});

describe('solid edges', () => {
  it('reads each edge and a point on it away from its ends', () => {
    const s = block();
    expect(edgeCount(s)).toBe(4);
    expect([...edgeLine(s, 1)]).toEqual([100, 0, 30, 100, 50, 30]);
    expect(edgeRefPoint(edgeLine(s, 0))).toEqual([50, 0, 30]); // a straight edge's middle
    // A curved edge: one of its mesh points (on the curve), not the middle of a chord.
    const p = edgeRefPoint(edgeLine(s, 3));
    expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 2);
    expect(p).not.toEqual([10, 0, 0]);
  });

  it('measures how far a point is from a triangle', () => {
    expect(pointTriangleDistance([1, 1, 5], [0, 0, 0], [10, 0, 0], [0, 10, 0])).toBeCloseTo(5);
    expect(pointTriangleDistance([-3, -4, 0], [0, 0, 0], [10, 0, 0], [0, 10, 0])).toBeCloseTo(5);
    expect(pointTriangleDistance([5, 5, 0], [0, 0, 0], [10, 0, 0], [0, 10, 0])).toBeCloseTo(0);
  });

  it('finds the edges round a face', () => {
    const s = block();
    expect(faceOfTriangle(s, 1)).toEqual({ start: 0, count: 6 });
    expect(faceOfTriangle(s, 2)).toEqual({ start: 6, count: 6 });
    expect(edgesOfFace(s, { start: 0, count: 6 })).toEqual([0, 1]); // the top: its front and right edges
    expect(edgesOfFace(s, { start: 6, count: 6 })).toEqual([0, 2]); // the front: its top and bottom edges
  });

  it('picks an edge, or leaves it out again; a face picks all its edges, or leaves them all out', () => {
    const e = (index: number): PickedEdge => ({ index, point: [index, 0, 0], line: new Float32Array(6) });
    let picks = toggleEdge([], e(1));
    picks = toggleEdge(picks, e(2));
    expect(picks.map(p => p.index)).toEqual([1, 2]);
    expect(toggleEdge(picks, e(1)).map(p => p.index)).toEqual([2]);
    picks = toggleFaceEdges(picks, [e(2), e(3)]);
    expect(picks.map(p => p.index)).toEqual([1, 2, 3]);
    expect(toggleFaceEdges(picks, [e(2), e(3)]).map(p => p.index)).toEqual([1]);
  });
});
