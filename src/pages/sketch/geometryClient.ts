// src/pages/sketch/geometryClient.ts
// One geometry worker for the page; build() resolves with the latest result
// and drops answers to requests a newer one has replaced.
import type { SketchDoc } from './sketchModel';
import type { BuildRequest, BuildResponse } from './geometryTypes';

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, (r: BuildResponse) => void>();

const getWorker = (): Worker => {
  if (!worker) {
    worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<BuildResponse>) => {
      const resolve = waiting.get(e.data.requestId);
      waiting.delete(e.data.requestId);
      resolve?.(e.data);
    };
    worker.onerror = (e) => {
      for (const [id, resolve] of waiting) resolve({ requestId: id, solids: [], errors: [], fatal: e.message || 'The 3D engine stopped.' });
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
