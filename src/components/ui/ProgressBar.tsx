// src/components/ui/ProgressBar.tsx
import React from 'react';

export const ProgressBar: React.FC<{
  done: number;
  total: number;
  className?: string;
  // Extra classes on the filled bar itself (not the wrapper) — e.g.
  // `breathing` for "live" bars (Wave 3 Task 11), which pulses the bar's
  // existing glow-bar glow rather than adding a new one.
  barClassName?: string;
  // Overrides the default "{done} / {total}" text. Use for values where the
  // raw done/total numbers wouldn't mean anything to a reader (e.g. cents) —
  // pass a pre-formatted, honestly-labeled string instead.
  label?: string;
}> = ({
  done,
  total,
  className = '',
  barClassName = '',
  label,
}) => {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-sunken">
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className={`glow-bar h-full rounded-full transition-[width] duration-300 ${barClassName}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-ink-faint">{label ?? `${done} / ${total}`}</span>
    </div>
  );
};
