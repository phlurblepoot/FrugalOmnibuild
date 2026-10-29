// src/pages/sketch/geometry.worker.ts
// Builds a sketch's solids with OpenCascade (through replicad) off the main
// thread and hands back triangle meshes and edge lines for three.js to draw.
// The ~23 MB engine loads on the first build only.
/// <reference lib="webworker" />
import opencascade from 'replicad-opencascadejs';
// @ts-ignore — Vite turns ?url imports into the emitted asset's URL
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC, draw, drawCircle, Plane, type Drawing } from 'replicad';
import { PLANES, type SketchDoc, type SketchShape } from './sketchModel';
import type { BuildRequest, BuildResponse, SolidMesh } from './geometryTypes';

let engine: Promise<void> | null = null;
const loadEngine = () => (engine ??= (async () => {
  const oc = await (opencascade as unknown as (o: { locateFile: () => string }) => Promise<unknown>)({ locateFile: () => wasmUrl as string });
  setOC(oc as Parameters<typeof setOC>[0]);
})());

const drawingFor = (s: SketchShape): Drawing => {
  if (s.type === 'circle') return drawCircle(s.radius).translate(s.center.x, s.center.y);
  let pen = draw([s.start.x, s.start.y]);
  for (const seg of s.segments) {
    pen = seg.kind === 'line'
      ? pen.lineTo([seg.to.x, seg.to.y])
      : pen.threePointsArcTo([seg.to.x, seg.to.y], [seg.through.x, seg.through.y]);
  }
  return pen.close(); // adds no edge when the path already ends at its start
};

// A solid's mesh depends only on its shape and pull, so unchanged ones are
// reused between builds instead of being rebuilt on every edit.
const cache = new Map<string, Omit<SolidMesh, 'featureId'>>();

const buildPull = (shape: SketchShape, distance: number): Omit<SolidMesh, 'featureId'> => {
  const key = JSON.stringify([shape, distance]);
  const hit = cache.get(key);
  if (hit) return hit;
  const f = PLANES[shape.plane];
  const plane = new Plane(f.origin, f.xDir, f.normal);
  const sketch = drawingFor(shape).sketchOnPlane(plane) as unknown as { extrude: (d: number) => SolidLike };
  const solid = sketch.extrude(distance);
  try {
    const mesh = solid.mesh({ tolerance: 0.05, angularTolerance: 0.1 });
    const edges = solid.meshEdges({ tolerance: 0.05, angularTolerance: 0.1 });
    const out = {
      positions: new Float32Array(mesh.vertices),
      normals: new Float32Array(mesh.normals),
      indices: new Uint32Array(mesh.triangles),
      edges: new Float32Array(edges.lines),
    };
    cache.set(key, out);
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return out;
  } finally {
    solid.delete();
  }
};

interface SolidLike {
  mesh(o: { tolerance: number; angularTolerance: number }): { vertices: number[]; normals: number[]; triangles: number[] };
  meshEdges(o: { tolerance: number; angularTolerance: number }): { lines: number[] };
  delete(): void;
}

const build = (doc: SketchDoc): Omit<BuildResponse, 'requestId'> => {
  const solids: SolidMesh[] = [];
  const errors: BuildResponse['errors'] = [];
  for (const f of doc.features) {
    const shape = doc.shapes.find(s => s.id === f.shapeId);
    if (!shape) continue;
    try {
      solids.push({ featureId: f.id, ...buildPull(shape, f.distance) });
    } catch (e) {
      errors.push({ featureId: f.id, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { solids, errors };
};

self.onmessage = async (event: MessageEvent<BuildRequest>) => {
  const { requestId, doc } = event.data;
  try {
    await loadEngine();
    const result = build(doc);
    // Copies, so the cached arrays stay usable after the transfer.
    const solids = result.solids.map(s => ({
      ...s, positions: s.positions.slice(), normals: s.normals.slice(), indices: s.indices.slice(), edges: s.edges.slice(),
    }));
    const transfer = solids.flatMap(s => [s.positions.buffer, s.normals.buffer, s.indices.buffer, s.edges.buffer]);
    (self as unknown as Worker).postMessage({ requestId, solids, errors: result.errors } satisfies BuildResponse, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      requestId, solids: [], errors: [], fatal: e instanceof Error ? e.message : String(e),
    } satisfies BuildResponse);
  }
};
