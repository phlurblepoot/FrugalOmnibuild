// src/pages/sketch/sketchNames.ts
import { SKETCH_EXTENSION } from './sketchModel';

/** A sketch file's name as people read it: "Cornice A", not "Cornice A.sketch.json". */
export const sketchTitle = (fileName: string | null | undefined): string => {
  const n = fileName ?? '';
  return (n.endsWith(SKETCH_EXTENSION) ? n.slice(0, -SKETCH_EXTENSION.length) : n) || 'Sketch';
};
