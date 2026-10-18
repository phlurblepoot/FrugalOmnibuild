// src/utils/removeWhiteBackground.ts — makes the paper white around a scanned
// signature or stamp transparent, so it sits cleanly on a document. Moved out
// of the retired PDF editor (its saved-signature feature); Phase 3 of the
// ONLYOFFICE project uses it for profile signatures and company stamps
// (docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md).

/** Near-white pixels become fully transparent and light greys fade out, so
 *  anti-aliased pen edges stay smooth. Works on RGBA data in place. */
export function clearWhitePixels(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const min = Math.min(d[i], d[i + 1], d[i + 2]);
    if (min > 220) {
      d[i + 3] = 0;
    } else if (min > 170) {
      d[i + 3] = Math.round(d[i + 3] * (220 - min) / 50);
    }
  }
}

/** A PNG data URL of the image with its white background removed. */
export const removeWhiteBackground = (dataUrl: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('This browser cannot process images'));
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      clearWhitePixels(data.data);
      ctx.putImageData(data, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Could not read the image'));
    img.src = dataUrl;
  });

/** A base64 data URL as a Blob (no fetch: data: URLs aren't fetchable
 *  everywhere). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, data] = dataUrl.split(',', 2);
  const mime = /data:([^;,]+)/.exec(head)?.[1] ?? 'application/octet-stream';
  const bin = atob(data ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
