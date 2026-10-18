import React, { useEffect, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// Renders one page of a stored PDF into a data URL so the page-naming preview
// modals (used by both new-project upload and add-pages-to-existing-project)
// can show the original-quality vector content rather than just the small
// thumbnail. Falls back to a legacy image URL or the thumbnail when no source
// PDF is available. The resolved data URL feeds the existing OCR-region
// extraction pipeline unchanged — buildOcrCrop only needs a loadable URL.
export const PdfPagePreview: React.FC<{
  sourcePdfUrl?: string;
  sourcePdfPageNum?: number;
  fallbackUrl?: string;
  alt: string;
  className: string;
  onLoadedSrc?: (src: string) => void;
}> = ({ sourcePdfUrl, sourcePdfPageNum, fallbackUrl, alt, className, onLoadedSrc }) => {
  const [src, setSrc] = useState<string | undefined>(fallbackUrl);
  useEffect(() => {
    if (!sourcePdfUrl || !sourcePdfPageNum) {
      setSrc(fallbackUrl);
      if (fallbackUrl) onLoadedSrc?.(fallbackUrl);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const proxy = await pdfjsLib.getDocument({ url: sourcePdfUrl }).promise;
        if (cancelled) { proxy.destroy().catch(() => {}); return; }
        const page = await proxy.getPage(sourcePdfPageNum);
        if (cancelled) { proxy.destroy().catch(() => {}); return; }
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport } as any).promise;
        if (cancelled) return;
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setSrc(dataUrl);
        onLoadedSrc?.(dataUrl);
        proxy.destroy().catch(() => {});
      } catch (err) {
        console.error('PdfPagePreview render failed', err);
        if (!cancelled && fallbackUrl) setSrc(fallbackUrl);
      }
    })();
    return () => { cancelled = true; };
  }, [sourcePdfUrl, sourcePdfPageNum, fallbackUrl]);

  if (!src) return null;
  return <img src={src} alt={alt} className={className} draggable={false} />;
};
