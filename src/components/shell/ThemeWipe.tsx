import React, { useEffect, useState } from 'react';
import { useTheme } from '../../context/ThemeContext';

interface Wipe { x: number; y: number; color: string; id: number }

export const ThemeWipe: React.FC = () => {
  const { reducedMotion } = useTheme();
  const [wipe, setWipe] = useState<Wipe | null>(null);
  const [go, setGo] = useState(false);

  useEffect(() => {
    const onWipe = (e: Event) => {
      if (reducedMotion) return;
      const { x, y } = (e as CustomEvent<{ x: number; y: number }>).detail;
      // Capture the pre-flip ground color BEFORE ThemeContext applies .dark.
      const color = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#f8fafc';
      setGo(false);
      setWipe({ x, y, color, id: Date.now() });
    };
    window.addEventListener('theme-wipe', onWipe);
    return () => window.removeEventListener('theme-wipe', onWipe);
  }, [reducedMotion]);

  useEffect(() => {
    if (!wipe) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setGo(true)));
    const t = setTimeout(() => setWipe(null), 650);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [wipe?.id]);

  if (!wipe) return null;
  return (
    <div
      data-testid="theme-wipe"
      className={`theme-wipe-overlay ${go ? 'wipe-go' : ''}`}
      style={{ backgroundColor: wipe.color, ['--wipe-x' as any]: `${wipe.x}px`, ['--wipe-y' as any]: `${wipe.y}px` }}
    />
  );
};
