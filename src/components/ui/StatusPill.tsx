// src/components/ui/StatusPill.tsx
import React from 'react';

export type PillTone =
  | 'slate' | 'blue' | 'violet' | 'green' | 'emerald' | 'amber' | 'orange' | 'red';

// Soft colour-tinted pills (spec §5 rule 1). Full class strings per tone so
// Tailwind's scanner sees every class statically.
const TONES: Record<PillTone, string> = {
  slate:   'bg-sunken text-ink-soft border-edge',
  blue:    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-400/10 dark:text-blue-300 dark:border-blue-400/20',
  violet:  'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-400/10 dark:text-violet-300 dark:border-violet-400/20',
  green:   'bg-green-50 text-green-700 border-green-200 dark:bg-green-400/10 dark:text-green-300 dark:border-green-400/20',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-400/10 dark:text-emerald-300 dark:border-emerald-400/20',
  amber:   'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-400/10 dark:text-amber-300 dark:border-amber-400/20',
  orange:  'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-400/10 dark:text-orange-300 dark:border-orange-400/20',
  red:     'bg-red-50 text-red-700 border-red-200 dark:bg-red-400/10 dark:text-red-300 dark:border-red-400/20',
};

export const StatusPill: React.FC<{
  tone?: PillTone;
  className?: string;
  children: React.ReactNode;
}> = ({ tone = 'slate', className = '', children }) => (
  <span
    className={
      'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 ' +
      `text-xs font-medium whitespace-nowrap ${TONES[tone]} ${className}`
    }
  >
    {children}
  </span>
);

// Project lifecycle: two live stages, `bidding` → `in_progress`. Archiving is
// an independent flag, not a stage, but the board still pills it as "Archived".
export const PROJECT_STATUS_META: Record<string, { label: string; tone: PillTone }> = {
  bidding:     { label: 'Bidding',     tone: 'blue' },
  in_progress: { label: 'In Progress', tone: 'amber' },
  archived:    { label: 'Archived',    tone: 'slate' },
};

// Pre-two-stage status ids, collapsed exactly the way migration 21 collapsed
// them server-side. A client can still meet these in a stale summary, an old
// bookmark's ?stage=, or a tab that was open across the deploy.
export const LEGACY_STATUS_MAP: Record<string, string> = {
  estimating:    'bidding',
  proposal_sent: 'bidding',
  lost:          'bidding',
  awarded:       'in_progress',
  punch_list:    'in_progress',
  complete:      'in_progress',
};

// Resolves any status string onto the live pair. Unrecognised ids fold into
// `bidding`, matching the board's "nothing vanishes" rule. Object.hasOwn keeps
// prototype keys ("constructor") from resolving to a function.
export const normalizeProjectStatus = (status: string): string => {
  if (Object.hasOwn(PROJECT_STATUS_META, status)) return status;
  if (Object.hasOwn(LEGACY_STATUS_MAP, status)) return LEGACY_STATUS_MAP[status];
  return 'bidding';
};

export const ProjectStatusPill: React.FC<{ status?: string | null; className?: string }> = ({
  status,
  className,
}) => {
  // A missing status means "not loaded yet" rather than a stage — don't claim
  // the project is bidding when we simply don't know.
  const meta = status ? PROJECT_STATUS_META[normalizeProjectStatus(status)] : null;
  return (
    <StatusPill tone={meta?.tone ?? 'slate'} className={className}>
      {meta?.label ?? 'Unknown'}
    </StatusPill>
  );
};

// A lost bid is a marker on an archived project, not a stage of its own.
export const LostBadge: React.FC<{ className?: string }> = ({ className }) => (
  <StatusPill tone="red" className={className}>Lost</StatusPill>
);
