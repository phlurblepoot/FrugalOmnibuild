// src/pages/sketch/SketchPage.tsx
// /tools/sketch: the list of sketches, or (?fileId=) one open in the editor.
// Loaded on demand (App.tsx lazy()), so three.js and the 3D engine are only
// downloaded by people who open a sketch.
import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useIsPresent } from 'motion/react';
import { SketchEditor } from './SketchEditor';
import { SketchHome } from './SketchHome';

const SketchPage: React.FC = () => {
  const [params] = useSearchParams();
  // Nothing in a page that is on its way out (PageTransition), so a WebGL
  // view is never built twice — the same guard as the document editor.
  const present = useIsPresent();
  if (!present) return null;
  const fileId = params.get('fileId');
  return fileId ? <SketchEditor key={fileId} fileId={fileId} /> : <SketchHome />;
};

export default SketchPage;
