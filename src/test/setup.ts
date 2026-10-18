// src/test/setup.ts
import '@testing-library/jest-dom/vitest';

// jsdom has no matchMedia; the shell uses it for mobile detection and
// ThemeContext consumers may touch it. A static non-matching stub is enough.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

// ProseMirror (TipTap, used by the mail composer's rich-text editor) measures
// selections through Range geometry that jsdom does not implement. Empty rects
// are enough: nothing under test depends on real layout, and without these the
// editor throws on mount.
if (typeof Range !== 'undefined') {
  const emptyRect = () =>
    ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = function getClientRects() {
      return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList;
    };
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = emptyRect;
  }
}
