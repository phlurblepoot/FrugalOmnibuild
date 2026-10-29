// src/pages/sketch/geometry.worker.ts
// Builds a sketch's solids with OpenCascade (through replicad) off the main
// thread and hands back triangle meshes and edge lines for three.js to draw.
// Each solid is built from its recipe (see planSolids): pulls, spins and
// runs, with shapes drawn on its faces joined to it or cut from it.
// The ~23 MB engine loads on the first build only.
/// <reference lib="webworker" />
import opencascade from 'replicad-opencascadejs';
// @ts-ignore — Vite turns ?url imports into the emitted asset's URL
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC, draw, drawCircle, genericSweep, makeCompound, makeProjectedEdges, Plane, ProjectionCamera, type Drawing } from 'replicad';
import { frameOf, planSolids, type Recipe, type SketchDoc, type SketchShape, type Transform, type Vec3 } from './sketchModel';
import type { BuildRequest, BuildResponse, ProjectRequest, ProjectResponse, ProjectedView, SolidMesh } from './geometryTypes';

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
  clone(): SolidLike;
  translate(v: Vec3): SolidLike;
  rotate(angle: number, origin: Vec3, axis: Vec3): SolidLike;
  mirror(normal: Vec3, origin: Vec3): SolidLike;
  mesh(o: { tolerance: number; angularTolerance: number }): {
    vertices: number[]; normals: number[]; triangles: number[]; faceGroups: { start: number; count: number }[];
  };
  meshEdges(o: { tolerance: number; angularTolerance: number }): { lines: number[] };
  delete(): void;
}
interface SketchLike {
  wire: unknown;
  extrude(d: number): SolidLike;
  revolve(axis: Vec3, o: { origin: Vec3; angle: number }): SolidLike;
  delete(): void;
}

const sketchOf = (shape: SketchShape): SketchLike => {
  const f = frameOf(shape.plane);
  return drawingFor(shape).sketchOnPlane(new Plane(f.origin, f.xDir, f.normal)) as unknown as SketchLike;
};

/** An open path's drawing (a closed one, or a circle, closes as usual). */
const pathDrawingFor = (s: SketchShape): Drawing => {
  if (s.type === 'circle' || s.closed) return drawingFor(s);
  let pen = draw([s.start.x, s.start.y]);
  for (const seg of s.segments) {
    pen = seg.kind === 'line'
      ? pen.lineTo([seg.to.x, seg.to.y])
      : pen.threePointsArcTo([seg.to.x, seg.to.y], [seg.through.x, seg.through.y]);
  }
  return pen.done();
};

type Errors = BuildResponse['errors'];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Within one build, the solid a move or copy starts from is made once and
// cloned after that (a solid and its copies share it).
let made = new Map<string, SolidLike>();
const shared = (r: Recipe, errors: Errors): SolidLike | null => {
  const key = JSON.stringify(r);
  const hit = made.get(key);
  if (hit) return hit.clone();
  const out = make(r, errors);
  if (out) made.set(key, out.clone());
  return out;
};

const transformed = (s: SolidLike, t: Transform, times: number): SolidLike => {
  if (t.kind === 'move') return s.translate([t.by[0] * times, t.by[1] * times, t.by[2] * times]);
  if (t.kind === 'rotate') return s.rotate(t.angle * times, t.origin, t.axis);
  return s.mirror(t.normal, t.origin);
};

/** Builds a recipe into a new OpenCascade solid (the caller deletes it), or null when it cannot be built. */
const make = (r: Recipe, errors: Errors): SolidLike | null => {
  try {
    switch (r.op) {
      case 'transform': {
        const s = shared(r.of, errors);
        if (!s) return null;
        try {
          return transformed(s, r.t, r.times); // replicad deletes the original
        } catch (e) {
          errors.push({ featureId: r.fid, message: message(e) });
          s.delete();
          return null;
        }
      }
      case 'pull':
        return sketchOf(r.shape).extrude(r.distance);
      case 'spin':
        return sketchOf(r.shape).revolve(r.direction, { origin: r.origin, angle: r.angle });
      case 'run': {
        const f = frameOf(r.path.plane);
        const spine = (pathDrawingFor(r.path).sketchOnPlane(new Plane(f.origin, f.xDir, f.normal)) as unknown as SketchLike).wire;
        // Right corners: each straight run meets the next in a mitre.
        return genericSweep(sketchOf(r.shape).wire as never, spine as never, { transitionMode: 'right' }) as unknown as SolidLike;
      }
      case 'join':
      case 'cut': {
        const a = make(r.a, errors);
        if (!a) return null;
        const b = make(r.b, errors);
        if (!b) return a;
        try {
          const out = r.op === 'cut' ? a.cut(b) : a.fuse(b);
          a.delete();
          return out;
        } catch (e) {
          errors.push({ featureId: r.fid, message: message(e) });
          return a;
        } finally {
          b.delete();
        }
      }
    }
  } catch (e) {
    errors.push({ featureId: r.fid, message: message(e) });
    return null;
  }
};

type Built = { mesh: Omit<SolidMesh, 'solidId' | 'featureIds' | 'pullIds'> | null; errors: Errors };

// A solid's mesh depends only on its recipe, so unchanged solids are reused
// between builds instead of being rebuilt on every edit.
const cache = new Map<string, Built>();

const buildSolid = (recipe: Recipe): Built => {
  const key = JSON.stringify(recipe);
  const hit = cache.get(key);
  if (hit) return hit;
  const errors: Errors = [];
  const body = make(recipe, errors);
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
    } catch (e) {
      errors.push({ featureId: recipe.fid, message: message(e) });
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
  const plan = planSolids(doc);
  const solids: SolidMesh[] = [];
  const errors: Errors = [];
  try {
    for (const planned of plan.solids) {
      const built = buildSolid(planned.recipe);
      errors.push(...built.errors);
      if (built.mesh) solids.push({ solidId: planned.id, featureIds: planned.featureIds, pullIds: planned.pullIds, ...built.mesh });
    }
  } finally {
    for (const s of made.values()) s.delete();
    made = new Map();
  }
  return { solids, errors };
};

interface PointLike { x: number; y: number; delete(): void }
interface EdgeLike {
  geomType: string;
  length: number;
  startPoint: PointLike;
  endPoint: PointLike;
  pointAt(position: number): PointLike;
  delete(): void;
}

/** An edge of a projection as a polyline: straight ones by their ends, curves every 1.5 mm or so. */
const edgePolyline = (e: EdgeLike): number[] => {
  const read = (p: PointLike) => { const xy = [p.x, p.y]; p.delete(); return xy; };
  if (e.geomType === 'LINE') return [...read(e.startPoint), ...read(e.endPoint)];
  const n = Math.min(256, Math.max(12, Math.ceil(e.length / 1.5)));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(...read(e.pointAt(i / n)));
  return out;
};

/** The sketch's solids seen from each view, hidden edges worked out by OpenCascade. */
const project = (doc: SketchDoc, views: ProjectRequest['views']): ProjectedView[] => {
  const errors: Errors = [];
  const solids = planSolids(doc).solids.map(p => make(p.recipe, errors)).filter((x): x is SolidLike => !!x);
  try {
    if (!solids.length) return views.map(v => ({ name: v.name, visible: [], hidden: [] }));
    const all = makeCompound(solids as never) as unknown as SolidLike;
    try {
      return views.map(v => {
        const { visible, hidden } = makeProjectedEdges(all as never, new ProjectionCamera([0, 0, 0], v.dir, v.xAxis), v.hidden) as unknown as { visible: EdgeLike[]; hidden: EdgeLike[] };
        const lines = (edges: EdgeLike[]) => edges.map(e => { try { return edgePolyline(e); } finally { e.delete(); } });
        return { name: v.name, visible: lines(visible), hidden: lines(hidden) };
      });
    } finally {
      all.delete();
    }
  } finally {
    for (const s of solids) s.delete();
    for (const s of made.values()) s.delete();
    made = new Map();
  }
};

self.onmessage = async (event: MessageEvent<BuildRequest | ProjectRequest>) => {
  if (event.data.kind === 'project') {
    const { requestId, doc, views } = event.data;
    try {
      await loadEngine();
      (self as unknown as Worker).postMessage({ requestId, views: project(doc, views) } satisfies ProjectResponse);
    } catch (e) {
      (self as unknown as Worker).postMessage({ requestId, views: [], fatal: e instanceof Error ? e.message : String(e) } satisfies ProjectResponse);
    }
    return;
  }
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
