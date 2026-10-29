// src/utils/pdfPhotos.ts
// Photos for the generated PDFs (proposals, daily reports, RFIs, issues,
// invoices, change orders). A phone often stores a portrait photo sideways
// with an EXIF tag saying "turn me upright"; the app's own screens obey the
// tag, but jsPDF embeds the raw pixels and ignores it, so the photo came out
// sideways. Each photo is therefore redrawn upright before it is embedded, and
// drawn at its own shape instead of stretched to fill a fixed box.
import type { jsPDF } from 'jspdf';

export interface PdfPhoto {
  dataUrl: string;
  /** Pixel size of the upright image; 0 when it could not be decoded here
   *  (jsPDF then reads the size itself, or the photo is skipped). */
  width: number;
  height: number;
}

// Longest edge of the re-encoded photo. A photo prints at most about 3.6"
// wide, so this is still over 400 dpi, and a 12 MP phone photo shrinks a lot.
const MAX_EDGE = 1600;

const readAsDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

// Decodes the image with its EXIF orientation applied and hands it to `draw`.
// createImageBitmap's 'from-image' does that directly; where the option is not
// supported, an <img> does it too (image-orientation: from-image is the
// default when an <img> is drawn to a canvas).
const withUprightImage = async <T>(blob: Blob, draw: (img: CanvasImageSource, w: number, h: number) => T): Promise<T> => {
  if (typeof createImageBitmap === 'function') {
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch { /* option or format not supported: try an <img> below */ }
    if (bmp) {
      try { return draw(bmp, bmp.width, bmp.height); } finally { bmp.close(); }
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    if (typeof img.decode !== 'function') throw new Error('cannot decode images here');
    img.src = url;
    await img.decode();
    return draw(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** A photo file, upright and as a JPEG ready for jsPDF. Null only when the
 *  file cannot be read at all. */
export const loadPdfPhoto = async (blob: Blob): Promise<PdfPhoto | null> => {
  try {
    return await withUprightImage(blob, (img, iw, ih) => {
      const scale = Math.min(1, MAX_EDGE / Math.max(iw, ih));
      const width = Math.max(1, Math.round(iw * scale));
      const height = Math.max(1, Math.round(ih * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no canvas');
      ctx.fillStyle = '#ffffff'; // a transparent PNG would turn black as a JPEG
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width, height };
    });
  } catch {
    // Not decodable in this browser: hand the file over as it is, the way
    // every photo used to go in. jsPDF reads it, or it is skipped when drawn.
    try {
      return { dataUrl: await readAsDataUrl(blob), width: 0, height: 0 };
    } catch {
      return null;
    }
  }
};

export const PHOTO_GAP = 12;

export interface PhotoCell<T extends PdfPhoto> {
  photo: T;
  /** Left edge of the photo's column; captions start here. */
  cellX: number;
  /** Where the photo itself is drawn, centred in its column and row. */
  x: number;
  dy: number;
  w: number;
  h: number;
}

export interface PhotoRow<T extends PdfPhoto> {
  cells: PhotoCell<T>[];
  height: number;
  cellW: number;
}

/** Two photos per row across `width`, each at its own shape. A photo fills its
 *  column's width, up to a square (so a portrait photo is as tall as a
 *  landscape one is wide); a row is as tall as its tallest photo. Photos
 *  jsPDF cannot read are left out instead of leaving a hole. */
export const layoutPhotoRows = <T extends PdfPhoto>(doc: jsPDF, photos: T[], left: number, width: number): PhotoRow<T>[] => {
  const cellW = (width - PHOTO_GAP) / 2;
  const maxH = cellW;
  const sized: { photo: T; w: number; h: number }[] = [];
  for (const photo of photos) {
    let { width: pw, height: ph } = photo;
    if (!pw || !ph) {
      try {
        ({ width: pw, height: ph } = doc.getImageProperties(photo.dataUrl));
      } catch {
        continue;
      }
    }
    if (!pw || !ph) continue;
    const s = Math.min(cellW / pw, maxH / ph);
    sized.push({ photo, w: pw * s, h: ph * s });
  }
  const rows: PhotoRow<T>[] = [];
  for (let i = 0; i < sized.length; i += 2) {
    const pair = sized.slice(i, i + 2);
    const height = Math.max(...pair.map(p => p.h));
    rows.push({
      cellW,
      height,
      cells: pair.map((p, col) => {
        const cellX = left + col * (cellW + PHOTO_GAP);
        return { photo: p.photo, cellX, x: cellX + (cellW - p.w) / 2, dy: (height - p.h) / 2, w: p.w, h: p.h };
      }),
    });
  }
  return rows;
};

export const drawPhoto = (doc: jsPDF, cell: PhotoCell<PdfPhoto>, rowY: number): void => {
  try {
    doc.addImage(cell.photo.dataUrl, 'JPEG', cell.x, rowY + cell.dy, cell.w, cell.h, undefined, 'FAST');
  } catch { /* skip an unreadable image */ }
};

/** The plain photo grid the record PDFs share: rows of two, a new page when a
 *  row would cross `bottom` (`newPage` returns the y to continue from).
 *  Returns the y below the grid. */
export const drawPhotoGrid = (
  doc: jsPDF,
  photos: PdfPhoto[],
  o: { left: number; width: number; y: number; bottom: number; newPage: () => number },
): number => {
  let y = o.y;
  for (const row of layoutPhotoRows(doc, photos, o.left, o.width)) {
    if (y + row.height > o.bottom) y = o.newPage();
    for (const cell of row.cells) drawPhoto(doc, cell, y);
    y += row.height + PHOTO_GAP;
  }
  return y;
};
