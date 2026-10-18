// Inline-SVG sparkline: a thin accent-colored line with a soft gradient fill
// underneath, and a stroke "draw-in" on mount via the `.chart-draw` CSS
// utility (src/index.css). No charting library — just a normalized polyline
// path (spec: CountUp + Sparkline, Wave 2 Task 5).
//
// Guard: fewer than 2 points, or a flat range (max === min), can't produce a
// meaningful slope — render a straight line through the vertical midpoint
// instead of dividing by zero (which would put NaN into `d`).
import React, { useId } from 'react';
import { useTheme } from '../../context/ThemeContext';

const VIEW_WIDTH = 100;

function buildLinePath(points: number[], height: number): string {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const flat = points.length < 2 || max === min;

  if (flat) {
    const mid = height / 2;
    return `M0,${mid} L${VIEW_WIDTH},${mid}`;
  }

  const step = VIEW_WIDTH / (points.length - 1);
  const coords = points.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / (max - min)) * height;
    return `${x},${y}`;
  });
  return `M${coords.join(' L')}`;
}

export const Sparkline: React.FC<{
  points: number[];
  height?: number;
  className?: string;
  'data-testid'?: string;
}> = ({ points, height = 36, className, 'data-testid': testId }) => {
  const { reducedMotion } = useTheme();
  const gradientId = `sparkline-fill-${useId()}`;

  const linePath = buildLinePath(points, height);
  const areaPath = `${linePath} L${VIEW_WIDTH},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className={className}
      data-testid={testId}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="oklch(0.62 0.18 var(--accent-h))" stopOpacity={0.28} />
          <stop offset="100%" stopColor="oklch(0.62 0.18 var(--accent-h))" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path
        className="sparkline-area"
        d={areaPath}
        fill={`url(#${gradientId})`}
        stroke="none"
      />
      <path
        className={reducedMotion ? 'sparkline-line' : 'sparkline-line chart-draw'}
        data-testid="sparkline-line"
        d={linePath}
        fill="none"
        stroke="oklch(0.62 0.18 var(--accent-h))"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
      />
    </svg>
  );
};
