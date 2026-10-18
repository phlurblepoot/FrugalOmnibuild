// Uniform hover-zoom law (spec §2.2 rule 8): every element grows the same
// ~6 physical pixels on hover — scale is derived from rendered width, so a
// small card and a full-width container feel identical and can never cross
// the grid gap into a neighbour. Re-measured on resize.
import { useEffect, useRef } from 'react';

const GROWTH_PX = 6;
const MAX_SCALE = 1.03;

export function softZoomScale(width: number): number {
  if (!width || width <= 0) return 1;
  return Math.min(MAX_SCALE, 1 + GROWTH_PX / width);
}

export function useSoftZoom<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const s = softZoomScale(el.offsetWidth);
      el.style.setProperty('--soft-zoom', String(s));
    };
    apply();
    // jsdom (test env) has no ResizeObserver — the initial apply() above still
    // sets a sane scale, we just skip live re-measurement on resize.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return ref;
}
