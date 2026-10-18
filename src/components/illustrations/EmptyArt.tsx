// src/components/illustrations/EmptyArt.tsx — decorative empty-state
// illustrations for CardShell (Wave 2 Task 12). Six inline-SVG blueprint /
// construction motifs, one per EmptyKind. Colors are entirely var()-driven
// (accent hue + theme ink token) so a single set of paths is correct in
// both themes and reacts to the user's custom accent color — no per-theme
// branching needed here.
import React from 'react';
import type { EmptyKind } from '../../cards/types';

// Shared stroke/fill tokens — see task brief: primary strokes use the
// accent hue at fixed lightness/chroma, soft fills are the same hue at low
// alpha, and secondary (de-emphasized) strokes ride the ink-faint token so
// they fade correctly in dark mode too.
const STROKE = 'oklch(0.62 0.12 var(--accent-h))';
const FILL_SOFT = 'oklch(0.62 0.18 var(--accent-h) / 0.12)';
const STROKE_FAINT = 'var(--ink-faint)';

const shared = {
  fill: 'none',
  strokeWidth: 2.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

// clear — sun over a ruled horizon ("all clear", nothing needs attention).
const ClearArt: React.FC = () => (
  <>
    <line x1="6" y1="54" x2="90" y2="54" stroke={STROKE_FAINT} strokeWidth={2} strokeLinecap="round" />
    <line x1="14" y1="62" x2="82" y2="62" stroke={STROKE_FAINT} strokeWidth={2} strokeLinecap="round" opacity={0.6} />
    <circle cx="48" cy="32" r="16" fill={FILL_SOFT} stroke={STROKE} {...shared} />
    <line x1="48" y1="6" x2="48" y2="12" stroke={STROKE} {...shared} />
    <line x1="70" y1="14" x2="66" y2="18" stroke={STROKE} {...shared} />
    <line x1="78" y1="32" x2="72" y2="32" stroke={STROKE} {...shared} />
  </>
);

// inbox — open envelope with a sheet peeking out.
const InboxArt: React.FC = () => (
  <>
    <rect x="14" y="28" width="68" height="38" rx="3" fill={FILL_SOFT} stroke={STROKE} {...shared} />
    <path d="M14 30 L48 52 L82 30" stroke={STROKE} {...shared} />
    <rect x="34" y="10" width="28" height="34" rx="2" fill="var(--raised)" stroke={STROKE_FAINT} strokeWidth={2} />
    <line x1="40" y1="19" x2="56" y2="19" stroke={STROKE_FAINT} strokeWidth={2} strokeLinecap="round" />
    <line x1="40" y1="26" x2="56" y2="26" stroke={STROKE_FAINT} strokeWidth={2} strokeLinecap="round" />
  </>
);

// money — coin stack with a rising trend tick.
const MoneyArt: React.FC = () => (
  <>
    <ellipse cx="32" cy="58" rx="20" ry="6" fill={FILL_SOFT} stroke={STROKE} {...shared} />
    <ellipse cx="32" cy="48" rx="20" ry="6" fill={FILL_SOFT} stroke={STROKE} {...shared} />
    <ellipse cx="32" cy="38" rx="20" ry="6" fill={FILL_SOFT} stroke={STROKE} {...shared} />
    <path d="M56 40 L68 24 L78 32 L92 12" stroke={STROKE_FAINT} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    <path d="M82 12 L92 12 L92 22" stroke={STROKE_FAINT} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </>
);

// checklist — clipboard with two checked rows.
const ChecklistArt: React.FC = () => (
  <>
    <rect x="22" y="10" width="52" height="58" rx="4" fill={FILL_SOFT} stroke={STROKE} {...shared} />
    <rect x="38" y="6" width="20" height="10" rx="2" fill="var(--raised)" stroke={STROKE} strokeWidth={2.5} />
    <path d="M32 30 L37 35 L47 25" stroke={STROKE} {...shared} />
    <line x1="54" y1="30" x2="66" y2="30" stroke={STROKE_FAINT} strokeWidth={2} strokeLinecap="round" />
    <path d="M32 48 L37 53 L47 43" stroke={STROKE} {...shared} />
    <line x1="54" y1="48" x2="66" y2="48" stroke={STROKE_FAINT} strokeWidth={2} strokeLinecap="round" />
  </>
);

// photos — two overlapping frames with a mountain glyph.
const PhotosArt: React.FC = () => (
  <>
    <rect x="10" y="18" width="52" height="40" rx="3" fill="var(--raised)" stroke={STROKE_FAINT} strokeWidth={2} transform="rotate(-6 36 38)" />
    <rect x="30" y="16" width="52" height="40" rx="3" fill={FILL_SOFT} stroke={STROKE} {...shared} />
    <circle cx="45" cy="28" r="3.5" fill="none" stroke={STROKE} strokeWidth={2.5} />
    <path d="M34 50 L48 34 L58 44 L64 38 L78 50" stroke={STROKE} {...shared} />
  </>
);

// blueprint — rolled plan with a grid corner.
const BlueprintArt: React.FC = () => (
  <>
    <rect x="10" y="14" width="16" height="48" rx="8" fill={FILL_SOFT} stroke={STROKE} {...shared} />
    <rect x="24" y="14" width="58" height="48" rx="2" fill={FILL_SOFT} stroke={STROKE} {...shared} />
    <line x1="24" y1="30" x2="82" y2="30" stroke={STROKE_FAINT} strokeWidth={1.5} />
    <line x1="24" y1="46" x2="82" y2="46" stroke={STROKE_FAINT} strokeWidth={1.5} />
    <line x1="42" y1="14" x2="42" y2="62" stroke={STROKE_FAINT} strokeWidth={1.5} />
    <line x1="60" y1="14" x2="60" y2="62" stroke={STROKE_FAINT} strokeWidth={1.5} />
  </>
);

const ART: Record<EmptyKind, React.FC> = {
  clear: ClearArt,
  inbox: InboxArt,
  money: MoneyArt,
  checklist: ChecklistArt,
  photos: PhotosArt,
  blueprint: BlueprintArt,
};

export const EmptyArt: React.FC<{ kind: EmptyKind; className?: string }> = ({ kind, className }) => {
  const resolved: EmptyKind = ART[kind] ? kind : 'clear';
  const Art = ART[resolved];
  return (
    <svg
      viewBox="0 0 96 72"
      className={className}
      aria-hidden="true"
      data-kind={resolved}
    >
      <Art />
    </svg>
  );
};
