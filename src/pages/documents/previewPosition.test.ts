// src/pages/documents/previewPosition.test.ts
import { describe, it, expect } from 'vitest';
import { clampToViewport, hoverCardPosition } from './previewPosition';

const viewport = { width: 1000, height: 800 };
const size = { width: 220, height: 200 };

describe('clampToViewport', () => {
  it('leaves a position that already fits untouched', () => {
    expect(clampToViewport(100, 100, size, viewport)).toEqual({ left: 100, top: 100 });
  });

  it('pulls back from the right/bottom edges by the margin', () => {
    expect(clampToViewport(990, 790, size, viewport)).toEqual({ left: 772, top: 592 });
  });

  it('pushes off the left/top edges by the margin', () => {
    expect(clampToViewport(-50, 0, size, viewport)).toEqual({ left: 8, top: 8 });
  });

  it('pins to the margin when the layer is bigger than the viewport', () => {
    expect(clampToViewport(10, 10, { width: 2000, height: 2000 }, viewport)).toEqual({ left: 8, top: 8 });
  });
});

describe('hoverCardPosition', () => {
  it('sits down-right of the cursor when there is room', () => {
    expect(hoverCardPosition({ x: 100, y: 100 }, size, viewport)).toEqual({ left: 116, top: 116 });
  });

  it('flips to the left of the cursor near the right edge', () => {
    // 900 + 16 + 220 + 8 > 1000, and 900 - 16 - 220 = 664 fits.
    expect(hoverCardPosition({ x: 900, y: 100 }, size, viewport).left).toBe(664);
  });

  it('flips above the cursor near the bottom edge', () => {
    expect(hoverCardPosition({ x: 100, y: 700 }, size, viewport).top).toBe(484);
  });

  it('falls back to the clamp when neither side fits', () => {
    // A card as wide as the viewport can't flip anywhere — clamp pins it.
    const wide = { width: 990, height: 200 };
    expect(hoverCardPosition({ x: 900, y: 100 }, wide, viewport).left).toBe(8);
  });

  it('never lets the card leave the viewport for cursors in any corner', () => {
    for (const cursor of [{ x: 0, y: 0 }, { x: 999, y: 0 }, { x: 0, y: 799 }, { x: 999, y: 799 }]) {
      const { left, top } = hoverCardPosition(cursor, size, viewport);
      expect(left).toBeGreaterThanOrEqual(8);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(left + size.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(top + size.height).toBeLessThanOrEqual(viewport.height - 8);
    }
  });
});
