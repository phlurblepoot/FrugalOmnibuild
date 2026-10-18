// src/cards/CardGrid.tsx
//
// Responsive grid host for one page's cards. Renders the user's resolved
// CardLayout at 1-4 columns (driven by window width) and owns "Customize"
// mode: drag-to-reorder, per-card width control, remove, and an add tray for
// cards currently off the layout. Cards render their own CardShell chrome —
// this component only positions them on the grid.
import React, { useEffect, useRef, useState } from 'react';
import type { CardContext, CardDef, CardLayoutEntry, CardPage, CardWidth } from './types';
import { cardsForPage } from './registry';
import { useCardLayout } from './useCardLayout';
import { MASONRY_GAP_PX, MASONRY_ROW_PX, useMasonrySpan } from './useMasonrySpan';
import { useReveal } from '../hooks/useReveal';

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

// Pure reorder logic shared by both the desktop HTML5 drag path and the
// touch long-press path (Wave 3 Task 13, closing the spec §5.1 debt): moves
// `draggedId` out of `cards` and reinserts it immediately before `targetId`
// (or at the end if the target isn't found — e.g. it was removed mid-drag).
export function reorderBefore(draggedId: string, targetId: string, cards: CardLayoutEntry[]): CardLayoutEntry[] {
  if (draggedId === targetId) return cards;
  const next = [...cards];
  const fromIndex = next.findIndex(c => c.id === draggedId);
  if (fromIndex === -1) return cards;
  const [moved] = next.splice(fromIndex, 1);
  const toIndex = next.findIndex(c => c.id === targetId);
  // Reorder-before-target: the dragged card lands just ahead of whatever
  // it was dropped on.
  if (toIndex === -1) next.push(moved);
  else next.splice(toIndex, 0, moved);
  return next;
}

// Pure snap math for the desktop edge-drag resize handle (Wave 3 Task 13):
// converts a pointer's absolute X into a supported CardWidth by measuring
// how many column-widths past the card's left edge the pointer has
// traveled, rounding to the nearest whole column, then snapping to whichever
// width the card actually supports (cards don't support every integer —
// e.g. widths=[1, 3] has no "2").
export function snapResizeWidth(pointerX: number, cardLeft: number, colWidth: number, widths: CardWidth[]): CardWidth {
  const raw = Math.max(1, Math.round((pointerX - cardLeft) / colWidth));
  return widths.reduce((best, w) => (Math.abs(w - raw) < Math.abs(best - raw) ? w : best), widths[0]);
}

function computeCols(w1600: boolean, w1024: boolean, w640: boolean): number {
  if (w1600) return 4;
  if (w1024) return 3;
  if (w640) return 2;
  return 1;
}

// Three independent min-width queries (mirrors AppShell's single-breakpoint
// matchMedia pattern, tripled) so a crossing at any one threshold re-renders
// without polling resize events.
function useColumnCount(): number {
  const queries = () => ({
    q1600: window.matchMedia('(min-width: 1600px)'),
    q1024: window.matchMedia('(min-width: 1024px)'),
    q640: window.matchMedia('(min-width: 640px)'),
  });

  const [cols, setCols] = useState(() => {
    const { q1600, q1024, q640 } = queries();
    return computeCols(q1600.matches, q1024.matches, q640.matches);
  });

  useEffect(() => {
    const { q1600, q1024, q640 } = queries();
    const update = () => setCols(computeCols(q1600.matches, q1024.matches, q640.matches));
    update();
    q1600.addEventListener('change', update);
    q1024.addEventListener('change', update);
    q640.addEventListener('change', update);
    return () => {
      q1600.removeEventListener('change', update);
      q1024.removeEventListener('change', update);
      q640.removeEventListener('change', update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return cols;
}

// One grid item: owns the masonry-span measurement (a hook, so each card
// needs its own component instance rather than being called inline from a
// .map). Editing decorations (wiggle, drag handlers, width/remove overlay,
// resize handle) live on the outer wrapper exactly as before; only the card
// body itself moves into the inner measured div.
const CardGridItem: React.FC<{
  entry: CardLayoutEntry;
  def: CardDef;
  ctx: CardContext;
  editing: boolean;
  effectiveWidth: CardWidth;
  widths: CardWidth[];
  armed: boolean;
  touchDevice: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onCardPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onWidthChange: (w: CardWidth) => void;
  onRemove: () => void;
  onResizeStart: (e: React.PointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}> = ({
  entry, def, ctx, editing, effectiveWidth, widths, armed, touchDevice,
  onDragStart, onDragOver, onDrop, onCardPointerDown, onWidthChange, onRemove, onResizeStart, onResizeKeyDown,
}) => {
  const { ref: measureRef, span } = useMasonrySpan<HTMLDivElement>();
  // Scroll reveal on the outer wrapper only (never the inner measured div —
  // see useMasonrySpan above). Skipped entirely while editing: wiggle and
  // reveal-in both animate `transform`, and Customize mode means the user is
  // already looking at every card, not scrolling one into view for the first
  // time. The ref is simply withheld rather than conditionally calling the
  // hook, which always runs (rules of hooks).
  const revealRef = useReveal<HTMLDivElement>();

  return (
    <div
      ref={editing ? undefined : revealRef}
      data-card-id={entry.id}
      draggable={editing}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDown={onCardPointerDown}
      className={
        'relative' +
        (editing && !armed ? ' animate-[card-wiggle_.4s_ease-in-out_infinite_alternate]' : '') +
        // Touch long-press lift (Wave 3 Task 13): scale + shadow on the
        // OUTER wrapper only — never on the measureRef div below, which
        // useMasonrySpan observes for its height. `transition` is a plain
        // CSS transition, so reduced motion is handled for free by the
        // global `.motion-reduce *` rule (zeroes transition-duration) rather
        // than needing a special case here.
        (armed ? ' z-20 scale-105 shadow-2xl transition duration-150' : '')
      }
      style={{
        gridColumn: `span ${effectiveWidth}`,
        gridRow: `span ${span}`,
        paddingBottom: MASONRY_GAP_PX,
        // Fix wave I1: touch-action is honored from touchSTART, not from
        // whenever we later flip a style prop — setting this only once the
        // long-press "arms" (500ms in) is too late, the native scroll
        // arbiter has already claimed the in-flight touch, so the first
        // post-arm move becomes a scroll + pointercancel and the reorder
        // gesture silently dies. Setting it here, from render, whenever
        // we're editing on a touch device — armed or not — means it's
        // already in force at the touchstart that begins the gesture.
        // Tradeoff: while editing on touch, a finger drag starting ON a
        // card can no longer scroll the page; scrolling still works via the
        // page/container area outside the cards, which is acceptable since
        // Customize mode is a deliberate, temporary editing state.
        touchAction: editing && touchDevice ? 'none' : undefined,
      }}
    >
      {editing && (
        <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
          <div role="group" aria-label={`${def.title} width`} className="flex gap-0.5">
            {widths.map(w => (
              <button
                key={w}
                type="button"
                className={
                  'flex size-5 items-center justify-center rounded text-[10px] font-medium ' +
                  (w === entry.width ? 'glow-accent' : 'bg-raised text-ink-soft hover:text-ink')
                }
                onClick={() => onWidthChange(w)}
              >
                {w}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label={`Remove ${def.title}`}
            className="flex size-5 items-center justify-center rounded bg-raised text-ink-soft hover:text-ink"
            onClick={onRemove}
          >
            ×
          </button>
        </div>
      )}
      {editing && widths.length > 1 && (
        // Desktop edge resize (Wave 3 Task 13): a real separator so keyboard
        // users get ←/→ parity with the drag, mirroring MailPage.tsx's pane
        // handles. stopPropagation keeps a pointerdown here from also
        // bubbling into onCardPointerDown above and arming a touch-reorder
        // gesture on the same interaction.
        <div
          role="separator"
          tabIndex={0}
          aria-label={`Resize ${def.title}`}
          aria-orientation="vertical"
          aria-valuenow={entry.width}
          aria-valuemin={widths[0]}
          aria-valuemax={widths[widths.length - 1]}
          data-testid={`card-resize-${entry.id}`}
          onPointerDown={e => { e.stopPropagation(); onResizeStart(e); }}
          onKeyDown={onResizeKeyDown}
          className="absolute inset-y-0 right-0 z-10 hidden w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-accent-500/40 focus-visible:bg-accent-500/60 focus-visible:outline-none lg:block"
        />
      )}
      <div ref={measureRef}>
        <def.Component width={effectiveWidth} ctx={ctx} />
      </div>
    </div>
  );
};

export const CardGrid: React.FC<{ page: CardPage; ctx: CardContext }> = ({ page, ctx }) => {
  const { layout, setLayout, reset } = useCardLayout(page, ctx);
  const cols = useColumnCount();
  const [editing, setEditing] = useState(false);
  // Native HTML5 drag: the dragged card's id lives in a ref (not
  // dataTransfer) so drop handling doesn't depend on jsdom/browser
  // dataTransfer support.
  const dragId = useRef<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const available = cardsForPage(page, ctx);
  const byId = new Map(available.map(def => [def.id, def]));
  const inLayout = new Set(layout.cards.map(c => c.id));
  const trayDefs = available.filter(def => !inLayout.has(def.id));

  const updateEntry = (id: string, patch: Partial<CardLayoutEntry>) => {
    setLayout({ ...layout, cards: layout.cards.map(c => (c.id === id ? { ...c, ...patch } : c)) });
  };

  const removeCard = (id: string) => {
    setLayout({ ...layout, cards: layout.cards.filter(c => c.id !== id) });
  };

  const addCard = (id: string, defaultWidth: CardWidth) => {
    setLayout({ ...layout, cards: [...layout.cards, { id, width: defaultWidth }] });
  };

  // ── Touch reorder (Wave 3 Task 13, closes spec §5.1 debt) ───────────────
  // Long-press (~500ms, longPressTimerRef idiom mirrored from
  // DocumentsTable.tsx's touch context-menu) arms "move mode" on a card:
  // `gestureId` is set immediately on pointerdown, `armed` flips true once
  // the timer fires. A single pair of window-bound pointermove/up listeners
  // — started once per gesture via the effect below — does double duty:
  // before armed, a move past tolerance cancels the gesture as a scroll;
  // once armed, it tracks which card wrapper the finger is over via
  // elementFromPoint, and pointerup drops before that target using the same
  // reorderBefore() the desktop HTML5 drag path uses.
  const touchDevice = useState(isTouchDevice)[0];
  const [gestureId, setGestureId] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const hoverIdRef = useRef<string | null>(null);
  // Mirrors state read inside the window-listener closures below, which are
  // created once per gesture (effect dep [gestureId]) and would otherwise
  // see stale `armed`/`layout` values from the moment the gesture started.
  const armedRef = useRef(false);
  armedRef.current = armed;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  useEffect(() => () => cancelLongPress(), []);

  const handleCardPointerDown = (id: string) => (e: React.PointerEvent) => {
    if (!editing || !touchDevice || e.pointerType !== 'touch') return;
    pressStartRef.current = { x: e.clientX, y: e.clientY };
    setArmed(false);
    setGestureId(id);
    cancelLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      setArmed(true);
    }, LONG_PRESS_MS);
  };

  useEffect(() => {
    if (!gestureId) return;
    const onMove = (e: PointerEvent) => {
      if (!armedRef.current) {
        const start = pressStartRef.current;
        if (
          start &&
          (Math.abs(e.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE ||
            Math.abs(e.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE)
        ) {
          // Moved too far before the long-press fired — this is a scroll,
          // not a reorder gesture.
          cancelLongPress();
          setGestureId(null);
        }
        return;
      }
      e.preventDefault();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const wrapper = (el as HTMLElement | null)?.closest('[data-card-id]');
      hoverIdRef.current = wrapper?.getAttribute('data-card-id') ?? null;
    };
    const onUp = () => {
      cancelLongPress();
      if (armedRef.current) {
        const targetId = hoverIdRef.current;
        if (targetId && targetId !== gestureId) {
          setLayout({ ...layoutRef.current, cards: reorderBefore(gestureId, targetId, layoutRef.current.cards) });
        }
      }
      hoverIdRef.current = null;
      setGestureId(null);
      setArmed(false);
    };
    // pointercancel means the gesture was REVOKED (a second touch starting a
    // pinch, the OS taking over, etc.) — drag-cancel semantics are "act on
    // nothing", so this must never commit a reorder using whatever
    // hoverIdRef last held. Same cleanup as onUp, minus the setLayout call.
    const onCancel = () => {
      cancelLongPress();
      hoverIdRef.current = null;
      setGestureId(null);
      setArmed(false);
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gestureId]);

  // ── Desktop edge resize (Wave 3 Task 13) ────────────────────────────────
  // Dragging a card's right-edge handle previews a snapped width live (via
  // `resize`/`previewWidth`) and persists it through the same setLayout path
  // the [1][2][3] buttons use, on release. Window-bound pointer events +
  // a ref mirroring the in-flight preview width, mirroring MailPage.tsx's
  // pane-resize pattern (widthsRef anti-stale-closure).
  const [resize, setResize] = useState<{ id: string; cardLeft: number; colWidth: number; widths: CardWidth[] } | null>(null);
  const [previewWidth, setPreviewWidth] = useState<CardWidth | null>(null);
  const previewWidthRef = useRef<CardWidth | null>(null);

  useEffect(() => {
    if (!resize) return;
    const onMove = (e: PointerEvent) => {
      const w = snapResizeWidth(e.clientX, resize.cardLeft, resize.colWidth, resize.widths);
      previewWidthRef.current = w;
      setPreviewWidth(w);
    };
    const onUp = () => {
      if (previewWidthRef.current != null) {
        updateEntry(resize.id, { width: previewWidthRef.current });
      }
      previewWidthRef.current = null;
      setResize(null);
      setPreviewWidth(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resize]);

  const handleResizeStart = (entry: CardLayoutEntry, widths: CardWidth[]) => (e: React.PointerEvent) => {
    if (!editing) return;
    e.preventDefault();
    const wrapper = (e.currentTarget as HTMLElement).closest('[data-card-id]') as HTMLElement | null;
    const gridEl = gridRef.current;
    if (!wrapper || !gridEl) return;
    const gridRect = gridEl.getBoundingClientRect();
    const cardRect = wrapper.getBoundingClientRect();
    const colWidth = (gridRect.width - (cols - 1) * MASONRY_GAP_PX) / cols;
    previewWidthRef.current = entry.width;
    setPreviewWidth(entry.width);
    setResize({ id: entry.id, cardLeft: cardRect.left, colWidth, widths });
  };

  const handleResizeKeyDown = (entry: CardLayoutEntry, widths: CardWidth[]) => (e: React.KeyboardEvent) => {
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const idx = widths.indexOf(entry.width);
    const nextIdx = Math.min(widths.length - 1, Math.max(0, idx + dir));
    updateEntry(entry.id, { width: widths[nextIdx] });
  };

  // Native drag events bubble regardless of a wrapper's own `draggable`
  // attribute — an in-card text-selection drag can still fire dragstart on
  // an ancestor. Gate the handlers themselves (not just `draggable`) so
  // dragging is completely inert outside Customize mode: no drop target, no
  // reorder, no persisted write.
  const handleDragStart = (id: string) => () => {
    if (!editing) return;
    dragId.current = id;
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!editing) return;
    e.preventDefault();
  };

  const handleDrop = (targetId: string) => (e: React.DragEvent<HTMLDivElement>) => {
    if (!editing) return;
    e.preventDefault();
    const draggedId = dragId.current;
    dragId.current = null;
    if (!draggedId || draggedId === targetId) return;
    setLayout({ ...layout, cards: reorderBefore(draggedId, targetId, layout.cards) });
  };

  return (
    <div>
      <div className="flex items-center justify-end gap-3 mb-3">
        {editing && (
          <button
            type="button"
            data-testid="cards-reset"
            className="text-xs font-medium text-ink-soft hover:text-ink"
            onClick={reset}
          >
            Reset to default
          </button>
        )}
        <button
          type="button"
          data-testid="cards-customize"
          className="text-xs font-medium text-ink-soft hover:text-ink"
          onClick={() => setEditing(e => !e)}
        >
          {editing ? '✓ Done' : '⚙ Customize'}
        </button>
      </div>

      <div
        ref={gridRef}
        data-testid="card-grid"
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          // Dense masonry packing: fine-grained 8px auto-rows let each card
          // span exactly as many rows as its measured content needs (see
          // useMasonrySpan), and `dense` lets later, narrower cards backfill
          // holes left by a tall neighbor instead of only ever flowing
          // forward. Row-gap must be 0 here — with 8px tracks a non-zero
          // row-gap would sit between EVERY track a card spans, inflating
          // its apparent height every time; the visual gap is instead baked
          // into each wrapper's paddingBottom (see CardGridItem).
          gridAutoRows: `${MASONRY_ROW_PX}px`,
          gridAutoFlow: 'dense',
          columnGap: MASONRY_GAP_PX,
          rowGap: 0,
        }}
      >
        {layout.cards.map(entry => {
          const def = byId.get(entry.id);
          if (!def) return null;
          const widths = [...def.widths].sort((a, b) => a - b);
          const liveWidth = resize?.id === entry.id && previewWidth != null ? previewWidth : entry.width;
          const effectiveWidth = Math.min(liveWidth, cols) as CardWidth;

          return (
            <CardGridItem
              key={entry.id}
              entry={entry}
              def={def}
              ctx={ctx}
              editing={editing}
              effectiveWidth={effectiveWidth}
              widths={widths}
              armed={armed && gestureId === entry.id}
              touchDevice={touchDevice}
              onDragStart={handleDragStart(entry.id)}
              onDragOver={handleDragOver}
              onDrop={handleDrop(entry.id)}
              onCardPointerDown={handleCardPointerDown(entry.id)}
              onWidthChange={w => updateEntry(entry.id, { width: w })}
              onRemove={() => removeCard(entry.id)}
              onResizeStart={handleResizeStart(entry, widths)}
              onResizeKeyDown={handleResizeKeyDown(entry, widths)}
            />
          );
        })}

        {layout.cards.length === 0 && (
          <div className="col-span-full flex items-center justify-center rounded-xl border border-dashed border-edge py-10 text-sm text-ink-faint">
            No cards yet — use Customize to add some.
          </div>
        )}
      </div>

      {editing && (
        <div data-testid="cards-tray" className="mt-3 flex flex-wrap gap-2">
          {trayDefs.map(def => (
            <button
              key={def.id}
              type="button"
              className="rounded-full border border-edge px-3 py-1 text-xs font-medium text-ink-soft hover:text-ink"
              onClick={() => addCard(def.id, def.defaultWidth)}
            >
              + {def.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
