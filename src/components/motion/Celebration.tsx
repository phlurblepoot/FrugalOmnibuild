import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../context/ThemeContext';

type Variant = 'confetti' | 'pulse';

interface Celebration {
  variant: Variant;
  x: number;
  y: number;
  id: number;
}

const CONFETTI_COLORS = ['var(--color-accent-500)', '#f97316', '#ef4444', '#eab308', '#22c55e', '#3b82f6', '#ec4899'];
const CONFETTI_COUNT = 14;

// Deterministic per-piece fly-out vectors (angle spread around a circle,
// slight radius jitter via index so the burst reads as organic without a
// runtime RNG mattering for tests).
const pieces = Array.from({ length: CONFETTI_COUNT }, (_, i) => {
  const angle = (i / CONFETTI_COUNT) * Math.PI * 2;
  const radius = 70 + (i % 3) * 24;
  return {
    dx: Math.cos(angle) * radius,
    dy: Math.sin(angle) * radius,
    r: (i * 47) % 360,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
    delay: (i % 4) * 15,
  };
});

export const CelebrationOverlay: React.FC = () => {
  const { reducedMotion } = useTheme();
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  // Monotonic counter, not Date.now() — two events inside the same
  // millisecond (or under fake timers, where Date.now() is frozen between
  // ticks) would otherwise collide and share a React key.
  const nextId = useRef(0);

  useEffect(() => {
    const onCelebrate = (e: Event) => {
      if (reducedMotion) return;
      const detail = (e as CustomEvent<{ variant?: Variant; x?: number; y?: number }>).detail || {};
      const variant: Variant = detail.variant === 'pulse' ? 'pulse' : 'confetti';
      const x = detail.x ?? window.innerWidth / 2;
      const y = detail.y ?? window.innerHeight / 2;
      setCelebration({ variant, x, y, id: nextId.current++ });
    };
    window.addEventListener('celebrate', onCelebrate);
    return () => window.removeEventListener('celebrate', onCelebrate);
  }, [reducedMotion]);

  useEffect(() => {
    if (!celebration) return;
    const { id } = celebration;
    const duration = celebration.variant === 'confetti' ? 1000 : 700;
    // Guard by id (ThemeWipe idiom): if a second celebration has already
    // replaced this one by the time the timer fires, this timeout must not
    // clear the NEW celebration out from under it.
    const t = setTimeout(() => {
      setCelebration(current => (current?.id === id ? null : current));
    }, duration);
    return () => clearTimeout(t);
  }, [celebration]);

  if (!celebration) return null;

  if (celebration.variant === 'pulse') {
    return (
      <div
        key={celebration.id}
        data-testid="celebration-pulse"
        className="celebration-pulse"
        style={{ ['--pulse-x' as any]: `${celebration.x}px`, ['--pulse-y' as any]: `${celebration.y}px` }}
      />
    );
  }

  return (
    <div
      key={celebration.id}
      data-testid="celebration-confetti"
      className="celebration-confetti"
      style={{ ['--confetti-x' as any]: `${celebration.x}px`, ['--confetti-y' as any]: `${celebration.y}px` }}
    >
      {pieces.map((p, i) => (
        <span
          key={i}
          className="celebration-confetti-piece"
          style={{
            ['--dx' as any]: `${p.dx}px`,
            ['--dy' as any]: `${p.dy}px`,
            ['--r' as any]: `${p.r}deg`,
            backgroundColor: p.color,
            animationDelay: `${p.delay}ms`,
          }}
        />
      ))}
    </div>
  );
};
