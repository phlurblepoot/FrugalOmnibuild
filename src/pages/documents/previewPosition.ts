// src/pages/documents/previewPosition.ts
// Pure viewport placement math for the Documents page's floating layers — the
// right-click RowContextMenu and the hover preview card
// (docs/superpowers/specs/2026-08-17-document-previews-design.md). Extracted
// from RowContextMenu's inline clamp so both share one rule (and so it can be
// unit tested without a DOM).

export interface Size { width: number; height: number; }
export interface Viewport { width: number; height: number; }
export interface Placement { left: number; top: number; }

// Gap kept between a floating layer and the viewport edge.
export const CLAMP_MARGIN = 8;

// How far from the cursor the hover card sits when there's room for it.
export const HOVER_OFFSET = 16;

// Keeps a layer of `size` fully on screen. When the layer is larger than the
// viewport (tiny window, tall menu) the margin wins over the far edge, so the
// layer is pinned top-left and overflows the bottom/right rather than being
// pushed off-screen in the other direction.
export const clampToViewport = (
  x: number,
  y: number,
  size: Size,
  viewport: Viewport,
  margin: number = CLAMP_MARGIN,
): Placement => ({
  left: Math.max(margin, Math.min(x, viewport.width - size.width - margin)),
  top: Math.max(margin, Math.min(y, viewport.height - size.height - margin)),
});

// Hover card placement: offset down-right of the cursor, flipping to the other
// side of the cursor on whichever axis runs out of room (so a row near the
// right edge doesn't end up with the card pasted under the pointer), then
// clamped as a backstop. The flip is only taken when the flipped position
// itself fits — otherwise the clamp handles it.
export const hoverCardPosition = (
  cursor: { x: number; y: number },
  size: Size,
  viewport: Viewport,
  offset: number = HOVER_OFFSET,
  margin: number = CLAMP_MARGIN,
): Placement => {
  let x = cursor.x + offset;
  if (x + size.width + margin > viewport.width) {
    const flipped = cursor.x - offset - size.width;
    if (flipped >= margin) x = flipped;
  }
  let y = cursor.y + offset;
  if (y + size.height + margin > viewport.height) {
    const flipped = cursor.y - offset - size.height;
    if (flipped >= margin) y = flipped;
  }
  return clampToViewport(x, y, size, viewport, margin);
};
