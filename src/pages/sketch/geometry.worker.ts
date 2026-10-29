// src/pages/sketch/geometry.worker.ts
// Builds a sketch's solids with OpenCascade (through replicad) off the main
// thread and hands back triangle meshes and edge lines for three.js to draw.
// Pulls of shapes drawn on a solid's faces are joined to it or cut from it.
// The ~23 MB engine loads on the first build only.
/// <reference lib="webworker" />
import opencascade from 'replicad-opencascadejs';
// @ts-ignore — Vite turns ?url imports into the emitted asset's URL
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC, draw, drawCircle, Plane, type Drawing } from 'replicad';
import { frameOf, solidOfPull, type PullFeature, type SketchDoc, type SketchShape } from './sketchModel';
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

interface SolidLike {
  fuse(other: SolidLike): SolidLike;
  cut(tool: SolidLike): SolidLike;
  mesh(o: { tolerance: number; angularTolerance: number }): {
    vertices: number[]; normals: number[]; triangles: number[]; faceGroups: { start: number; count: number }[];
  };
  meshEdges(o: { tolerance: number; angularTolerance: number }): { lines: number[] };
  delete(): void;
}

const pullShape = (shape: SketchShape, distance: number): SolidLike => {
  const f = frameOf(shape.plane);
  const plane = new Plane(f.origin, f.xDir, f.normal);
  const sketch = drawingFor(shape).sketchOnPlane(plane) as unknown as { extrude: (d: number) => SolidLike };
  return sketch.extrude(distance);
};

type Built = { mesh: Omit<SolidMesh, 'featureId' | 'featureIds'> | null; errors: BuildResponse['errors'] };

// A solid's mesh depends only on its pulls and their shapes, so unchanged
// ones are reused between builds instead of being rebuilt on every edit.
const cache = new Map<string, Built>();

/** One solid from its pulls in order: the first makes it, each later one
 *  (drawn on one of its faces) joins it when pulled out or cuts it when pulled in. */
const buildSolid = (pulls: { feature: PullFeature; shape: SketchShape }[]): Built => {
  const key = JSON.stringify(pulls);
  const hit = cache.get(key);
  if (hit) return hit;
  const errors: BuildResponse['errors'] = [];
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let body: SolidLike | null = null;
  for (const { feature, shape } of pulls) {
    let piece: SolidLike;
    try {
      piece = pullShape(shape, feature.distance);
    } catch (e) {
      errors.push({ featureId: feature.id, message: message(e) });
      continue;
    }
    if (!body) { body = piece; continue; }
    try {
      const next: SolidLike = feature.distance < 0 ? body.cut(piece) : body.fuse(piece);
      body.delete();
      body = next;
    } catch (e) {
      errors.push({ featureId: feature.id, message: message(e) });
    } finally {
      piece.delete();
    }
  }
  let mesh: Built['mesh'] = null;
  if (body) {
    try {
      const m = body.mesh({ tolerance: 0.05, angularTolerance: 0.1 });
      const edges = body.meshEdges({ tolerance: 0.05, angularTolerance: 0.1 });
      mesh = {
        positions: new Float32Array(m.vertices),
        normals: new Float32Array(m.normals),
        indices: new Uint32Array(m.triangles),
        faceRuns: new Uint32Array(m.faceGroups.flatMap(g => [g.start, g.count])),
        edges: new Float32Array(edges.lines),
      };
    } finally {
      body.delete();
    }
  }
  const out = { mesh, errors };
  cache.set(key, out);
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return out;
};

const build = (doc: SketchDoc): Omit<BuildResponse, 'requestId'> => {
  const solidOf = solidOfPull(doc);
  const groups = new Map<string, { feature: PullFeature; shape: SketchShape }[]>();
  for (const feature of doc.features) {
    const shape = doc.shapes.find(s => s.id === feature.shapeId);
    if (!shape) continue;
    const root = solidOf.get(feature.id) ?? feature.id;
    const list = groups.get(root) ?? [];
    list.push({ feature, shape });
    groups.set(root, list);
  }
  const solids: SolidMesh[] = [];
  const errors: BuildResponse['errors'] = [];
  for (const [root, pulls] of groups) {
    try {
      const built = buildSolid(pulls);
      errors.push(...built.errors);
      if (built.mesh) solids.push({ featureId: root, featureIds: pulls.map(p => p.feature.id), ...built.mesh });
    } catch (e) {
      errors.push({ featureId: root, message: e instanceof Error ? e.message : String(e) });
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
      ...s, positions: s.positions.slice(), normals: s.normals.slice(), indices: s.indices.slice(), faceRuns: s.faceRuns.slice(), edges: s.edges.slice(),
    }));
    const transfer = solids.flatMap(s => [s.positions.buffer, s.normals.buffer, s.indices.buffer, s.faceRuns.buffer, s.edges.buffer]);
    (self as unknown as Worker).postMessage({ requestId, solids, errors: result.errors } satisfies BuildResponse, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      requestId, solids: [], errors: [], fatal: e instanceof Error ? e.message : String(e),
    } satisfies BuildResponse);
  }
};
