// src/pages/sketch/referenceImage.ts
// Loads a reference photo's picture for the sketch view: a photo the right
// way up (as the camera held it), or a PDF's first page, scaled down to what
// a graphics card takes as one texture.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { fetchFileBlob } from '../../utils/store';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

export interface ReferenceImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

const MAX_EDGE = 4096;

const toCanvas = (src: CanvasImageSource, w: number, h: number): HTMLCanvasElement => {
  const k = Math.min(1, MAX_EDGE / Math.max(w, h, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  canvas.getContext('2d')!.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
};

const fromPdf = async (blob: Blob): Promise<HTMLCanvasElement> => {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, 3000 / Math.max(base.width, base.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport } as any).promise;
    return canvas;
  } finally {
    pdf.destroy().catch(() => {});
  }
};

const fromImage = async (blob: Blob): Promise<HTMLCanvasElement> => {
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    try { return toCanvas(bmp, bmp.width, bmp.height); } finally { bmp.close(); }
  } catch {
    // Older browsers: an <img> applies the photo's orientation by itself.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return toCanvas(img, img.naturalWidth, img.naturalHeight);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
};

const cache = new Map<string, Promise<ReferenceImage>>();

/** The picture for a reference photo's file (loaded once per visit). */
export const loadReferenceImage = (fileId: string): Promise<ReferenceImage> => {
  const hit = cache.get(fileId);
  if (hit) return hit;
  const p = (async () => {
    const blob = await fetchFileBlob(fileId);
    const canvas = blob.type === 'application/pdf' ? await fromPdf(blob) : await fromImage(blob);
    return { canvas, width: canvas.width, height: canvas.height };
  })();
  cache.set(fileId, p);
  p.catch(() => cache.delete(fileId));
  return p;
};
