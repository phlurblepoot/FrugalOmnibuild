import { describe, it, expect } from 'vitest';
import { hasPhotoThumbnail } from './photoFormats';

describe('hasPhotoThumbnail', () => {
  it('takes the photo formats the server can read, in any spelling', () => {
    for (const mime of ['image/jpeg', 'image/JPG', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'image/avif', 'image/jpeg; charset=binary']) {
      expect(hasPhotoThumbnail({ mime })).toBe(true);
    }
  });

  it('leaves the rest to their icon', () => {
    for (const mime of ['image/heic', 'image/heif', 'image/svg+xml', 'image/bmp', 'application/pdf', 'application/octet-stream']) {
      expect(hasPhotoThumbnail({ mime })).toBe(false);
    }
  });
});
