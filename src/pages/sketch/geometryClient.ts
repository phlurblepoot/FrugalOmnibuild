// src/pages/sketch/geometryClient.ts
// One geometry worker for the page; build() resolves with the latest result
// and drops answers to requests a newer one has replaced.
import type { SketchDoc } from './sketchModel';
import type { BuildRequest, BuildResponse, ProjectRequest, ProjectResponse, ViewSpec } from './geometryTypes';

let worker: Worker | null = null;
let nextId = 1;
// Answers to builds and to projections share one id sequence.
const waiting = new Map<number, (r: BuildResponse & ProjectResponse) => void>();

const getWorker = (): Worker => {
  if (!worker) {
    worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<BuildResponse & ProjectResponse>) => {
      const resolve = waiting.get(e.data.requestId);
      waiting.delete(e.data.requestId);
      resolve?.(e.data);
    };
    worker.onerror = (e) => {
      for (const [id, resolve] of waiting) resolve({ requestId: id, solids: [], errors: [], views: [], fatal: e.message || 'The 3D engine stopped.' });
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
};

/** Builds the sketch's solids. The first call also loads the 3D engine. */
export const buildSolids = (doc: SketchDoc): Promise<BuildResponse> =>
  new Promise(resolve => {
    const requestId = nextId++;
    waiting.set(requestId, resolve);
    getWorker().postMessage({ requestId, doc } satisfies BuildRequest);
  });

/** The sketch's solids drawn flat from each view (seen and hidden edges), for drawing sheets and DXF. */
export const projectViews = (doc: SketchDoc, views: ViewSpec[]): Promise<ProjectResponse> =>
  new Promise(resolve => {
    const requestId = nextId++;
    waiting.set(requestId, resolve);
    getWorker().postMessage({ kind: 'project', requestId, doc, views } satisfies ProjectRequest);
  });
