// Animated number ticker. Counts from the previous displayed value up (or
// down) to `value` using motion's standalone `animate()` value-animation
// overload (no DOM element required — we just read the interpolated number
// off `onUpdate` into React state). Formatting is the caller's job: pass
// `formatMoney` for cents, leave the default (toLocaleString) for plain
// counts (spec: CountUp + Sparkline, Wave 2 Task 5).
//
// reducedMotion (ThemeContext) renders the exact final formatted value with
// no animation at all, on mount AND on later value changes — the initial
// state is computed lazily off `reducedMotion` so the very first render
// already shows the final value (no interim frame to flash away).
import React, { useEffect, useRef, useState } from 'react';
import { animate } from 'motion/react';
import { useTheme } from '../../context/ThemeContext';

// Rounding lives only in the default formatter — a caller-supplied formatter
// (e.g. `v => v.toFixed(1)` for fractional hours) must see the raw
// interpolated value, not one pre-rounded to an integer by CountUp itself.
const defaultFormat = (v: number): string => Math.round(v).toLocaleString();

export const CountUp: React.FC<{
  value: number;
  format?: (v: number) => string;
  className?: string;
  durationMs?: number;
}> = ({ value, format = defaultFormat, className, durationMs = 800 }) => {
  const { reducedMotion } = useTheme();
  const [display, setDisplay] = useState<number>(() => (reducedMotion ? value : 0));
  // Tracks the last *target* value so a later change animates from where the
  // previous animation was headed, not from whatever frame happened to be
  // mid-flight when it was interrupted.
  const prevValueRef = useRef<number>(reducedMotion ? value : 0);

  useEffect(() => {
    if (reducedMotion) {
      setDisplay(value);
      prevValueRef.current = value;
      return;
    }

    const from = prevValueRef.current;
    const to = value;
    prevValueRef.current = to;

    if (from === to) {
      setDisplay(to);
      return;
    }

    const controls = animate(from, to, {
      duration: durationMs / 1000,
      ease: 'easeOut',
      onUpdate: (latest: number) => setDisplay(latest),
      // Belt-and-suspenders: even though the final onUpdate frame already
      // lands on `to`, explicitly snap to the exact target on completion so
      // float drift in the tween can never leave display fractionally off.
      onComplete: () => setDisplay(to),
    });

    // Stops the in-flight animation both on unmount and whenever this effect
    // re-runs for a new value (so rapid value changes don't fight each other).
    return () => controls.stop();
  }, [value, reducedMotion, durationMs]);

  return <span className={className}>{format(display)}</span>;
};
