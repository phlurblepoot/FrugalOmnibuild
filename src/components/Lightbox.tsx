// src/components/Lightbox.tsx
// A single, net-new photo viewer mounted app-wide over issues/punch/daily/
// RFI/CO/task/proposal photo grids and the Documents preview (Wave 3 Task 9).
// Deliberately NOT built on components/ui/Modal — Modal's Tab-trap stack is
// for editor dialogs, and this needs to sit on top of one of those (e.g. an
// issue editor) rather than join its stack. It does its own minimal focus
// management instead: move focus in on open, restore it on close.
//
// Escape handling (controller ruling): Modal.tsx listens for Escape on
// `window` at the default (bubble) phase. If Lightbox also listened at the
// bubble phase, a single Escape press over a nested editor would close BOTH
// layers in the same tick — both listeners live on the same `window` object,
// so bubble-phase order is just registration order, and there is no clean
// signal to only run one. Listening at the CAPTURE phase and calling
// stopPropagation() there ends the event before it ever reaches the target
// (and before it bubbles back up to Modal's own window listener), so only
// the topmost lightbox closes.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export interface LightboxItem {
  src: string;
  caption?: string;
}

export interface LightboxProps {
  items: LightboxItem[];
  index: number;
  onClose: () => void;
}

const SCALE_MIN = 1;
const SCALE_MAX = 4;
const SWIPE_THRESHOLD_PX = 60;
const DOUBLE_TAP_MS = 300;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export const Lightbox: React.FC<LightboxProps> = ({ items, index, onClose }) => {
  const { reducedMotion } = useTheme();
  const [current, setCurrent] = useState(() => clamp(index, 0, Math.max(items.length - 1, 0)));
  const [scale, setScale] = useState(1);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // A new open (different starting index/items) resets position and zoom.
  useEffect(() => {
    setCurrent(clamp(index, 0, Math.max(items.length - 1, 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);
  useEffect(() => { setScale(1); }, [current]);

  const atStart = current <= 0;
  const atEnd = current >= items.length - 1;

  const goPrev = useCallback(() => setCurrent(c => Math.max(0, c - 1)), []);
  const goNext = useCallback(() => setCurrent(c => Math.min(items.length - 1, c + 1)), [items.length]);

  // ── Focus in on open, restore on close. Not Modal's Tab-trap loop — this
  // viewer's only interactive chrome is the close/prev/next buttons, so a
  // full trap is more machinery than the surface needs; documented here per
  // the brief instead of silently doing less than Modal does. ──────────────
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const id = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(id);
      const el = restoreRef.current;
      if (el && document.contains(el)) el.focus();
    };
  }, []);

  // ── Keyboard: Escape (capture-phase, see header note), arrow nav. ────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Fix wave I2: CommandPalette (z-400) can open ON TOP of an
        // already-open Lightbox (z-300) via ⌘K or '/'. If this capture-phase
        // handler unconditionally stopped propagation here, the topmost
        // layer visually would be the palette, but Escape would close the
        // Lightbox underneath instead (inverted from what the user sees).
        // So: while the palette is open, let Escape pass through uncaptured
        // — CommandPalette's own bubble-phase window listener closes the
        // palette first. Only once the palette is gone does the Lightbox
        // reclaim Escape for itself.
        if (document.querySelector('[data-palette-open]')) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowRight') { goNext(); return; }
      if (e.key === 'ArrowLeft') { goPrev(); }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, goNext, goPrev]);

  // ── Pointer handling: single-pointer swipe nav (only while unzoomed),
  // two-pointer pinch-zoom, double-tap toggles 1↔2. Kept in refs rather than
  // state — these fire on every pointermove and don't need re-renders except
  // when they actually change `scale`. ─────────────────────────────────────
  // Wheel/trackpad zoom is intentionally NOT implemented here — this viewer
  // is touch-first (field photos, phone/tablet use per the brief), and a bare
  // wheel listener would also hijack normal page/backdrop scroll intent for
  // desktop mouse users. Ctrl+wheel zoom is a reasonable candidate for the
  // ledgered pan/zoom follow-up, not this pass.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const pinchStartDist = useRef<number | null>(null);
  const pinchStartScale = useRef(1);
  const lastTapAt = useRef(0);

  const handlePointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = Array.from(pointers.current.values());
      pinchStartDist.current = dist(a, b);
      pinchStartScale.current = scale;
      dragStart.current = null;
    } else if (pointers.current.size === 1) {
      dragStart.current = { x: e.clientX, y: e.clientY };
      const now = Date.now();
      if (now - lastTapAt.current < DOUBLE_TAP_MS) {
        setScale(s => (s > 1 ? 1 : 2));
        lastTapAt.current = 0;
      } else {
        lastTapAt.current = now;
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinchStartDist.current) {
      const [a, b] = Array.from(pointers.current.values());
      const ratio = dist(a, b) / pinchStartDist.current;
      setScale(clamp(pinchStartScale.current * ratio, SCALE_MIN, SCALE_MAX));
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    const wasSingleDrag = pointers.current.size === 1 && dragStart.current && scale === 1;
    if (wasSingleDrag && dragStart.current) {
      const dx = e.clientX - dragStart.current.x;
      if (dx <= -SWIPE_THRESHOLD_PX) goNext();
      else if (dx >= SWIPE_THRESHOLD_PX) goPrev();
    }
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStartDist.current = null;
    dragStart.current = null;
  };

  if (items.length === 0) return null;
  const item = items[current];

  const entranceMotion = reducedMotion
    ? { initial: false as const, animate: { scale: 1, opacity: 1 }, transition: { duration: 0 } }
    : {
        initial: { scale: 0.9, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        transition: { type: 'spring' as const, stiffness: 380, damping: 30 },
      };

  return createPortal(
    <div
      data-testid="lightbox-backdrop"
      className="fixed inset-0 z-[300] flex flex-col bg-black/80"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Photo viewer"
        tabIndex={-1}
        className="relative flex h-full w-full flex-col outline-none"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between px-4 py-3 text-white">
          <span className="text-sm tabular-nums text-white/80">{current + 1} / {items.length}</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X size={20} />
          </button>
        </div>

        <div
          className="relative flex flex-1 items-center justify-center overflow-hidden px-2 touch-none select-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
        >
          <button
            onClick={goPrev}
            disabled={atStart}
            aria-label="Previous"
            className="absolute left-2 z-10 flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-black/40"
          >
            <ChevronLeft size={22} />
          </button>

          <motion.div
            key={current}
            data-testid="lightbox-frame"
            data-motion={reducedMotion ? 'instant' : 'spring'}
            initial={entranceMotion.initial}
            animate={entranceMotion.animate}
            transition={entranceMotion.transition}
            className="flex max-h-full max-w-full items-center justify-center"
          >
            <img
              src={item.src}
              alt={item.caption || `Photo ${current + 1} of ${items.length}`}
              draggable={false}
              className="max-h-[75dvh] max-w-full object-contain"
              style={{ transform: `scale(${scale})`, transition: 'transform 0.15s ease-out' }}
            />
          </motion.div>

          <button
            onClick={goNext}
            disabled={atEnd}
            aria-label="Next"
            className="absolute right-2 z-10 flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/40 text-white transition-colors hover:bg-black/60 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-black/40"
          >
            <ChevronRight size={22} />
          </button>
        </div>

        {item.caption && (
          <div data-testid="lightbox-caption" className="shrink-0 px-4 py-3 text-center text-sm text-white/90">
            {item.caption}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
