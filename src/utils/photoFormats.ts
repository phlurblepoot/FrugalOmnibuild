// src/utils/photoFormats.ts — which stored images the server can shrink to a
// thumbnail (server/onlyoffice/thumbnails.ts, with sharp). Shared by the
// client (whether a Documents row asks for one) and the server, so the two
// agree about a file.
//
// HEIC isn't here: the sharp build the server ships reads AVIF but not HEIC,
// so an iPhone .heic keeps its icon. SVG isn't either: it's small already, and
// a vector is better shown as itself.

export const THUMBNAILABLE_PHOTO_TYPES: readonly string[] = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'image/avif',
];

// Other spellings browsers and phones use for the same formats.
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
  'image/tif': 'image/tiff',
};

/** Whether a stored file is a photo the server can make a thumbnail of. */
export function hasPhotoThumbnail(meta: { mime: string }): boolean {
  const mime = meta.mime.toLowerCase().split(';')[0].trim();
  return THUMBNAILABLE_PHOTO_TYPES.includes(MIME_ALIASES[mime] ?? mime);
}
