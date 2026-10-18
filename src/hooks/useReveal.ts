// src/hooks/useReveal.ts
//
// One-shot scroll reveal: fades + lifts an element in the first time it
// crosses 15% visible, then disconnects — it never re-triggers on subsequent
// scrolls. Mirrors useSoftZoom/useMasonrySpan's shape (a ref-returning hook,
// jsdom-guarded for environments with no IntersectionObserver).
//
// IMPORTANT default-visible contract: the element must NOT be invisible
// before this hook has had a chance to run (no-IO test/legacy environments,
// or a frame that renders before the effect commits). So the hiding class
// (`reveal-init`, opacity:0) is only ever added AFTER we've confirmed
// IntersectionObserver exists — never as a static className in JSX. If IO
// isn't supported the element is simply left at its default (visible) state
// and this hook is a no-op, same tradeoff useSoftZoom/useMasonrySpan make for
// ResizeObserver.
import { useEffect, useRef } from 'react';

const REVEAL_THRESHOLD = 0.15;

export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom (test env) and older browsers have no IntersectionObserver — skip
    // entirely so the element stays at its default, fully-visible state.
    if (typeof IntersectionObserver === 'undefined') return;

    el.classList.add('reveal-init');
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          el.classList.remove('reveal-init');
          el.classList.add('reveal-in');
          // Fire once: this is an arrival animation, not a re-triggerable one.
          observer.disconnect();
        }
      },
      { threshold: REVEAL_THRESHOLD }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return ref;
}
